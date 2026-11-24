import { addDays, localDate, startOfMonth, startOfWeek, startOfYear, DEFAULT_TZ } from './time';

/**
 * Plantillas de valores seguras para automatizaciones, filtros y paneles (sin eval):
 *   {{today}} {{today+3d}} {{today-7d}} {{now}} {{now+2h}} {{week_start}} {{month_start}}
 *   {{year_start}} {{record.id}} {{record.<campo>}}
 */
export interface TemplateContext {
  now: Date;
  tz?: string;
  record?: { id: string; data: Record<string, unknown> } | null;
}

// Expresiones LINEALES (sin cuantificadores solapados sobre espacios, que provocaban backtracking cúbico
// con entradas como "{{" + miles de espacios sin cierre). resolveToken ya hace el trim.
const TOKEN_RE = /\{\{([^{}]{1,100})\}\}/g;
const SINGLE_RE = /^\{\{([^{}]{1,100})\}\}$/;

export function resolveToken(token: string, ctx: TemplateContext): unknown {
  const tz = ctx.tz ?? DEFAULT_TZ;
  const t = token.trim();
  const rel = t.match(/^(today|now)\s*(?:([+-])\s*(\d{1,4})\s*([hdwm]))?$/);
  if (rel) {
    const [, base, sign, amount, unit] = rel;
    let d = ctx.now;
    if (sign && amount && unit) {
      const n = Number(amount) * (sign === '-' ? -1 : 1);
      if (unit === 'h') d = new Date(d.getTime() + n * 3_600_000);
      else if (unit === 'd') d = addDays(d, n);
      else if (unit === 'w') d = addDays(d, n * 7);
      else if (unit === 'm') d = addDays(d, n * 30);
    }
    return base === 'today' ? localDate(d, tz) : d.toISOString();
  }
  if (t === 'month_start') return startOfMonth(ctx.now, tz);
  if (t === 'week_start') return startOfWeek(ctx.now, tz);
  if (t === 'year_start') return startOfYear(ctx.now, tz);
  if (t === 'record.id') return ctx.record?.id ?? null;
  const field = t.match(/^record\.([a-z][a-z0-9_]{0,39})$/);
  if (field) return ctx.record?.data[field[1]] ?? null;
  return null;
}

export function resolveTemplate(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') {
    const single = value.match(SINGLE_RE);
    if (single) return resolveToken(single[1], ctx);
    if (!value.includes('{{')) return value;
    return value.replace(TOKEN_RE, (_, tok: string) => {
      const v = resolveToken(tok, ctx);
      if (v === null || v === undefined) return '';
      return Array.isArray(v) ? v.join(', ') : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, ctx));
  return value;
}

export function resolveValues(values: Record<string, unknown>, ctx: TemplateContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = resolveTemplate(v, ctx);
  return out;
}
