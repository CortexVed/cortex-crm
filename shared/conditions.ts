import type { Condition } from './blueprint';
import { resolveTemplate, type TemplateContext } from './templates';

/** Vista mínima de un registro para evaluar condiciones (producción y sandbox). */
export interface RecordLike {
  id: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  createdBy?: string | null;
}

export function getFieldValue(rec: RecordLike, field: string): unknown {
  switch (field) {
    case 'id':
      return rec.id;
    case 'created_at':
      return rec.createdAt;
    case 'updated_at':
      return rec.updatedAt;
    case 'last_activity_at':
      return rec.lastActivityAt;
    case 'created_by':
      return rec.createdBy;
    default:
      return rec.data[field];
  }
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function toComparable(a: unknown, b: unknown): [unknown, unknown] {
  const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a)) ? Number(a) : null;
  const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b)) ? Number(b) : null;
  if (na !== null && nb !== null && (typeof a === 'number' || typeof b === 'number')) return [na, nb];
  if (typeof a === 'string' && typeof b === 'string') {
    // Fecha vs fecha-hora: comparar por día.
    const isDateA = /^\d{4}-\d{2}-\d{2}$/.test(a);
    const isDateB = /^\d{4}-\d{2}-\d{2}$/.test(b);
    if (isDateA !== isDateB && /^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b)) {
      return [a.slice(0, 10), b.slice(0, 10)];
    }
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const ba = a === true || a === 'true' ? true : a === false || a === 'false' ? false : a;
    const bb = b === true || b === 'true' ? true : b === false || b === 'false' ? false : b;
    return [ba, bb];
  }
  return [a, b];
}

function equals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) {
    if (Array.isArray(b)) return a.length === b.length && a.every((x) => b.includes(x));
    return a.includes(b);
  }
  const [x, y] = toComparable(a, b);
  if (typeof x === 'string' && typeof y === 'string') return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

function order(a: unknown, b: unknown): number | null {
  if (isEmptyValue(a) || isEmptyValue(b)) return null;
  const [x, y] = toComparable(a, b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : x > y ? 1 : 0;
  return null;
}

export function evaluateCondition(
  cond: Condition,
  rec: RecordLike,
  ctx: TemplateContext & { previous?: Record<string, unknown> | null },
): boolean {
  const actual = getFieldValue(rec, cond.field);
  const expected = resolveTemplate(cond.value, { ...ctx, record: { id: rec.id, data: rec.data } });
  switch (cond.operator) {
    case 'eq':
      return equals(actual, expected);
    case 'neq':
      return !equals(actual, expected);
    case 'gt': {
      const o = order(actual, expected);
      return o !== null && o > 0;
    }
    case 'gte': {
      const o = order(actual, expected);
      return o !== null && o >= 0;
    }
    case 'lt': {
      const o = order(actual, expected);
      return o !== null && o < 0;
    }
    case 'lte': {
      const o = order(actual, expected);
      return o !== null && o <= 0;
    }
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(expected as never);
      return typeof actual === 'string' && typeof expected === 'string' && actual.toLowerCase().includes(expected.toLowerCase());
    case 'not_contains':
      if (Array.isArray(actual)) return !actual.includes(expected as never);
      return !(typeof actual === 'string' && typeof expected === 'string' && actual.toLowerCase().includes(expected.toLowerCase()));
    case 'is_empty':
      return isEmptyValue(actual);
    case 'is_not_empty':
      return !isEmptyValue(actual);
    case 'in':
      return Array.isArray(expected) && expected.some((e) => equals(actual, e));
    case 'changed': {
      if (!ctx.previous) return false;
      const prev = ctx.previous[cond.field];
      return JSON.stringify(prev ?? null) !== JSON.stringify(actual ?? null);
    }
    default:
      return false;
  }
}

export function evaluateConditions(
  conds: Condition[],
  rec: RecordLike,
  ctx: TemplateContext & { previous?: Record<string, unknown> | null },
): boolean {
  return conds.every((c) => evaluateCondition(c, rec, ctx));
}
