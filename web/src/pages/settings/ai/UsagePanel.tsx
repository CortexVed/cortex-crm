import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Coins, Gauge, Hash, Timer } from 'lucide-react';
import { AI_TASK_LABELS, type AiTask } from '../../../../../shared/constants';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Skeleton, Spinner, StatTile } from '../../../components/ui';
import { BarChart, LineChart } from '../../../components/charts';
import { get } from '../../../lib/api';
import { formatDate, formatNumber, relativeTime } from '../../../lib/format';
import type { SeriesPoint } from '../../../lib/types';
import { AI_KEYS, ERROR_CODE_LABELS, formatMs, formatTokens, formatUsd, providerName, ProviderMonogram, Segmented } from './shared';
import type { ProviderState, UsageDaily, UsageResponse } from './types';

type Period = '7' | '30' | '90';
type Metric = 'requests' | 'cost';

const DAY_MS = 86_400_000;

/** Completa los días sin actividad para que la serie sea continua (fechas en UTC, como el servidor). */
function fillDays(rows: UsageDaily[], days: number): UsageDaily[] {
  const map = new Map(rows.map((r) => [r.day, r]));
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: UsageDaily[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(base - i * DAY_MS).toISOString().slice(0, 10);
    out.push(map.get(day) ?? { day, requests: 0, cost_usd: 0 });
    map.delete(day);
  }
  const rest = [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  return [...rest.filter((r) => r.day < out[0].day), ...out, ...rest.filter((r) => r.day > out[out.length - 1].day)];
}

function dayLabel(day: string, short: boolean): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('es-ES', short ? { weekday: 'short', day: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export function UsagePanel({ providers, onConfigurePrices }: { providers: ProviderState[]; onConfigurePrices: () => void }) {
  const [period, setPeriod] = useState<Period>('30');
  const [metric, setMetric] = useState<Metric>('requests');
  const days = Number(period);
  const q = useQuery({ queryKey: AI_KEYS.usage(days), queryFn: () => get<UsageResponse>(`/ai/usage?days=${days}`), placeholderData: keepPreviousData, staleTime: 30_000 });

  const points = useMemo<SeriesPoint[]>(() => {
    if (!q.data) return [];
    return fillDays(q.data.daily, days).map((d) => ({ key: d.day, label: dayLabel(d.day, days <= 7), value: metric === 'requests' ? d.requests : Number(d.cost_usd) || 0 }));
  }, [q.data, days, metric]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold">Consumo de IA</h3>
        <p className="text-xs text-zinc-500">Todas las llamadas a modelos de esta organización: asistente, motor de evolución, pruebas y comparativas.</p>
      </div>
      <div className="flex items-center gap-2">
        {q.isFetching && !q.isLoading && <Spinner className="size-4" />}
        <Segmented
          size="sm"
          value={period}
          onChange={setPeriod}
          options={[
            { key: '7', label: '7 días' },
            { key: '30', label: '30 días' },
            { key: '90', label: '90 días' },
          ]}
        />
      </div>
    </div>
  );

  if (q.isLoading)
    return (
      <div className="space-y-4">
        {header}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-48" />
      </div>
    );
  if (q.error || !q.data)
    return (
      <div className="space-y-4">
        {header}
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    );

  const { totals, byModel, byTask, recentErrors } = q.data;
  const okRequests = totals.requests - totals.errors;
  const taskTotal = byTask.reduce((a, t) => a + t.requests, 0);

  return (
    <div className="space-y-5">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Peticiones" icon={<Activity className="size-4 text-brand-500" />} value={formatNumber(totals.requests)} hint={totals.errors ? `${formatNumber(totals.errors)} con error (${pct(totals.errors, totals.requests)} %)` : 'Sin errores'} />
        <StatTile label="Coste estimado" icon={<Coins className="size-4 text-emerald-500" />} value={formatUsd(totals.cost_usd)} hint={totals.unpriced ? `${formatNumber(totals.unpriced)} llamada${totals.unpriced === 1 ? '' : 's'} sin precio` : 'Todas las llamadas con precio'} />
        <StatTile label="Tokens" icon={<Hash className="size-4 text-sky-500" />} value={formatTokens(totals.input_tokens + totals.output_tokens)} hint={`Entrada ${formatTokens(totals.input_tokens)} · salida ${formatTokens(totals.output_tokens)}`} />
        <StatTile label="Latencia (p50)" icon={<Timer className="size-4 text-amber-500" />} value={formatMs(totals.p50)} hint={`p95: ${formatMs(totals.p95)} · sobre ${formatNumber(okRequests)} correctas`} />
      </div>

      {totals.unpriced > 0 && (
        <Alert tone="warning" title="Hay llamadas sin precio conocido">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {formatNumber(totals.unpriced)} llamada{totals.unpriced === 1 ? '' : 's'} de este periodo se cuenta{totals.unpriced === 1 ? '' : 'n'} en «sin precio»: no suma{totals.unpriced === 1 ? '' : 'n'} al coste ni al presupuesto mensual. Configura sus precios en «Enrutado y límites».
            </span>
            <Button size="sm" className="shrink-0" onClick={onConfigurePrices}>
              Configurar precios
            </Button>
          </div>
        </Alert>
      )}

      {totals.requests === 0 ? (
        <Card>
          <EmptyState icon={<Gauge className="size-5" />} title={`Sin actividad en los últimos ${days} días`} description="Cuando el asistente, el motor de evolución o una comparativa llamen a un modelo, verás aquí peticiones, tokens, coste y latencia." />
        </Card>
      ) : (
        <>
          <Card
            title="Actividad diaria"
            description={metric === 'requests' ? 'Peticiones por día (incluye errores y reintentos)' : 'Coste estimado por día en USD'}
            actions={
              <Segmented
                size="sm"
                value={metric}
                onChange={setMetric}
                options={[
                  { key: 'requests', label: 'Peticiones' },
                  { key: 'cost', label: 'Coste' },
                ]}
              />
            }
          >
            {days > 31 ? <LineChart points={points} format={metric === 'cost' ? 'currency' : 'number'} currency="USD" height={180} /> : <BarChart points={points} format={metric === 'cost' ? 'currency' : 'number'} currency="USD" height={180} />}
          </Card>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card title="Por modelo" description="Modelos realmente servidos (incluye alternativas usadas por conmutación)." padded={false}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="text-left text-xs text-zinc-500">
                    <tr className="border-b border-zinc-100 dark:border-zinc-800">
                      <th className="px-4 py-2 font-medium">Modelo</th>
                      <th className="px-3 py-2 text-right font-medium">Peticiones</th>
                      <th className="px-3 py-2 text-right font-medium">Errores</th>
                      <th className="px-3 py-2 text-right font-medium">Tokens (ent. / sal.)</th>
                      <th className="px-3 py-2 text-right font-medium">Coste</th>
                      <th className="px-4 py-2 text-right font-medium">Latencia media</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {byModel.map((m) => (
                      <tr key={`${m.provider}:${m.model}`} className="hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30">
                        <td className="px-4 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <ProviderMonogram provider={{ id: m.provider, label: providerName(providers, m.provider) }} size="sm" />
                            <div className="min-w-0">
                              <div className="max-w-[16rem] truncate font-mono text-[12.5px]" title={m.model}>
                                {m.model}
                              </div>
                              <div className="text-[11px] text-zinc-500">{providerName(providers, m.provider)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.requests)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.errors ? <span className="text-red-600 dark:text-red-400">{formatNumber(m.errors)}</span> : <span className="text-zinc-400">0</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                          {formatTokens(m.input_tokens)} / {formatTokens(m.output_tokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatUsd(m.cost_usd)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{m.avg_latency_ms ? formatMs(m.avg_latency_ms) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Por tarea" description="Qué partes de EVOLVE consumen IA." padded={false}>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {byTask.map((t) => {
                  const share = pct(t.requests, taskTotal);
                  return (
                    <li key={t.task} className="px-4 py-2.5">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{AI_TASK_LABELS[t.task as AiTask] ?? t.task}</span>
                        <span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-400">
                          {formatNumber(t.requests)} · {formatUsd(t.cost_usd)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <div className="h-full rounded-full bg-brand-500 transition-all duration-500" style={{ width: `${Math.max(share, 1.5)}%` }} />
                        </div>
                        <span className="w-12 text-right text-[11px] tabular-nums text-zinc-500">{formatNumber(share)} %</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        </>
      )}

      <Card title={<span className="inline-flex items-center gap-2"><AlertTriangle className="size-4 text-red-500" /> Errores recientes</span>} description="Las 25 llamadas fallidas más recientes (de cualquier fecha). Con conmutación, un error no implica que la tarea fallase." padded={false}>
        {recentErrors.length === 0 ? (
          <EmptyState title="Sin errores registrados" description="Todas las llamadas recientes a modelos se han completado correctamente." className="py-10" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-4 py-2 font-medium">Cuándo</th>
                  <th className="px-3 py-2 font-medium">Tarea</th>
                  <th className="px-3 py-2 font-medium">Proveedor · modelo</th>
                  <th className="px-3 py-2 font-medium">Error</th>
                  <th className="px-4 py-2 text-right font-medium">Latencia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recentErrors.map((e, i) => (
                  <tr key={`${e.created_at}-${i}`} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-zinc-600 dark:text-zinc-400" title={formatDate(e.created_at, true)}>
                      {relativeTime(e.created_at)}
                    </td>
                    <td className="px-3 py-2">{AI_TASK_LABELS[e.task as AiTask] ?? e.task}</td>
                    <td className="px-3 py-2">
                      <div className="text-[13px]">{providerName(providers, e.provider)}</div>
                      <div className="max-w-[14rem] truncate font-mono text-[11px] text-zinc-500" title={e.model}>
                        {e.model}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {e.error_code && (
                        <Badge color="red" className="mb-1">
                          {ERROR_CODE_LABELS[e.error_code] ?? e.error_code}
                        </Badge>
                      )}
                      <div className="line-clamp-2 max-w-md break-words text-xs text-zinc-600 dark:text-zinc-400" title={e.error_message ?? undefined}>
                        {e.error_message ?? '—'}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{e.latency_ms ? formatMs(e.latency_ms) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
