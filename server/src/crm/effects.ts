import { ROLE_RANK, type Role } from '../../../shared/constants';
import type { Integration } from '../../../shared/blueprint';
import type { Queryable } from '../db/db';
import { newId } from '../lib/crypto';

export interface NotifyRequest {
  userIds?: string[];
  minRole?: Role;
  all?: boolean;
  title: string;
  body?: string;
  link?: string;
  kind?: string;
  /**
   * Rol mínimo para leer el registro del aviso: quien no llega no lo recibe (el texto puede incluir datos
   * del registro y el enlace apunta a él).
   */
  readRole?: Role;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rango mínimo que debe tener un destinatario según el rol pedido y el de lectura del registro. */
function floorRank(n: NotifyRequest): number {
  return Math.max(n.minRole ? ROLE_RANK[n.minRole] : 0, n.readRole ? ROLE_RANK[n.readRole] : 0);
}

export interface AutomationRunInput {
  automationKey: string;
  recordId: string | null;
  trigger: string;
  dedupeKey?: string;
}

/**
 * Efectos secundarios de registros y automatizaciones. En producción se persisten
 * (notificaciones, cola de webhooks, ejecuciones); en el sandbox se capturan en memoria.
 */
export interface SideEffects {
  notify(n: NotifyRequest): Promise<number>;
  webhook(integration: Integration, payload: Record<string, unknown>): Promise<void>;
  /** Reserva una ejecución. Devuelve null si ya existe una con la misma clave de deduplicación. */
  startRun(run: AutomationRunInput): Promise<string | null>;
  finishRun(runId: string, status: 'success' | 'failed' | 'skipped', log: string[]): Promise<void>;
}

export class PgSideEffects implements SideEffects {
  constructor(private q: Queryable, private workspaceId: string) {}

  async notify(n: NotifyRequest): Promise<number> {
    const ids = (n.userIds ?? []).filter((id) => UUID_RE.test(id));
    if (!n.all && !n.minRole && !ids.length) return 0;
    const r =
      n.all || n.minRole
        ? await this.q.query<{ user_id: string; role: Role }>(`SELECT user_id, role FROM memberships WHERE workspace_id = $1`, [this.workspaceId])
        : await this.q.query<{ user_id: string; role: Role }>(`SELECT user_id, role FROM memberships WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])`, [this.workspaceId, ids]);
    const floor = floorRank(n);
    const userIds = r.rows.filter((m) => ROLE_RANK[m.role] >= floor).map((m) => m.user_id);
    for (const uid of new Set(userIds)) {
      await this.q.query(
        `INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newId(), this.workspaceId, uid, n.kind ?? 'automation', n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, n.link ?? null],
      );
    }
    return userIds.length;
  }

  async webhook(integration: Integration, payload: Record<string, unknown>) {
    await this.q.query(
      `INSERT INTO jobs (id, workspace_id, type, payload, max_attempts) VALUES ($1,$2,'webhook.deliver',$3,5)`,
      [newId(), this.workspaceId, JSON.stringify({ integrationKey: integration.key, url: integration.url, payload })],
    );
  }

  async startRun(run: AutomationRunInput): Promise<string | null> {
    const id = newId();
    // Reserva atómica: con varias instancias del worker, solo una ejecuta cada (automatización, registro, periodo).
    const r = await this.q.query(
      `INSERT INTO automation_runs (id, workspace_id, automation_key, record_id, trigger, status, dedupe_key) VALUES ($1,$2,$3,$4,$5,'running',$6)
       ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [id, this.workspaceId, run.automationKey, run.recordId, run.trigger, run.dedupeKey ?? null],
    );
    return r.rowCount ? id : null;
  }

  async finishRun(runId: string, status: 'success' | 'failed' | 'skipped', log: string[]) {
    await this.q.query(`UPDATE automation_runs SET status = $1, log = $2 WHERE id = $3 AND workspace_id = $4`, [
      status,
      JSON.stringify(log.slice(0, 50)),
      runId,
      this.workspaceId,
    ]);
  }
}

export class MemorySideEffects implements SideEffects {
  notifications: (NotifyRequest & { recipients: number })[] = [];
  webhooks: { integration: string; payload: Record<string, unknown> }[] = [];
  runs = new Map<string, AutomationRunInput & { status: string; log: string[] }>();
  private dedupe = new Set<string>();
  constructor(private members: { id: string; role: Role }[] = []) {}

  async notify(n: NotifyRequest) {
    const floor = floorRank(n);
    const pool = n.all || n.minRole ? this.members : this.members.filter((m) => (n.userIds ?? []).includes(m.id));
    const recipients = pool.filter((m) => ROLE_RANK[m.role] >= floor).length;
    this.notifications.push({ ...n, recipients });
    return recipients;
  }
  async webhook(integration: Integration, payload: Record<string, unknown>) {
    this.webhooks.push({ integration: integration.key, payload });
  }
  async startRun(run: AutomationRunInput) {
    if (run.dedupeKey) {
      if (this.dedupe.has(run.dedupeKey)) return null;
      this.dedupe.add(run.dedupeKey);
    }
    const id = newId();
    this.runs.set(id, { ...run, status: 'running', log: [] });
    return id;
  }
  async finishRun(runId: string, status: 'success' | 'failed' | 'skipped', log: string[]) {
    const r = this.runs.get(runId);
    if (r) Object.assign(r, { status, log });
  }
}
