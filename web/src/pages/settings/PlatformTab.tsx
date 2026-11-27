import { Fragment, useState, type ReactNode } from 'react';
import { useIsFetching, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Activity, AlertTriangle, Building2, Check, ChevronRight, Clock, Gauge, ListChecks, MemoryStick, RefreshCw, ShieldAlert, Users, X } from 'lucide-react';
import { get } from '../../lib/api';
import { getIntlTag, listFormat, msg, t, tk, tp } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { formatDate, formatNumber, formatPercent, relativeTime } from '../../lib/format';
import { Badge, Button, Card, cx, EmptyState, ErrorState, IconButton, Skeleton, StatTile } from '../../components/ui';
import type { Color } from '../../../../shared/constants';

interface Overview {
  workspaces: number;
  users: number;
  jobs: { status: string; n: number }[];
  errors24h: number;
  llm24h: { provider: string; requests: number; errors: number; cost_usd: number }[];
  config: {
    env: string;
    role: string;
    appUrl: boolean;
    email: boolean;
    signupOpen: boolean;
    platformLlmKeys: Record<string, boolean>;
    database: string;
  };
}

interface Metrics {
  uptimeSec: number;
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  latencyMs: { p50: number; p95: number; p99: number };
  memoryMb: { rss: number; heapUsed: number };
  topRoutes: { route: string; requests: number; avgMs: number; errors: number }[];
}

interface ErrorEvent {
  id: string;
  workspace_id: string | null;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
  created_at: string;
}

interface JobRow {
  id: string;
  workspace_id: string | null;
  type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  run_at: string;
  created_at: string;
  finished_at: string | null;
}

const ROOT_KEY = ['platform-admin'];
const PREVIEW_ROWS = 20;

const JOB_STATUS: Record<string, { one: string; many: (n: number) => string; color: Color }> = {
  queued: { one: msg('En cola'), many: (n) => tp(n, '{count} en cola', '{count} en cola'), color: 'amber' },
  running: { one: msg('En curso'), many: (n) => tp(n, '{count} en curso', '{count} en curso'), color: 'sky' },
  done: { one: msg('Completado'), many: (n) => tp(n, '{count} completado', '{count} completados'), color: 'emerald' },
  failed: { one: msg('Fallido'), many: (n) => tp(n, '{count} fallido', '{count} fallidos'), color: 'red' },
};

const ERROR_SOURCES: Record<string, { label: string; color: Color }> = {
  api: { label: 'API', color: 'violet' },
  web: { label: msg('Web'), color: 'sky' },
  worker: { label: msg('Worker'), color: 'amber' },
};

const PROVIDERS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', openrouter: 'OpenRouter', gemini: 'Gemini', mistral: 'Mistral', groq: 'Groq' };

const TH = 'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
const TD = 'px-4 py-2.5 align-top';
const NUM = 'text-right tabular-nums';

const shortId = (id: string | null) => (id ? `${id.slice(0, 8)}…` : '—');
const usd = (n: number) => formatNumber(n, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  // Unidades abreviadas del idioma activo (en español: «3 d 4 h», «5 min», «6 s»).
  const unit = (n: number, u: 'day' | 'hour' | 'minute' | 'second') => new Intl.NumberFormat(getIntlTag(), { style: 'unit', unit: u, unitDisplay: 'short' }).format(n);
  if (d) return `${unit(d, 'day')} ${unit(h, 'hour')}`;
  if (h) return `${unit(h, 'hour')} ${unit(m, 'minute')}`;
  if (m) return unit(m, 'minute');
  return unit(sec, 'second');
}

export default function PlatformTab() {
  const { me } = useSession();
  const allowed = !!me?.user.isPlatformAdmin;
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: [...ROOT_KEY, 'overview'], queryFn: () => get<Overview>('/admin/overview'), enabled: allowed });
  const metrics = useQuery({ queryKey: [...ROOT_KEY, 'metrics'], queryFn: () => get<Metrics>('/admin/metrics'), enabled: allowed });
  const errors = useQuery({ queryKey: [...ROOT_KEY, 'errors'], queryFn: () => get<ErrorEvent[]>('/admin/errors'), enabled: allowed });
  const jobs = useQuery({ queryKey: [...ROOT_KEY, 'jobs'], queryFn: () => get<JobRow[]>('/admin/jobs'), enabled: allowed });
  const fetching = useIsFetching({ queryKey: ROOT_KEY }) > 0;

  if (!allowed) {
    return (
      <Card>
        <EmptyState icon={<ShieldAlert className="size-5" />} title={t('Acceso restringido')} description={t('Solo los administradores de la plataforma pueden ver el estado de la instancia.')} />
      </Card>
    );
  }

  const updatedAt = Math.max(overview.dataUpdatedAt, metrics.dataUpdatedAt, errors.dataUpdatedAt, jobs.dataUpdatedAt);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('Estado de la plataforma')}</h2>
          <p className="mt-0.5 text-sm text-zinc-500">{t('Organizaciones, rendimiento, errores y trabajos en segundo plano de toda la instancia.')}</p>
        </div>
        <div className="flex items-center gap-3">
          {updatedAt > 0 && <span className="text-xs text-zinc-500">{t('Actualizado a las {time}', { time: new Date(updatedAt).toLocaleTimeString(getIntlTag()) })}</span>}
          <Button size="sm" icon={<RefreshCw className={cx('size-3.5', fetching && 'animate-spin')} />} disabled={fetching} onClick={() => qc.invalidateQueries({ queryKey: ROOT_KEY })}>
            {t('Actualizar')}
          </Button>
        </div>
      </div>

      <OverviewTiles q={overview} />
      <MetricsTiles q={metrics} />

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <ConfigCard q={overview} />
        <LlmCard q={overview} />
      </div>

      <ErrorsCard q={errors} />
      <JobsCard q={jobs} />
      <RoutesCard q={metrics} />
    </div>
  );
}

function TilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[6.5rem]" />
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2.5 p-4">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  );
}

function OverviewTiles({ q }: { q: UseQueryResult<Overview> }) {
  if (q.isLoading) return <TilesSkeleton />;
  if (q.isError || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  const o = q.data;
  const jobsTotal = o.jobs.reduce((a, j) => a + j.n, 0);
  const jobsHint = o.jobs.length
    ? o.jobs
        .slice()
        .sort((a, b) => b.n - a.n)
        .map((j) => JOB_STATUS[j.status]?.many(j.n) ?? `${formatNumber(j.n)} ${j.status}`)
        .join(' · ')
    : t('Sin trabajos en la última semana');
  const failed = o.jobs.find((j) => j.status === 'failed')?.n ?? 0;
  const icon = (node: ReactNode) => <span className="text-zinc-400">{node}</span>;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label={t('Organizaciones')} value={formatNumber(o.workspaces)} icon={icon(<Building2 className="size-4" />)} />
      <StatTile label={t('Usuarios')} value={formatNumber(o.users)} icon={icon(<Users className="size-4" />)} />
      <StatTile
        label={t('Errores (24 h)')}
        value={<span className={o.errors24h ? 'text-red-600 dark:text-red-400' : undefined}>{formatNumber(o.errors24h)}</span>}
        hint={o.errors24h ? t('Revisa los errores recientes') : t('Sin errores registrados')}
        icon={icon(<AlertTriangle className="size-4" />)}
      />
      <StatTile
        label={t('Trabajos (7 días)')}
        value={<span className={failed ? 'text-amber-600 dark:text-amber-400' : undefined}>{formatNumber(jobsTotal)}</span>}
        hint={jobsHint}
        icon={icon(<ListChecks className="size-4" />)}
      />
    </div>
  );
}

function MetricsTiles({ q }: { q: UseQueryResult<Metrics> }) {
  if (q.isLoading) return <TilesSkeleton />;
  if (q.isError || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  const m = q.data;
  const icon = (node: ReactNode) => <span className="text-zinc-400">{node}</span>;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label={t('Tiempo activo')} value={formatUptime(m.uptimeSec)} hint={t('Desde el último arranque de esta instancia')} icon={icon(<Clock className="size-4" />)} />
      <StatTile
        label={t('Peticiones')}
        value={formatNumber(m.requests)}
        hint={
          <>
            {/* i18n-ignore: clases de estado HTTP */}
            2xx {formatNumber(m.s2xx)} · 3xx {formatNumber(m.s3xx)} · 4xx {formatNumber(m.s4xx)} · <span className={m.s5xx ? 'font-medium text-red-600 dark:text-red-400' : undefined}>5xx {formatNumber(m.s5xx)}</span>
          </>
        }
        icon={icon(<Activity className="size-4" />)}
      />
      <StatTile
        label={t('Latencia p50 / p95 / p99')}
        value={
          <>
            {m.latencyMs.p50}
            <span className="text-sm font-medium text-zinc-400">
              {' '}
              / {m.latencyMs.p95} / {m.latencyMs.p99} ms
            </span>
          </>
        }
        hint={t('Últimas 2.000 peticiones')}
        icon={icon(<Gauge className="size-4" />)}
      />
      <StatTile label={t('Memoria (RSS)')} value={`${formatNumber(m.memoryMb.rss)} MB`} hint={t('Heap en uso: {size} MB', { size: formatNumber(m.memoryMb.heapUsed) })} icon={icon(<MemoryStick className="size-4" />)} />
    </div>
  );
}

function Flag({ on, yes = t('Sí'), no = t('No'), neutral }: { on: boolean; yes?: string; no?: string; neutral?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1 text-sm', on ? (neutral ? 'text-zinc-700 dark:text-zinc-300' : 'text-emerald-600 dark:text-emerald-400') : 'text-zinc-500')}>
      {on ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      {on ? yes : no}
    </span>
  );
}

function ConfigRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="min-w-0">
        <div className="text-sm text-zinc-700 dark:text-zinc-300">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </dt>
      <dd className="flex min-w-0 shrink-0 justify-end text-right">{children}</dd>
    </div>
  );
}

function ConfigCard({ q }: { q: UseQueryResult<Overview> }) {
  const c = q.data?.config;
  return (
    <Card title={t('Configuración')} description={t('Variables de entorno relevantes (solo se indica si están definidas).')}>
      {q.isLoading ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
      ) : !c ? (
        <p className="py-6 text-center text-sm text-zinc-500">{t('No disponible.')}</p>
      ) : (
        <dl className="-my-2.5 divide-y divide-zinc-100 dark:divide-zinc-800">
          <ConfigRow label={t('Entorno')}>
            <Badge color={c.env === 'production' ? 'emerald' : 'amber'}>{c.env}</Badge>
          </ConfigRow>
          <ConfigRow label={t('Rol del proceso')} hint={t('web, worker o all (ambos)')}>
            <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{c.role}</code>
          </ConfigRow>
          <ConfigRow label={t('Base de datos')}>
            <span className="text-sm text-zinc-700 dark:text-zinc-300">{c.database === 'pg' ? 'PostgreSQL' : c.database === 'pglite' ? t('PGlite (embebida)') : c.database}</span>
          </ConfigRow>
          <ConfigRow label={t('URL pública')} hint="APP_URL" /* i18n-ignore: nombre de la variable de entorno */>
            <Flag on={c.appUrl} yes={t('Configurada')} no={t('Sin configurar')} />
          </ConfigRow>
          <ConfigRow label={t('Envío de email')} hint={listFormat(['RESEND_API_KEY', 'EMAIL_FROM'])}>
            <Flag on={c.email} yes={t('Configurado')} no={t('Sin configurar')} />
          </ConfigRow>
          <ConfigRow label={t('Registro público')} hint="ALLOW_SIGNUP" /* i18n-ignore: nombre de la variable de entorno */>
            <Flag on={c.signupOpen} yes={t('Abierto')} no={t('Cerrado')} neutral />
          </ConfigRow>
          <ConfigRow label={t('Claves LLM de plataforma')} hint={t('Activas solo con ALLOW_PLATFORM_LLM_KEYS')}>
            <div className="flex max-w-56 flex-wrap justify-end gap-1">
              {Object.entries(c.platformLlmKeys).map(([k, on]) => (
                <Badge key={k} color={on ? 'emerald' : 'slate'}>
                  {on ? <Check className="size-3" /> : <X className="size-3" />}
                  {PROVIDERS[k] ?? k}
                </Badge>
              ))}
            </div>
          </ConfigRow>
        </dl>
      )}
    </Card>
  );
}

function LlmCard({ q }: { q: UseQueryResult<Overview> }) {
  const rows = q.data?.llm24h ?? [];
  const total = rows.reduce((a, r) => ({ requests: a.requests + r.requests, errors: a.errors + r.errors, cost: a.cost + (r.cost_usd ?? 0) }), { requests: 0, errors: 0, cost: 0 });
  return (
    <Card padded={false} title={t('Uso de LLM (24 h)')} description={t('Peticiones, errores y coste estimado por proveedor en todas las organizaciones.')}>
      {q.isLoading ? (
        <TableSkeleton />
      ) : !q.data ? (
        <p className="py-10 text-center text-sm text-zinc-500">{t('No disponible.')}</p>
      ) : !rows.length ? (
        <EmptyState icon={<Activity className="size-5" />} title={t('Sin uso de IA')} description={t('No se han registrado peticiones a proveedores en las últimas 24 horas.')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={TH}>{t('Proveedor')}</th>
                <th className={cx(TH, 'text-right')}>{t('Peticiones')}</th>
                <th className={cx(TH, 'text-right')}>{t('Errores')}</th>
                <th className={cx(TH, 'text-right')}>{t('Coste')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.provider}>
                  <td className={cx(TD, 'font-medium text-zinc-800 dark:text-zinc-200')}>{PROVIDERS[r.provider] ?? r.provider}</td>
                  <td className={cx(TD, NUM)}>{formatNumber(r.requests)}</td>
                  <td className={cx(TD, NUM, r.errors ? 'text-red-600 dark:text-red-400' : 'text-zinc-500')}>
                    {formatNumber(r.errors)}
                    {r.requests > 0 && r.errors > 0 && <span className="ml-1 text-xs">({formatPercent(Math.round((r.errors / r.requests) * 100))})</span>}
                  </td>
                  <td className={cx(TD, NUM)}>{usd(r.cost_usd ?? 0)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot className="border-t border-zinc-200 font-medium dark:border-zinc-700">
                <tr>
                  <td className={TD}>{t('Total')}</td>
                  <td className={cx(TD, NUM)}>{formatNumber(total.requests)}</td>
                  <td className={cx(TD, NUM)}>{formatNumber(total.errors)}</td>
                  <td className={cx(TD, NUM)}>{usd(total.cost)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Card>
  );
}

function ShowMore({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  if (total <= PREVIEW_ROWS) return null;
  return (
    <div className="border-t border-zinc-100 px-4 py-2.5 text-center dark:border-zinc-800">
      <button type="button" className="text-xs font-medium text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-100" onClick={onToggle}>
        {expanded ? t('Mostrar menos') : t('Mostrar los {count}', { count: total })}
      </button>
    </div>
  );
}

function ErrorsCard({ q }: { q: UseQueryResult<ErrorEvent[]> }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = q.data ?? [];
  const shown = expanded ? rows : rows.slice(0, PREVIEW_ROWS);
  return (
    <Card padded={false} title={t('Errores recientes')} description={t('Últimos 100 errores de la API, el worker y el navegador.')}>
      {q.isLoading ? (
        <TableSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !rows.length ? (
        <EmptyState icon={<Check className="size-5" />} title={t('Sin errores registrados')} description={t('Cuando algo falle en la API, el worker o el navegador, aparecerá aquí.')} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                <tr>
                  <th className="w-10 py-2.5 pl-3" aria-label={t('Detalles')} />
                  <th className={TH}>{t('Fecha')}</th>
                  <th className={TH}>{t('Origen')}</th>
                  <th className={TH}>{t('Mensaje')}</th>
                  <th className={TH}>{t('Organización')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {shown.map((e) => {
                  const src = ERROR_SOURCES[e.source] ?? { label: e.source, color: 'slate' as Color };
                  const isOpen = open === e.id;
                  const hasContext = !!e.context && Object.keys(e.context).length > 0;
                  return (
                    <Fragment key={e.id}>
                      <tr className={cx(isOpen && 'bg-zinc-50/70 dark:bg-zinc-800/30')}>
                        <td className="py-2 pl-3 align-top">
                          <IconButton label={isOpen ? t('Ocultar detalles') : t('Ver detalles')} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>
                            <ChevronRight className={cx('size-4 transition-transform', isOpen && 'rotate-90')} />
                          </IconButton>
                        </td>
                        <td className={cx(TD, 'whitespace-nowrap')}>
                          <div className="text-zinc-800 dark:text-zinc-200">{formatDate(e.created_at, true)}</div>
                          <div className="text-xs text-zinc-500">{relativeTime(e.created_at)}</div>
                        </td>
                        <td className={TD}>
                          <Badge color={src.color}>{tk(src.label)}</Badge>
                        </td>
                        <td className={cx(TD, 'max-w-md')}>
                          <div className={cx('break-words text-zinc-800 dark:text-zinc-200', !isOpen && 'line-clamp-2')}>{e.message}</div>
                        </td>
                        <td className={cx(TD, 'whitespace-nowrap font-mono text-xs text-zinc-500')} title={e.workspace_id ?? t('Sin organización')}>
                          {shortId(e.workspace_id)}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-zinc-50/70 dark:bg-zinc-800/30">
                          <td />
                          <td colSpan={4} className="px-4 pb-3">
                            <pre className="max-h-72 overflow-auto rounded-lg bg-white p-3 font-mono text-xs leading-relaxed text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-300 dark:ring-zinc-800">
                              {hasContext ? JSON.stringify(e.context, null, 2) : t('Sin contexto adicional.')}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ShowMore total={rows.length} expanded={expanded} onToggle={() => setExpanded((x) => !x)} />
        </>
      )}
    </Card>
  );
}

function JobsCard({ q }: { q: UseQueryResult<JobRow[]> }) {
  const [expanded, setExpanded] = useState(false);
  const rows = q.data ?? [];
  const shown = expanded ? rows : rows.slice(0, PREVIEW_ROWS);
  return (
    <Card padded={false} title={t('Trabajos recientes')} description={t('Últimos 100 trabajos en segundo plano: planificación de EVOLVE, automatizaciones, webhooks, fórmulas y mantenimiento.')}>
      {q.isLoading ? (
        <TableSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !rows.length ? (
        <EmptyState icon={<ListChecks className="size-5" />} title={t('Sin trabajos')} description={t('Todavía no se ha encolado ningún trabajo en segundo plano.')} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                <tr>
                  <th className={TH}>{t('Trabajo')}</th>
                  <th className={TH}>{t('Estado')}</th>
                  <th className={cx(TH, 'text-right')}>{t('Intentos')}</th>
                  <th className={TH}>{t('Creado')}</th>
                  <th className={TH}>{t('Programado')}</th>
                  <th className={TH}>{t('Finalizado')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {shown.map((j) => {
                  const st = JOB_STATUS[j.status] ?? { one: j.status, color: 'slate' as Color };
                  return (
                    <tr key={j.id}>
                      <td className={cx(TD, 'max-w-sm')}>
                        <div className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{j.type}</div>
                        <div className="font-mono text-[11px] text-zinc-400" title={j.workspace_id ?? t('Sin organización')}>
                          {t('Org. {id}', { id: shortId(j.workspace_id) })}
                        </div>
                        {j.last_error && (
                          <div className="mt-1 line-clamp-2 break-words text-xs text-red-600 dark:text-red-400" title={j.last_error}>
                            {j.last_error}
                          </div>
                        )}
                      </td>
                      <td className={TD}>
                        <Badge color={st.color} dot>
                          {tk(st.one)}
                        </Badge>
                      </td>
                      <td className={cx(TD, NUM)}>{j.attempts}</td>
                      <td className={cx(TD, 'whitespace-nowrap text-zinc-600 dark:text-zinc-400')} title={formatDate(j.created_at, true)}>
                        {relativeTime(j.created_at)}
                      </td>
                      <td className={cx(TD, 'whitespace-nowrap text-zinc-600 dark:text-zinc-400')}>{formatDate(j.run_at, true)}</td>
                      <td className={cx(TD, 'whitespace-nowrap text-zinc-600 dark:text-zinc-400')}>{j.finished_at ? formatDate(j.finished_at, true) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ShowMore total={rows.length} expanded={expanded} onToggle={() => setExpanded((x) => !x)} />
        </>
      )}
    </Card>
  );
}

function RoutesCard({ q }: { q: UseQueryResult<Metrics> }) {
  const routes = q.data?.topRoutes ?? [];
  return (
    <Card padded={false} title={t('Rutas más usadas')} description={t('Las 20 rutas con más peticiones desde el último arranque de esta instancia.')}>
      {q.isLoading ? (
        <TableSkeleton />
      ) : !q.data ? (
        <p className="py-10 text-center text-sm text-zinc-500">{t('No disponible.')}</p>
      ) : !routes.length ? (
        <EmptyState icon={<Activity className="size-5" />} title={t('Sin peticiones todavía')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={TH}>{t('Ruta')}</th>
                <th className={cx(TH, 'text-right')}>{t('Peticiones')}</th>
                <th className={cx(TH, 'text-right')}>{t('Media@@promedio')}</th>
                <th className={cx(TH, 'text-right')}>{t('Errores 5xx')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {routes.map((r) => (
                <tr key={r.route}>
                  <td className={cx(TD, 'break-all font-mono text-xs text-zinc-800 dark:text-zinc-200')}>{r.route}</td>
                  <td className={cx(TD, NUM)}>{formatNumber(r.requests)}</td>
                  <td className={cx(TD, NUM, r.avgMs >= 1000 ? 'text-amber-600 dark:text-amber-400' : undefined)}>{formatNumber(r.avgMs, { style: 'unit', unit: 'millisecond', unitDisplay: 'short' })}</td>
                  <td className={cx(TD, NUM, r.errors ? 'text-red-600 dark:text-red-400' : 'text-zinc-500')}>{formatNumber(r.errors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
