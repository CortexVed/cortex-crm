import type { Queryable } from '../db/db';
import { newId } from '../lib/crypto';

export interface MemoryItem {
  id: string;
  scope: 'org' | 'user';
  kind: string;
  content: string;
  source: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  user_id: string | null;
}

/**
 * Memoria de la IA: decisiones técnicas, preferencias e instrucciones, por organización
 * (y por usuario). Vive en tablas con RLS, así que el contexto de una organización nunca
 * se mezcla con el de otra. Es consultable, editable y auditable.
 */
export async function listMemory(q: Queryable, ws: string, userId: string, opts: { includeUser?: boolean; limit?: number; excludeSources?: string[] } = {}): Promise<MemoryItem[]> {
  const r = await q.query<MemoryItem>(
    `SELECT id, scope, kind, content, source, source_ref, created_at, updated_at, user_id FROM ai_memory
     WHERE workspace_id = $1 AND archived_at IS NULL AND (scope = 'org' OR ($2::boolean AND user_id = $3))
       AND NOT (source = ANY($5::text[]))
     ORDER BY updated_at DESC LIMIT $4`,
    [ws, opts.includeUser ?? true, userId, opts.limit ?? 40, opts.excludeSources ?? []],
  );
  return r.rows;
}

export async function addMemory(q: Queryable, ws: string, item: { scope: 'org' | 'user'; kind: string; content: string; source: string; sourceRef?: string | null; userId?: string | null; createdBy?: string | null }) {
  const id = newId();
  await q.query(
    `INSERT INTO ai_memory (id, workspace_id, scope, user_id, kind, content, source, source_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ws, item.scope, item.scope === 'user' ? item.userId ?? null : null, item.kind, item.content.slice(0, 2000), item.source, item.sourceRef ?? null, item.createdBy ?? null],
  );
  return id;
}
