import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Coins, FileSearch, ListChecks, MessageSquareText, Plus, ShieldAlert, Sparkles, StickyNote, Tags, Wand2 } from 'lucide-react';
import { ApiError, errorMessage, patch, post } from '../lib/api';
import { useBlueprint } from '../lib/hooks';
import { useSession } from '../lib/session';
import { formatNumber, formatValue } from '../lib/format';
import { t, tx } from '../lib/i18n';
import type { Module, Widget, WidgetData } from '../lib/types';
import { Alert, Badge, Button, Card, Input, Modal, Spinner } from './ui';
import { WidgetBody } from './WidgetBody';
import { useToast } from './toast';

/** Aviso común cuando la organización todavía no tiene proveedor de IA. */
function AiError({ error }: { error: unknown }) {
  const { can } = useSession();
  if (error instanceof ApiError && error.code === 'ai_not_configured') {
    return (
      <Alert tone="info" title={t('EVOLVE AI necesita un proveedor de IA')}>
        {can('admin')
          ? tx('Añade una API key (Claude, OpenAI, DeepSeek u OpenRouter) en <link>Ajustes › Proveedores de IA</link>.', {
              link: (c) => (
                <Link to="/settings/ai" className="font-semibold underline">
                  {c}
                </Link>
              ),
            })
          : t('Pide a un administrador que configure un proveedor de IA en los ajustes.')}
      </Alert>
    );
  }
  return <Alert tone="danger">{errorMessage(error)}</Alert>;
}

function ModelNote({ provider, model, costUsd }: { provider?: string | null; model?: string | null; costUsd?: number | null }) {
  if (!provider) return null;
  return (
    <p className="text-[11px] text-zinc-400">
      {t('Generado por {provider}/{model}', { provider, model })}
      {typeof costUsd === 'number' ? ` · ${costUsd < 0.01 ? `<${formatNumber(0.01, { minimumFractionDigits: 2 })}` : formatNumber(costUsd, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD` : ''} · {t('Revisa el resultado antes de usarlo.')}
    </p>
  );
}

// ------------------------------------------------------------------ consultas en lenguaje natural

interface QueryResult {
  widget: Widget;
  data: WidgetData;
  explanation: string;
  provider: string;
  model: string;
  costUsd: number | null;
}

// Función (no constante): los ejemplos se traducen al pintar, en el idioma de ese momento.
const examples = () => [t('¿Cuánto importe tenemos en oportunidades abiertas por etapa?'), t('¿Cuántos contactos nuevos hemos creado cada mes?'), t('Empresas por sector'), t('Tareas urgentes pendientes')];

export function AskDataCard() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useSession();
  const bp = useBlueprint();
  const [question, setQuestion] = useState('');
  const ask = useMutation({ mutationFn: (q: string) => post<QueryResult>('/ai/query', { question: q }) });
  const addToDashboard = useMutation({
    mutationFn: (r: QueryResult) => {
      const dash = bp.data?.blueprint.dashboards[0];
      if (!dash) throw new Error(t('No hay ningún panel al que añadir el widget'));
      const widget = { ...r.widget, key: `w_${Date.now().toString(36)}` };
      return post<{ id: string }>('/evolve/requests/manual', {
        changeSet: { title: t('Panel: añadir «{title}»', { title: r.widget.title }), summary: t('Añade al panel {dashboard} el widget «{title}» creado desde una pregunta en lenguaje natural.', { dashboard: dash.label, title: r.widget.title }), operations: [{ op: 'upsert_dashboard', dashboard: { ...dash, widgets: [...dash.widgets, widget] } }] },
      });
    },
    onSuccess: (r) => {
      toast(t('Cambio enviado: se valida y prueba antes de publicarse'));
      navigate(`/evolve/requests/${r.id}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim().length >= 4) ask.mutate(question.trim());
  };
  const r = ask.data;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <MessageSquareText className="size-4 text-fuchsia-500" /> {t('Pregunta a tus datos')}
        </span>
      }
      description={t('Escribe una pregunta y EVOLVE AI la convierte en una consulta segura sobre tus datos (nunca ejecuta SQL libre y respeta tus permisos).')}
    >
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('Ej.: ¿Qué importe hemos ganado cada mes este año?')} maxLength={500} aria-label={t('Pregunta sobre tus datos')} />
        <Button type="submit" variant="ai" icon={<Sparkles className="size-4" />} loading={ask.isPending} disabled={question.trim().length < 4}>
          {t('Preguntar')}
        </Button>
      </form>
      {!r && !ask.isPending && !ask.error && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {examples().map((ex) => (
            <button key={ex} type="button" onClick={() => { setQuestion(ex); ask.mutate(ex); }} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
              {ex}
            </button>
          ))}
        </div>
      )}
      {ask.isPending && (
        <p className="mt-4 flex items-center gap-2 text-sm text-zinc-500"><Spinner /> {t('Preparando la consulta…')}</p>
      )}
      {ask.error && <div className="mt-4"><AiError error={ask.error} /></div>}
      {r && !ask.isPending && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">{r.widget.title}</div>
              {r.explanation && <p className="text-xs text-zinc-500">{r.explanation}</p>}
            </div>
            {can('admin') && bp.data?.blueprint.dashboards.length ? (
              <Button size="sm" icon={<Plus className="size-3.5" />} loading={addToDashboard.isPending} onClick={() => addToDashboard.mutate(r)}>
                {t('Añadir al panel')}
              </Button>
            ) : null}
          </div>
          <div className="rounded-xl bg-zinc-50/70 p-3 ring-1 ring-zinc-100 dark:bg-zinc-900/50 dark:ring-zinc-800">
            <WidgetBody w={r.widget} data={r.data} />
          </div>
          <ModelNote provider={r.provider} model={r.model} costUsd={r.costUsd} />
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ clasificación de un registro

interface Suggestion {
  field: string;
  label: string;
  value: string;
  valueLabel: string;
  current: unknown;
  confidence: number;
  reason: string;
  multi: boolean;
}

export function ClassifyButton({ mod, recordId, data }: { mod: Module; recordId: string; data: Record<string, unknown> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const run = useMutation({
    mutationFn: () => post<{ summary: string; suggestions: Suggestion[]; provider: string; model: string; costUsd: number | null }>(`/records/${mod.key}/${recordId}/classify`),
    onSuccess: (r) => setPicked(Object.fromEntries(r.suggestions.map((s, i) => [i, s.confidence >= 0.6]))),
  });
  const apply = useMutation({
    mutationFn: () => {
      const values: Record<string, unknown> = {};
      (run.data?.suggestions ?? []).forEach((s, i) => {
        if (!picked[i]) return;
        if (s.multi) {
          const base = Array.isArray(values[s.field]) ? (values[s.field] as string[]) : Array.isArray(data[s.field]) ? [...(data[s.field] as string[])] : [];
          values[s.field] = base.includes(s.value) ? base : [...base, s.value];
        } else values[s.field] = s.value;
      });
      return patch(`/records/${mod.key}/${recordId}`, { values });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['record', mod.key, recordId] });
      qc.invalidateQueries({ queryKey: ['records', mod.key] });
      qc.invalidateQueries({ queryKey: ['timeline', mod.key, recordId] });
      toast(t('Clasificación aplicada'));
      setOpen(false);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const start = () => {
    setOpen(true);
    run.reset();
    run.mutate();
  };
  const chosen = Object.values(picked).filter(Boolean).length;
  return (
    <>
      <Button variant="ghost" size="sm" icon={<Tags className="size-3.5 text-fuchsia-500" />} onClick={start}>
        {t('Clasificar con IA')}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('Clasificación sugerida por EVOLVE AI')}
        description={t('La IA propone valores para los campos de selección a partir de los datos, relaciones y notas de la ficha. Nada se guarda hasta que lo apliques.')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('Cerrar')}</Button>
            {!!run.data?.suggestions.length && (
              <Button variant="primary" disabled={!chosen} loading={apply.isPending} onClick={() => apply.mutate()}>
                {chosen ? t('Aplicar ({count})', { count: chosen }) : t('Aplicar')}
              </Button>
            )}
          </>
        }
      >
        {run.isPending ? (
          <p className="flex items-center gap-2 py-6 text-sm text-zinc-500"><Spinner /> {t('Analizando la ficha…')}</p>
        ) : run.error ? (
          <AiError error={run.error} />
        ) : run.data ? (
          <div className="space-y-3">
            {run.data.summary && <p className="text-sm text-zinc-600 dark:text-zinc-300">{run.data.summary}</p>}
            {run.data.suggestions.length === 0 ? (
              <Alert tone="info">{t('No hay cambios que sugerir: la clasificación actual parece correcta o faltan datos para proponer otra.')}</Alert>
            ) : (
              <ul className="space-y-2">
                {run.data.suggestions.map((s, i) => (
                  <li key={`${s.field}-${s.value}`} className="rounded-lg p-3 ring-1 ring-zinc-200 dark:ring-zinc-800">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input type="checkbox" className="mt-1 size-4 accent-brand-600" checked={!!picked[i]} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{s.label}</span>
                          <span className="text-zinc-400">→</span>
                          <Badge color="violet">{s.valueLabel}</Badge>
                          <span className="text-xs text-zinc-400">{t('confianza {percent}%', { percent: Math.round(s.confidence * 100) })}</span>
                        </span>
                        {s.reason && <span className="mt-1 block text-xs text-zinc-500">{s.reason}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <ModelNote provider={run.data.provider} model={run.data.model} costUsd={run.data.costUsd} />
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ análisis de documentos

interface Analysis {
  summary: string;
  keyPoints: string[];
  dates: { date: string; description: string }[];
  amounts: { amount: number; currency: string; description: string }[];
  risks: string[];
  suggestedTasks: { title: string; dueDate?: string }[];
}

const ANALYZABLE = /\.(pdf|txt|csv|md|json)$/i;

export function canAnalyze(fileName: string) {
  return ANALYZABLE.test(fileName);
}

export function AnalyzeFileButton({ file, mod, recordId }: { file: { id: string; name: string }; mod: Module; recordId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const bp = useBlueprint();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Record<number, boolean>>({});
  const run = useMutation({
    mutationFn: () => post<{ analysis: Analysis; truncated: boolean; provider: string; model: string; costUsd: number | null }>(`/files/${file.id}/analyze`),
  });
  const tasks = bp.data?.blueprint.modules.find((m) => m.key === 'tasks' && !m.archived);
  const link = tasks?.fields.find((f) => f.type === 'relation' && !f.archived && f.relation?.module === mod.key);
  const saveNote = useMutation({
    mutationFn: (a: Analysis) => {
      // La nota se guarda ya en el idioma de quien la crea.
      const lines = [t('Análisis IA de «{name}»', { name: file.name }), '', a.summary];
      if (a.keyPoints.length) lines.push('', t('Puntos clave:'), ...a.keyPoints.map((p) => `• ${p}`));
      if (a.dates.length) lines.push('', t('Fechas:'), ...a.dates.map((d) => `• ${d.date}: ${d.description}`));
      if (a.amounts.length) lines.push('', t('Importes:'), ...a.amounts.map((x) => `• ${formatValue(x.amount, 'currency', x.currency || 'EUR')}: ${x.description}`));
      if (a.risks.length) lines.push('', t('Riesgos:'), ...a.risks.map((r) => `• ${r}`));
      return post(`/records/${mod.key}/${recordId}/notes`, { body: lines.join('\n').slice(0, 10_000) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', mod.key, recordId] });
      toast(t('Análisis guardado como nota'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const createTask = useMutation({
    mutationFn: ({ task }: { task: { title: string; dueDate?: string }; i: number }) => {
      const values: Record<string, unknown> = { title: task.title };
      if (task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) && tasks?.fields.some((f) => f.key === 'due_date')) values.due_date = task.dueDate;
      if (link) values[link.key] = recordId;
      return post('/records/tasks', { values });
    },
    onSuccess: (_r, v) => {
      setCreated((c) => ({ ...c, [v.i]: true }));
      qc.invalidateQueries({ queryKey: ['records', 'tasks'] });
      qc.invalidateQueries({ queryKey: ['record', mod.key, recordId] });
      toast(t('Tarea creada'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const start = () => {
    setOpen(true);
    setCreated({});
    run.reset();
    // Un análisis nuevo se puede volver a guardar (antes «Guardado como nota» se quedaba del anterior).
    saveNote.reset();
    run.mutate();
  };
  const a = run.data?.analysis;
  return (
    <>
      <button type="button" aria-label={t('Analizar {name} con IA', { name: file.name })} title={t('Analizar con IA')} className="text-zinc-400 hover:text-fuchsia-600" onClick={start}>
        <FileSearch className="size-3.5" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('Análisis de «{name}»', { name: file.name })} description={t('EVOLVE AI lee el documento y extrae lo importante. Revisa el resultado antes de actuar.')} size="lg" footer={<Button onClick={() => setOpen(false)}>{t('Cerrar')}</Button>}>
        {run.isPending ? (
          <p className="flex items-center gap-2 py-6 text-sm text-zinc-500"><Spinner /> {t('Leyendo el documento…')}</p>
        ) : run.error ? (
          <AiError error={run.error} />
        ) : a ? (
          <div className="space-y-4 text-sm">
            {run.data?.truncated && <Alert tone="warning">{t('El documento es muy largo: solo se ha analizado el principio.')}</Alert>}
            <p className="leading-relaxed">{a.summary}</p>
            {a.keyPoints.length > 0 && (
              <Section icon={<ListChecks className="size-4" />} title={t('Puntos clave')}>
                <ul className="list-disc space-y-1 pl-5">{a.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </Section>
            )}
            {a.dates.length > 0 && (
              <Section icon={<CalendarClock className="size-4" />} title={t('Fechas')}>
                <ul className="space-y-1">{a.dates.map((d, i) => <li key={i}><span className="font-mono text-xs">{d.date}</span> · {d.description}</li>)}</ul>
              </Section>
            )}
            {a.amounts.length > 0 && (
              <Section icon={<Coins className="size-4" />} title={t('Importes')}>
                <ul className="space-y-1">{a.amounts.map((x, i) => <li key={i}><span className="font-medium tabular-nums">{formatValue(x.amount, 'currency', x.currency || 'EUR')}</span> · {x.description}</li>)}</ul>
              </Section>
            )}
            {a.risks.length > 0 && (
              <Section icon={<ShieldAlert className="size-4" />} title={t('Riesgos')}>
                <ul className="list-disc space-y-1 pl-5">{a.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </Section>
            )}
            {a.suggestedTasks.length > 0 && (
              <Section icon={<Wand2 className="size-4" />} title={t('Tareas sugeridas')}>
                <ul className="space-y-1.5">
                  {a.suggestedTasks.map((task, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">{task.title}{task.dueDate ? <span className="text-xs text-zinc-500"> · {task.dueDate}</span> : null}</span>
                      {tasks && can(tasks.permissions.create) && (created[i] ? (
                        <Badge color="emerald">{t('Creada')}</Badge>
                      ) : (
                        <Button size="sm" icon={<Plus className="size-3.5" />} loading={createTask.isPending && createTask.variables?.i === i} disabled={createTask.isPending && createTask.variables?.i !== i} onClick={() => createTask.mutate({ task, i })}>{t('Crear tarea')}</Button>
                      ))}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <ModelNote provider={run.data?.provider} model={run.data?.model} costUsd={run.data?.costUsd} />
              {can(mod.permissions.update) && (
                <Button size="sm" icon={<StickyNote className="size-3.5" />} loading={saveNote.isPending} disabled={saveNote.isSuccess} onClick={() => saveNote.mutate(a)}>
                  {saveNote.isSuccess ? t('Guardado como nota') : t('Guardar como nota')}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">{icon} {title}</div>
      {children}
    </div>
  );
}
