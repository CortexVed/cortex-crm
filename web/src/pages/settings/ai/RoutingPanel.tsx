import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, Coins, Gauge, Plus, Route, Star, Trash2 } from 'lucide-react';
import { AI_TASKS, AI_TASK_LABELS, type AiTask } from '../../../../../shared/constants';
import { Alert, Badge, Button, Card, cx, ErrorState, Field, IconButton, Input, Select, Skeleton } from '../../../components/ui';
import { useToast } from '../../../components/toast';
import { get, put } from '../../../lib/api';
import { ModelPicker } from './ModelPicker';
import { AI_KEYS, cachedModel, describeError, FieldGroup, invalidateAiConfig, isUsable, providerName, ProviderMonogram } from './shared';
import type { AiLimits, AiSettings, AiSettingsInput, AiSettingsResponse, ModelPricing, ProviderState, RouteTarget, Routing } from './types';

const MAX_ROUTE = 5;

function useSaveSettings(message: string, onSaved: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: AiSettingsInput) => put<AiSettings>('/ai/settings', body),
    onSuccess: (saved) => {
      // Se actualiza la caché con lo guardado (sin parpadeo) y se recalculan las rutas efectivas.
      qc.setQueryData<AiSettingsResponse>(AI_KEYS.settings, (old) => (old && saved ? { ...old, settings: saved } : old));
      invalidateAiConfig(qc);
      onSaved();
      toast(message);
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
}

function providerOptionLabel(p: ProviderState) {
  return `${p.label}${!p.configured ? ' · sin API key' : !p.enabled ? ' · desactivado' : ''}`;
}

function SaveBar({ dirty, saving, disabled, onSave, onReset, error }: { dirty: boolean; saving: boolean; disabled?: boolean; onSave: () => void; onReset: () => void; error?: string | null }) {
  return (
    <div className="flex flex-col gap-2 border-t border-zinc-100 pt-3 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800">
      <span className={cx('text-xs', error ? 'text-red-600 dark:text-red-400' : 'text-zinc-500')}>{error ?? (dirty ? 'Hay cambios sin guardar.' : 'Sin cambios pendientes.')}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={onReset}>
          Descartar
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty || !!disabled} loading={saving} onClick={onSave}>
          Guardar
        </Button>
      </div>
    </div>
  );
}

function RouteChain({ targets, providers, max = 4 }: { targets: RouteTarget[]; providers: ProviderState[]; max?: number }) {
  if (!targets.length) return <span className="text-xs font-medium text-red-600 dark:text-red-400">Ningún proveedor disponible: esta tarea fallará hasta que configures uno.</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {targets.slice(0, max).map((t, i) => (
        <span key={`${t.provider}:${t.model}:${i}`} className="inline-flex items-center gap-1">
          {i > 0 && <ArrowRight className="size-3 text-zinc-400" />}
          <span className="inline-flex max-w-[16rem] items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" title={`${providerName(providers, t.provider)} · ${t.model}`}>
            <span className="font-semibold tabular-nums text-zinc-400">{i + 1}</span>
            <span className="shrink-0">{providerName(providers, t.provider)}</span>
            <span className="truncate font-mono text-zinc-500">{t.model}</span>
          </span>
        </span>
      ))}
      {targets.length > max && <span className="text-[11px] text-zinc-500">+{targets.length - max} más</span>}
    </span>
  );
}

// ---------------------------------------------------------------- proveedor y modelo por defecto

function DefaultCard({ data, providers }: { data: AiSettingsResponse; providers: ProviderState[] }) {
  const [draft, setDraft] = useState<{ provider: string | null; model: string | null } | null>(null);
  const cur = draft ?? { provider: data.settings.defaultProvider, model: data.settings.defaultModel };
  const prov = providers.find((p) => p.id === cur.provider);
  const save = useSaveSettings('Proveedor por defecto guardado', () => setDraft(null));
  const dirty = !!draft && (draft.provider !== data.settings.defaultProvider || draft.model !== data.settings.defaultModel);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Star className="size-4 text-amber-500" /> Proveedor y modelo por defecto</span>} description="Se usa en las tareas sin ruta propia y como respaldo cuando todas las opciones de una tarea fallan.">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <Field label="Proveedor">
            <Select value={cur.provider ?? ''} onChange={(e) => setDraft({ provider: e.target.value || null, model: null })}>
              <option value="">Automático (el primero disponible)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerOptionLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
          <FieldGroup label="Modelo">
            <ModelPicker
              provider={prov}
              value={cur.provider ? cur.model : null}
              disabled={!cur.provider}
              onChange={(m) => setDraft({ provider: cur.provider, model: m })}
              nullLabel={prov ? `Modelo por defecto del proveedor${prov.defaultModel ? ` (${prov.defaultModel})` : ''}` : 'Modelo por defecto de cada proveedor'}
              ariaLabel="Modelo por defecto de la organización"
            />
          </FieldGroup>
        </div>
        {prov && !(prov.configured && prov.enabled) && (
          <Alert tone="warning">{prov.label} no tiene API key o está desactivado: mientras tanto se usará el siguiente proveedor disponible.</Alert>
        )}
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onReset={() => setDraft(null)}
          onSave={() => save.mutate({ defaultProvider: cur.provider, defaultModel: cur.provider ? cur.model : null })}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- enrutado por tarea

function TaskRouteRow({
  task,
  label,
  entries,
  effective,
  providers,
  disabled,
  expanded,
  onToggle,
  onChange,
}: {
  task: AiTask;
  label: string;
  entries: RouteTarget[];
  effective: RouteTarget[];
  providers: ProviderState[];
  disabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: RouteTarget[]) => void;
}) {
  const usable = providers.filter(isUsable);
  const set = (i: number, t: RouteTarget) => onChange(entries.map((e, j) => (j === i ? t : e)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...entries];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const add = () => {
    const used = new Set(entries.map((e) => e.provider));
    const p = usable.find((x) => !used.has(x.id)) ?? usable[0] ?? providers[0];
    onChange([...entries, { provider: p?.id ?? '', model: p?.defaultModel ?? '' }]);
  };
  const first = entries[0];
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-start gap-3 text-left">
        <ChevronDown className={cx('mt-0.5 size-4 shrink-0 text-zinc-400 transition', !expanded && '-rotate-90')} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{label}</span>
            <span className="font-mono text-[11px] text-zinc-400">{task}</span>
            {disabled && <Badge color="red">Desactivada</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-zinc-500">
            {first ? (
              <>
                Ruta propia: {providerName(providers, first.provider)} · <span className="font-mono">{first.model || '(sin modelo)'}</span>
                {entries.length > 1 && ` + ${entries.length - 1} alternativa${entries.length > 2 ? 's' : ''}`}
              </>
            ) : (
              'Sin ruta propia: usa el modelo por defecto y después el resto de proveedores activos'
            )}
          </span>
        </span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">Ruta efectiva</span>
        <RouteChain targets={effective} providers={providers} />
      </div>
      {expanded && (
        <div className="mt-3 space-y-2 pl-7">
          {entries.length === 0 && <p className="text-xs text-zinc-500">Añade un modelo principal para fijar qué proveedor resuelve esta tarea.</p>}
          <ol className="space-y-2">
            {entries.map((e, i) => {
              const prov = providers.find((p) => p.id === e.provider);
              const dup = entries.findIndex((x) => x.provider === e.provider && x.model === e.model) !== i;
              const warn = !prov ? 'Proveedor desconocido' : !prov.configured ? 'Sin API key: se omitirá' : !prov.enabled ? 'Desactivado: se omitirá' : dup && e.model ? 'Duplicada: se ignorará' : null;
              return (
                <li key={i} className="rounded-lg bg-zinc-50 p-2 ring-1 ring-inset ring-zinc-200/60 dark:bg-zinc-950/40 dark:ring-zinc-800">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <span className={cx('w-24 shrink-0 text-xs font-medium', i === 0 ? 'text-brand-600 dark:text-brand-400' : 'text-zinc-500')}>{i === 0 ? 'Principal' : `Alternativa ${i}`}</span>
                    <Select
                      className="sm:w-52"
                      aria-label="Proveedor"
                      value={e.provider}
                      onChange={(ev) => {
                        const p = providers.find((x) => x.id === ev.target.value);
                        set(i, { provider: ev.target.value, model: p?.defaultModel ?? '' });
                      }}
                    >
                      {!prov && <option value={e.provider}>{e.provider || 'Elige proveedor'}</option>}
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {providerOptionLabel(p)}
                        </option>
                      ))}
                    </Select>
                    <div className="min-w-0 flex-1">
                      <ModelPicker provider={prov} value={e.model || null} invalid={!e.model} onChange={(m) => set(i, { ...e, model: m ?? '' })} ariaLabel={`Modelo de la entrada ${i + 1}`} />
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5 self-end sm:self-auto">
                      <IconButton label="Subir prioridad" disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton label="Bajar prioridad" disabled={i === entries.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown className="size-4" />
                      </IconButton>
                      <IconButton label="Quitar de la ruta" onClick={() => onChange(entries.filter((_, j) => j !== i))} danger>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </div>
                  {(warn || !e.model) && <p className={cx('mt-1.5 text-xs sm:pl-26', !e.model ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400')}>{!e.model ? 'Elige un modelo del catálogo o escribe su ID.' : warn}</p>}
                </li>
              );
            })}
          </ol>
          {entries.length < MAX_ROUTE ? (
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add}>
              {entries.length ? 'Añadir alternativa' : 'Añadir modelo principal'}
            </Button>
          ) : (
            <p className="text-xs text-zinc-500">Máximo {MAX_ROUTE} modelos por tarea.</p>
          )}
        </div>
      )}
    </li>
  );
}

function RoutingCard({ data, providers, disabledTasks }: { data: AiSettingsResponse; providers: ProviderState[]; disabledTasks: AiTask[] }) {
  const [draft, setDraft] = useState<Routing | null>(null);
  const [expanded, setExpanded] = useState<Set<AiTask>>(() => new Set());
  const routing = draft ?? data.settings.routing;
  const save = useSaveSettings('Enrutado guardado: las rutas efectivas se han recalculado', () => setDraft(null));
  const tasks = data.tasks.length ? data.tasks : AI_TASKS.map((key) => ({ key, label: AI_TASK_LABELS[key] }));
  const incomplete = tasks.some((t) => (routing[t.key] ?? []).some((e) => !e.provider || !e.model.trim()));
  const configuredCount = tasks.filter((t) => (routing[t.key] ?? []).length > 0).length;
  const toggle = (t: AiTask) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  const submit = () => {
    const clean: Routing = {};
    for (const t of tasks) {
      const list = (routing[t.key] ?? []).map((e) => ({ provider: e.provider, model: e.model.trim() })).filter((e) => e.provider && e.model);
      if (list.length) clean[t.key] = list.slice(0, MAX_ROUTE);
    }
    save.mutate({ routing: clean });
  };
  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><Route className="size-4 text-brand-500" /> Enrutado por tarea</span>}
      description="Cada tarea puede tener un modelo principal y hasta 4 alternativas en orden de prioridad."
      actions={
        <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded.size === tasks.length ? new Set() : new Set(tasks.map((t) => t.key)))}>
          {expanded.size === tasks.length ? 'Contraer todo' : 'Expandir todo'}
        </Button>
      }
    >
      <div className="space-y-4">
        <Alert tone="info" title="Conmutación automática por error">
          Si un proveedor falla (caída, límite de peticiones, saldo agotado o clave inválida), EVOLVE reintenta con el siguiente modelo de la ruta; después prueba el modelo por defecto y el resto de proveedores activos. Cada intento queda registrado en Consumo.
        </Alert>
        <p className="text-xs text-zinc-500">
          {configuredCount} de {tasks.length} tareas con ruta propia. La ruta efectiva refleja la configuración <strong className="font-medium">guardada</strong>
          {draft ? ': guarda para recalcularla.' : '.'}
        </p>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {tasks.map((t) => (
            <TaskRouteRow
              key={t.key}
              task={t.key}
              label={AI_TASK_LABELS[t.key] ?? t.label}
              entries={routing[t.key] ?? []}
              effective={data.effectiveRoutes[t.key] ?? []}
              providers={providers}
              disabled={disabledTasks.includes(t.key)}
              expanded={expanded.has(t.key)}
              onToggle={() => toggle(t.key)}
              onChange={(next) => setDraft({ ...routing, [t.key]: next })}
            />
          ))}
        </ul>
        <SaveBar dirty={!!draft} saving={save.isPending} disabled={incomplete} error={incomplete ? 'Completa el proveedor y el modelo de todas las entradas antes de guardar.' : null} onReset={() => setDraft(null)} onSave={submit} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- límites

interface LimitsDraft {
  budget: string;
  rph: string;
  maxOut: string;
  disabled: AiTask[];
}
const limitsToDraft = (l: AiLimits): LimitsDraft => ({ budget: l.monthlyBudgetUsd === null ? '' : String(l.monthlyBudgetUsd), rph: String(l.maxRequestsPerHour), maxOut: String(l.maxOutputTokens), disabled: [...l.disabledTasks] });

function LimitsCard({ data, onDisabledPreview }: { data: AiSettingsResponse; onDisabledPreview: (tasks: AiTask[] | null) => void }) {
  const [draft, setDraftState] = useState<LimitsDraft | null>(null);
  const setDraft = (d: LimitsDraft | null) => {
    setDraftState(d);
    onDisabledPreview(d ? d.disabled : null);
  };
  const cur = draft ?? limitsToDraft(data.settings.limits);
  const save = useSaveSettings('Límites de IA guardados', () => setDraft(null));
  const errors: Partial<Record<'budget' | 'rph' | 'maxOut', string>> = {};
  const budget = cur.budget.trim() === '' ? null : Number(cur.budget.replace(',', '.'));
  if (budget !== null && (!Number.isFinite(budget) || budget < 0 || budget > 1_000_000)) errors.budget = 'Introduce un importe entre 0 y 1.000.000 USD, o déjalo vacío.';
  const rph = Number(cur.rph);
  if (!Number.isInteger(rph) || rph < 1 || rph > 10_000) errors.rph = 'Número entero entre 1 y 10.000.';
  const maxOut = Number(cur.maxOut);
  if (!Number.isInteger(maxOut) || maxOut < 256 || maxOut > 128_000) errors.maxOut = 'Número entero entre 256 y 128.000.';
  const invalid = Object.keys(errors).length > 0;
  const toggleTask = (t: AiTask, on: boolean) => setDraft({ ...cur, disabled: on ? [...cur.disabled, t] : cur.disabled.filter((x) => x !== t) });
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Gauge className="size-4 text-sky-500" /> Límites y control de gasto</span>} description="Protegen a la organización de consumos inesperados. Se aplican a todas las llamadas de IA.">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Presupuesto mensual (USD)" error={errors.budget} hint="Vacío = sin límite. Se cuenta por mes natural.">
            <Input type="number" inputMode="decimal" min={0} step="0.01" placeholder="Sin límite" value={cur.budget} invalid={!!errors.budget} onChange={(e) => setDraft({ ...cur, budget: e.target.value })} />
          </Field>
          <Field label="Peticiones por hora" error={errors.rph} hint="Máximo de llamadas a modelos en 60 minutos.">
            <Input type="number" inputMode="numeric" min={1} max={10000} step={1} value={cur.rph} invalid={!!errors.rph} onChange={(e) => setDraft({ ...cur, rph: e.target.value })} />
          </Field>
          <Field label="Tokens de salida por petición" error={errors.maxOut} hint="Tope de longitud de cada respuesta.">
            <Input type="number" inputMode="numeric" min={256} max={128000} step={256} value={cur.maxOut} invalid={!!errors.maxOut} onChange={(e) => setDraft({ ...cur, maxOut: e.target.value })} />
          </Field>
        </div>
        <FieldGroup label="Tareas desactivadas" hint="Una tarea desactivada falla al instante con un aviso (por ejemplo, desactivar «Creación de funcionalidades» detiene el motor de evolución).">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {AI_TASKS.map((t) => {
              const on = cur.disabled.includes(t);
              return (
                <label key={t} className={cx('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ring-1 ring-inset transition', on ? 'bg-red-50 ring-red-200 dark:bg-red-500/10 dark:ring-red-500/25' : 'ring-zinc-200/70 hover:bg-zinc-50 dark:ring-zinc-800 dark:hover:bg-zinc-800/50')}>
                  <input type="checkbox" className="size-4 rounded accent-red-600" checked={on} onChange={(e) => toggleTask(t, e.target.checked)} />
                  <span className="min-w-0 flex-1 truncate">{AI_TASK_LABELS[t]}</span>
                  {on && <span className="text-[11px] font-medium text-red-600 dark:text-red-400">Desactivada</span>}
                </label>
              );
            })}
          </div>
        </FieldGroup>
        <SaveBar
          dirty={!!draft}
          saving={save.isPending}
          disabled={invalid}
          error={invalid ? 'Revisa los valores marcados.' : null}
          onReset={() => setDraft(null)}
          onSave={() => save.mutate({ limits: { monthlyBudgetUsd: budget, maxRequestsPerHour: rph, maxOutputTokens: maxOut, disabledTasks: cur.disabled } })}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- precios

interface PriceRow {
  provider: string;
  model: string;
  input: string;
  output: string;
}

const pricingToRows = (p: Record<string, ModelPricing>): PriceRow[] =>
  Object.entries(p).map(([k, v]) => {
    const i = k.indexOf(':');
    return { provider: i > 0 ? k.slice(0, i) : k, model: i > 0 ? k.slice(i + 1) : '', input: String(v.inputPerM), output: String(v.outputPerM) };
  });

const parsePrice = (s: string) => {
  const n = Number(s.trim().replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : null;
};

function PricingCard({ data, providers }: { data: AiSettingsResponse; providers: ProviderState[] }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<PriceRow[] | null>(null);
  const rows = draft ?? pricingToRows(data.settings.pricing);
  const firstProvider = providers.find(isUsable) ?? providers[0];
  const [form, setForm] = useState<PriceRow>({ provider: firstProvider?.id ?? '', model: '', input: '', output: '' });
  const save = useSaveSettings('Precios guardados: se aplicarán a las próximas llamadas', () => setDraft(null));
  const formProvider = providers.find((p) => p.id === form.provider);

  const rowError = (r: PriceRow, i: number): string | null => {
    if (!r.provider || !r.model.trim()) return 'Falta el modelo';
    if (`${r.provider}:${r.model.trim()}`.length > 250) return 'ID demasiado largo';
    if (parsePrice(r.input) === null || parsePrice(r.output) === null) return 'Precio entre 0 y 10.000';
    if (rows.findIndex((x) => x.provider === r.provider && x.model.trim() === r.model.trim()) !== i) return 'Duplicado';
    return null;
  };
  const errors = rows.map(rowError);
  const invalid = errors.some(Boolean);
  const formDup = rows.some((x) => x.provider === form.provider && x.model.trim() === form.model.trim());
  const formValid = !!form.provider && !!form.model.trim() && parsePrice(form.input) !== null && parsePrice(form.output) !== null && !formDup;

  const pickModel = (m: string | null) => {
    const info = m ? cachedModel(qc, form.provider, m) : undefined;
    setForm({ ...form, model: m ?? '', input: info?.pricing ? String(info.pricing.inputPerM) : form.input, output: info?.pricing ? String(info.pricing.outputPerM) : form.output });
  };
  const addRow = () => {
    if (!formValid) return;
    setDraft([...rows, { ...form, model: form.model.trim() }]);
    setForm({ ...form, model: '', input: '', output: '' });
  };
  const update = (i: number, patch: Partial<PriceRow>) => setDraft(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const submit = () => {
    const pricing: Record<string, ModelPricing> = {};
    for (const r of rows) pricing[`${r.provider}:${r.model.trim()}`] = { inputPerM: parsePrice(r.input) ?? 0, outputPerM: parsePrice(r.output) ?? 0 };
    save.mutate({ pricing });
  };

  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><Coins className="size-4 text-emerald-500" /> Precios por modelo</span>}
      description="USD por millón de tokens. Tienen prioridad sobre los precios del catálogo del proveedor y los precios públicos conocidos."
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-zinc-500">
          Claude usa sus precios públicos y OpenRouter informa del coste real de cada llamada. Para el resto (OpenAI, DeepSeek…) añade aquí sus precios: las llamadas sin precio conocido aparecen como «sin precio» en Consumo y <strong className="font-medium text-zinc-700 dark:text-zinc-300">no cuentan para el presupuesto mensual</strong>.
        </p>
        {rows.length > 0 ? (
          <div className="overflow-x-auto rounded-lg ring-1 ring-zinc-200/80 dark:ring-zinc-800">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-zinc-50 text-left text-xs text-zinc-500 dark:bg-zinc-900/60">
                <tr>
                  <th className="px-3 py-2 font-medium">Proveedor · modelo</th>
                  <th className="w-32 px-3 py-2 font-medium">Entrada / 1M</th>
                  <th className="w-32 px-3 py-2 font-medium">Salida / 1M</th>
                  <th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r, i) => (
                  <tr key={`${r.provider}:${r.model}:${i}`}>
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <ProviderMonogram provider={{ id: r.provider, label: providerName(providers, r.provider) }} size="sm" />
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[12.5px]">{r.model}</div>
                          <div className="text-[11px] text-zinc-500">{providerName(providers, r.provider)}</div>
                        </div>
                      </div>
                      {errors[i] && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{errors[i]}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <Input aria-label="Precio de entrada" inputMode="decimal" value={r.input} invalid={parsePrice(r.input) === null} onChange={(e) => update(i, { input: e.target.value })} className="h-8 tabular-nums" />
                    </td>
                    <td className="px-3 py-2">
                      <Input aria-label="Precio de salida" inputMode="decimal" value={r.output} invalid={parsePrice(r.output) === null} onChange={(e) => update(i, { output: e.target.value })} className="h-8 tabular-nums" />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <IconButton label="Quitar precio" onClick={() => setDraft(rows.filter((_, j) => j !== i))} danger>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-sm text-zinc-500 dark:border-zinc-700">No hay precios personalizados.</p>
        )}

        <div className="rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:ring-zinc-800">
          <div className="mb-2 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">Añadir precio</div>
          <div className="grid gap-2 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_7rem_7rem_auto]">
            <Select aria-label="Proveedor" value={form.provider} onChange={(e) => setForm({ provider: e.target.value, model: '', input: '', output: '' })}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <ModelPicker provider={formProvider} value={form.model || null} onChange={pickModel} ariaLabel="Modelo al que aplicar el precio" />
            <Input aria-label="Entrada USD por 1M tokens" placeholder="Entrada" inputMode="decimal" value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} />
            <Input aria-label="Salida USD por 1M tokens" placeholder="Salida" inputMode="decimal" value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} />
            <Button icon={<Plus className="size-3.5" />} disabled={!formValid} onClick={addRow}>
              Añadir
            </Button>
          </div>
          {formDup && <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">Ese modelo ya tiene precio: edítalo en la tabla.</p>}
          <p className="mt-1.5 text-xs text-zinc-500">Si el catálogo del proveedor publica el precio, se rellena automáticamente al elegir el modelo.</p>
        </div>

        <SaveBar dirty={!!draft} saving={save.isPending} disabled={invalid} error={invalid ? 'Corrige las filas marcadas antes de guardar.' : null} onReset={() => setDraft(null)} onSave={submit} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- panel

export function RoutingPanel({ providers }: { providers: ProviderState[] }) {
  const q = useQuery({ queryKey: AI_KEYS.settings, queryFn: () => get<AiSettingsResponse>('/ai/settings') });
  const [disabledPreview, setDisabledPreview] = useState<AiTask[] | null>(null);
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-96" />
      </div>
    );
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  const visible = providers.filter((p) => p.id !== 'mock' || p.configured);
  let note: ReactNode = null;
  if (!providers.some(isUsable)) note = <Alert tone="warning">Ningún proveedor está listo (API key + activo + modelo). Las rutas se guardarán, pero no se resolverán hasta que configures uno en «Proveedores».</Alert>;
  return (
    <div className="space-y-5">
      {note}
      <DefaultCard data={data} providers={visible} />
      <RoutingCard data={data} providers={visible} disabledTasks={disabledPreview ?? data.settings.limits.disabledTasks} />
      <LimitsCard data={data} onDisabledPreview={setDisabledPreview} />
      <PricingCard data={data} providers={visible} />
    </div>
  );
}
