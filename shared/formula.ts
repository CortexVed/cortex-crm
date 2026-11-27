import { daysBetween, localDate, DEFAULT_TZ } from './time';
import { t } from './i18n';

/**
 * Lenguaje de fórmulas seguro (sin eval ni acceso a nada fuera del registro).
 * Ejemplos:
 *   {amount} * {probability} / 100
 *   IF({tier} = "vip", 30, 0) + MIN(40, COUNT_RELATED("activities", "company") * 4)
 *   ROUND(SUM_RELATED("deals", "company", "amount") / 1000, 1)
 */

export type FNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'field'; key: string }
  | { t: 'unary'; op: '-' | '!'; e: FNode }
  | { t: 'bin'; op: string; l: FNode; r: FNode }
  | { t: 'call'; name: string; args: FNode[] };

export class FormulaError extends Error {}

type Tok = { k: 'num' | 'str' | 'field' | 'id' | 'op' | 'eof'; v: string };

const MAX_TOKENS = 500;
const MAX_DEPTH = 40;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = src.slice(i, j);
      if (!/^\d*\.?\d+$|^\d+\.?\d*$/.test(num)) throw new FormulaError(t('Número inválido "{value}"', { value: num }));
      out.push({ k: 'num', v: num });
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (src[j] !== c) throw new FormulaError(t('Cadena sin cerrar'));
      out.push({ k: 'str', v: s });
      i = j + 1;
    } else if (c === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new FormulaError(t('Referencia de campo sin cerrar'));
      const key = src.slice(i + 1, j).trim();
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) && !['created_at', 'updated_at', 'last_activity_at'].includes(key)) {
        throw new FormulaError(t('Referencia de campo inválida "{key}"', { key }));
      }
      out.push({ k: 'field', v: key });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
    } else {
      const two = src.slice(i, i + 2);
      if (['>=', '<=', '!=', '<>', '==', '&&', '||'].includes(two)) {
        out.push({ k: 'op', v: two });
        i += 2;
      } else if ('+-*/%(),=<>!'.includes(c)) {
        out.push({ k: 'op', v: c });
        i++;
      } else throw new FormulaError(t('Carácter no permitido "{char}"', { char: c }));
    }
    if (out.length > MAX_TOKENS) throw new FormulaError(t('Fórmula demasiado larga'));
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

export const FORMULA_FUNCTIONS: Record<string, { min: number; max: number; related?: boolean }> = {
  IF: { min: 2, max: 3 },
  AND: { min: 1, max: 20 },
  OR: { min: 1, max: 20 },
  NOT: { min: 1, max: 1 },
  MIN: { min: 1, max: 20 },
  MAX: { min: 1, max: 20 },
  ROUND: { min: 1, max: 2 },
  FLOOR: { min: 1, max: 1 },
  CEIL: { min: 1, max: 1 },
  ABS: { min: 1, max: 1 },
  CLAMP: { min: 3, max: 3 },
  COALESCE: { min: 1, max: 10 },
  LEN: { min: 1, max: 1 },
  CONCAT: { min: 1, max: 20 },
  UPPER: { min: 1, max: 1 },
  LOWER: { min: 1, max: 1 },
  CONTAINS: { min: 2, max: 2 },
  DAYS_SINCE: { min: 1, max: 1 },
  DAYS_UNTIL: { min: 1, max: 1 },
  TODAY: { min: 0, max: 0 },
  YEAR: { min: 1, max: 1 },
  MONTH: { min: 1, max: 1 },
  COUNT_RELATED: { min: 2, max: 2, related: true },
  SUM_RELATED: { min: 3, max: 3, related: true },
  AVG_RELATED: { min: 3, max: 3, related: true },
};

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek() {
    return this.toks[this.p];
  }
  private next() {
    return this.toks[this.p++];
  }
  private isOp(v: string) {
    const tok = this.peek();
    return tok.k === 'op' && tok.v === v;
  }
  private isKw(v: string) {
    const tok = this.peek();
    return tok.k === 'id' && tok.v.toUpperCase() === v;
  }
  parse(): FNode {
    const n = this.or(0);
    if (this.peek().k !== 'eof') throw new FormulaError(t('Símbolo inesperado "{symbol}"', { symbol: this.peek().v }));
    return n;
  }
  private guard(d: number) {
    if (d > MAX_DEPTH) throw new FormulaError(t('Fórmula demasiado anidada'));
  }
  private or(d: number): FNode {
    this.guard(d);
    let l = this.and(d + 1);
    while (this.isOp('||') || this.isKw('OR')) {
      this.next();
      l = { t: 'bin', op: '||', l, r: this.and(d + 1) };
    }
    return l;
  }
  private and(d: number): FNode {
    let l = this.cmp(d + 1);
    while (this.isOp('&&') || this.isKw('AND')) {
      this.next();
      l = { t: 'bin', op: '&&', l, r: this.cmp(d + 1) };
    }
    return l;
  }
  private cmp(d: number): FNode {
    const l = this.add(d + 1);
    const tok = this.peek();
    if (tok.k === 'op' && ['=', '==', '!=', '<>', '>', '>=', '<', '<='].includes(tok.v)) {
      this.next();
      const op = tok.v === '==' ? '=' : tok.v === '<>' ? '!=' : tok.v;
      return { t: 'bin', op, l, r: this.add(d + 1) };
    }
    return l;
  }
  private add(d: number): FNode {
    let l = this.mul(d + 1);
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.mul(d + 1) };
    }
    return l;
  }
  private mul(d: number): FNode {
    let l = this.unary(d + 1);
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.unary(d + 1) };
    }
    return l;
  }
  private unary(d: number): FNode {
    this.guard(d);
    if (this.isOp('-')) {
      this.next();
      return { t: 'unary', op: '-', e: this.unary(d + 1) };
    }
    if (this.isOp('!') || this.isKw('NOT')) {
      // NOT(x) como función también es válido
      if (this.isKw('NOT') && this.toks[this.p + 1]?.v === '(') return this.primary(d + 1);
      this.next();
      return { t: 'unary', op: '!', e: this.unary(d + 1) };
    }
    return this.primary(d + 1);
  }
  private primary(d: number): FNode {
    this.guard(d);
    const tok = this.next();
    if (tok.k === 'num') return { t: 'num', v: Number(tok.v) };
    if (tok.k === 'str') return { t: 'str', v: tok.v };
    if (tok.k === 'field') return { t: 'field', key: tok.v };
    if (tok.k === 'op' && tok.v === '(') {
      const e = this.or(d + 1);
      if (!this.isOp(')')) throw new FormulaError(t('Falta ")"'));
      this.next();
      return e;
    }
    if (tok.k === 'id') {
      const up = tok.v.toUpperCase();
      if (up === 'TRUE') return { t: 'bool', v: true };
      if (up === 'FALSE') return { t: 'bool', v: false };
      if (up === 'NULL') return { t: 'null' };
      const spec = FORMULA_FUNCTIONS[up];
      if (!spec) throw new FormulaError(t('Función desconocida "{name}"', { name: tok.v }));
      if (!this.isOp('(')) throw new FormulaError(t('Falta "(" tras {name}', { name: up }));
      this.next();
      const args: FNode[] = [];
      if (!this.isOp(')')) {
        args.push(this.or(d + 1));
        while (this.isOp(',')) {
          this.next();
          args.push(this.or(d + 1));
        }
      }
      if (!this.isOp(')')) throw new FormulaError(t('Falta ")" en {name}', { name: up }));
      this.next();
      if (args.length < spec.min || args.length > spec.max) {
        throw new FormulaError(t('{name} espera entre {min} y {max} argumentos', { name: up, min: spec.min, max: spec.max }));
      }
      if (spec.related && args.some((a) => a.t !== 'str')) {
        throw new FormulaError(t('{name} requiere nombres de módulo y campo entre comillas', { name: up }));
      }
      return { t: 'call', name: up, args };
    }
    throw new FormulaError(t('Símbolo inesperado "{symbol}"', { symbol: tok.v || t('fin de fórmula') }));
  }
}

export function parseFormula(expression: string): FNode {
  if (expression.length > 1000) throw new FormulaError(t('Fórmula demasiado larga'));
  return new Parser(tokenize(expression)).parse();
}

export function collectFieldRefs(n: FNode, acc: Set<string> = new Set()): Set<string> {
  if (n.t === 'field') acc.add(n.key);
  else if (n.t === 'unary') collectFieldRefs(n.e, acc);
  else if (n.t === 'bin') {
    collectFieldRefs(n.l, acc);
    collectFieldRefs(n.r, acc);
  } else if (n.t === 'call') n.args.forEach((a) => collectFieldRefs(a, acc));
  return acc;
}

export interface RelatedCall {
  fn: 'COUNT_RELATED' | 'SUM_RELATED' | 'AVG_RELATED';
  module: string;
  field: string;
  valueField?: string;
}

export function collectRelatedCalls(n: FNode, acc: RelatedCall[] = []): RelatedCall[] {
  if (n.t === 'call') {
    if (FORMULA_FUNCTIONS[n.name]?.related) {
      const [m, f, v] = n.args as { t: 'str'; v: string }[];
      acc.push({ fn: n.name as RelatedCall['fn'], module: m.v, field: f.v, valueField: v?.v });
    }
    n.args.forEach((a) => collectRelatedCalls(a, acc));
  } else if (n.t === 'unary') collectRelatedCalls(n.e, acc);
  else if (n.t === 'bin') {
    collectRelatedCalls(n.l, acc);
    collectRelatedCalls(n.r, acc);
  }
  return acc;
}

export const relatedKey = (c: RelatedCall) => `${c.fn}|${c.module}|${c.field}|${c.valueField ?? ''}`;

export interface FormulaContext {
  data: Record<string, unknown>;
  system?: { created_at?: string; updated_at?: string; last_activity_at?: string };
  now: Date;
  tz?: string;
  related?: Map<string, number>;
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return 0;
};
const truthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
const str = (v: unknown): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

export function evaluateFormula(n: FNode, ctx: FormulaContext): unknown {
  const ev = (x: FNode): unknown => evaluateFormula(x, ctx);
  switch (n.t) {
    case 'num':
      return n.v;
    case 'str':
      return n.v;
    case 'bool':
      return n.v;
    case 'null':
      return null;
    case 'field': {
      if (n.key === 'created_at' || n.key === 'updated_at' || n.key === 'last_activity_at') return ctx.system?.[n.key] ?? null;
      const v = ctx.data[n.key];
      return v === undefined ? null : v;
    }
    case 'unary':
      return n.op === '-' ? -num(ev(n.e)) : !truthy(ev(n.e));
    case 'bin': {
      if (n.op === '&&') return truthy(ev(n.l)) && truthy(ev(n.r));
      if (n.op === '||') return truthy(ev(n.l)) || truthy(ev(n.r));
      const l = ev(n.l);
      const r = ev(n.r);
      switch (n.op) {
        case '+':
          if (typeof l === 'string' && typeof r === 'string' && (Number.isNaN(Number(l)) || Number.isNaN(Number(r)))) return l + r;
          return num(l) + num(r);
        case '-':
          return num(l) - num(r);
        case '*':
          return num(l) * num(r);
        case '/':
          return num(r) === 0 ? null : num(l) / num(r);
        case '%':
          return num(r) === 0 ? null : num(l) % num(r);
        case '=':
          return typeof l === 'number' || typeof r === 'number' ? num(l) === num(r) : str(l).toLowerCase() === str(r).toLowerCase();
        case '!=':
          return typeof l === 'number' || typeof r === 'number' ? num(l) !== num(r) : str(l).toLowerCase() !== str(r).toLowerCase();
        case '>':
          return typeof l === 'string' && typeof r === 'string' && Number.isNaN(Number(l)) ? l > r : num(l) > num(r);
        case '>=':
          return typeof l === 'string' && typeof r === 'string' && Number.isNaN(Number(l)) ? l >= r : num(l) >= num(r);
        case '<':
          return typeof l === 'string' && typeof r === 'string' && Number.isNaN(Number(l)) ? l < r : num(l) < num(r);
        case '<=':
          return typeof l === 'string' && typeof r === 'string' && Number.isNaN(Number(l)) ? l <= r : num(l) <= num(r);
      }
      return null;
    }
    case 'call': {
      const a = n.args;
      const tz = ctx.tz ?? DEFAULT_TZ;
      switch (n.name) {
        case 'IF':
          return truthy(ev(a[0])) ? ev(a[1]) : a[2] ? ev(a[2]) : null;
        case 'AND':
          return a.every((x) => truthy(ev(x)));
        case 'OR':
          return a.some((x) => truthy(ev(x)));
        case 'NOT':
          return !truthy(ev(a[0]));
        case 'MIN':
          return Math.min(...a.map((x) => num(ev(x))));
        case 'MAX':
          return Math.max(...a.map((x) => num(ev(x))));
        case 'ROUND': {
          const d = a[1] ? Math.max(0, Math.min(6, Math.trunc(num(ev(a[1]))))) : 0;
          const f = 10 ** d;
          return Math.round(num(ev(a[0])) * f) / f;
        }
        case 'FLOOR':
          return Math.floor(num(ev(a[0])));
        case 'CEIL':
          return Math.ceil(num(ev(a[0])));
        case 'ABS':
          return Math.abs(num(ev(a[0])));
        case 'CLAMP':
          return Math.min(num(ev(a[2])), Math.max(num(ev(a[1])), num(ev(a[0]))));
        case 'COALESCE':
          for (const x of a) {
            const v = ev(x);
            if (v !== null && v !== undefined && v !== '') return v;
          }
          return null;
        case 'LEN':
          return str(ev(a[0])).length;
        case 'CONCAT':
          return a.map((x) => str(ev(x))).join('');
        case 'UPPER':
          return str(ev(a[0])).toUpperCase();
        case 'LOWER':
          return str(ev(a[0])).toLowerCase();
        case 'CONTAINS': {
          const h = ev(a[0]);
          const needle = ev(a[1]);
          if (Array.isArray(h)) return h.includes(needle as never);
          return str(h).toLowerCase().includes(str(needle).toLowerCase());
        }
        case 'DAYS_SINCE': {
          const v = ev(a[0]);
          if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
          return daysBetween(v.length > 10 ? localDate(new Date(v), tz) : v, localDate(ctx.now, tz));
        }
        case 'DAYS_UNTIL': {
          const v = ev(a[0]);
          if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
          return daysBetween(localDate(ctx.now, tz), v.length > 10 ? localDate(new Date(v), tz) : v);
        }
        case 'TODAY':
          return localDate(ctx.now, tz);
        case 'YEAR': {
          const v = str(ev(a[0]));
          return /^\d{4}/.test(v) ? Number(v.slice(0, 4)) : null;
        }
        case 'MONTH': {
          const v = str(ev(a[0]));
          return /^\d{4}-\d{2}/.test(v) ? Number(v.slice(5, 7)) : null;
        }
        case 'COUNT_RELATED':
        case 'SUM_RELATED':
        case 'AVG_RELATED': {
          const [m, f, v] = a as { t: 'str'; v: string }[];
          return ctx.related?.get(relatedKey({ fn: n.name, module: m.v, field: f.v, valueField: v?.v })) ?? 0;
        }
      }
      return null;
    }
  }
}

export function computeFormula(
  expression: string,
  resultType: 'number' | 'text' | 'boolean',
  ctx: FormulaContext,
  decimals?: number,
  /** Árbol ya analizado (evita volver a analizar la expresión en cada cálculo). */
  parsed?: FNode,
): unknown {
  const v = evaluateFormula(parsed ?? parseFormula(expression), ctx);
  if (v === null || v === undefined) return null;
  if (resultType === 'number') {
    const n = num(v);
    const f = 10 ** (decimals ?? 2);
    return Math.round(n * f) / f;
  }
  if (resultType === 'boolean') return truthy(v);
  return str(v).slice(0, 2000);
}
