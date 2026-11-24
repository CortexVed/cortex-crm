import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Coins, Copy, GitCompareArrows, Hash, Plus, Sparkles, Trash2, Trophy, Zap } from 'lucide-react';
import { Alert, Badge, Button, Card, cx, EmptyState, Field, IconButton, Select, Skeleton, Textarea } from '../../../components/ui';
import { useToast } from '../../../components/toast';
import { Markdown } from '../../../components/Markdown';
import { post } from '../../../lib/api';
import { formatNumber } from '../../../lib/format';
import { ModelPicker } from './ModelPicker';
import { describeError, FieldGroup, formatMs, formatUsd, invalidateUsage, providerName, ProviderMonogram } from './shared';
import type { CompareResult, ProviderState, RouteTarget } from './types';

const MIN_TARGETS = 2;
const MAX_TARGETS = 4;

function initialTargets(usable: ProviderState[]): RouteTarget[] {
  const out: RouteTarget[] = usable.slice(0, MIN_TARGETS).map((p) => ({ provider: p.id, model: p.defaultModel ?? '' }));
  while (out.length < MIN_TARGETS && usable[0]) out.push({ provider: usable[0].id, model: '' });
  return out;
}

const GRID: Record<number, string> = { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-2 xl:grid-cols-3', 4: 'md:grid-cols-2 xl:grid-cols-4' };

export function ComparePanel({ providers, onGoToProviders }: { providers: ProviderState[]; onGoToProviders: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const usable = providers.filter((p) => p.configured && p.enabled);
  const [targets, setTargets] = useState<RouteTarget[]>(() => initialTargets(usable));
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [run, setRun] = useState<{ targets: RouteTarget[]; results: CompareResult[] | null } | null>(null);

  const compare = useMutation({
    mutationFn: (body: { prompt: string; system?: string; targets: RouteTarget[] }) => post<{ results: CompareResult[] }>('/ai/compare', body),
    onMutate: (body) => setRun({ targets: body.targets, results: null }),
    onSuccess: (r, body) => {
      setRun({ targets: body.targets, results: r.results });
      invalidateUsage(qc);
      const ok = r.results.filter((x) => x.ok).length;
      toast(ok === r.results.length ? 'Comparativa completada' : `Comparativa completada: ${r.results.length - ok} modelo(s) con error`, ok ? 'success' : 'error');
    },
    onError: (e) => {
      setRun(null);
      toast(describeError(e), 'error');
    },
  });

  if (!usable.length) {
    return (
      <Card>
        <EmptyState
          icon={<GitCompareArrows className="size-5" />}
          title="Necesitas al menos un proveedor configurado"
          description="Añade una API key y activa un proveedor para comparar sus modelos. Con uno solo puedes comparar dos modelos distintos del mismo proveedor."
          action={
            <Button variant="primary" onClick={onGoToProviders}>
              Configurar proveedores
            </Button>
          }
        />
      </Card>
    );
  }

  const setTarget = (i: number, t: RouteTarget) => setTargets(targets.map((x, j) => (j === i ? t : x)));
  const addTarget = () => {
    const used = new Set(targets.map((t) => t.provider));
    const p = usable.find((x) => !used.has(x.id)) ?? usable[0];
    setTargets([...targets, { provider: p.id, model: used.has(p.id) ? '' : p.defaultModel ?? '' }]);
  };
  const promptOk = prompt.trim().length >= 2 && prompt.length <= 8000;
  const targetsOk = targets.length >= MIN_TARGETS && targets.every((t) => t.provider && t.model.trim());
  const submit = () => {
    if (!promptOk || !targetsOk) return;
    compare.mutate({ prompt: prompt.trim(), system: system.trim() || undefined, targets: targets.map((t) => ({ provider: t.provider, model: t.model.trim() })) });
  };

  const results = run?.results ?? null;
  const okResults = (results ?? []).filter((r): r is Extract<CompareResult, { ok: true }> => r.ok);
  const fastest = okResults.length > 1 ? okResults.reduce((a, b) => (b.latencyMs < a.latencyMs ? b : a)) : null;
  const priced = okResults.filter((r) => r.costUsd !== null);
  const cheapest = priced.length > 1 ? priced.reduce((a, b) => ((b.costUsd ?? Infinity) < (a.costUsd ?? Infinity) ? b : a)) : null;

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><GitCompareArrows className="size-4 text-fuchsia-500" /> Comparar modelos</span>} description="Envía el mismo prompt a 2–4 modelos a la vez y compara calidad, velocidad y coste antes de decidir el enrutado.">
        <div className="space-y-4">
          <FieldGroup label="Modelos a comparar">
            <ol className="space-y-2">
              {targets.map((t, i) => {
                const prov = providers.find((p) => p.id === t.provider);
                return (
                  <li key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <span className="flex w-6 shrink-0 items-center justify-center text-xs font-semibold tabular-nums text-zinc-400">{String.fromCharCode(65 + i)}</span>
                    <Select
                      className="sm:w-52"
                      aria-label={`Proveedor ${String.fromCharCode(65 + i)}`}
                      value={t.provider}
                      onChange={(e) => {
                        const p = providers.find((x) => x.id === e.target.value);
                        setTarget(i, { provider: e.target.value, model: p?.defaultModel ?? '' });
                      }}
                    >
                      {!usable.some((p) => p.id === t.provider) && <option value={t.provider}>{providerName(providers, t.provider)} (no disponible)</option>}
                      {usable.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                    <div className="min-w-0 flex-1">
                      <ModelPicker provider={prov} value={t.model || null} invalid={!t.model} onChange={(m) => setTarget(i, { ...t, model: m ?? '' })} ariaLabel={`Modelo ${String.fromCharCode(65 + i)}`} />
                    </div>
                    <IconButton label="Quitar modelo" disabled={targets.length <= MIN_TARGETS} onClick={() => setTargets(targets.filter((_, j) => j !== i))} className="self-end hover:text-red-600 disabled:opacity-30 sm:self-auto">
                      <Trash2 className="size-4" />
                    </IconButton>
                  </li>
                );
              })}
            </ol>
            {targets.length < MAX_TARGETS && (
              <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="size-3.5" />} onClick={addTarget}>
                Añadir modelo
              </Button>
            )}
          </FieldGroup>

          <Field label="Prompt" required hint={`${formatNumber(prompt.length)} / 8.000 caracteres`} error={prompt.length > 8000 ? 'Máximo 8.000 caracteres' : undefined}>
            <Textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ej.: Resume en 5 puntos el estado de una oportunidad de 25.000 € en negociación y propone el siguiente paso."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </Field>

          {showSystem ? (
            <Field label="Instrucciones de sistema (opcional)" hint="Se envían igual a todos los modelos." error={system.length > 4000 ? 'Máximo 4.000 caracteres' : undefined}>
              <Textarea rows={3} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="Ej.: Eres un analista comercial. Responde en español, de forma concisa." />
            </Field>
          ) : (
            <button type="button" onClick={() => setShowSystem(true)} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
              + Añadir instrucciones de sistema
            </button>
          )}

          <div className="flex flex-col gap-2 border-t border-zinc-100 pt-3 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800">
            <p className="text-xs text-zinc-500">Cada comparativa consume tokens de todos los modelos y cuenta para el presupuesto y el límite por hora.</p>
            <Button variant="ai" icon={<Sparkles className="size-4" />} loading={compare.isPending} disabled={!promptOk || !targetsOk || system.length > 4000} onClick={submit}>
              Comparar
            </Button>
          </div>
        </div>
      </Card>

      {run && (
        <div className={cx('grid gap-4', GRID[run.targets.length] ?? 'md:grid-cols-2')}>
          {run.targets.map((t, i) => {
            const r = results?.[i];
            const prov = { id: t.provider, label: providerName(providers, t.provider) };
            return (
              <section key={`${t.provider}:${t.model}:${i}`} className="flex min-w-0 flex-col rounded-xl bg-white shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
                <header className="flex items-start gap-2.5 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                  <ProviderMonogram provider={prov} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-zinc-400">{String.fromCharCode(65 + i)}</span>
                      <span className="text-sm font-semibold">{prov.label}</span>
                      {r?.ok && fastest === r && (
                        <Badge color="sky">
                          <Zap className="size-3" /> Más rápido
                        </Badge>
                      )}
                      {r?.ok && cheapest === r && (
                        <Badge color="emerald">
                          <Trophy className="size-3" /> Más barato
                        </Badge>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-zinc-500" title={t.model}>
                      {t.model}
                    </div>
                  </div>
                  {r?.ok && (
                    <IconButton
                      label="Copiar respuesta"
                      onClick={() =>
                        navigator.clipboard
                          .writeText(r.text)
                          .then(() => toast('Respuesta copiada'))
                          .catch(() => toast('No se pudo copiar al portapapeles', 'error'))
                      }
                    >
                      <Copy className="size-4" />
                    </IconButton>
                  )}
                </header>
                <div className="min-h-40 flex-1 px-4 py-3">
                  {!r ? (
                    <div className="space-y-2" aria-label="Esperando respuesta">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                      <Skeleton className="h-4 w-2/3" />
                      <p className="pt-2 text-xs text-zinc-400">Esperando respuesta…</p>
                    </div>
                  ) : r.ok ? (
                    <div className="max-h-[28rem] overflow-y-auto pr-1 scrollbar-thin">
                      {r.text.trim() ? <Markdown text={r.text} /> : <p className="text-sm italic text-zinc-500">(Respuesta vacía)</p>}
                    </div>
                  ) : (
                    <Alert tone="danger" title="Error">
                      <span className="break-words">{r.error}</span>
                    </Alert>
                  )}
                </div>
                {r?.ok && (
                  <footer className="grid grid-cols-3 gap-2 rounded-b-xl border-t border-zinc-100 bg-zinc-50/60 px-4 py-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/60">
                    <div title="Latencia total">
                      <div className="flex items-center gap-1 text-zinc-500">
                        <Clock className="size-3" /> Latencia
                      </div>
                      <div className="font-medium tabular-nums">{formatMs(r.latencyMs)}</div>
                    </div>
                    <div title="Tokens de entrada / salida">
                      <div className="flex items-center gap-1 text-zinc-500">
                        <Hash className="size-3" /> Tokens
                      </div>
                      <div className="font-medium tabular-nums">
                        {formatNumber(r.inputTokens)} / {formatNumber(r.outputTokens)}
                      </div>
                    </div>
                    <div title={r.costUsd === null ? 'Sin precio configurado para este modelo' : 'Coste estimado'}>
                      <div className="flex items-center gap-1 text-zinc-500">
                        <Coins className="size-3" /> Coste
                      </div>
                      <div className="font-medium tabular-nums">{r.costUsd === null ? 'Sin precio' : formatUsd(r.costUsd)}</div>
                    </div>
                    {r.servedModel && r.servedModel !== t.model && (
                      <div className="col-span-3 truncate text-[11px] text-zinc-500" title={r.servedModel}>
                        Modelo servido: <span className="font-mono">{r.servedModel}</span>
                      </div>
                    )}
                  </footer>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
