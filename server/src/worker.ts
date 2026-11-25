import { activeModules, BlueprintSchema } from '../../shared/blueprint';
import type { AppDeps } from './deps';
import { hmacHex } from './lib/crypto';
import { enqueue, JobRunner, type Job, type JobContext, type JobHandler } from './lib/jobs';
import { safePost, SsrfError } from './lib/ssrf';
import { loadWorkspace, makeRecordService } from './crm/context';
import { runScheduledAutomations } from './crm/automations';
import { runEvolutionPipeline } from './evolve/pipeline';
import { runAdvisor, runSecurityReview } from './evolve/security';
import { runCodeDeployJob, runCodePlanJob } from './code-engine/jobs';

type Log = { info: (o: object, m: string) => void; error: (o: object, m: string) => void };

/** Archivos borrados cuyo contenido se purga por sentencia en el mantenimiento diario. */
const PURGE_BATCH = 100;

export function createJobHandlers(deps: AppDeps): Record<string, JobHandler> {
  const finishReport = async (ws: string, requestId: string, run: () => Promise<unknown>) => {
    try {
      const report = await run();
      await deps.db.tenant(ws, (q) => q.query(`UPDATE evolution_requests SET status = 'ready_for_review', impact = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`, [JSON.stringify(report), requestId, ws]));
    } catch (e) {
      await deps.db.tenant(ws, (q) => q.query(`UPDATE evolution_requests SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`, [(e as Error).message.slice(0, 2000), requestId, ws]));
    }
  };

  // Si el watchdog abandona un trabajo de EVOLVE (o se apaga el worker) en su último intento, la petición
  // pasa a fallida: el pipeline colgado ya no la actualizará y, si no, se quedaría «planificando» para siempre.
  const failRequestIfAbandoned = (job: Job, ctx: JobContext | undefined): (() => void) => {
    const signal = ctx?.signal;
    const ws = job.workspace_id;
    const requestId = job.payload?.requestId;
    if (!signal || !ws || !requestId) return () => {};
    const onAbort = () => {
      if (job.attempts < job.max_attempts) return; // se reintentará
      const reason = `Ejecución interrumpida: ${(signal.reason as Error)?.message ?? 'cancelada'}`;
      deps.db
        .tenant(ws, (q) =>
          q.query(`UPDATE evolution_requests SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3 AND status IN ('queued','planning','testing')`, [reason, requestId, ws]),
        )
        .catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  };
  const guardEvolve =
    (run: (job: Job) => Promise<unknown>): JobHandler =>
    async (job, ctx) => {
      const release = failRequestIfAbandoned(job, ctx);
      try {
        await run(job);
      } finally {
        release();
      }
    };

  return {
    'evolve.plan': guardEvolve((job) => runEvolutionPipeline(deps, job.workspace_id!, job.payload.requestId)),

    'evolve.security': guardEvolve(async (job) => {
      const ws = job.workspace_id!;
      const req = (await deps.db.tenant(ws, (q) => q.query(`SELECT requested_by FROM evolution_requests WHERE id = $1`, [job.payload.requestId]))).rows[0];
      await deps.db.tenant(ws, (q) => q.query(`UPDATE evolution_requests SET status = 'planning' WHERE id = $1`, [job.payload.requestId]));
      await finishReport(ws, job.payload.requestId, () => runSecurityReview(deps, ws, { userId: req?.requested_by, platformAdmin: !!job.payload.platformAdmin }));
    }),

    'evolve.advice': guardEvolve(async (job) => {
      const ws = job.workspace_id!;
      const req = (await deps.db.tenant(ws, (q) => q.query(`SELECT requested_by FROM evolution_requests WHERE id = $1`, [job.payload.requestId]))).rows[0];
      await deps.db.tenant(ws, (q) => q.query(`UPDATE evolution_requests SET status = 'planning' WHERE id = $1`, [job.payload.requestId]));
      await finishReport(ws, job.payload.requestId, () => runAdvisor(deps, ws, req?.requested_by));
    }),

    'webhook.deliver': async (job, ctx) => {
      const { url, integrationKey, payload } = job.payload;
      const body = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000).toString();
      const secret = deps.box.derive(`webhook:${job.workspace_id}:${integrationKey}`);
      try {
        // safePost impone su propio plazo total (10 s); la señal del watchdog corta además la conexión al instante.
        const res = await safePost(url, body, { 'X-Cortex-Timestamp': ts, 'X-Cortex-Signature': `sha256=${hmacHex(secret, `${ts}.${body}`)}`, 'X-Cortex-Event': String(payload?.event ?? '') }, { allowHttp: !deps.config.isProd, signal: ctx?.signal });
        if (res.status < 200 || res.status >= 300) throw new Error(`El destino respondió ${res.status}`);
      } catch (e) {
        if (e instanceof SsrfError) {
          // Error permanente: no tiene sentido reintentar.
          job.attempts = job.max_attempts;
        }
        throw e;
      }
    },

    'automations.scheduled': async (job) => {
      const ws = job.workspace_id!;
      await deps.db.tenant(ws, async (q) => {
        const loaded = await loadWorkspace(q, ws);
        if (!loaded.blueprint.automations.some((a) => a.enabled && (a.trigger.type === 'date_reached' || a.trigger.type === 'inactivity'))) return;
        await runScheduledAutomations(makeRecordService(q, loaded, { type: 'system', id: null }, deps.now));
      });
    },

    'formulas.recompute': async (job, ctx) => {
      const ws = job.workspace_id!;
      await deps.db.tenant(ws, async (q) => {
        const loaded = await loadWorkspace(q, ws);
        const svc = makeRecordService(q, loaded, { type: 'system', id: null }, deps.now);
        for (const mod of activeModules(loaded.blueprint)) {
          if (!mod.fields.some((f) => f.type === 'formula' && !f.archived)) continue;
          let offset = 0;
          for (;;) {
            // Si el watchdog lo abandona, se aborta la transacción en lugar de seguir ocupando la conexión.
            ctx?.signal.throwIfAborted();
            const { items } = await svc.ctx.store.list(mod, { limit: 200, offset }, { now: deps.now(), tz: loaded.settings.timezone });
            for (const rec of items) {
              const next = await svc.computeFormulas(mod, rec);
              if (JSON.stringify(next) !== JSON.stringify(rec.data)) {
                await q.query(`UPDATE records SET data = $1 WHERE id = $2 AND workspace_id = $3`, [JSON.stringify(next), rec.id, ws]);
              }
            }
            if (items.length < 200 || offset > 20_000) break;
            offset += 200;
          }
        }
      });
    },

    // Motor de código fuente de la instalación (docs/CODE_ENGINE.md). Cada ejecución es una fase acotada y el
    // estado vive en source_changes: el trabajo sobrevive a que Railway sustituya este proceso al desplegar.
    'code.plan': (job, ctx) => runCodePlanJob(deps, job, ctx),
    'code.deploy': (job, ctx) => runCodeDeployJob(deps, job, ctx),

    'maintenance.cleanup': async (_job, ctx) => {
      await deps.db.query(`DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - interval '7 days'`);
      await deps.db.query(`DELETE FROM sessions WHERE expires_at < now()`);
      await deps.db.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`);
      await deps.db.query(`DELETE FROM notifications WHERE read_at < now() - interval '180 days'`);
      await deps.db.query(`DELETE FROM error_events WHERE created_at < now() - interval '90 days'`);
      // Archivos borrados por los usuarios (borrado lógico): pasados 7 días se purga su contenido. La fila y
      // sus metadatos se conservan; `size = 0` significa «purgado» (y deja de contar en la cuota). Por lotes
      // y con un presupuesto de tiempo para no rozar el statement_timeout ni el watchdog del trabajo con
      // muchos archivos grandes: lo que quede se purga en la siguiente ejecución diaria.
      const until = Date.now() + 2 * 60_000;
      for (let i = 0; i < 200 && !ctx?.signal.aborted && Date.now() < until; i++) {
        const r = await deps.db.query(
          `UPDATE files SET content = ''::bytea, size = 0
           WHERE id IN (SELECT id FROM files WHERE deleted_at < now() - interval '7 days' AND (size <> 0 OR octet_length(content) <> 0) LIMIT $1)`,
          [PURGE_BATCH],
        );
        if (r.rowCount < PURGE_BATCH) break;
      }
    },
  };
}

/** Planificador: encola trabajos periódicos con deduplicación (seguro con varias instancias). */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private deps: AppDeps, private log: Log) {}

  async tick(now = new Date()) {
    const bucket5 = Math.floor(now.getTime() / 300_000);
    const hour = Math.floor(now.getTime() / 3_600_000);
    const day = now.toISOString().slice(0, 10);
    const rows = (await this.deps.db.query<{ id: string; definition: unknown }>(
      `SELECT w.id, bv.definition FROM workspaces w JOIN blueprint_versions bv ON bv.workspace_id = w.id AND bv.version = w.blueprint_version`,
    )).rows;
    for (const w of rows) {
      const parsed = BlueprintSchema.safeParse(w.definition);
      if (!parsed.success) continue;
      const bp = parsed.data;
      if (bp.automations.some((a) => a.enabled && (a.trigger.type === 'date_reached' || a.trigger.type === 'inactivity'))) {
        await enqueue(this.deps.db, { type: 'automations.scheduled', workspaceId: w.id, dedupeKey: `sched:${w.id}:${bucket5}`, maxAttempts: 1 });
      }
      if (bp.modules.some((m) => m.fields.some((f) => f.type === 'formula' && /DAYS_|TODAY|_RELATED/.test(f.formula?.expression ?? '')))) {
        await enqueue(this.deps.db, { type: 'formulas.recompute', workspaceId: w.id, dedupeKey: `formulas:${w.id}:${hour}`, maxAttempts: 1 });
      }
    }
    await enqueue(this.deps.db, { type: 'maintenance.cleanup', workspaceId: null, dedupeKey: `cleanup:${day}`, maxAttempts: 1 });
  }

  start(intervalMs = 60_000) {
    const run = () =>
      this.tick().catch((e) => this.log.error({ err: (e as Error).message }, 'Error del planificador'));
    void run();
    this.timer = setInterval(run, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

export function createWorker(deps: AppDeps, log: Log) {
  const runner = new JobRunner(deps.db, createJobHandlers(deps), log);
  const scheduler = new Scheduler(deps, log);
  return {
    runner,
    scheduler,
    async start() {
      await runner.recoverStale();
      runner.start();
      scheduler.start();
    },
    async stop() {
      scheduler.stop();
      await runner.stop();
    },
  };
}
