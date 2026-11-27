import os from 'node:os';
import type { Db, Queryable } from '../db/db';
import { newId } from './crypto';
import { isLocale, localeFromRegion, type Locale } from '../../../shared/i18n';
import { contextLocale, t, withLocale } from '../i18n';

export interface Job {
  id: string;
  workspace_id: string | null;
  type: string;
  payload: any;
  attempts: number;
  max_attempts: number;
  /** Idioma de quien lo encoló (NULL si lo encoló el sistema: entonces, el de la organización). */
  locale?: string | null;
}

/**
 * Contexto de ejecución de un trabajo. `signal` se aborta cuando el watchdog abandona el trabajo por
 * superar su duración máxima (o cuando el worker se apaga): los manejadores que lo respetan cortan su
 * E/S en ese momento (p. ej. `webhook.deliver` destruye la conexión).
 */
export interface JobContext {
  signal: AbortSignal;
  /** Instante (ms desde epoch) en el que el watchdog abandonará el trabajo. */
  deadline: number;
}

export type JobHandler = (job: Job, ctx?: JobContext) => Promise<void>;

export interface EnqueueInput {
  type: string;
  workspaceId: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

/**
 * Encola un trabajo. La deduplicación solo está disponible desde el contexto privilegiado. Guarda el idioma de
 * la petición en curso: los textos que genere el trabajo saldrán en el idioma de quien lo pidió.
 */
export async function enqueue(q: Queryable, job: EnqueueInput): Promise<string> {
  const id = newId();
  const params = [id, job.workspaceId, job.type, JSON.stringify(job.payload ?? {}), (job.runAt ?? new Date()).toISOString(), job.maxAttempts ?? 3, contextLocale()];
  if (job.dedupeKey) {
    await q.query(
      `INSERT INTO jobs (id, workspace_id, type, payload, run_at, max_attempts, locale, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
      [...params, job.dedupeKey],
    );
  } else {
    await q.query(`INSERT INTO jobs (id, workspace_id, type, payload, run_at, max_attempts, locale) VALUES ($1,$2,$3,$4,$5,$6,$7)`, params);
  }
  return id;
}

/** Duración máxima de cada tipo de trabajo; los tipos no listados usan DEFAULT_JOB_TIMEOUT_MS. */
export const JOB_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  'webhook.deliver': 30_000,
  'evolve.plan': 15 * 60_000,
  'evolve.security': 15 * 60_000,
  'evolve.advice': 15 * 60_000,
};
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;

/** Si el bucle de trabajos no da señales de vida durante más de esto, el health check del worker responde 503. */
export const LOOP_STALE_MS = 5 * 60_000;
/** Si sigue sin dar señales de vida durante más de esto, el watchdog de vivacidad termina el proceso. */
export const LOOP_DEAD_MS = 10 * 60_000;

export interface JobRunnerOptions {
  /** Trabajos simultáneos en este proceso (por defecto 4). */
  concurrency?: number;
  /** Máximo de trabajos simultáneos de una misma organización en este proceso (por defecto 2). */
  perWorkspace?: number;
  /** Duración máxima por tipo (se combina con JOB_TIMEOUTS_MS). */
  timeouts?: Record<string, number>;
  /** Duración máxima de los tipos sin entrada propia (por defecto 5 min). */
  defaultTimeoutMs?: number;
  /** Cada cuánto se recuperan trabajos huérfanos mientras el bucle está en marcha (por defecto 5 min). */
  recoverEveryMs?: number;
  /** Antigüedad a partir de la cual un trabajo 'running' se considera huérfano (por defecto: la mayor duración máxima + 5 min). */
  staleAfterMs?: number;
}

/** El trabajo superó la duración máxima de su tipo y el watchdog lo ha abandonado. */
export class JobTimeoutError extends Error {
  constructor(
    readonly type: string,
    readonly limitMs: number,
  ) {
    super(t('Tiempo máximo de ejecución superado ({duration})', { duration: fmtDuration(limitMs) }));
    this.name = 'JobTimeoutError';
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);
/** Clave de organización para los contadores ('' = trabajos de plataforma, sin organización). */
const wsKey = (workspaceId: string | null): string => workspaceId ?? '';

/** Organizaciones con trabajo pendiente que se consideran en cada vuelta (cota de memoria). */
const CANDIDATE_LIMIT = 1000;
/** Organizaciones cuyo último turno se recuerda (las más antiguas se olvidan). */
const LAST_SERVED_MAX = 10_000;

/**
 * Candidatos: los `perWorkspace` trabajos ejecutables más antiguos de CADA organización que no esté ya
 * en su límite (sin bloquear filas). La reclamación real se hace después, fila a fila, con SKIP LOCKED.
 * Recorre los trabajos listos usando el índice parcial jobs_ready_idx.
 */
const CANDIDATES_SQL = `
  SELECT id, workspace_id, run_at, rn::int AS rank FROM (
    SELECT id, workspace_id, run_at, row_number() OVER (PARTITION BY workspace_id ORDER BY run_at, id) AS rn
    FROM jobs
    WHERE status = 'queued' AND run_at <= now() AND NOT (coalesce(workspace_id::text, '') = ANY($1::text[]))
  ) c
  WHERE rn <= $2
  ORDER BY rn, run_at, id
  LIMIT $3`;

const CLAIM_SQL = `
  UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
  WHERE id = (SELECT id FROM jobs WHERE id = $2 AND status = 'queued' AND run_at <= now() FOR UPDATE SKIP LOCKED)
  RETURNING id, workspace_id, type, payload, attempts, max_attempts, locale`;

// Las actualizaciones de resultado llevan un "token" de reclamación (attempts + locked_by): si el trabajo
// ya se recuperó o lo reclamó otro worker, el resultado tardío se descarta en lugar de pisarlo.
const DONE_SQL = `UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1 AND status = 'running' AND attempts = $2 AND locked_by = $3`;

const FAIL_SQL = `
  UPDATE jobs SET status = $1, last_error = $2, locked_at = NULL,
    run_at = CASE WHEN $1 = 'queued' THEN now() + make_interval(secs => $3) ELSE run_at END,
    finished_at = CASE WHEN $1 = 'failed' THEN now() ELSE NULL END
  WHERE id = $4 AND status = 'running' AND attempts = $5 AND locked_by = $6`;

const RECOVER_SQL = `
  UPDATE jobs SET
    status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
    run_at = CASE WHEN attempts >= max_attempts THEN run_at ELSE now() + make_interval(secs => least(3600, 30 * power(2, greatest(attempts, 1) - 1))) END,
    finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
    locked_at = NULL,
    last_error = $2
  WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1) AND NOT (id = ANY($3::uuid[]))
  RETURNING id, workspace_id, type, status, attempts`;

interface ActiveJob {
  job: Job;
  key: string;
  startedAt: number;
  controller: AbortController;
  /** Se resuelve cuando el trabajo deja libre su hueco (terminado, fallido o abandonado por el watchdog). */
  done: Promise<void>;
}

interface Candidate {
  id: string;
  key: string;
  rank: number;
  runAt: number;
}

/**
 * Cola de trabajos sobre PostgreSQL (FOR UPDATE SKIP LOCKED): varias instancias de worker pueden
 * consumir en paralelo sin duplicar trabajo, con reintentos y backoff exponencial.
 *
 * Planificación (aislamiento entre organizaciones):
 * - Concurrencia acotada (`concurrency`, 4) y como mucho `perWorkspace` (2) trabajos de una misma
 *   organización a la vez: una organización con miles de trabajos lentos ocupa como mucho 2 huecos.
 * - Turno rotatorio: en cada vuelta se toma el trabajo más antiguo de cada organización y se sirve
 *   antes a la que menos trabajos tiene en curso y, a igualdad, a la que lleva más tiempo sin turno.
 *   Ninguna cola atrasada deja sin servicio a las demás.
 * - Watchdog por trabajo (Promise.race con la duración máxima de su tipo): un trabajo colgado se da por
 *   fallido o se reintenta (según max_attempts, con backoff), su señal se aborta y la cola sigue aunque
 *   la promesa colgada no termine nunca.
 * - Recuperación periódica de trabajos huérfanos (worker caído) respetando max_attempts.
 * - Latido (`lastTickAt`) del bucle para el health check y el watchdog de vivacidad del proceso.
 */
export class JobRunner {
  readonly workerId = `${os.hostname()}-${process.pid}`;
  private readonly concurrency: number;
  private readonly perWorkspace: number;
  private readonly timeouts: Record<string, number>;
  private readonly defaultTimeoutMs: number;
  private readonly recoverEveryMs: number;
  private readonly staleAfterMs: number;

  /** Trabajos que ocupan hueco ahora mismo (los abandonados por el watchdog ya no cuentan). */
  private readonly active = new Map<string, ActiveJob>();
  /** Trabajos en curso por organización. */
  private readonly running = new Map<string, number>();
  /** Turno en el que se sirvió por última vez a cada organización (orden de inserción = antigüedad). */
  private readonly lastServed = new Map<string, number>();
  private serveSeq = 0;
  private abandonedCount = 0;
  /** Las reclamaciones se serializan para que los contadores por organización no se adelanten. */
  private claimChain: Promise<unknown> = Promise.resolve();

  private timer: NodeJS.Timeout | null = null;
  private recoverTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private closing = false;
  private ticking = false;
  private kickPending = false;
  private recovering = false;
  private lastTick = Date.now();

  constructor(
    private db: Db,
    private handlers: Record<string, JobHandler>,
    private log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void },
    private pollMs = 1500,
    opts: JobRunnerOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
    this.perWorkspace = Math.max(1, Math.floor(opts.perWorkspace ?? 2));
    this.timeouts = { ...JOB_TIMEOUTS_MS, ...(opts.timeouts ?? {}) };
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    this.recoverEveryMs = opts.recoverEveryMs ?? 5 * 60_000;
    // Siempre por encima de la duración máxima de cualquier tipo: un trabajo que sigue vivo en otra
    // instancia (con su propio watchdog) nunca se toma por huérfano.
    this.staleAfterMs = opts.staleAfterMs ?? Math.max(this.defaultTimeoutMs, ...Object.values(this.timeouts)) + 5 * 60_000;
  }

  /** Duración máxima de un tipo de trabajo. */
  timeoutFor(type: string): number {
    // Motor de código fuente (code.plan, code.deploy): el agente de IA y las esperas al CI y a los despliegues
    // de Railway necesitan más margen. Cada ejecución es una fase acotada y source_changes lleva su propio
    // lease con latido, así que, aunque otra instancia lo tomara por huérfano, el cambio no se procesa dos veces.
    if (this.timeouts[type] === undefined && type.startsWith('code.')) return 45 * 60_000;
    return this.timeouts[type] ?? this.defaultTimeoutMs;
  }

  /** Latido: última vez que el bucle completó una vuelta (con o sin trabajo que hacer). */
  get lastTickAt(): number {
    return this.lastTick;
  }

  /** Estado para el health check del worker. */
  stats() {
    return {
      lastTickAt: this.lastTick,
      stalledMs: Date.now() - this.lastTick,
      running: this.active.size,
      abandoned: this.abandonedCount,
      looping: !this.stopped,
    };
  }

  /** Reclama (sin ejecutarlo) el siguiente trabajo según el turno rotatorio. Se mantiene por compatibilidad. */
  claim(): Promise<Job | null> {
    return this.serialized(async () => {
      for (const c of await this.candidates()) {
        if ((this.running.get(c.key) ?? 0) >= this.perWorkspace) continue;
        const job = await this.claimById(c.id);
        if (job) return job;
      }
      return null;
    });
  }

  /** Ejecuta un trabajo ya reclamado con su watchdog y registra el resultado (sin ocupar hueco de concurrencia). */
  async process(job: Job): Promise<void> {
    await this.execute(job, new AbortController());
  }

  /**
   * Procesa trabajos hasta que no quede ninguno ejecutable (tests y modo de proceso único) con los mismos
   * límites que el bucle: concurrencia, máximo por organización, turno rotatorio y watchdog. Espera a que
   * terminen (o se abandonen) los que inicia. Devuelve cuántos trabajos ha iniciado (como mucho `max`).
   */
  async drain(max = 100): Promise<number> {
    let started = 0;
    for (;;) {
      if (started < max) started += await this.fill(max - started);
      this.lastTick = Date.now();
      if (!this.active.size) return started;
      await Promise.race([...this.active.values()].map((a) => a.done));
    }
  }

  /**
   * Recupera trabajos 'running' huérfanos (su worker murió o dejó de responder): vuelven a la cola con
   * backoff si les quedan intentos y, si los agotaron, quedan como fallidos (y se registran en
   * error_events). Nunca toca los trabajos que este proceso está ejecutando. Se ejecuta al arrancar y,
   * con el bucle en marcha, cada `recoverEveryMs`.
   */
  async recoverStale(): Promise<number> {
    const msg = t('Recuperado: el worker que lo ejecutaba dejó de responder durante más de {duration}', { duration: fmtDuration(this.staleAfterMs) });
    const r = await this.db.query<{ id: string; workspace_id: string | null; type: string; status: string; attempts: number }>(RECOVER_SQL, [
      this.staleAfterMs / 1000,
      msg,
      [...this.active.keys()],
    ]);
    for (const j of r.rows) {
      const failed = j.status === 'failed';
      this.log.error({ jobId: j.id, type: j.type, attempt: j.attempts }, failed ? 'Trabajo huérfano sin intentos restantes: marcado como fallido' : 'Trabajo huérfano devuelto a la cola');
      if (failed) await this.recordFailure(j, msg);
    }
    return r.rows.length;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.closing = false;
    this.lastTick = Date.now();
    this.timer = setTimeout(() => void this.tick(), 200);
    this.recoverTimer = setInterval(() => void this.periodicRecover(), this.recoverEveryMs);
    this.recoverTimer.unref?.();
  }

  /** Deja de reclamar trabajos y espera (como mucho `graceMs`) a que terminen los que están en curso. */
  async stop(graceMs = 30_000) {
    this.stopped = true;
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.recoverTimer) clearInterval(this.recoverTimer);
    this.timer = null;
    this.recoverTimer = null;
    const deadline = Date.now() + graceMs;
    const until = (p: Promise<unknown>) => {
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([p, new Promise((r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))))]).finally(() => clearTimeout(timer));
    };
    await until(this.claimChain); // una reclamación en curso puede lanzar todavía un trabajo
    while (this.active.size && Date.now() < deadline) await until(Promise.race([...this.active.values()].map((a) => a.done)));
    if (this.active.size) {
      this.log.error({ pending: this.active.size }, 'Apagado con trabajos en curso: se cancelan y se recuperarán más tarde');
      for (const a of this.active.values()) a.controller.abort(new Error(t('El worker se está apagando')));
    }
  }

  // ---------------------------------------------------------------------------------------------

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.claimChain.then(fn);
    this.claimChain = run.catch(() => undefined);
    return run;
  }

  /** Ocupa los huecos libres con trabajos reclamados por turno rotatorio. Devuelve cuántos ha lanzado. */
  private fill(budget = Number.POSITIVE_INFINITY): Promise<number> {
    return this.serialized(async () => {
      let launched = 0;
      const hasRoom = () => !this.closing && launched < budget && this.active.size < this.concurrency;
      while (hasRoom()) {
        let progressed = false;
        for (const c of await this.candidates()) {
          if (!hasRoom()) break;
          if ((this.running.get(c.key) ?? 0) >= this.perWorkspace) continue;
          const job = await this.claimById(c.id);
          if (!job) continue; // lo ha tomado otra instancia o ya no es ejecutable
          this.launch(job);
          launched++;
          progressed = true;
        }
        if (!progressed) break;
      }
      return launched;
    });
  }

  private async candidates(): Promise<Candidate[]> {
    const saturated = [...this.running].filter(([, n]) => n >= this.perWorkspace).map(([k]) => k);
    const r = await this.db.query<{ id: string; workspace_id: string | null; run_at: Date | string; rank: number }>(CANDIDATES_SQL, [saturated, this.perWorkspace, CANDIDATE_LIMIT]);
    const load = (k: string) => this.running.get(k) ?? 0;
    const served = (k: string) => this.lastServed.get(k) ?? 0;
    // Primero el trabajo más antiguo de cada organización; entre ellas, la que menos tiene en curso y,
    // a igualdad, la que lleva más tiempo sin turno (las nunca servidas primero); después, antigüedad.
    return r.rows
      .map((row) => ({ id: row.id, key: wsKey(row.workspace_id), rank: Number(row.rank), runAt: new Date(row.run_at).getTime() }))
      .sort((a, b) => a.rank - b.rank || load(a.key) - load(b.key) || served(a.key) - served(b.key) || a.runAt - b.runAt);
  }

  private async claimById(id: string): Promise<Job | null> {
    const r = await this.db.query<Job>(CLAIM_SQL, [this.workerId, id]);
    return r.rows[0] ?? null;
  }

  private markServed(key: string) {
    this.lastServed.delete(key);
    this.lastServed.set(key, ++this.serveSeq);
    if (this.lastServed.size > LAST_SERVED_MAX) this.lastServed.delete(this.lastServed.keys().next().value!);
  }

  private launch(job: Job) {
    const key = wsKey(job.workspace_id);
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    this.markServed(key);
    const controller = new AbortController();
    const entry: ActiveJob = { job, key, startedAt: Date.now(), controller, done: Promise.resolve() };
    this.active.set(job.id, entry);
    entry.done = this.execute(job, controller)
      .catch((e) => this.log.error({ jobId: job.id, type: job.type, err: errMsg(e) }, 'No se pudo registrar el resultado del trabajo'))
      .finally(() => {
        this.active.delete(job.id);
        const left = (this.running.get(key) ?? 1) - 1;
        if (left > 0) this.running.set(key, left);
        else this.running.delete(key);
        this.kick();
      });
  }

  /** Idioma del trabajo: el de quien lo encoló o, si no consta, el de su organización (cuya región da el formato). */
  private async jobLocale(job: Job): Promise<{ locale: Locale; orgTag: string | null }> {
    let orgTag: string | null = null;
    if (job.workspace_id) {
      try {
        orgTag = (await this.db.query<{ tag: string | null }>(`SELECT settings->>'locale' AS tag FROM workspaces WHERE id = $1`, [job.workspace_id])).rows[0]?.tag ?? null;
      } catch {
        /* sin región: el formato del idioma */
      }
    }
    return { locale: isLocale(job.locale) ? job.locale : localeFromRegion(orgTag), orgTag };
  }

  /**
   * Ejecuta el trabajo en su idioma: el manejador y también el watchdog, cuyos errores se guardan y se muestran
   * (last_error, peticiones de EVOLVE que quedan fallidas).
   */
  private async execute(job: Job, controller: AbortController): Promise<void> {
    const { locale, orgTag } = await this.jobLocale(job);
    return withLocale(locale, () => this.executeInLocale(job, controller), orgTag);
  }

  /** Ejecuta el manejador compitiendo con el watchdog del tipo y registra el resultado. */
  private async executeInLocale(job: Job, controller: AbortController): Promise<void> {
    const fence = job.attempts; // token de esta reclamación (el manejador puede modificar job.attempts)
    const limitMs = this.timeoutFor(job.type);
    const handler = this.handlers[job.type];
    const ctx: JobContext = { signal: controller.signal, deadline: Date.now() + limitMs };
    const work = (async () => {
      if (!handler) throw new Error(t('Sin manejador para el trabajo "{type}"', { type: job.type }));
      await handler(job, ctx);
    })();
    let timer: NodeJS.Timeout | undefined;
    let timeoutErr: JobTimeoutError | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject((timeoutErr = new JobTimeoutError(job.type, limitMs))), limitMs);
    });
    let failure: { err: unknown } | null = null;
    try {
      await Promise.race([work, watchdog]);
    } catch (err) {
      failure = { err };
    } finally {
      clearTimeout(timer);
    }
    if (!failure) return this.complete(job, fence);
    if (timeoutErr && failure.err === timeoutErr) this.abandon(job, work, controller, timeoutErr);
    await this.fail(job, fence, failure.err);
  }

  /** El watchdog renuncia al trabajo: se aborta su señal y su promesa solo se vigila para registrarla. */
  private abandon(job: Job, work: Promise<void>, controller: AbortController, reason: JobTimeoutError) {
    this.abandonedCount++;
    const at = Date.now();
    this.log.error({ jobId: job.id, type: job.type, limitMs: reason.limitMs }, 'Trabajo abandonado por el watchdog: superó su duración máxima');
    controller.abort(reason);
    void work
      .then(
        () => this.log.info({ jobId: job.id, type: job.type, lateMs: Date.now() - at }, 'Un trabajo abandonado terminó tarde: se descarta su resultado'),
        (e) => this.log.info({ jobId: job.id, type: job.type, lateMs: Date.now() - at, err: errMsg(e) }, 'Un trabajo abandonado terminó tarde con error: se descarta'),
      )
      .catch(() => undefined)
      .finally(() => {
        this.abandonedCount--;
      });
  }

  private async complete(job: Job, fence: number) {
    const r = await this.db.query(DONE_SQL, [job.id, fence, this.workerId]);
    if (!r.rowCount) this.log.error({ jobId: job.id, type: job.type }, 'El trabajo terminó cuando ya no estaba asignado a este worker: se descarta el resultado');
  }

  private async fail(job: Job, fence: number, err: unknown) {
    const msg = errMsg(err).slice(0, 2000);
    const final = job.attempts >= job.max_attempts;
    const backoffSec = Math.min(3600, 30 * 2 ** (fence - 1));
    const r = await this.db.query(FAIL_SQL, [final ? 'failed' : 'queued', msg, backoffSec, job.id, fence, this.workerId]);
    if (!r.rowCount) {
      this.log.error({ jobId: job.id, type: job.type, err: msg }, 'El trabajo falló cuando ya no estaba asignado a este worker: se descarta el resultado');
      return;
    }
    this.log.error({ jobId: job.id, type: job.type, attempt: fence, err: msg }, final ? 'Trabajo fallido definitivamente' : 'Trabajo fallido, se reintentará');
    if (final) await this.recordFailure(job, msg);
  }

  private async recordFailure(job: { id: string; workspace_id: string | null; type: string }, msg: string) {
    await this.db.query(`INSERT INTO error_events (id, workspace_id, source, message, context) VALUES ($1,$2,'worker',$3,$4)`, [
      newId(),
      job.workspace_id,
      msg.slice(0, 2000),
      JSON.stringify({ jobId: job.id, type: job.type }),
    ]);
  }

  private async periodicRecover() {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      await this.recoverStale();
    } catch (e) {
      this.log.error({ err: errMsg(e) }, 'Error al recuperar trabajos huérfanos');
    } finally {
      this.recovering = false;
    }
  }

  /** Una vuelta del bucle: ocupa los huecos libres y deja constancia del latido. */
  private async tick() {
    this.timer = null;
    if (this.stopped) return;
    this.ticking = true;
    try {
      await this.fill();
    } catch (e) {
      this.log.error({ err: errMsg(e) }, 'Error en el bucle de trabajos');
    } finally {
      // El latido se actualiza aunque la vuelta falle (p. ej. base de datos caída: lo refleja el health
      // check); solo deja de avanzar si la vuelta se queda colgada.
      this.ticking = false;
      this.lastTick = Date.now();
      if (!this.stopped) {
        const delay = this.kickPending ? 0 : this.pollMs;
        this.kickPending = false;
        this.timer = setTimeout(() => void this.tick(), delay);
      }
    }
  }

  /** Al quedar un hueco libre se adelanta la siguiente vuelta en lugar de esperar a `pollMs`. */
  private kick() {
    if (this.stopped || this.closing) return;
    if (this.ticking) {
      this.kickPending = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
  }
}
