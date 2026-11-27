import { findModule, type Blueprint } from '../../../shared/blueprint';
import { recordTitle } from '../../../shared/records';
import type { Queryable } from '../db/db';
import { t } from '../i18n';
import type { StoredRecord } from './store';

export interface Refs {
  records: Record<string, { title: string; module: string }>;
  users: Record<string, string>;
  files: Record<string, { name: string; size: number; mime: string }>;
}

/** Resuelve títulos de relaciones, nombres de usuarios y metadatos de archivos para la UI. */
export async function resolveRefs(q: Queryable, workspaceId: string, bp: Blueprint, items: StoredRecord[], canRead: (moduleKey: string) => boolean = () => true): Promise<Refs> {
  const recordIds = new Set<string>();
  const userIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const item of items) {
    const mod = findModule(bp, item.moduleKey);
    if (item.createdBy) userIds.add(item.createdBy);
    if (item.updatedBy) userIds.add(item.updatedBy);
    if (!mod) continue;
    for (const f of mod.fields) {
      const v = item.data[f.key];
      if (v === null || v === undefined) continue;
      if (f.type === 'relation' && typeof v === 'string') recordIds.add(v);
      else if (f.type === 'user' && typeof v === 'string') userIds.add(v);
      else if (f.type === 'file' && Array.isArray(v)) v.forEach((x) => typeof x === 'string' && fileIds.add(x));
    }
  }
  const refs: Refs = { records: {}, users: {}, files: {} };
  if (recordIds.size) {
    const r = await q.query(`SELECT id, module_key, data FROM records WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [workspaceId, [...recordIds]]);
    for (const row of r.rows) {
      const mod = findModule(bp, row.module_key);
      // Sin permiso de lectura sobre el módulo relacionado no se revela el título.
      refs.records[row.id] = { title: !canRead(row.module_key) ? t('Registro restringido') : mod ? recordTitle(mod, row.data) : t('Registro'), module: row.module_key };
    }
  }
  if (userIds.size) {
    const r = await q.query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [[...userIds]]);
    for (const row of r.rows) refs.users[row.id] = row.name;
  }
  if (fileIds.size) {
    const r = await q.query(`SELECT id, name, size, mime FROM files WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [workspaceId, [...fileIds]]);
    for (const row of r.rows) refs.files[row.id] = { name: row.name, size: row.size, mime: row.mime };
  }
  return refs;
}

export function serializeRecord(r: StoredRecord) {
  return {
    id: r.id,
    module: r.moduleKey,
    data: r.data,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastActivityAt: r.lastActivityAt,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
  };
}
