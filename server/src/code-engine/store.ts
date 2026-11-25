import type { Db, Queryable } from '../db/db';
import { newId } from '../lib/crypto';
import { enqueue } from '../lib/jobs';
import type { Flag, GuardStats, Violation } from './guards';
import type { SourceVersion } from './source';
import type { FileChange } from './workspace';

/**
 * Tabla source_changes (plataforma, sin RLS): estado de cada cambio del código fuente. Los trabajos del worker
 * escriben con un lease (token + caducidad renovada por un latido) y solo mientras el cambio sigue en un
 * estado que les corresponde, así que ni dos ejecuciones simultáneas ni una cancelación a mitad pueden
 * pisarse.
 */

export const ACTIVE_STATUSES = ['queued', 'planning', 'testing', 'deploying', 'rolling_back'] as const;
export const PLAN_STATUSES = ['queued', 'planning', 'testing'] as const;
export const DEPLOY_STATUSES = ['deploying', 'rolling_back'] as const;
export const CANCELLABLE = ['queued', 'planning', 'testing', 'ready_for_review', 'needs_input', 'failed'] as const;
export const REFINABLE = ['ready_for_review', 'needs_input', 'failed'] as const;

export type ChangeStatus =
  | (typeof ACTIVE_STATUSES)[number]
  | 'needs_input'
  | 'ready_for_review'
  | 'deployed'
  | 'failed'
  | 'rolled_back'
  | 'cancelled';

export interface ProgressEntry {
  step: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  at: string;
}

export interface CiAttempt {
  n: number;
  deploymentId: string | null;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  railwayStatus?: string;
  startedAt: string;
  finishedAt?: string;
  treeHash: string;
  sourceVersion: SourceVersion;
  files: number;
  bytes: number;
  summary?: string[];
  errors?: string[];
  failedTests?: string[];
  excerpt?: string;
  removed?: boolean;
  note?: string;
}

export interface CiState {
  attempts: CiAttempt[];
  /** Intentos que ya existían al empezar la ronda actual (cada refinado empieza una ronda). */
  roundStart?: number;
  agentRuns?: number;
  transientErrors?: number;
}

export interface ServiceDeployment {
  serviceId: string;
  deploymentId: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DeployState {
  phase?: 'pending' | 'worker_upload' | 'worker_wait' | 'web_upload' | 'web_wait' | 'verify' | 'rollback_verify' | 'done';
  requestedAt?: string;
  requestedBy?: string;
  attempt?: number;
  sourceVersion?: SourceVersion;
  treeHash?: string;
  previous?: { worker?: ServiceDeployment; web?: ServiceDeployment };
  worker?: ServiceDeployment;
  web?: ServiceDeployment;
  workerReadyAt?: string;
  continuedBy?: string;
  verification?: { ok: boolean; checks: { name: string; passed: boolean; detail?: string }[]; at: string };
  rollback?: {
    reason: 'failure' | 'manual';
    requestedAt: string;
    by?: string;
    message?: string;
    services: { service: 'worker' | 'web'; deploymentId: string; ok: boolean; error?: string }[];
    verified?: boolean;
    detail?: string;
  };
  transientErrors?: number;
}

export interface Approval {
  userId: string;
  name: string;
  at: string;
  comment?: string;
  confirmation: string;
  attempt: number;
  treeHash: string;
}

export interface ConversationEntry {
  role: 'request' | 'feedback';
  content: string;
  by: string | null;
  byName?: string;
  at: string;
}

export interface LlmEntry {
  phase: string;
  provider: string;
  model: string;
  costUsd: number | null;
  steps?: number;
  at: string;
}

export interface ReviewResult {
  status: 'done' | 'skipped' | 'error';
  verdict?: 'approve' | 'concerns' | 'reject';
  summary?: string;
  concerns?: { severity: 'low' | 'medium' | 'high' | 'critical'; file?: string; message: string }[];
  provider?: string;
  model?: string;
  sameProvider?: boolean;
  truncated?: boolean;
  message?: string;
  at: string;
}

export interface SourceChange {
  id: string;
  ai_workspace_id: string | null;
  requested_by: string | null;
  origin: { type: 'evolve'; workspaceId: string; workspaceName?: string; requestId: string } | null;
  prompt: string;
  title: string | null;
  summary: string | null;
  status: ChangeStatus;
  base_version: string | null;
  base_tree_hash: string | null;
  patch: { files: FileChange[]; testsAdded?: string[] };
  stats: Partial<GuardStats>;
  guards: { ok: boolean; violations: Violation[]; at: string } | null;
  flags: Flag[];
  problems: string[];
  ci: CiState;
  review: ReviewResult | null;
  risk: string;
  approvals: Approval[];
  deploy: DeployState;
  conversation: ConversationEntry[];
  progress: ProgressEntry[];
  llm: LlmEntry[];
  lease_token: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  deployed_at: string | null;
  rolled_back_at: string | null;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export function hydrate(row: Record<string, any>): SourceChange {
  return {
    ...(row as SourceChange),
    patch: row.patch && Array.isArray(row.patch.files) ? row.patch : { files: [] },
    stats: row.stats ?? {},
    flags: Array.isArray(row.flags) ? row.flags : [],
    problems: Array.isArray(row.problems) ? row.problems : [],
    ci: row.ci && Array.isArray(row.ci.attempts) ? row.ci : { attempts: [] },
    approvals: Array.isArray(row.approvals) ? row.approvals : [],
    deploy: row.deploy ?? {},
    conversation: Array.isArray(row.conversation) ? row.conversation : [],
    progress: Array.isArray(row.progress) ? row.progress : [],
    llm: Array.isArray(row.llm) ? row.llm : [],
    lease_until: iso(row.lease_until),
    heartbeat_at: iso(row.heartbeat_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    deployed_at: iso(row.deployed_at),
    rolled_back_at: iso(row.rolled_back_at),
  };
}

export async function getChange(q: Queryable, id: string): Promise<SourceChange | null> {
  const r = await q.query(`SELECT * FROM source_changes WHERE id = $1`, [id]);
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

const JSON_COLUMNS = new Set(['patch', 'stats', 'guards', 'flags', 'problems', 'ci', 'review', 'approvals', 'deploy', 'conversation', 'llm', 'origin']);
const WRITABLE = new Set(['title', 'summary', 'status', 'base_version', 'base_tree_hash', 'error', 'risk', 'deployed_at', 'rolled_back_at', ...JSON_COLUMNS]);

/** Construye `SET …` parametrizado (solo columnas conocidas). */
export function setClause(fields: Record<string, unknown>, params: unknown[]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!WRITABLE.has(k)) throw new Error(`Columna no permitida: ${k}`);
    params.push(JSON_COLUMNS.has(k) && v !== null && v !== undefined ? JSON.stringify(v) : (v ?? null));
    parts.push(`${k} = $${params.length}`);
  }
  return parts.join(', ');
}

/** El cambio ya no pertenece a esta ejecución (cancelado, cambiado de estado o lease perdido). */
export class ChangeStopped extends Error {
  constructor(message = 'El cambio ya no está en un estado que procese este trabajo') {
    super(message);
    this.name = 'ChangeStopped';
  }
}

export const progressEntry = (step: string, status: ProgressEntry['status'], detail?: string, now = new Date()): ProgressEntry => ({
  step,
  status,
  ...(detail ? { detail: detail.slice(0, 1000) } : {}),
  at: now.toISOString(),
});

export class ChangeLease {
  private timer: NodeJS.Timeout | null = null;
  private readonly controller = new AbortController();
  lost = false;

  private constructor(
    private readonly db: Db,
    readonly token: string,
    readonly expect: readonly string[],
    private readonly ttlMs: number,
    public change: SourceChange,
  ) {}

  /** Toma el cambio si nadie más lo está procesando y sigue en uno de los estados `expect`. */
  static async acquire(db: Db, id: string, expect: readonly string[], ttlMs: number): Promise<ChangeLease | null> {
    const token = newId();
    const r = await db.query(
      `UPDATE source_changes SET lease_token = $1, lease_until = now() + make_interval(secs => $2), heartbeat_at = now()
       WHERE id = $3 AND status = ANY($4::text[]) AND (lease_until IS NULL OR lease_until < now()) RETURNING *`,
      [token, ttlMs / 1000, id, [...expect]],
    );
    return r.rows[0] ? new ChangeLease(db, token, expect, ttlMs, hydrate(r.rows[0])) : null;
  }

  /** Se aborta si se pierde el lease o el cambio sale de los estados esperados (p. ej. se cancela). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get id(): string {
    return this.change.id;
  }

  startHeartbeat(everyMs: number, onBeat?: () => Promise<void>) {
    this.timer = setInterval(() => {
      void this.beat(onBeat);
    }, everyMs);
    this.timer.unref?.();
  }

  private async beat(onBeat?: () => Promise<void>) {
    if (this.lost) return;
    try {
      const r = await this.db.query(
        `UPDATE source_changes SET lease_until = now() + make_interval(secs => $1), heartbeat_at = now()
         WHERE id = $2 AND lease_token = $3 AND status = ANY($4::text[]) RETURNING id`,
        [this.ttlMs / 1000, this.id, this.token, [...this.expect]],
      );
      if (!r.rowCount) this.markLost();
      else await onBeat?.();
    } catch {
      /* un latido fallido no detiene el trabajo: el siguiente lo reintenta */
    }
  }

  private markLost() {
    this.lost = true;
    this.controller.abort(new ChangeStopped());
  }

  /** Escribe campos y progreso con el lease. Lanza ChangeStopped si el cambio ya no es de esta ejecución. */
  async save(fields: Record<string, unknown>, progress: ProgressEntry[] = [], expect: readonly string[] = this.expect): Promise<void> {
    if (this.lost) throw new ChangeStopped();
    const params: unknown[] = [];
    const set = setClause(fields, params);
    params.push(JSON.stringify(progress));
    const progressParam = params.length;
    params.push(this.id, this.token, [...expect]);
    const r = await this.db.query(
      `UPDATE source_changes SET ${set ? `${set}, ` : ''}progress = progress || $${progressParam}::jsonb, updated_at = now(), heartbeat_at = now()
       WHERE id = $${params.length - 2} AND lease_token = $${params.length - 1} AND status = ANY($${params.length}::text[]) RETURNING *`,
      params,
    );
    if (!r.rows[0]) {
      this.markLost();
      throw new ChangeStopped();
    }
    this.change = hydrate(r.rows[0]);
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.db.query(`UPDATE source_changes SET lease_token = NULL, lease_until = NULL WHERE id = $1 AND lease_token = $2`, [this.id, this.token]).catch(() => undefined);
  }
}

/** Encola la siguiente ejecución de un trabajo del motor (los trabajos de plataforma no tienen organización). */
export async function enqueueCodeJob(q: Queryable, type: 'code.plan' | 'code.deploy', changeId: string, delayMs = 0, dedupeKey?: string): Promise<void> {
  await enqueue(q, {
    type,
    workspaceId: null,
    payload: { changeId },
    runAt: new Date(Date.now() + Math.max(0, delayMs)),
    maxAttempts: 1,
    ...(dedupeKey ? { dedupeKey } : {}),
  });
}

export const jobTypeFor = (status: string): 'code.plan' | 'code.deploy' | null =>
  (PLAN_STATUSES as readonly string[]).includes(status) ? 'code.plan' : (DEPLOY_STATUSES as readonly string[]).includes(status) ? 'code.deploy' : null;

/**
 * Si un cambio en curso se ha quedado sin nadie que lo procese (el proceso que lo llevaba murió, p. ej. al
 * sustituir Railway el worker durante un despliegue), lo vuelve a encolar. Lo llaman las rutas de consulta.
 */
export async function nudgeIfStalled(db: Db, change: Pick<SourceChange, 'id' | 'status' | 'lease_until' | 'heartbeat_at'>, now = Date.now()): Promise<boolean> {
  const type = jobTypeFor(change.status);
  if (!type) return false;
  if (change.lease_until && new Date(change.lease_until).getTime() > now) return false;
  if (change.heartbeat_at && now - new Date(change.heartbeat_at).getTime() < 90_000) return false;
  const queued = await db.query(`SELECT 1 FROM jobs WHERE type IN ('code.plan', 'code.deploy') AND status = 'queued' AND payload->>'changeId' = $1 LIMIT 1`, [change.id]);
  if (queued.rows.length) return false;
  await enqueueCodeJob(db, type, change.id, 0, `code:${change.id}:nudge:${Math.floor(now / 60_000)}`);
  return true;
}
