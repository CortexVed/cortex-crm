import fs from 'node:fs';
import http from 'node:http';
import { loadConfig } from './config';
import { createDb } from './db/db';
import { runMigrations } from './db/migrations';
import { SecretBox } from './lib/crypto';
import { createMailer } from './lib/mailer';
import { AiManager } from './ai/manager';
import { buildApp, buildVersion } from './app';
import { createWorker } from './worker';
import { LOOP_DEAD_MS, LOOP_STALE_MS } from './lib/jobs';
import { shutdownScriptPool } from './crm/scripts';
import { waitForDatabase } from './lib/wait-db';
import type { AppDeps } from './deps';

const log = {
  info: (o: object, m: string) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: m, ...o })),
  error: (o: object, m: string) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg: m, ...o })),
};

async function main() {
  // En desarrollo se carga .env si existe (en producción las variables vienen de Railway).
  if (process.env.NODE_ENV !== 'production' && fs.existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const db = await createDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir ?? (config.databaseUrl ? undefined : '.data/pglite'), poolMax: config.dbPoolMax });
  // En una instalación nueva (plantilla de Railway) los servicios arrancan a la vez que Postgres: se espera a
  // que acepte conexiones en lugar de fallar y depender de los reinicios de la plataforma.
  if (config.databaseUrl) {
    const attempts = await waitForDatabase(db, { log: (attempt, err) => log.info({ attempt, err }, 'Esperando a la base de datos…') });
    if (attempts > 1) log.info({ attempts }, 'Base de datos disponible');
  }
  await runMigrations(db, (m) => log.info({}, m));
  const box = new SecretBox(config.encryptionKey);
  const deps: AppDeps = {
    config,
    db,
    box,
    ai: new AiManager({ db, box, config }),
    mailer: createMailer(config, log),
    fetchImpl: fetch,
    now: () => new Date(),
  };

  const closers: (() => Promise<void>)[] = [];
  if (config.role === 'web' || config.role === 'all') {
    const app = await buildApp(deps);
    await app.listen({ port: config.port, host: config.host });
    closers.push(() => app.close());
  }
  if (config.role === 'worker' || config.role === 'all') {
    const worker = createWorker(deps, log);
    await worker.start();
    closers.push(() => worker.stop());
    // Watchdog de vivacidad: Railway solo reinicia el servicio cuando el proceso termina (restartPolicy
    // ON_FAILURE; su health check solo se consulta al desplegar). Si el bucle de trabajos lleva más de
    // LOOP_DEAD_MS sin latido, se sale con código 1 para forzar el reinicio. En `all` fuera de producción
    // (desarrollo) solo se avisa. Los trabajos que queden 'running' se recuperan al volver.
    const exitOnStall = config.role === 'worker' || config.isProd;
    let stallReported = false;
    const liveness = setInterval(() => {
      const { stalledMs } = worker.runner.stats();
      if (stalledMs <= LOOP_DEAD_MS) {
        stallReported = false;
        return;
      }
      if (!stallReported) log.error({ stalledMs, exiting: exitOnStall }, `El bucle de trabajos lleva más de ${LOOP_DEAD_MS / 60_000} minutos sin avanzar`);
      stallReported = true;
      if (exitOnStall) process.exit(1);
    }, 30_000);
    liveness.unref();
    closers.push(async () => clearInterval(liveness));
    if (config.role === 'worker') {
      // El health check no debe quedarse colgado si la base de datos no responde.
      const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => {
        let t: NodeJS.Timeout | undefined;
        return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error('Tiempo de espera agotado')), ms)))]).finally(() => clearTimeout(t));
      };
      // El worker expone un health check mínimo para Railway: base de datos y latido del bucle de trabajos.
      const server = http.createServer(async (req, res) => {
        if (req.url === '/api/health') {
          const loop = worker.runner.stats();
          const loopOk = loop.stalledMs <= LOOP_STALE_MS;
          let dbOk = true;
          try {
            await withTimeout(db.query('SELECT 1'), 5_000);
          } catch {
            dbOk = false;
          }
          const ok = dbOk && loopOk;
          res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(
            JSON.stringify({
              status: ok ? 'ok' : 'degraded',
              role: 'worker',
              db: dbOk ? 'ok' : 'error',
              jobs: { loop: loopOk ? 'ok' : 'stalled', lastTickAt: new Date(loop.lastTickAt).toISOString(), running: loop.running, abandoned: loop.abandoned },
              version: buildVersion(),
            }),
          );
        } else {
          res.writeHead(404).end();
        }
      });
      server.listen(config.port, config.host);
      closers.push(() => new Promise((r) => server.close(() => r())));
    }
  }
  log.info({ role: config.role, port: config.port, db: db.kind, version: buildVersion() }, 'Cortex CRM iniciado');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Apagado ordenado');
    for (const c of closers.reverse()) await c().catch(() => {});
    // Hilos del sandbox de scripts: se terminan antes de cerrar la base de datos.
    await shutdownScriptPool().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'Fallo al iniciar');
  process.exit(1);
});
