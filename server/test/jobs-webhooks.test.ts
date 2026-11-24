import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, CONTRACTS_CHANGESET, setup } from './helpers';
import { newId } from '../src/lib/crypto';
import { enqueue, JobRunner, JobTimeoutError, type JobHandler } from '../src/lib/jobs';
import { __test, safePost, SafePostError, SsrfError } from '../src/lib/ssrf';
import { createJobHandlers } from '../src/worker';

/**
 * Endurecimiento de la cola de trabajos y de los webhooks salientes: plazo total de safePost frente a
 * receptores maliciosos, watchdog por trabajo, equidad entre organizaciones, recuperación de trabajos
 * huérfanos respetando max_attempts y purga del contenido de archivos borrados.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const past = (ms: number) => new Date(Date.now() - ms);

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('waitFor: la condición no se cumplió a tiempo');
    await sleep(10);
  }
}

/** Servidor HTTP local efímero en 127.0.0.1 (el transporte de pruebas permite destinos privados). */
async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/hook`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const post = (url: string, opts: Parameters<typeof __test.postWithDeadline>[3] = {}) => __test.postWithDeadline(url, '{"event":"test"}', {}, opts);
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('se esperaba un rechazo'); }, (e) => e);

describe('safePost: plazo total y límites contra un receptor malicioso', () => {
  it('respuesta normal: devuelve estado y cuerpo, con las cabeceras de la entrega', async () => {
    await withServer(
      (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: JSON.parse(body), ua: req.headers['user-agent'], sig: req.headers['x-cortex-signature'] }));
        });
      },
      async (url) => {
        const r = await __test.postWithDeadline(url, JSON.stringify({ event: 'record.created' }), { 'X-Cortex-Signature': 'sha256=abc' }, { timeoutMs: 2000 });
        expect(r.status).toBe(201);
        expect(JSON.parse(r.body)).toEqual({ received: { event: 'record.created' }, ua: 'EVOLVE-CRM-Webhooks/1.0', sig: 'sha256=abc' });
      },
    );
  });

  it('goteo lento (un byte cada poco): se rechaza al vencer el plazo TOTAL aunque sigan llegando bytes y se cierra la conexión', async () => {
    let serverSawClose = false;
    await withServer(
      (req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const t = setInterval(() => res.write(' '), 50); // nunca 50 ms de inactividad: el antiguo timeout de socket no saltaba
          res.on('close', () => {
            clearInterval(t);
            serverSawClose = true;
          });
        });
      },
      async (url) => {
        const started = Date.now();
        const err = await failure(post(url, { timeoutMs: 400 }));
        const elapsed = Date.now() - started;
        expect(err).toBeInstanceOf(SafePostError);
        expect(err.code).toBe('timeout');
        expect(elapsed).toBeGreaterThanOrEqual(300);
        expect(elapsed).toBeLessThan(2000);
        await waitFor(() => serverSawClose);
      },
    );
  });

  it('el destino acepta la conexión y no responde nunca: se rechaza al vencer el plazo', async () => {
    await withServer(
      () => {},
      async (url) => {
        const err = await failure(post(url, { timeoutMs: 300 }));
        expect(err).toBeInstanceOf(SafePostError);
        expect(err.code).toBe('timeout');
      },
    );
  });

  it('cuerpo parcial y cierre del socket: se rechaza en cuanto se corta la conexión (sin esperar al plazo)', async () => {
    await withServer(
      (req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
          res.write('{"partial":');
          setTimeout(() => res.socket?.destroy(), 50);
        });
      },
      async (url) => {
        const started = Date.now();
        const err = await failure(post(url, { timeoutMs: 10_000 }));
        expect(err).toBeInstanceOf(SafePostError);
        expect(err.code).toBe('incomplete');
        expect(Date.now() - started).toBeLessThan(2000);
      },
    );
  });

  it('cuerpo demasiado grande (flujo sin fin): se corta la conexión al superar maxBytes y la entrega cuenta como recibida', async () => {
    let serverSawClose = false;
    let sent = 0;
    await withServer(
      (req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' }); // chunked, sin Content-Length
          const chunk = Buffer.alloc(16 * 1024, 'x');
          const t = setInterval(() => {
            res.write(chunk);
            sent += chunk.length;
          }, 2);
          res.on('close', () => {
            clearInterval(t);
            serverSawClose = true;
          });
        });
      },
      async (url) => {
        const res = await post(url, { timeoutMs: 10_000, maxBytes: 64 * 1024 });
        expect(res.status).toBe(200);
        expect(res.truncated).toBe(true);
        expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(64 * 1024);
        await waitFor(() => serverSawClose);
        expect(sent).toBeLessThan(4 * 1024 * 1024);
      },
    );
  });

  it('Content-Length anunciado por encima de maxBytes: no se lee el cuerpo y se conserva el código de estado', async () => {
    await withServer(
      (req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Length': String(50 * 1024 * 1024) });
          res.write('x');
        });
      },
      async (url) => {
        const res = await post(url, { timeoutMs: 10_000, maxBytes: 64 * 1024 });
        expect(res.status).toBe(200);
        expect(res.truncated).toBe(true);
        expect(res.body).toBe('');
      },
    );
  });

  it('la señal externa (watchdog del JobRunner) cancela la petición en curso', async () => {
    await withServer(
      () => {},
      async (url) => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 100);
        const started = Date.now();
        const err = await failure(post(url, { timeoutMs: 10_000, signal: ac.signal }));
        expect(err.code).toBe('aborted');
        expect(Date.now() - started).toBeLessThan(2000);
      },
    );
  });

  it('se conservan las protecciones SSRF de safePost (también la validación de la IP al conectar)', async () => {
    await expect(safePost('http://127.0.0.1:9/hook', '{}', {}, { allowHttp: true })).rejects.toBeInstanceOf(SsrfError);
    await expect(safePost('http://example.com/hook', '{}', {})).rejects.toThrow(/HTTPS/);
    await expect(safePost('https://user:pass@example.com/', '{}', {})).rejects.toThrow(/credenciales/);
    await expect(safePost('https://[::1]/hook', '{}', {})).rejects.toThrow(/privado/);
    // Un nombre que resuelve a una IP privada se rechaza en el lookup del momento de conectar, con un
    // SsrfError (error permanente para webhook.deliver) aunque haya un servidor escuchando.
    let hits = 0;
    await withServer(
      (_req, res) => {
        hits++;
        res.end('ok');
      },
      async (url) => {
        const viaName = url.replace('127.0.0.1', 'localhost');
        const err = await failure(__test.postWithDeadline(viaName, '{}', {}, { timeoutMs: 2000, lookup: __test.guardedLookup }));
        expect(err).toBeInstanceOf(SsrfError);
        expect(hits).toBe(0);
      },
    );
  });
});

describe('JobRunner: watchdog, equidad entre organizaciones y recuperación', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  const logs: { level: 'info' | 'error'; msg: string; o: any }[] = [];
  const log = { info: (o: object, msg: string) => logs.push({ level: 'info', msg, o }), error: (o: object, msg: string) => logs.push({ level: 'error', msg, o }) };

  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());
  beforeEach(async () => {
    logs.length = 0;
    await env.db.query(`DELETE FROM jobs`);
  });

  async function workspace(name: string) {
    const id = newId();
    await env.db.query(`INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`, [id, name, `${name}-${id.slice(0, 8)}`]);
    return id;
  }

  async function jobRows(ids: string[]): Promise<Record<string, any>> {
    const r = await env.db.query(`SELECT id, status, attempts, max_attempts, last_error, run_at, locked_at, finished_at FROM jobs WHERE id = ANY($1::uuid[])`, [ids]);
    return Object.fromEntries(r.rows.map((x: any) => [x.id, x]));
  }

  it('duraciones máximas por tipo: webhooks 30 s, IA 15 min, el resto 5 min', () => {
    const runner = new JobRunner(env.db, {}, log);
    expect(runner.timeoutFor('webhook.deliver')).toBe(30_000);
    for (const t of ['evolve.plan', 'evolve.security', 'evolve.advice']) expect(runner.timeoutFor(t)).toBe(15 * 60_000);
    for (const t of ['automations.scheduled', 'formulas.recompute', 'maintenance.cleanup']) expect(runner.timeoutFor(t)).toBe(5 * 60_000);
  });

  it('un trabajo que nunca termina no bloquea la cola: el watchdog lo da por fallido y se ejecuta el siguiente', async () => {
    const ws = await workspace('watchdog');
    const ran: string[] = [];
    let signal: AbortSignal | undefined;
    const runner = new JobRunner(
      env.db,
      {
        'test.hang': (_job, ctx) => {
          signal = ctx?.signal;
          return new Promise<void>(() => {}); // no se resuelve nunca
        },
        'test.ok': async (job) => {
          ran.push(job.payload.n);
        },
      },
      log,
      10,
      { concurrency: 1, timeouts: { 'test.hang': 150 } }, // un solo hueco: el siguiente solo corre si el watchdog lo libera
    );
    const hang = await enqueue(env.db, { type: 'test.hang', workspaceId: ws, maxAttempts: 1, runAt: past(2000) });
    const ok = await enqueue(env.db, { type: 'test.ok', workspaceId: ws, payload: { n: 'siguiente' }, runAt: past(1000) });
    const started = Date.now();
    expect(await runner.drain()).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ran).toEqual(['siguiente']);
    const rows = await jobRows([hang, ok]);
    expect(rows[hang]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(rows[hang].last_error).toMatch(/Tiempo máximo de ejecución superado/);
    expect(rows[hang].finished_at).not.toBeNull();
    expect(rows[ok].status).toBe('done');
    expect(signal?.aborted).toBe(true); // el manejador recibe la cancelación para cortar su E/S
    expect(runner.stats()).toMatchObject({ running: 0, abandoned: 1 });
    const ev = await env.db.query(`SELECT message FROM error_events WHERE source = 'worker' AND context->>'jobId' = $1`, [hang]);
    expect(ev.rows).toHaveLength(1);
  });

  it('si le quedan intentos, el trabajo colgado vuelve a la cola con backoff; si termina tarde, su resultado se descarta', async () => {
    const ws = await workspace('reintento');
    let finishLate: (() => void) | undefined;
    const runner = new JobRunner(env.db, { 'test.slow': () => new Promise<void>((r) => (finishLate = r)) }, log, 10, { timeouts: { 'test.slow': 100 } });
    const id = await enqueue(env.db, { type: 'test.slow', workspaceId: ws, maxAttempts: 3, runAt: past(1000) });
    expect(await runner.drain()).toBe(1);
    let row = (await jobRows([id]))[id];
    expect(row).toMatchObject({ status: 'queued', attempts: 1, locked_at: null });
    expect(row.last_error).toMatch(/Tiempo máximo de ejecución superado/);
    expect(new Date(row.run_at).getTime() - Date.now()).toBeGreaterThan(20_000); // backoff de 30 s
    // El manejador abandonado acaba más tarde: no puede marcar como hecho un trabajo que ya no es suyo.
    finishLate!();
    await waitFor(() => runner.stats().abandoned === 0);
    row = (await jobRows([id]))[id];
    expect(row.status).toBe('queued');
    expect(logs.some((l) => /terminó tarde/.test(l.msg))).toBe(true);
  });

  it('equidad: la cola atrasada de una organización no impide que otra avance en el mismo drain', async () => {
    const big = await workspace('atrasada');
    const small = await workspace('pequena');
    const order: string[] = [];
    const live = new Map<string, number>();
    let maxLive = 0;
    let maxLiveBig = 0;
    const handler: JobHandler = async (job) => {
      const ws = job.workspace_id!;
      order.push(ws === small ? 'small' : 'big');
      live.set(ws, (live.get(ws) ?? 0) + 1);
      maxLive = Math.max(maxLive, [...live.values()].reduce((a, b) => a + b, 0));
      maxLiveBig = Math.max(maxLiveBig, live.get(big) ?? 0);
      await sleep(25);
      live.set(ws, live.get(ws)! - 1);
    };
    const runner = new JobRunner(env.db, { 'test.work': handler }, log, 10); // valores por defecto: 4 huecos, 2 por organización
    // La organización atrasada encoló 12 trabajos ANTES (run_at más antiguo); con el orden global por
    // run_at, el trabajo de la pequeña sería el último.
    for (let i = 0; i < 12; i++) await enqueue(env.db, { type: 'test.work', workspaceId: big, payload: { i }, runAt: past(60_000 - i) });
    await enqueue(env.db, { type: 'test.work', workspaceId: small, runAt: past(1000) });
    expect(await runner.drain()).toBe(13);
    expect(order).toHaveLength(13);
    expect(order.indexOf('small')).toBeLessThan(3);
    expect(maxLiveBig).toBeLessThanOrEqual(2);
    expect(maxLive).toBeLessThanOrEqual(4);
  });

  it('con más organizaciones atrasadas que huecos, el turno rotatorio no deja a ninguna sin servicio', async () => {
    const heavy = [await workspace('a'), await workspace('b'), await workspace('c'), await workspace('d')];
    const late = await workspace('e');
    const order: string[] = [];
    const live = new Map<string, number>();
    let maxLive = 0;
    let maxPerWs = 0;
    const handler: JobHandler = async (job) => {
      const ws = job.workspace_id!;
      order.push(ws);
      live.set(ws, (live.get(ws) ?? 0) + 1);
      maxLive = Math.max(maxLive, [...live.values()].reduce((a, b) => a + b, 0));
      maxPerWs = Math.max(maxPerWs, ...live.values());
      await sleep(20);
      live.set(ws, live.get(ws)! - 1);
    };
    const runner = new JobRunner(env.db, { 'test.work': handler }, log, 10);
    let age = 120_000;
    for (const ws of heavy) for (let i = 0; i < 6; i++) await enqueue(env.db, { type: 'test.work', workspaceId: ws, runAt: past(age--) });
    await enqueue(env.db, { type: 'test.work', workspaceId: late, runAt: past(1000) }); // el más reciente de todos
    expect(await runner.drain()).toBe(25);
    // Entra en cuanto queda el primer hueco libre (con orden global por run_at sería el 25.º).
    expect(order.indexOf(late)).toBeLessThanOrEqual(5);
    expect(maxLive).toBeLessThanOrEqual(4);
    expect(maxPerWs).toBeLessThanOrEqual(2);
  });

  it('drain respeta el máximo de trabajos indicado', async () => {
    const ws = await workspace('maximo');
    const runner = new JobRunner(env.db, { 'test.quick': async () => {} }, log, 10);
    for (let i = 0; i < 5; i++) await enqueue(env.db, { type: 'test.quick', workspaceId: ws, runAt: past(1000 - i) });
    expect(await runner.drain(3)).toBe(3);
    expect(await runner.drain(10)).toBe(2);
    expect(await runner.drain()).toBe(0);
  });

  it('recoverStale devuelve a la cola los huérfanos con intentos y marca como fallidos los que los agotaron', async () => {
    const ws = await workspace('huerfanos');
    const runner = new JobRunner(env.db, {}, log, 10);
    const orphan = async (attempts: number, max: number, lockedAgo: string) => {
      const id = newId();
      await env.db.query(
        `INSERT INTO jobs (id, workspace_id, type, status, attempts, max_attempts, locked_at, locked_by) VALUES ($1,$2,'test.orphan','running',$3,$4, now() - $5::interval, 'worker-caido')`,
        [id, ws, attempts, max, lockedAgo],
      );
      return id;
    };
    const exhausted = await orphan(1, 1, '2 hours');
    const retry = await orphan(1, 3, '2 hours');
    const fresh = await orphan(1, 3, '1 minute');
    expect(await runner.recoverStale()).toBe(2);
    const rows = await jobRows([exhausted, retry, fresh]);
    expect(rows[exhausted]).toMatchObject({ status: 'failed', attempts: 1, locked_at: null });
    expect(rows[exhausted].finished_at).not.toBeNull();
    expect(rows[exhausted].last_error).toMatch(/dejó de responder/);
    expect(rows[retry]).toMatchObject({ status: 'queued', attempts: 1, locked_at: null });
    expect(new Date(rows[retry].run_at).getTime() - Date.now()).toBeGreaterThan(20_000); // con backoff
    expect(rows[fresh].status).toBe('running'); // todavía dentro de su plazo
    const ev = await env.db.query(`SELECT 1 FROM error_events WHERE source = 'worker' AND context->>'jobId' = $1`, [exhausted]);
    expect(ev.rows).toHaveLength(1);
  });

  it('con el bucle en marcha, recoverStale se ejecuta periódicamente y el latido avanza', async () => {
    const ws = await workspace('periodico');
    const runner = new JobRunner(env.db, {}, log, 20, { recoverEveryMs: 50 });
    const id = newId();
    await env.db.query(
      `INSERT INTO jobs (id, workspace_id, type, status, attempts, max_attempts, locked_at, locked_by) VALUES ($1,$2,'test.orphan','running',2,2, now() - interval '3 hours', 'worker-caido')`,
      [id, ws],
    );
    const before = runner.lastTickAt;
    runner.start();
    try {
      await waitFor(async () => (await jobRows([id]))[id].status === 'failed');
      await waitFor(() => runner.lastTickAt > before);
      expect(runner.stats()).toMatchObject({ looping: true, running: 0 });
      expect(runner.stats().stalledMs).toBeLessThan(5000);
    } finally {
      await runner.stop();
    }
    expect(runner.stats().looping).toBe(false);
  });

  it('EVOLVE: si el watchdog abandona la planificación en su último intento, la petición pasa a fallida', async () => {
    const owner = new Client(env.app);
    await owner.register('Vera', 'vera@example.com', 'Vigilancia SL');
    const ws = (await owner.req('GET', '/api/auth/me')).body.workspace.id;
    env.setMock(() => ({ text: JSON.stringify(CONTRACTS_CHANGESET) }));
    const handlers = createJobHandlers(env.deps);
    const planAndAbort = async (attempts: number, maxAttempts: number) => {
      const created = await owner.req('POST', '/api/evolve/requests', { prompt: 'Quiero un módulo de contratos con vencimientos' });
      expect(created.status).toBe(200);
      const controller = new AbortController();
      const job = { id: newId(), workspace_id: ws, type: 'evolve.plan', payload: { requestId: created.body.id }, attempts, max_attempts: maxAttempts };
      const running = handlers['evolve.plan'](job, { signal: controller.signal, deadline: Date.now() });
      controller.abort(new JobTimeoutError('evolve.plan', 15 * 60_000)); // lo que hace el watchdog al vencer el plazo
      await running;
      return (await owner.req('GET', `/api/evolve/requests/${created.body.id}`)).body;
    };
    const last = await planAndAbort(1, 1);
    expect(last.status).toBe('failed');
    expect(last.error).toMatch(/Ejecución interrumpida: Tiempo máximo de ejecución superado/);
    // Si le quedan intentos se reintentará: la petición no se toca.
    expect((await planAndAbort(1, 3)).status).toBe('ready_for_review');
  });

  it('webhook.deliver: un destino privado es un error permanente (no se reintenta)', async () => {
    const ws = await workspace('webhook');
    const id = await enqueue(env.db, { type: 'webhook.deliver', workspaceId: ws, maxAttempts: 5, runAt: past(1000), payload: { url: 'https://127.0.0.1/hook', integrationKey: 'erp', payload: { event: 'record.created' } } });
    await env.drain();
    const row = (await jobRows([id]))[id];
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.last_error).toMatch(/privado/);
  });

  it('mantenimiento: purga el contenido de los archivos borrados hace más de 7 días y conserva la fila', async () => {
    const ws = await workspace('archivos');
    const file = async (name: string, deletedAgo: string | null) => {
      const id = newId();
      const content = Buffer.from(`contenido de ${name}`);
      await env.db.query(`INSERT INTO files (id, workspace_id, name, mime, size, sha256, content) VALUES ($1,$2,$3,'text/plain',$4,'hash-original',$5)`, [id, ws, name, content.length, content]);
      if (deletedAgo) await env.db.query(`UPDATE files SET deleted_at = now() - $2::interval WHERE id = $1`, [id, deletedAgo]);
      return { id, size: content.length };
    };
    const old = await file('viejo.txt', '8 days');
    const recent = await file('reciente.txt', '2 days');
    const live = await file('vivo.txt', null);
    const job = await enqueue(env.db, { type: 'maintenance.cleanup', workspaceId: null, maxAttempts: 1, runAt: past(1000) });
    await env.drain();
    expect((await jobRows([job]))[job].status).toBe('done');
    const r = await env.db.query(`SELECT id, name, mime, sha256, size, octet_length(content)::int AS bytes, deleted_at FROM files WHERE id = ANY($1::uuid[])`, [[old.id, recent.id, live.id]]);
    const by = Object.fromEntries(r.rows.map((x: any) => [x.id, x]));
    expect(by[old.id]).toMatchObject({ name: 'viejo.txt', mime: 'text/plain', sha256: 'hash-original', size: 0, bytes: 0 });
    expect(by[old.id].deleted_at).not.toBeNull();
    expect(by[recent.id]).toMatchObject({ size: recent.size, bytes: recent.size }); // borrado hace menos de 7 días
    expect(by[live.id]).toMatchObject({ size: live.size, bytes: live.size, deleted_at: null });
  });
});
