import type { Field, Module } from './blueprint';
import { resolveTemplate } from './templates';

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
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail('Debe ser texto');
      const s = String(raw).trim();
      return s.length > 2000 ? fail('Máximo 2000 caracteres') : ok(s === '' ? null : s);
    }
    case 'long_text': {
      if (typeof raw !== 'string') return fail('Debe ser texto');
      return raw.length > 50_000 ? fail('Máximo 50.000 caracteres') : ok(raw);
    }
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(',', '.').trim()) : NaN;
      if (!Number.isFinite(n)) return fail('Debe ser un número');
      if (field.min !== undefined && n < field.min) return fail(`Debe ser ≥ ${field.min}`);
      if (field.max !== undefined && n > field.max) return fail(`Debe ser ≤ ${field.max}`);
      const d = field.decimals ?? (field.type === 'number' ? 6 : 2);
      const f = 10 ** d;
      return ok(Math.round(n * f) / f);
    }
    case 'rating': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) return fail('Debe ser un entero entre 1 y 5');
      return ok(n);
    }
    case 'date': {
      if (typeof raw !== 'string') return fail('Fecha inválida (AAAA-MM-DD)');
      const s = raw.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return fail('Fecha inválida (AAAA-MM-DD)');
      return ok(s);
    }
    case 'datetime': {
      if (typeof raw !== 'string') return fail('Fecha y hora inválida');
      const s = raw.trim();
      const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s + 'Z';
      const t = Date.parse(withZone);
      if (Number.isNaN(t)) return fail('Fecha y hora inválida');
      return ok(new Date(t).toISOString());
    }
    case 'boolean': {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return ok(true);
      if (raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === '') return ok(false);
      return fail('Debe ser sí o no');
    }
    case 'email': {
      if (typeof raw !== 'string') return fail('Email inválido');
      const s = raw.trim().toLowerCase();
      return s.length <= 254 && EMAIL_RE.test(s) ? ok(s) : fail('Email inválido');
    }
    case 'phone': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail('Teléfono inválido');
      const s = String(raw).trim();
      return PHONE_RE.test(s) ? ok(s) : fail('Teléfono inválido');
    }
    case 'url': {
      if (typeof raw !== 'string') return fail('URL inválida');
      let s = raw.trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+/.test(s)) s = 'https://' + s;
      try {
        const u = new URL(s);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Solo se permiten URLs http(s)');
        return s.length > 2000 ? fail('URL demasiado larga') : ok(u.toString());
      } catch {
        return fail('URL inválida');
      }
    }
    case 'select': {
      const v = matchOption(field, raw);
      return v ? ok(v) : fail(`Opción no válida "${String(raw)}"`);
    }
    case 'multi_select': {
      const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (!arr) return fail('Debe ser una lista de opciones');
      const out: string[] = [];
      for (const item of arr) {
        const v = matchOption(field, item);
        if (!v) return fail(`Opción no válida "${String(item)}"`);
        if (!out.includes(v)) out.push(v);
      }
      return ok(out.length ? out : null);
    }
    case 'relation':
    case 'user':
      return isUuid(raw) ? ok(raw.toLowerCase()) : fail('Identificador inválido');
    case 'file': {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (!arr.every(isUuid)) return fail('Lista de archivos inválida');
      if (arr.length > (field.maxFiles ?? 10)) return fail(`Máximo ${field.maxFiles ?? 10} archivos`);
      return ok(arr.length ? Array.from(new Set(arr.map((s) => (s as string).toLowerCase()))) : null);
    }
    case 'formula':
      return fail('Campo calculado: no se puede editar');
    default:
      return fail('Tipo de campo no soportado');
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
    return { data, issues: [{ field: '_', message: 'Los datos deben ser un objeto' }] };
  }
  for (const [key, raw] of Object.entries(input)) {
    const field = mod.fields.find((f) => f.key === key);
    if (!field) {
      issues.push({ field: key, message: 'Campo desconocido' });
      continue;
    }
    if (field.archived) {
      issues.push({ field: key, message: 'Campo archivado' });
      continue;
    }
    if (field.type === 'formula') {
      issues.push({ field: key, message: 'Campo calculado: no se puede editar' });
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
      if (!issues.some((i) => i.field === f.key)) issues.push({ field: f.key, message: 'Obligatorio' });
    }
  }
  return { data, issues };
}

function key_in(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function recordTitle(mod: Module, data: Record<string, unknown>): string {
  const v = data[mod.primaryField];
  if (v === null || v === undefined || v === '') return 'Sin título';
  return Array.isArray(v) ? v.join(', ') : String(v);
}
