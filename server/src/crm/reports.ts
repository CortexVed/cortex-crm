import { findModule, type Blueprint } from '../../../shared/blueprint';
import type { Queryable } from '../db/db';
import { activeIntlTag, t } from '../i18n';

export const REPORT_TYPES = ['sales', 'conversion', 'activity', 'performance', 'customers'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportChart {
  key: string;
  title: string;
  type: 'bar' | 'line' | 'donut' | 'funnel';
  format: 'currency' | 'number' | 'percent';
  points: { key: string; label: string; value: number; color?: string }[];
}

export interface Report {
  type: ReportType;
  title: string;
  description: string;
  available: boolean;
  missing: string[];
  kpis: { label: string; value: number; format: 'currency' | 'number' | 'percent' }[];
  charts: ReportChart[];
  table?: { columns: { key: string; label: string; format?: 'currency' | 'number' | 'percent' }[]; rows: Record<string, unknown>[] };
}

/** Título y descripción de cada informe (en el idioma de la petición). */
const titles = (): Record<ReportType, [string, string]> => ({
  sales: [t('Ventas'), t('Ingresos ganados, pipeline abierto y ponderado.')],
  conversion: [t('Conversión'), t('Embudo de oportunidades y ciclo de vida de contactos.')],
  activity: [t('Actividad comercial'), t('Llamadas, reuniones, emails y tareas completadas.')],
  performance: [t('Rendimiento del equipo'), t('Resultados por comercial.')],
  customers: [t('Evolución de clientes'), t('Altas de contactos y empresas, y estado de la cartera.')],
});

function months(n: number, now: Date) {
  const out: { key: string; label: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ key: d.toISOString().slice(0, 10), label: d.toLocaleDateString(activeIntlTag(), { month: 'short', year: '2-digit', timeZone: 'UTC' }) });
  }
  return out;
}

export async function buildReport(q: Queryable, workspaceId: string, bp: Blueprint, type: ReportType, now: Date): Promise<Report> {
  const [title, description] = titles()[type];
  const base: Report = { type, title, description, available: true, missing: [], kpis: [], charts: [] };
  const need = (moduleKey: string, fields: string[]) => {
    const m = findModule(bp, moduleKey);
    if (!m || m.archived) {
      base.missing.push(t('módulo "{key}"', { key: moduleKey }));
      return null;
    }
    for (const f of fields) if (!m.fields.some((x) => x.key === f && !x.archived)) base.missing.push(`${moduleKey}.${f}`);
    return m;
  };
  const ws = workspaceId;

  if (type === 'sales' || type === 'conversion') {
    const deals = need('deals', ['stage', 'amount']);
    const stageField = deals?.fields.find((f) => f.key === 'stage');
    const hasWon = stageField?.options?.some((o) => o.value === 'ganado');
    if (deals && !hasWon) base.missing.push(t('deals.stage con la etapa "ganado"'));
    if (base.missing.length) return { ...base, available: false };
    const options = stageField!.options!;
    const closed = ['ganado', 'perdido'];
    const byStage = await q.query<{ k: string | null; n: number; amount: number }>(
      `SELECT data->>'stage' AS k, count(*)::int AS n, COALESCE(sum(CASE WHEN jsonb_typeof(data->'amount')='number' THEN (data->>'amount')::numeric END),0)::float8 AS amount
       FROM records WHERE workspace_id = $1 AND module_key = 'deals' AND deleted_at IS NULL GROUP BY 1`,
      [ws],
    );
    const stageMap = new Map(byStage.rows.map((r) => [r.k, r]));
    if (type === 'sales') {
      const won = await q.query<{ k: string; amount: number; n: number }>(
        `WITH w AS (
           SELECT r.id, COALESCE(CASE WHEN jsonb_typeof(r.data->'amount')='number' THEN (r.data->>'amount')::numeric END, 0) AS amount,
             COALESCE((SELECT max(h.created_at) FROM record_history h WHERE h.workspace_id = $1 AND h.record_id = r.id AND h.action = 'update' AND h.changes->'stage'->>'to' = 'ganado'), r.created_at) AS won_at
           FROM records r WHERE r.workspace_id = $1 AND r.module_key = 'deals' AND r.deleted_at IS NULL AND r.data->>'stage' = 'ganado')
         SELECT to_char(date_trunc('month', won_at), 'YYYY-MM-DD') AS k, sum(amount)::float8 AS amount, count(*)::int AS n
         FROM w WHERE won_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1`,
        [ws],
      );
      const wonMap = new Map(won.rows.map((r) => [r.k, r]));
      const series = months(12, now).map((m) => ({ key: m.key, label: m.label, value: Number(wonMap.get(m.key)?.amount ?? 0) }));
      const totalWon = series.reduce((a, b) => a + b.value, 0);
      const wonCount = won.rows.reduce((a, b) => a + b.n, 0);
      const open = byStage.rows.filter((r) => r.k && !closed.includes(r.k));
      const weighted = await q.query<{ v: number }>(
        `SELECT COALESCE(sum(COALESCE(CASE WHEN jsonb_typeof(data->'amount')='number' THEN (data->>'amount')::numeric END,0) * COALESCE(CASE WHEN jsonb_typeof(data->'probability')='number' THEN (data->>'probability')::numeric END,0) / 100),0)::float8 AS v
         FROM records WHERE workspace_id = $1 AND module_key = 'deals' AND deleted_at IS NULL AND NOT (data->>'stage' = ANY($2::text[]))`,
        [ws, closed],
      );
      base.kpis = [
        { label: t('Ganado (12 meses)'), value: totalWon, format: 'currency' },
        { label: t('Oportunidades ganadas'), value: wonCount, format: 'number' },
        { label: t('Ticket medio'), value: wonCount ? totalWon / wonCount : 0, format: 'currency' },
        { label: t('Pipeline abierto'), value: open.reduce((a, b) => a + Number(b.amount), 0), format: 'currency' },
        { label: t('Pipeline ponderado'), value: Number(weighted.rows[0]?.v ?? 0), format: 'currency' },
      ];
      base.charts = [
        { key: 'won_by_month', title: t('Ingresos ganados por mes'), type: 'bar', format: 'currency', points: series },
        {
          key: 'pipeline_by_stage',
          title: t('Pipeline por etapa'),
          type: 'bar',
          format: 'currency',
          points: options.filter((o) => !closed.includes(o.value)).map((o) => ({ key: o.value, label: o.label, value: Number(stageMap.get(o.value)?.amount ?? 0), color: o.color })),
        },
      ];
      return base;
    }
    // conversion
    const won = stageMap.get('ganado')?.n ?? 0;
    const lost = stageMap.get('perdido')?.n ?? 0;
    const total = byStage.rows.reduce((a, b) => a + b.n, 0);
    base.kpis = [
      { label: t('Tasa de cierre (ganadas / cerradas)'), value: won + lost ? (won / (won + lost)) * 100 : 0, format: 'percent' },
      { label: t('Oportunidades totales'), value: total, format: 'number' },
      { label: t('Ganadas'), value: won, format: 'number' },
      { label: t('Perdidas'), value: lost, format: 'number' },
    ];
    base.charts.push({
      key: 'deal_funnel',
      title: t('Embudo de oportunidades'),
      type: 'funnel',
      format: 'number',
      points: options.map((o) => ({ key: o.value, label: o.label, value: stageMap.get(o.value)?.n ?? 0, color: o.color })),
    });
    const contacts = findModule(bp, 'contacts');
    const lifecycle = contacts?.fields.find((f) => f.key === 'lifecycle' && !f.archived);
    if (lifecycle?.options) {
      const lc = await q.query<{ k: string | null; n: number }>(
        `SELECT data->>'lifecycle' AS k, count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = 'contacts' AND deleted_at IS NULL GROUP BY 1`,
        [ws],
      );
      const lcMap = new Map(lc.rows.map((r) => [r.k, r.n]));
      const totalC = lc.rows.reduce((a, b) => a + b.n, 0);
      base.kpis.push({ label: t('Contactos convertidos en clientes'), value: totalC ? ((lcMap.get('cliente') ?? 0) / totalC) * 100 : 0, format: 'percent' });
      base.charts.push({ key: 'lifecycle', title: t('Ciclo de vida de contactos'), type: 'funnel', format: 'number', points: lifecycle.options.map((o) => ({ key: o.value, label: o.label, value: lcMap.get(o.value) ?? 0, color: o.color })) });
    }
    return base;
  }

  if (type === 'activity') {
    const acts = need('activities', ['type', 'date']);
    if (!acts) return { ...base, available: false };
    if (base.missing.length) return { ...base, available: false };
    const typeField = acts.fields.find((f) => f.key === 'type')!;
    const weekly = await q.query<{ k: string; n: number }>(
      `SELECT to_char(date_trunc('week', (data->>'date')::timestamptz), 'YYYY-MM-DD') AS k, count(*)::int AS n FROM records
       WHERE workspace_id = $1 AND module_key = 'activities' AND deleted_at IS NULL AND data->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}'
         AND (data->>'date')::timestamptz >= date_trunc('week', now()) - interval '11 weeks' GROUP BY 1 ORDER BY 1`,
      [ws],
    );
    const wMap = new Map(weekly.rows.map((r) => [r.k, r.n]));
    const weeks: { key: string; label: string; value: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() - day + 1 - i * 7);
      const key = d.toISOString().slice(0, 10);
      weeks.push({ key, label: d.toLocaleDateString(activeIntlTag(), { day: '2-digit', month: 'short', timeZone: 'UTC' }), value: wMap.get(key) ?? 0 });
    }
    const byType = await q.query<{ k: string | null; n: number }>(
      `SELECT data->>'type' AS k, count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = 'activities' AND deleted_at IS NULL
         AND created_at >= now() - interval '90 days' GROUP BY 1`,
      [ws],
    );
    const tasksDone = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = 'tasks' AND deleted_at IS NULL AND data->>'status' = 'completada' AND updated_at >= now() - interval '30 days'`,
      [ws],
    );
    const last30 = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = 'activities' AND deleted_at IS NULL AND created_at >= now() - interval '30 days'`,
      [ws],
    );
    base.kpis = [
      { label: t('Actividades (30 días)'), value: last30.rows[0].n, format: 'number' },
      { label: t('Tareas completadas (30 días)'), value: tasksDone.rows[0].n, format: 'number' },
    ];
    base.charts = [
      { key: 'weekly', title: t('Actividades por semana'), type: 'line', format: 'number', points: weeks },
      { key: 'by_type', title: t('Actividades por tipo (90 días)'), type: 'donut', format: 'number', points: (typeField.options ?? []).map((o) => ({ key: o.value, label: o.label, value: byType.rows.find((r) => r.k === o.value)?.n ?? 0, color: o.color })) },
    ];
    return base;
  }

  if (type === 'performance') {
    const deals = need('deals', ['stage', 'amount', 'owner']);
    if (!deals || base.missing.length) return { ...base, available: false };
    const r = await q.query(
      `WITH m AS (SELECT u.id, u.name FROM memberships mm JOIN users u ON u.id = mm.user_id WHERE mm.workspace_id = $1),
       d AS (SELECT data->>'owner' AS owner, data->>'stage' AS stage, COALESCE(CASE WHEN jsonb_typeof(data->'amount')='number' THEN (data->>'amount')::numeric END,0) AS amount
             FROM records WHERE workspace_id = $1 AND module_key = 'deals' AND deleted_at IS NULL),
       a AS (SELECT data->>'owner' AS owner, count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = 'activities' AND deleted_at IS NULL AND created_at >= now() - interval '90 days' GROUP BY 1),
       t AS (SELECT data->>'assignee' AS owner, count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = 'tasks' AND deleted_at IS NULL AND data->>'status' = 'completada' AND updated_at >= now() - interval '90 days' GROUP BY 1)
       SELECT m.id, m.name,
         COALESCE((SELECT count(*) FROM d WHERE d.owner = m.id::text AND d.stage = 'ganado'),0)::int AS won,
         COALESCE((SELECT sum(amount) FROM d WHERE d.owner = m.id::text AND d.stage = 'ganado'),0)::float8 AS won_amount,
         COALESCE((SELECT sum(amount) FROM d WHERE d.owner = m.id::text AND d.stage NOT IN ('ganado','perdido')),0)::float8 AS pipeline,
         COALESCE((SELECT count(*) FROM d WHERE d.owner = m.id::text AND d.stage = 'perdido'),0)::int AS lost,
         COALESCE((SELECT n FROM a WHERE a.owner = m.id::text),0)::int AS activities,
         COALESCE((SELECT n FROM t WHERE t.owner = m.id::text),0)::int AS tasks_done
       FROM m ORDER BY won_amount DESC`,
      [ws],
    );
    const rows = r.rows.map((x: any) => ({ ...x, win_rate: x.won + x.lost ? (x.won / (x.won + x.lost)) * 100 : 0 }));
    base.table = {
      columns: [
        { key: 'name', label: t('Comercial') },
        { key: 'won', label: t('Ganadas'), format: 'number' },
        { key: 'won_amount', label: t('Importe ganado'), format: 'currency' },
        { key: 'pipeline', label: t('Pipeline abierto'), format: 'currency' },
        { key: 'win_rate', label: t('Tasa de cierre'), format: 'percent' },
        { key: 'activities', label: t('Actividades (90 d)'), format: 'number' },
        { key: 'tasks_done', label: t('Tareas hechas (90 d)'), format: 'number' },
      ],
      rows,
    };
    base.charts = [{ key: 'won_by_owner', title: t('Importe ganado por comercial'), type: 'bar', format: 'currency', points: rows.map((x: any) => ({ key: x.id, label: x.name, value: Number(x.won_amount) })) }];
    return base;
  }

  // customers
  const series = async (moduleKey: string) => {
    const r = await q.query<{ k: string; n: number }>(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM-DD') AS k, count(*)::int AS n FROM records
       WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL AND created_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1`,
      [ws, moduleKey],
    );
    const m = new Map(r.rows.map((x) => [x.k, x.n]));
    return months(12, now).map((mm) => ({ key: mm.key, label: mm.label, value: m.get(mm.key) ?? 0 }));
  };
  const contactsSeries = findModule(bp, 'contacts') ? await series('contacts') : [];
  const companiesSeries = findModule(bp, 'companies') ? await series('companies') : [];
  base.charts.push({ key: 'new_contacts', title: t('Nuevos contactos por mes'), type: 'line', format: 'number', points: contactsSeries });
  base.charts.push({ key: 'new_companies', title: t('Nuevas empresas por mes'), type: 'bar', format: 'number', points: companiesSeries });
  const companies = findModule(bp, 'companies');
  const status = companies?.fields.find((f) => f.key === 'status' && !f.archived);
  if (status?.options) {
    const r = await q.query<{ k: string | null; n: number }>(
      `SELECT data->>'status' AS k, count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = 'companies' AND deleted_at IS NULL GROUP BY 1`,
      [ws],
    );
    base.charts.push({ key: 'companies_status', title: t('Cartera por estado'), type: 'donut', format: 'number', points: status.options.map((o) => ({ key: o.value, label: o.label, value: r.rows.find((x) => x.k === o.value)?.n ?? 0, color: o.color })) });
  }
  base.kpis = [
    { label: t('Nuevos contactos (12 meses)'), value: contactsSeries.reduce((a, b) => a + b.value, 0), format: 'number' },
    { label: t('Nuevas empresas (12 meses)'), value: companiesSeries.reduce((a, b) => a + b.value, 0), format: 'number' },
  ];
  return base;
}

/** Datos agregados (sin datos personales) que se envían a la IA para predicciones. */
export async function pipelineSnapshot(q: Queryable, workspaceId: string) {
  const r = await q.query(
    `SELECT data->>'stage' AS stage,
            COALESCE(CASE WHEN jsonb_typeof(data->'amount')='number' THEN (data->>'amount')::numeric END,0)::float8 AS amount,
            COALESCE(CASE WHEN jsonb_typeof(data->'probability')='number' THEN (data->>'probability')::numeric END,0)::float8 AS probability,
            data->>'expected_close' AS expected_close,
            extract(day FROM now() - created_at)::int AS age_days,
            extract(day FROM now() - last_activity_at)::int AS idle_days
     FROM records WHERE workspace_id = $1 AND module_key = 'deals' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 400`,
    [workspaceId],
  );
  return r.rows;
}
