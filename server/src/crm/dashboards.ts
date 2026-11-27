import { findModule, type Blueprint, type Module, type Widget } from '../../../shared/blueprint';
import { recordTitle } from '../../../shared/records';
import type { Queryable } from '../db/db';
import { activeIntlTag, t } from '../i18n';
import { conditionsToSql } from './store';

export interface SeriesPoint {
  key: string;
  label: string;
  value: number;
  color?: string;
}

export type WidgetData =
  | { type: 'metric'; value: number; format: 'currency' | 'number' | 'percent'; currency?: string }
  | { type: 'bar' | 'donut'; points: SeriesPoint[]; format: 'currency' | 'number' | 'percent'; currency?: string }
  | { type: 'line'; points: SeriesPoint[]; format: 'currency' | 'number' | 'percent'; currency?: string }
  | { type: 'list'; items: { id: string; title: string; subtitle?: string }[]; module: string }
  | { type: 'error'; message: string };

const SYS_DATES = new Set(['created_at', 'updated_at', 'last_activity_at']);
const NUMERIC = new Set(['number', 'currency', 'percent', 'rating', 'formula']);

function aggregateSql(w: Widget, params: unknown[]): string {
  if (w.aggregate === 'count' || !w.field) return 'count(*)::float8';
  params.push(w.field);
  const k = `$${params.length}`;
  return `COALESCE(${w.aggregate}(CASE WHEN jsonb_typeof(data->${k}) = 'number' THEN (data->>${k})::numeric END), 0)::float8`;
}

function formatFor(mod: Module, w: Widget): { format: 'currency' | 'number' | 'percent'; currency?: string } {
  if (w.aggregate === 'count') return { format: 'number' };
  const f = mod.fields.find((x) => x.key === w.field);
  if (f?.type === 'currency' || (f?.type === 'formula' && f.currency)) return { format: 'currency', currency: f.currency ?? 'EUR' };
  if (f?.type === 'percent') return { format: 'percent' };
  return { format: 'number' };
}

export async function computeWidget(
  q: Queryable,
  workspaceId: string,
  bp: Blueprint,
  w: Widget,
  ctx: { now: Date; tz: string; /** Permiso de lectura por módulo: sin él no se revelan títulos de registros relacionados. */ canRead?: (moduleKey: string) => boolean },
): Promise<WidgetData> {
  const mod = findModule(bp, w.module);
  if (!mod || mod.archived) return { type: 'error', message: t('Módulo "{module}" no disponible', { module: w.module }) };
  try {
    const params: unknown[] = [workspaceId, mod.key];
    const where = ['workspace_id = $1', 'module_key = $2', 'deleted_at IS NULL', ...conditionsToSql(mod, w.filters, params, ctx)].join(' AND ');
    const fmt = formatFor(mod, w);

    if (w.type === 'metric') {
      const agg = aggregateSql(w, params);
      const r = await q.query<{ v: number }>(`SELECT ${agg} AS v FROM records WHERE ${where}`, params);
      return { type: 'metric', value: Number(r.rows[0]?.v ?? 0), ...fmt };
    }

    if (w.type === 'bar' || w.type === 'donut') {
      const g = w.groupBy!;
      const field = mod.fields.find((f) => f.key === g);
      const agg = aggregateSql(w, params);
      let sql: string;
      if (field?.type === 'multi_select') {
        params.push(g);
        sql = `SELECT t.k AS k, ${agg} AS v FROM records, LATERAL jsonb_array_elements_text(COALESCE(data->$${params.length}, '[]'::jsonb)) AS t(k) WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`;
      } else if (g === 'created_by') {
        sql = `SELECT created_by::text AS k, ${agg} AS v FROM records WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`;
      } else {
        params.push(g);
        sql = `SELECT data->>$${params.length} AS k, ${agg} AS v FROM records WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`;
      }
      const r = await q.query<{ k: string | null; v: number }>(sql, params);
      let points: SeriesPoint[] = r.rows.map((row) => ({ key: row.k ?? '', label: row.k ?? t('Sin valor'), value: Number(row.v) }));
      if (field?.options) {
        const order = field.options.map((o) => o.value);
        points = points
          .map((p) => {
            const opt = field.options!.find((o) => o.value === p.key);
            return { ...p, label: opt?.label ?? (p.key || t('Sin valor')), color: opt?.color };
          })
          .sort((a, b) => (order.indexOf(a.key) === -1 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) === -1 ? 99 : order.indexOf(b.key)));
      } else if (field?.type === 'user' || g === 'created_by') {
        const ids = points.map((p) => p.key).filter(Boolean);
        if (ids.length) {
          const u = await q.query(`SELECT id::text, name FROM users WHERE id = ANY($1::uuid[])`, [ids]);
          const names = new Map(u.rows.map((x: any) => [x.id, x.name]));
          points = points.map((p) => ({ ...p, label: names.get(p.key) ?? (p.key ? t('Usuario') : t('Sin asignar')) }));
        }
      } else if (field?.type === 'relation') {
        const ids = points.map((p) => p.key).filter(Boolean);
        const target = findModule(bp, field.relation!.module);
        if (ids.length && target && ctx.canRead && !ctx.canRead(target.key)) {
          points = points.map((p) => ({ ...p, label: p.key ? t('Registro restringido') : t('Sin relación') }));
        } else if (ids.length && target) {
          const rr = await q.query(`SELECT id::text, data FROM records WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, ids]);
          const titles = new Map(rr.rows.map((x: any) => [x.id, recordTitle(target, x.data)]));
          points = points.map((p) => ({ ...p, label: titles.get(p.key) ?? (p.key ? t('Registro') : t('Sin relación')) }));
        }
      } else if (field?.type === 'boolean') {
        points = points.map((p) => ({ ...p, label: p.key === 'true' ? t('Sí') : p.key === 'false' ? t('No') : t('Sin valor') }));
      }
      return { type: w.type, points, ...fmt };
    }

    if (w.type === 'line') {
      const df = w.dateField!;
      let dateExpr: string;
      if (SYS_DATES.has(df)) dateExpr = df;
      else {
        params.push(df);
        dateExpr = `(CASE WHEN data->>$${params.length} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (data->>$${params.length})::timestamptz END)`;
      }
      const agg = aggregateSql(w, params);
      const periods = w.interval === 'day' ? 30 : w.interval === 'week' ? 12 : 12;
      params.push(w.interval);
      const unit = `$${params.length}`;
      params.push(periods);
      const r = await q.query<{ k: string; v: number }>(
        `SELECT to_char(date_trunc(${unit}, ${dateExpr}), 'YYYY-MM-DD') AS k, ${agg} AS v FROM records
         WHERE ${where} AND ${dateExpr} IS NOT NULL AND ${dateExpr} >= date_trunc(${unit}, now()) - (CASE ${unit} WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week' ELSE interval '1 month' END) * ($${params.length} - 1)
         GROUP BY 1 ORDER BY 1`,
        params,
      );
      const values = new Map(r.rows.map((row) => [row.k, Number(row.v)]));
      // Rellena huecos para que la serie sea continua.
      const points: SeriesPoint[] = [];
      const now = ctx.now;
      for (let i = periods - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        if (w.interval === 'month') {
          d.setUTCDate(1);
          d.setUTCMonth(d.getUTCMonth() - i);
        } else if (w.interval === 'week') {
          const day = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() - day + 1 - i * 7);
        } else d.setUTCDate(d.getUTCDate() - i);
        const key = d.toISOString().slice(0, 10);
        const label = w.interval === 'month' ? d.toLocaleDateString(activeIntlTag(), { month: 'short', year: '2-digit', timeZone: 'UTC' }) : d.toLocaleDateString(activeIntlTag(), { day: '2-digit', month: 'short', timeZone: 'UTC' });
        points.push({ key, label, value: values.get(key) ?? 0 });
      }
      return { type: 'line', points, ...fmt };
    }

    // list
    const dateField = mod.fields.find((f) => (f.type === 'date' || f.type === 'datetime') && !f.archived);
    let order = 'created_at DESC';
    if (dateField) {
      params.push(dateField.key);
      order = `data->>$${params.length} ASC NULLS LAST, created_at DESC`;
    }
    params.push(w.limit);
    const r = await q.query(`SELECT id, data FROM records WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
    return {
      type: 'list',
      module: mod.key,
      items: r.rows.map((row: any) => ({
        id: row.id,
        title: recordTitle(mod, row.data),
        subtitle: dateField && row.data[dateField.key] ? String(row.data[dateField.key]).slice(0, 10) : undefined,
      })),
    };
  } catch (e) {
    return { type: 'error', message: (e as Error).message.slice(0, 200) };
  }
}

export { NUMERIC as NUMERIC_TYPES_FOR_WIDGETS };
