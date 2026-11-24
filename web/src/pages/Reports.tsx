import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, BarChart3, Coins, Cpu, Funnel, Hash, Lock, Percent, RefreshCw, Settings, Sparkles, TrendingUp, UserPlus, Users, WandSparkles, type LucideIcon } from 'lucide-react';
import { Alert, Avatar, Button, Card, EmptyState, ErrorState, PageHeader, Skeleton, StatTile, Tabs, cx } from '../components/ui';
import { BarChart, DonutChart, FunnelChart, LineChart } from '../components/charts';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/toast';
import { AskDataCard } from '../components/AiTools';
import { ApiError, errorMessage, get, post } from '../lib/api';
import { useBlueprint } from '../lib/hooks';
import { useSession } from '../lib/session';
import { formatValue } from '../lib/format';
import type { SeriesPoint } from '../lib/types';

type ReportType = 'sales' | 'conversion' | 'activity' | 'performance' | 'customers';
type Fmt = 'currency' | 'number' | 'percent';

interface ReportChart {
  key: string;
  title: string;
  type: 'bar' | 'line' | 'donut' | 'funnel';
  format: Fmt;
  points: SeriesPoint[];
}

interface ReportColumn {
  key: string;
  label: string;
  format?: Fmt;
}

interface ReportTableData {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

interface Report {
  type: ReportType;
  title: string;
  description: string;
  available: boolean;
  missing: string[];
  kpis: { label: string; value: number; format: Fmt }[];
  charts: ReportChart[];
  table?: ReportTableData;
}

interface Prediction {
  text: string;
  provider: string | null;
  model: string | null;
  costUsd?: number | null;
}

const TABS: { key: ReportType; label: string; icon: LucideIcon }[] = [
  { key: 'sales', label: 'Ventas', icon: TrendingUp },
  { key: 'conversion', label: 'Conversión', icon: Funnel },
  { key: 'activity', label: 'Actividad comercial', icon: Activity },
  { key: 'performance', label: 'Rendimiento del equipo', icon: Users },
  { key: 'customers', label: 'Evolución de clientes', icon: UserPlus },
];

const KPI_ICON: Record<Fmt, LucideIcon> = { currency: Coins, percent: Percent, number: Hash };
// Clases literales: Tailwind solo genera las que aparecen tal cual en el código.
const KPI_COLS: Record<number, string> = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' };

const usd = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tipo');
  const type: ReportType = TABS.find((t) => t.key === raw)?.key ?? 'sales';
  const { data: bp } = useBlueprint();
  const currency = bp?.settings.currency ?? 'EUR';
  const q = useQuery({ queryKey: ['report', type], queryFn: () => get<Report>(`/reports/${type}`) });

  const changeTab = (k: ReportType) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (k === 'sales') next.delete('tipo');
        else next.set('tipo', k);
        return next;
      },
      { replace: true },
    );

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
            <BarChart3 className="size-5" />
          </span>
        }
        title="Informes"
        description="Indicadores clave calculados en tiempo real con los datos de tu CRM."
        actions={
          <Button size="sm" icon={<RefreshCw className={cx('size-3.5', q.isFetching && 'animate-spin')} />} disabled={q.isFetching} onClick={() => q.refetch()}>
            Actualizar
          </Button>
        }
      />

      <Tabs
        tabs={TABS.map((t) => {
          const Icon = t.icon;
          return {
            key: t.key,
            label: (
              <>
                <Icon className="size-4" />
                {t.label}
              </>
            ),
          };
        })}
        value={type}
        onChange={changeTab}
      />

      <div key={type} className="animate-fade-in">
        {q.isLoading ? (
          <ReportSkeleton />
        ) : q.isError ? (
          <Card>
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </Card>
        ) : q.data ? (
          <ReportContent report={q.data} currency={currency} />
        ) : null}
      </div>

      <AskDataCard />

      <PredictionsCard />
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Cargando informe">
      <Skeleton className="h-4 w-72 max-w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-64 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function ReportContent({ report, currency }: { report: Report; currency: string }) {
  const hasContent = report.kpis.length > 0 || report.charts.length > 0 || !!report.table;
  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-500">{report.description}</p>

      {!report.available && <UnavailableNotice missing={report.missing} />}

      {report.kpis.length > 0 && (
        <div className={cx('grid grid-cols-2 gap-3', report.kpis.length >= 5 ? 'lg:grid-cols-3 xl:grid-cols-5' : KPI_COLS[report.kpis.length])}>
          {report.kpis.map((k) => {
            const Icon = KPI_ICON[k.format] ?? Hash;
            const text = formatValue(k.value, k.format, currency);
            return (
              <StatTile
                key={k.label}
                label={k.label}
                icon={<Icon className="size-3.5 shrink-0 text-zinc-400" />}
                value={
                  <span className="block truncate" title={text}>
                    {text}
                  </span>
                }
              />
            );
          })}
        </div>
      )}

      {report.charts.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {report.charts.map((c, i) => {
            // Una serie temporal que queda sola en la última fila ocupa todo el ancho.
            const wide = report.charts.length % 2 === 1 && i === report.charts.length - 1 && (c.type === 'bar' || c.type === 'line');
            return (
              <Card key={c.key} title={c.title} className={cx(wide && 'lg:col-span-2')}>
                <ChartView chart={c} currency={currency} />
              </Card>
            );
          })}
        </div>
      )}

      {report.table && <ReportTable table={report.table} currency={currency} />}

      {report.available && !hasContent && (
        <Card>
          <EmptyState icon={<BarChart3 className="size-5" />} title="Todavía no hay datos para este informe" description="Cuando registres actividad en el CRM, los indicadores aparecerán aquí automáticamente." />
        </Card>
      )}
    </div>
  );
}

function UnavailableNotice({ missing }: { missing: string[] }) {
  return (
    <Alert tone="warning" title="Este informe no está disponible con la configuración actual de tu CRM">
      <p>Se calcula a partir de módulos y campos predeterminados que se han personalizado, archivado o eliminado.{missing.length > 0 && ' Falta:'}</p>
      {missing.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {missing.map((m) => (
            <li key={m}>
              <code className="rounded bg-amber-100/80 px-1.5 py-0.5 font-mono text-xs dark:bg-amber-500/15">{m}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2">Pide a EVOLVE AI ENGINE que adapte tu configuración para recuperar estos campos o que cree un panel equivalente con tus campos actuales. El cambio pasará por pruebas automáticas y tu aprobación.</p>
      <Link to="/evolve" className="mt-2 inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
        <Sparkles className="size-3.5" /> Abrir EVOLVE AI ENGINE
      </Link>
    </Alert>
  );
}

function ChartView({ chart, currency }: { chart: ReportChart; currency: string }) {
  const props = { points: chart.points, format: chart.format, currency };
  switch (chart.type) {
    case 'line':
      return <LineChart {...props} />;
    case 'donut':
      return <DonutChart {...props} />;
    case 'funnel':
      return <FunnelChart {...props} />;
    default:
      return <BarChart {...props} />;
  }
}

function ReportTable({ table, currency }: { table: ReportTableData; currency: string }) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const col = table.columns.find((c) => c.key === sort.key);
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...table.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (col?.format) return ((Number(x) || 0) - (Number(y) || 0)) * factor;
      return String(x ?? '').localeCompare(String(y ?? ''), 'es') * factor;
    });
  }, [table, sort]);

  const toggle = (c: ReportColumn) => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: c.key, dir: c.format ? 'desc' : 'asc' }));

  const display = (c: ReportColumn, v: unknown) => {
    if (c.format) {
      const n = Number(v);
      return v === null || v === undefined || !Number.isFinite(n) ? '—' : formatValue(n, c.format, currency);
    }
    return v === null || v === undefined || v === '' ? '—' : String(v);
  };

  return (
    <Card title="Detalle por comercial" description="Resultados de cada miembro del equipo. Pulsa en una columna para ordenar." padded={false}>
      {table.rows.length === 0 ? (
        <EmptyState icon={<Users className="size-5" />} title="Sin miembros que mostrar" description="Invita a tu equipo y asígnales oportunidades para comparar su rendimiento." />
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/60">
                {table.columns.map((c) => {
                  const active = sort?.key === c.key;
                  const SortIcon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                  return (
                    <th key={c.key} scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cx('whitespace-nowrap px-4 py-2.5 font-medium', c.format ? 'text-right' : 'text-left')}>
                      <button
                        type="button"
                        onClick={() => toggle(c)}
                        className={cx('inline-flex items-center gap-1 text-xs transition hover:text-zinc-900 dark:hover:text-zinc-100', active ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500', c.format && 'flex-row-reverse')}
                      >
                        {c.label}
                        <SortIcon className={cx('size-3', !active && 'opacity-40')} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r, i) => (
                <tr key={String(r.id ?? i)} className="transition hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40">
                  {table.columns.map((c) => {
                    const text = display(c, r[c.key]);
                    return (
                      <td key={c.key} className={cx('whitespace-nowrap px-4 py-2.5', c.format ? 'text-right tabular-nums text-zinc-700 dark:text-zinc-300' : 'text-left font-medium text-zinc-900 dark:text-zinc-100')}>
                        {c.key === 'name' ? (
                          <span className="inline-flex items-center gap-2">
                            <Avatar name={text === '—' ? '?' : text} size="sm" />
                            {text}
                          </span>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PredictionsCard() {
  const { can } = useSession();
  const toast = useToast();
  const canRun = can('member');
  const m = useMutation({
    mutationFn: () => post<Prediction>('/reports/predictions'),
    onSuccess: (p) => {
      if (p.provider) toast('Predicción generada');
    },
    onError: (e) => {
      // La falta de proveedor se explica dentro de la tarjeta, no como error genérico.
      if (e instanceof ApiError && e.code === 'ai_not_configured') return;
      toast(errorMessage(e), 'error');
    },
  });
  const notConfigured = m.error instanceof ApiError && m.error.code === 'ai_not_configured';

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="size-4 text-fuchsia-500" />
          Predicciones con IA
        </span>
      }
      description="Previsión de ingresos, oportunidades en riesgo y recomendaciones a partir de tu pipeline."
      actions={
        canRun ? (
          <Button variant="ai" size="sm" icon={<WandSparkles className="size-3.5" />} loading={m.isPending} onClick={() => m.mutate()}>
            {m.data ? 'Regenerar' : 'Generar predicción'}
          </Button>
        ) : undefined
      }
    >
      {m.isPending ? (
        <div className="space-y-2.5" aria-busy="true">
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Sparkles className="size-4 animate-pulse text-fuchsia-500" /> Analizando tu pipeline…
          </p>
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-9/12" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : notConfigured ? (
        <AiNotConfigured />
      ) : m.data ? (
        <PredictionResult p={m.data} />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white evolve-gradient">
            <WandSparkles className="size-5" />
          </span>
          <div className="space-y-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            <p>La IA estima los ingresos de los próximos 30 y 90 días, detecta oportunidades en riesgo por inactividad o antigüedad y te propone tres acciones concretas.</p>
            <p className="flex items-start gap-1.5 text-xs text-zinc-500">
              <Lock className="mt-0.5 size-3 shrink-0" />
              Solo se envían datos agregados y anónimos (etapa, importe, probabilidad, cierre previsto y antigüedad). Nunca nombres ni datos de contacto.
            </p>
            {!canRun && <p className="text-xs text-zinc-500">Tu rol es de solo lectura: pide a un miembro del equipo que genere la predicción.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

function AiNotConfigured() {
  const { can } = useSession();
  return (
    <Alert tone="warning" title="Configura un proveedor de IA para generar predicciones">
      <p>Las predicciones usan el proveedor de IA de tu organización (Claude, OpenAI, DeepSeek u OpenRouter) y todavía no hay ninguno configurado.</p>
      {can('admin') ? (
        <Link to="/settings/ai" className="mt-2 inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
          <Settings className="size-3.5" /> Configurar proveedores de IA
        </Link>
      ) : (
        <p className="mt-1">Pide a un administrador que añada una API key en Ajustes › Proveedores de IA.</p>
      )}
    </Alert>
  );
}

function PredictionResult({ p }: { p: Prediction }) {
  // Sin proveedor: el servidor indica que no hay datos suficientes (no se ha llamado a la IA).
  if (!p.provider) return <Alert tone="info">{p.text}</Alert>;
  return (
    <div className="animate-fade-in">
      <Markdown text={p.text} className="space-y-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300" />
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        <span className="inline-flex items-center gap-1">
          <Cpu className="size-3" />
          {p.provider}
          {p.model ? ` · ${p.model}` : ''}
        </span>
        {typeof p.costUsd === 'number' && <span>Coste estimado: {usd.format(p.costUsd)}</span>}
        <span>Estimación orientativa: revísala antes de tomar decisiones.</span>
      </div>
    </div>
  );
}
