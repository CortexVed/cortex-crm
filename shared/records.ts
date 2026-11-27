import type { Field, Module } from './blueprint';
import { resolveTemplate } from './templates';
import { t, tp } from './i18n';

export interface FieldIssue {
  field: string;
  message: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()\-.]{6,25}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

type Norm = { ok: true; value: unknown } | { ok: false; message: string };
const ok = (value: unknown): Norm => ({ ok: true, value });
const fail = (message: string): Norm => ({ ok: false, message });

function matchOption(field: Field, raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  const opts = field.options ?? [];
  const byValue = opts.find((o) => o.value === s);
  if (byValue) return byValue.value;
  const byLabel = opts.find((o) => o.label.toLowerCase() === s.toLowerCase() || o.value === s.toLowerCase());
  return byLabel ? byLabel.value : null;
}

export function normalizeValue(field: Field, raw: unknown): Norm {
  if (raw === undefined || raw === null || (raw === '' && field.type !== 'boolean')) return ok(null);
  switch (field.type) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail(t('Debe ser texto'));
      const s = String(raw).trim();
      return s.length > 2000 ? fail(t('Máximo 2000 caracteres')) : ok(s === '' ? null : s);
    }
    case 'long_text': {
      if (typeof raw !== 'string') return fail(t('Debe ser texto'));
      return raw.length > 50_000 ? fail(t('Máximo 50.000 caracteres')) : ok(raw);
    }
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(',', '.').trim()) : NaN;
      if (!Number.isFinite(n)) return fail(t('Debe ser un número'));
      if (field.min !== undefined && n < field.min) return fail(t('Debe ser ≥ {min}', { min: field.min }));
      if (field.max !== undefined && n > field.max) return fail(t('Debe ser ≤ {max}', { max: field.max }));
      const d = field.decimals ?? (field.type === 'number' ? 6 : 2);
      const f = 10 ** d;
      return ok(Math.round(n * f) / f);
    }
    case 'rating': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) return fail(t('Debe ser un entero entre 1 y 5'));
      return ok(n);
    }
    case 'date': {
      if (typeof raw !== 'string') return fail(t('Fecha inválida (AAAA-MM-DD)'));
      const s = raw.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return fail(t('Fecha inválida (AAAA-MM-DD)'));
      return ok(s);
    }
    case 'datetime': {
      if (typeof raw !== 'string') return fail(t('Fecha y hora inválida'));
      const s = raw.trim();
      const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s + 'Z';
      const ms = Date.parse(withZone);
      if (Number.isNaN(ms)) return fail(t('Fecha y hora inválida'));
      return ok(new Date(ms).toISOString());
    }
    case 'boolean': {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return ok(true);
      if (raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === '') return ok(false);
      return fail(t('Debe ser sí o no'));
    }
    case 'email': {
      if (typeof raw !== 'string') return fail(t('Email inválido'));
      const s = raw.trim().toLowerCase();
      return s.length <= 254 && EMAIL_RE.test(s) ? ok(s) : fail(t('Email inválido'));
    }
    case 'phone': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail(t('Teléfono inválido'));
      const s = String(raw).trim();
      return PHONE_RE.test(s) ? ok(s) : fail(t('Teléfono inválido'));
    }
    case 'url': {
      if (typeof raw !== 'string') return fail(t('URL inválida'));
      let s = raw.trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+/.test(s)) s = 'https://' + s;
      try {
        const u = new URL(s);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail(t('Solo se permiten URLs http(s)'));
        return s.length > 2000 ? fail(t('URL demasiado larga')) : ok(u.toString());
      } catch {
        return fail(t('URL inválida'));
      }
    }
    case 'select': {
      const v = matchOption(field, raw);
      return v ? ok(v) : fail(t('Opción no válida "{value}"', { value: String(raw) }));
    }
    case 'multi_select': {
      const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (!arr) return fail(t('Debe ser una lista de opciones'));
      const out: string[] = [];
      for (const item of arr) {
        const v = matchOption(field, item);
        if (!v) return fail(t('Opción no válida "{value}"', { value: String(item) }));
        if (!out.includes(v)) out.push(v);
      }
      return ok(out.length ? out : null);
    }
    case 'relation':
    case 'user':
      return isUuid(raw) ? ok(raw.toLowerCase()) : fail(t('Identificador inválido'));
    case 'file': {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (!arr.every(isUuid)) return fail(t('Lista de archivos inválida'));
      const maxFiles = field.maxFiles ?? 10;
      if (arr.length > maxFiles) return fail(tp(maxFiles, 'Máximo {count} archivo', 'Máximo {count} archivos'));
      return ok(arr.length ? Array.from(new Set(arr.map((s) => (s as string).toLowerCase()))) : null);
    }
    case 'formula':
      return fail(t('Campo calculado: no se puede editar'));
    default:
      return fail(t('Tipo de campo no soportado'));
  }
}

export interface NormalizeOptions {
  mode: 'create' | 'update';
  existing?: Record<string, unknown>;
  now?: Date;
  tz?: string;
}

export function normalizeRecordInput(
  mod: Module,
  input: Record<string, unknown>,
  opts: NormalizeOptions,
): { data: Record<string, unknown>; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const data: Record<string, unknown> = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { data, issues: [{ field: '_', message: t('Los datos deben ser un objeto') }] };
  }
  for (const [key, raw] of Object.entries(input)) {
    const field = mod.fields.find((f) => f.key === key);
    if (!field) {
      issues.push({ field: key, message: t('Campo desconocido') });
      continue;
    }
    if (field.archived) {
      issues.push({ field: key, message: t('Campo archivado') });
      continue;
    }
    if (field.type === 'formula') {
      issues.push({ field: key, message: t('Campo calculado: no se puede editar') });
      continue;
    }
    const r = normalizeValue(field, raw);
    if (!r.ok) issues.push({ field: key, message: r.message });
    else data[key] = r.value;
  }

  if (opts.mode === 'create') {
    const now = opts.now ?? new Date();
    for (const f of mod.fields) {
      if (f.archived || f.type === 'formula' || f.defaultValue === undefined) continue;
      if (data[f.key] === undefined || data[f.key] === null) {
        const r = normalizeValue(f, resolveTemplate(f.defaultValue, { now, tz: opts.tz }));
        if (r.ok && r.value !== null) data[f.key] = r.value;
      }
    }
  }

  const merged = opts.mode === 'update' ? { ...(opts.existing ?? {}), ...data } : data;
  for (const f of mod.fields) {
    if (!f.required || f.archived || f.type === 'formula') continue;
    const relevant = opts.mode === 'create' || key_in(input, f.key);
    if (!relevant) continue;
    const v = merged[f.key];
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      if (!issues.some((i) => i.field === f.key)) issues.push({ field: f.key, message: t('Obligatorio') });
    }
  }
  return { data, issues };
}

function key_in(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function recordTitle(mod: Module, data: Record<string, unknown>): string {
  const v = data[mod.primaryField];
  if (v === null || v === undefined || v === '') return t('Sin título');
  return Array.isArray(v) ? v.join(', ') : String(v);
}
