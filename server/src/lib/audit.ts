import type { Queryable } from '../db/db';
import { newId } from './crypto';
import { redact } from './errors';

export interface AuditEntry {
  workspaceId: string | null;
  actorId: string | null;
  actorType?: 'user' | 'api' | 'system' | 'automation' | 'ai';
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(q: Queryable, e: AuditEntry) {
  await q.query(
    `INSERT INTO audit_log (id, workspace_id, actor_id, actor_type, action, target_type, target_id, meta, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      newId(),
      e.workspaceId,
      e.actorId,
      e.actorType ?? 'user',
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      JSON.stringify(redact(e.meta ?? {})),
      e.ip ?? null,
    ],
  );
}
