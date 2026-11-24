import type { Condition, Module } from '../../../shared/blueprint';
import { evaluateConditions, getFieldValue, isEmptyValue } from '../../../shared/conditions';
import { resolveTemplate } from '../../../shared/templates';
import type { Queryable } from '../db/db';
import { newId } from '../lib/crypto';

export interface StoredRecord {
  id: string;
  moduleKey: string;
  data: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface ListQuery {
  search?: string;
  filters?: Condition[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit: number;
  offset: number;
  ids?: string[];
}

export interface HistoryEntry {
  recordId: string;
  moduleKey: string;
  action: string;
  changes: Record<string, unknown>;
  actorId: string | null;
  actorType: string;
}

export interface RecordStore {
  insert(r: StoredRecord): Promise<void>;
  update(id: string, data: Record<string, unknown>, by: string | null, at: string): Promise<void>;
  touch(ids: string[], at: string): Promise<void>;
  softDelete(id: string, by: string | null, at: string): Promise<void>;
  get(id: string): Promise<StoredRecord | null>;
  list(mod: Module, q: ListQuery, ctx: { now: Date; tz: string }): Promise<{ items: StoredRecord[]; total: number }>;
  existsInModule(moduleKey: string, id: string): Promise<boolean>;
  isUnique(moduleKey: string, field: string, value: unknown, excludeId?: string): Promise<boolean>;
  aggregateRelated(moduleKey: string, relationField: string, targetId: string, op: 'count' | 'sum' | 'avg', valueField?: string): Promise<number>;
  findReferencing(moduleKey: string, relationField: string, targetId: string): Promise<string[]>;
  addHistory(h: HistoryEntry): Promise<void>;
  isMember(userId: string): Promise<boolean>;
  filesExist(ids: string[], ctx?: FileUseContext): Promise<boolean>;
  linkFiles(ids: string[], link: { recordId: string; moduleKey: string; fieldKey: string; actorId: string | null }): Promise<void>;
}

export const SEARCHABLE_TYPES = new Set(['text', 'long_text', 'email', 'phone', 'url']);
const NUMERIC_TYPES = new Set(['number', 'currency', 'percent', 'rating']);
const ARRAY_TYPES = new Set(['multi_select', 'file']);
const SYSTEM_COLUMNS: Record<string, string> = {
  id: 'id::text',
  created_at: 'created_at',
  updated_at: 'updated_at',
  last_activity_at: 'last_activity_at',
  created_by: 'created_by::text',
};

function rowToRecord(r: any): StoredRecord {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: r.id,
    moduleKey: r.module_key,
    data: r.data ?? {},
    createdBy: r.created_by ?? null,
    updatedBy: r.updated_by ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    lastActivityAt: iso(r.last_activity_at),
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Traduce condiciones del blueprint a SQL parametrizado sobre JSONB (sin interpolar valores). */
export function conditionsToSql(mod: Module, conds: Condition[], params: unknown[], ctx: { now: Date; tz: string }): string[] {
  const out: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  for (const c of conds) {
    if (c.operator === 'changed') continue;
    const value = resolveTemplate(c.value, { now: ctx.now, tz: ctx.tz });
    // Object.hasOwn: una clave como "constructor" no debe resolverse contra Object.prototype.
    const sys = Object.hasOwn(SYSTEM_COLUMNS, c.field) ? SYSTEM_COLUMNS[c.field] : undefined;
    const field = mod.fields.find((f) => f.key === c.field);
    if (!sys && !field) {
      out.push('false');
      continue;
    }
    const isDateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (sys) {
      const isTs = ['created_at', 'updated_at', 'last_activity_at'].includes(c.field);
      // Un valor que no es una fecha válida no coincide con nada (en vez de provocar un error de SQL).
      if (isTs && !isDateOnly && ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(c.operator) && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        out.push('false');
        continue;
      }
      const col = isTs && isDateOnly ? `to_char(${sys} AT TIME ZONE 'UTC', 'YYYY-MM-DD')` : isTs ? sys : sys;
      const cast = isTs && !isDateOnly ? '::timestamptz' : '';
      switch (c.operator) {
        case 'eq': out.push(`${col} = ${p(value)}${cast}`); break;
        case 'neq': out.push(`${col} <> ${p(value)}${cast}`); break;
        case 'gt': out.push(`${col} > ${p(value)}${cast}`); break;
        case 'gte': out.push(`${col} >= ${p(value)}${cast}`); break;
        case 'lt': out.push(`${col} < ${p(value)}${cast}`); break;
        case 'lte': out.push(`${col} <= ${p(value)}${cast}`); break;
        case 'is_empty': out.push(`${sys} IS NULL`); break;
        case 'is_not_empty': out.push(`${sys} IS NOT NULL`); break;
        case 'in': out.push(Array.isArray(value) ? `${sys}::text = ANY(${p(value.map(String))}::text[])` : 'false'); break;
        default: out.push('true');
      }
      continue;
    }
    const k = p(c.field);
    const type = field!.type === 'formula' ? (field!.formula?.resultType === 'number' ? 'number' : 'text') : field!.type;
    if (NUMERIC_TYPES.has(type)) {
      const num = `(CASE WHEN jsonb_typeof(data->${k}) = 'number' THEN (data->>${k})::numeric END)`;
      const n = (v: unknown) => `${p(Number(v))}::numeric`;
      switch (c.operator) {
        case 'eq': out.push(`${num} = ${n(value)}`); break;
        case 'neq': out.push(`(${num} IS NULL OR ${num} <> ${n(value)})`); break;
        case 'gt': out.push(`${num} > ${n(value)}`); break;
        case 'gte': out.push(`${num} >= ${n(value)}`); break;
        case 'lt': out.push(`${num} < ${n(value)}`); break;
        case 'lte': out.push(`${num} <= ${n(value)}`); break;
        case 'is_empty': out.push(`${num} IS NULL`); break;
        case 'is_not_empty': out.push(`${num} IS NOT NULL`); break;
        case 'in': out.push(Array.isArray(value) ? `${num} = ANY(${p(value.map(Number))}::numeric[])` : 'false'); break;
        default: out.push('true');
      }
    } else if (ARRAY_TYPES.has(type)) {
      const arr = `data->${k}`;
      const empty = `(${arr} IS NULL OR ${arr} = 'null'::jsonb OR ${arr} = '[]'::jsonb)`;
      switch (c.operator) {
        case 'eq':
        case 'contains': out.push(`COALESCE(${arr} @> ${p(JSON.stringify([value]))}::jsonb, false)`); break;
        case 'neq':
        case 'not_contains': out.push(`NOT COALESCE(${arr} @> ${p(JSON.stringify([value]))}::jsonb, false)`); break;
        case 'is_empty': out.push(empty); break;
        case 'is_not_empty': out.push(`NOT ${empty}`); break;
        case 'in': out.push(Array.isArray(value) ? `COALESCE(${arr} ?| ${p(value.map(String))}::text[], false)` : 'false'); break;
        default: out.push('true');
      }
    } else if (type === 'boolean') {
      const b = `data->${k}`;
      const truthy = value === true || value === 'true';
      switch (c.operator) {
        case 'eq': out.push(truthy ? `${b} = 'true'::jsonb` : `(${b} IS NULL OR ${b} <> 'true'::jsonb)`); break;
        case 'neq': out.push(truthy ? `(${b} IS NULL OR ${b} <> 'true'::jsonb)` : `${b} = 'true'::jsonb`); break;
        case 'is_empty': out.push(`(${b} IS NULL OR ${b} = 'null'::jsonb)`); break;
        case 'is_not_empty': out.push(`(${b} IS NOT NULL AND ${b} <> 'null'::jsonb)`); break;
        default: out.push('true');
      }
    } else {
      const raw = `(data->>${k})`;
      const col = type === 'datetime' && isDateOnly ? `left(${raw}, 10)` : raw;
      const s = (v: unknown) => p(v === null || v === undefined ? '' : String(v));
      switch (c.operator) {
        case 'eq': out.push(`lower(${col}) = lower(${s(value)})`); break;
        case 'neq': out.push(`(${col} IS NULL OR lower(${col}) <> lower(${s(value)}))`); break;
        case 'gt': out.push(`${col} > ${s(value)}`); break;
        case 'gte': out.push(`${col} >= ${s(value)}`); break;
        case 'lt': out.push(`${col} < ${s(value)}`); break;
        case 'lte': out.push(`${col} <= ${s(value)}`); break;
        case 'contains': out.push(`${col} ILIKE ${p('%' + escapeLike(String(value ?? '')) + '%')}`); break;
        case 'not_contains': out.push(`(${col} IS NULL OR ${col} NOT ILIKE ${p('%' + escapeLike(String(value ?? '')) + '%')})`); break;
        case 'is_empty': out.push(`(${col} IS NULL OR ${col} = '')`); break;
        case 'is_not_empty': out.push(`(${col} IS NOT NULL AND ${col} <> '')`); break;
        case 'in': out.push(Array.isArray(value) ? `${col} = ANY(${p(value.map(String))}::text[])` : 'false'); break;
        default: out.push('true');
      }
    }
  }
  return out;
}

export function sortToSql(mod: Module, sort: ListQuery['sort'], params: unknown[]): string {
  const dir = sort?.direction === 'asc' ? 'ASC' : 'DESC';
  if (!sort) return 'created_at DESC, id';
  if (Object.hasOwn(SYSTEM_COLUMNS, sort.field)) return `${SYSTEM_COLUMNS[sort.field]} ${dir} NULLS LAST, id`;
  const field = mod.fields.find((f) => f.key === sort.field);
  if (!field) return 'created_at DESC, id';
  params.push(sort.field);
  const k = `$${params.length}`;
  const numeric = NUMERIC_TYPES.has(field.type) || (field.type === 'formula' && field.formula?.resultType === 'number');
  const expr = numeric ? `(CASE WHEN jsonb_typeof(data->${k}) = 'number' THEN (data->>${k})::numeric END)` : `lower(data->>${k})`;
  return `${expr} ${dir} NULLS LAST, created_at DESC, id`;
}

/** Almacén de producción: PostgreSQL (contexto de organización con RLS). */
export class PgRecordStore implements RecordStore {
  constructor(private q: Queryable, private workspaceId: string) {}

  async insert(r: StoredRecord) {
    await this.q.query(
      `INSERT INTO records (id, workspace_id, module_key, data, created_by, updated_by, created_at, updated_at, last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7)`,
      [r.id, this.workspaceId, r.moduleKey, JSON.stringify(r.data), r.createdBy, r.updatedBy, r.createdAt],
    );
  }
  async update(id: string, data: Record<string, unknown>, by: string | null, at: string) {
    await this.q.query(
      `UPDATE records SET data = $1, updated_by = $2, updated_at = $3, last_activity_at = $3 WHERE id = $4 AND workspace_id = $5`,
      [JSON.stringify(data), by, at, id, this.workspaceId],
    );
  }
  async touch(ids: string[], at: string) {
    if (!ids.length) return;
    await this.q.query(`UPDATE records SET last_activity_at = $1 WHERE id = ANY($2::uuid[]) AND workspace_id = $3 AND deleted_at IS NULL`, [at, ids, this.workspaceId]);
  }
  async softDelete(id: string, by: string | null, at: string) {
    await this.q.query(`UPDATE records SET deleted_at = $1, deleted_by = $2 WHERE id = $3 AND workspace_id = $4`, [at, by, id, this.workspaceId]);
  }
  async get(id: string) {
    const r = await this.q.query(`SELECT * FROM records WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [id, this.workspaceId]);
    return r.rows[0] ? rowToRecord(r.rows[0]) : null;
  }
  async list(mod: Module, q: ListQuery, ctx: { now: Date; tz: string }) {
    const params: unknown[] = [this.workspaceId, mod.key];
    const where = ['workspace_id = $1', 'module_key = $2', 'deleted_at IS NULL'];
    if (q.ids) {
      params.push(q.ids);
      where.push(`id = ANY($${params.length}::uuid[])`);
    }
    if (q.search && q.search.trim()) {
      const fields = mod.fields.filter((f) => !f.archived && SEARCHABLE_TYPES.has(f.type));
      if (fields.length) {
        params.push('%' + escapeLike(q.search.trim()) + '%');
        const term = `$${params.length}`;
        const ors = fields.map((f) => {
          params.push(f.key);
          return `data->>$${params.length} ILIKE ${term}`;
        });
        where.push(`(${ors.join(' OR ')})`);
      }
    }
    where.push(...conditionsToSql(mod, q.filters ?? [], params, ctx));
    const whereSql = where.join(' AND ');
    const countParams = [...params];
    const order = sortToSql(mod, q.sort, params);
    params.push(Math.min(Math.max(q.limit, 1), 1000), Math.max(q.offset, 0));
    const rows = await this.q.query(
      `SELECT * FROM records WHERE ${whereSql} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = await this.q.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE ${whereSql}`, countParams);
    return { items: rows.rows.map(rowToRecord), total: total.rows[0]?.n ?? 0 };
  }
  async existsInModule(moduleKey: string, id: string) {
    const r = await this.q.query(`SELECT 1 FROM records WHERE id = $1 AND workspace_id = $2 AND module_key = $3 AND deleted_at IS NULL`, [id, this.workspaceId, moduleKey]);
    return r.rows.length > 0;
  }
  async isUnique(moduleKey: string, field: string, value: unknown, excludeId?: string) {
    const r = await this.q.query(
      `SELECT 1 FROM records WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL AND lower(data->>$3) = lower($4) AND ($5::uuid IS NULL OR id <> $5::uuid) LIMIT 1`,
      [this.workspaceId, moduleKey, field, String(value), excludeId ?? null],
    );
    return r.rows.length === 0;
  }
  async aggregateRelated(moduleKey: string, relationField: string, targetId: string, op: 'count' | 'sum' | 'avg', valueField?: string) {
    const agg =
      op === 'count'
        ? 'count(*)'
        : `${op}(CASE WHEN jsonb_typeof(data->$5) = 'number' THEN (data->>$5)::numeric END)`;
    const params: unknown[] = [this.workspaceId, moduleKey, relationField, targetId];
    if (op !== 'count') params.push(valueField ?? '');
    const r = await this.q.query<{ v: string | number | null }>(
      `SELECT COALESCE(${agg}, 0)::float8 AS v FROM records WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL AND data->>$3 = $4`,
      params,
    );
    return Number(r.rows[0]?.v ?? 0);
  }
  async findReferencing(moduleKey: string, relationField: string, targetId: string) {
    const r = await this.q.query<{ id: string }>(
      `SELECT id FROM records WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL AND data->>$3 = $4 LIMIT 500`,
      [this.workspaceId, moduleKey, relationField, targetId],
    );
    return r.rows.map((x) => x.id);
  }
  async addHistory(h: HistoryEntry) {
    await this.q.query(
      `INSERT INTO record_history (id, workspace_id, record_id, module_key, action, changes, actor_id, actor_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), this.workspaceId, h.recordId, h.moduleKey, h.action, JSON.stringify(h.changes), h.actorId, h.actorType],
    );
  }
  async isMember(userId: string) {
    const r = await this.q.query(`SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [this.workspaceId, userId]);
    return r.rows.length > 0;
  }
  async filesExist(ids: string[], ctx: FileUseContext = {}) {
    if (!ids.length) return true;
    // Un archivo se puede usar si ya pertenece a ESTE registro o si aún no está vinculado y lo subió quien
    // guarda (las automatizaciones y el sistema no tienen autor). Así nadie "adopta" archivos ajenos.
    const r = await this.q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM files
        WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
          AND ((record_id IS NOT NULL AND record_id = $3::uuid) OR (record_id IS NULL AND ($4::uuid IS NULL OR uploaded_by = $4::uuid)))`,
      [this.workspaceId, ids, ctx.recordId ?? null, ctx.actorId ?? null],
    );
    return (r.rows[0]?.n ?? 0) === new Set(ids).size;
  }
  async linkFiles(ids: string[], link: { recordId: string; moduleKey: string; fieldKey: string; actorId: string | null }) {
    if (!ids.length) return;
    await this.q.query(
      `UPDATE files SET record_id = $3, module_key = $4, field_key = $5
        WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND record_id IS NULL AND ($6::uuid IS NULL OR uploaded_by = $6::uuid)`,
      [this.workspaceId, ids, link.recordId, link.moduleKey, link.fieldKey, link.actorId],
    );
  }
}

export interface FileUseContext {
  recordId?: string;
  actorId?: string | null;
}

/** Almacén en memoria: entorno aislado (sandbox) del motor evolutivo. Nunca toca producción. */
export class MemoryRecordStore implements RecordStore {
  records = new Map<string, StoredRecord & { deleted?: boolean }>();
  history: HistoryEntry[] = [];
  constructor(private members: string[] = [], private fileIds: string[] = []) {}

  async insert(r: StoredRecord) {
    this.records.set(r.id, structuredClone(r));
  }
  async update(id: string, data: Record<string, unknown>, by: string | null, at: string) {
    const r = this.records.get(id);
    if (r) Object.assign(r, { data: structuredClone(data), updatedBy: by, updatedAt: at, lastActivityAt: at });
  }
  async touch(ids: string[], at: string) {
    for (const id of ids) {
      const r = this.records.get(id);
      if (r && !r.deleted) r.lastActivityAt = at;
    }
  }
  async softDelete(id: string) {
    const r = this.records.get(id);
    if (r) r.deleted = true;
  }
  async get(id: string) {
    const r = this.records.get(id);
    return r && !r.deleted ? structuredClone(r) : null;
  }
  private alive(moduleKey: string) {
    return [...this.records.values()].filter((r) => !r.deleted && r.moduleKey === moduleKey);
  }
  async list(mod: Module, q: ListQuery, ctx: { now: Date; tz: string }) {
    let items = this.alive(mod.key);
    if (q.ids) items = items.filter((r) => q.ids!.includes(r.id));
    if (q.search?.trim()) {
      const term = q.search.trim().toLowerCase();
      const keys = mod.fields.filter((f) => !f.archived && SEARCHABLE_TYPES.has(f.type)).map((f) => f.key);
      items = items.filter((r) => keys.some((k) => String(r.data[k] ?? '').toLowerCase().includes(term)));
    }
    if (q.filters?.length) items = items.filter((r) => evaluateConditions(q.filters!, r, { now: ctx.now, tz: ctx.tz }));
    if (q.sort) {
      const { field, direction } = q.sort;
      const mult = direction === 'asc' ? 1 : -1;
      items.sort((a, b) => {
        const va = getFieldValue(a, field);
        const vb = getFieldValue(b, field);
        if (isEmptyValue(va) && isEmptyValue(vb)) return 0;
        if (isEmptyValue(va)) return 1;
        if (isEmptyValue(vb)) return -1;
        return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * mult;
      });
    } else items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: items.slice(q.offset, q.offset + q.limit).map((r) => structuredClone(r)), total: items.length };
  }
  async existsInModule(moduleKey: string, id: string) {
    const r = this.records.get(id);
    return !!r && !r.deleted && r.moduleKey === moduleKey;
  }
  async isUnique(moduleKey: string, field: string, value: unknown, excludeId?: string) {
    return !this.alive(moduleKey).some((r) => r.id !== excludeId && String(r.data[field] ?? '').toLowerCase() === String(value).toLowerCase());
  }
  async aggregateRelated(moduleKey: string, relationField: string, targetId: string, op: 'count' | 'sum' | 'avg', valueField?: string) {
    const rel = this.alive(moduleKey).filter((r) => r.data[relationField] === targetId);
    if (op === 'count') return rel.length;
    const nums = rel.map((r) => r.data[valueField ?? '']).filter((v): v is number => typeof v === 'number');
    if (!nums.length) return 0;
    const sum = nums.reduce((a, b) => a + b, 0);
    return op === 'sum' ? sum : sum / nums.length;
  }
  async findReferencing(moduleKey: string, relationField: string, targetId: string) {
    return this.alive(moduleKey).filter((r) => r.data[relationField] === targetId).map((r) => r.id);
  }
  async addHistory(h: HistoryEntry) {
    this.history.push(h);
  }
  async isMember(userId: string) {
    return this.members.includes(userId);
  }
  async filesExist(ids: string[]) {
    return ids.every((id) => this.fileIds.includes(id));
  }
  async linkFiles() {
    /* en el sandbox no hay archivos reales que vincular */
  }
}
