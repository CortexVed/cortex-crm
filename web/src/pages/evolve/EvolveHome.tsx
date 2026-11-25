import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Brain, CheckCircle2, FlaskConical, GitBranch, Lightbulb, Rocket, RotateCcw, ScanSearch, ShieldCheck, Sparkles, UserCheck, Wand2, Workflow } from 'lucide-react';
import { errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { relativeTime } from '../../lib/format';
import type { EvolutionRequestSummary } from '../../lib/types';
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { useToast } from '../../components/toast';
import { EXAMPLES, RiskBadge, RUNNING, StatusBadge } from './shared';

const STEPS = [
  { icon: Brain, label: 'Interpretar' },
  { icon: ScanSearch, label: 'Analizar' },
  { icon: Workflow, label: 'Planificar' },
  { icon: GitBranch, label: 'Desarrollar aislado' },
  { icon: FlaskConical, label: 'Probar' },
  { icon: Lightbulb, label: 'Presentar' },
  { icon: UserCheck, label: 'Autorizar' },
  { icon: Rocket, label: 'Desplegar' },
  { icon: CheckCircle2, label: 'Verificar' },
  { icon: RotateCcw, label: 'Recuperar' },
];

function Advice() {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const latest = useQuery({ queryKey: ['evolve', 'advice'], queryFn: () => get<EvolutionRequestSummary[]>('/evolve/requests?kind=advice') });
  const current = latest.data?.[0];
  const detail = useQuery({
    queryKey: ['evolve', 'request', current?.id],
    queryFn: () => get<any>(`/evolve/requests/${current!.id}`),
    enabled: !!current,
    refetchInterval: (q) => (q.state.data && RUNNING.has(q.state.data.status) ? 2000 : false),
  });
  const run = useMutation({ mutationFn: () => post('/evolve/advice'), onSuccess: () => qc.invalidateQueries({ queryKey: ['evolve', 'advice'] }), onError: (e) => toast(errorMessage(e), 'error') });
  const use = useMutation({ mutationFn: (prompt: string) => post<{ id: string }>('/evolve/requests', { prompt }), onSuccess: (r) => navigate(`/evolve/requests/${r.id}`), onError: (e) => toast(errorMessage(e), 'error') });
  const report = detail.data?.status === 'ready_for_review' ? detail.data.impact : null;
  const running = detail.data && RUNNING.has(detail.data.status);
  return (
    <Card title={<span className="flex items-center gap-2"><Lightbulb className="size-4 text-amber-500" /> Propuestas de mejora</span>} description="La IA analiza la estructura y el uso real (sin datos personales) y propone mejoras del propio CRM." actions={<Button size="sm" loading={run.isPending || !!running} onClick={() => run.mutate()}>{current ? 'Volver a analizar' : 'Analizar mi CRM'}</Button>}>
      {latest.isLoading ? (
        <Skeleton className="h-20" />
      ) : !current ? (
        <p className="text-sm text-zinc-500">Todavía no hay análisis. Pulsa «Analizar mi CRM».</p>
      ) : running ? (
        <p className="text-sm text-zinc-500">Analizando… esto puede tardar un minuto.</p>
      ) : detail.data?.status === 'failed' ? (
        <Alert tone="danger">{detail.data.error}</Alert>
      ) : report ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{report.summary}</p>
          {report.suggestions?.map((s: any, i: number) => (
            <div key={i} className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200/70 dark:bg-zinc-800/40 dark:ring-zinc-800">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium">{s.title}</div>
                <Badge color={s.impact === 'alto' ? 'fuchsia' : s.impact === 'medio' ? 'amber' : 'slate'}>Impacto {s.impact}</Badge>
              </div>
              <p className="mt-1 text-sm text-zinc-500">{s.description}</p>
              <Button size="sm" variant="ghost" className="mt-1.5 -ml-2" icon={<Wand2 className="size-3.5 text-brand-500" />} loading={use.isPending && use.variables === s.prompt} onClick={() => use.mutate(s.prompt)}>
                Preparar este cambio
              </Button>
            </div>
          ))}
          <p className="text-[11px] text-zinc-400">{report.model} · {relativeTime(report.ranAt)}</p>
        </div>
      ) : null}
    </Card>
  );
}

export default function EvolveHome() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const [prompt, setPrompt] = useState('');
  // Texto pedido desde la paleta de comandos: al montar y, si ya estaba abierta la página, con el evento.
  useEffect(() => {
    const consume = () => {
      const pre = sessionStorage.getItem('evolve-prefill');
      if (pre) {
        setPrompt(pre);
        sessionStorage.removeItem('evolve-prefill');
      }
    };
    consume();
    window.addEventListener('evolve:prefill', consume);
    return () => window.removeEventListener('evolve:prefill', consume);
  }, []);
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => get<{ configured: boolean }>('/ai/status') });
  const list = useQuery({
    queryKey: ['evolve', 'requests'],
    queryFn: () => get<EvolutionRequestSummary[]>('/evolve/requests'),
    refetchInterval: (q) => (q.state.data?.some((r) => RUNNING.has(r.status)) ? 3000 : false),
  });
  const submit = useMutation({
    mutationFn: () => post<{ id: string }>('/evolve/requests', { prompt }),
    onSuccess: (r) => navigate(`/evolve/requests/${r.id}`),
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <section className="relative overflow-hidden rounded-3xl bg-zinc-950 p-6 text-white ring-1 ring-zinc-800 sm:p-8">
        <div className="absolute -left-24 -top-24 size-80 rounded-full bg-brand-600/35 blur-3xl" />
        <div className="absolute -bottom-32 right-0 size-96 rounded-full bg-fuchsia-600/25 blur-3xl" />
        <div className="relative">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 ring-1 ring-white/15">
            <Sparkles className="size-3.5 text-fuchsia-300" /> EVOLVE AI ENGINE
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">¿Cómo quieres que evolucione tu CRM?</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">Descríbelo con tus palabras. La IA lo interpreta, analiza tu configuración, planifica los cambios, los desarrolla y prueba en un entorno aislado y te los presenta. Nada llega a producción sin tu aprobación, y todo se puede revertir.</p>
          {status.data && !status.data.configured && (
            <Alert tone="warning" onDark className="mt-4">
              No hay ningún proveedor de IA configurado. {can('admin') ? <Link to="/settings/ai" className="font-semibold underline">Configurar ahora</Link> : 'Pide a un administrador que configure uno.'}
              {can('admin') && <> También puedes hacer cambios sin IA desde <Link to="/settings/customization" className="font-semibold underline">Personalización</Link>.</>}
            </Alert>
          )}
          {can('builder') ? (
            <form className="mt-5" onSubmit={(e) => { e.preventDefault(); if (prompt.trim().length >= 8 && !submit.isPending) submit.mutate(); }}>
              <div className="rounded-2xl bg-white/[0.06] p-2 ring-1 ring-white/15 focus-within:ring-fuchsia-400/60">
                {/* Textarea propio (no el de ui.tsx): sus clases base (fondo blanco, anillo) no se pueden anular con className. */}
                <textarea
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      // Las mismas condiciones que el botón: sin doble envío ni saltarse un botón desactivado.
                      if (prompt.trim().length >= 8 && !submit.isPending && status.data?.configured !== false) submit.mutate();
                    }
                  }}
                  aria-label="Describe el cambio"
                  placeholder="Ej.: Quiero un módulo para gestionar contratos con fechas de vencimiento, documentos adjuntos y avisos automáticos 30 días antes…"
                  className="block min-h-20 w-full resize-y rounded-lg bg-transparent px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none"
                />
                <div className="flex items-center justify-between gap-2 px-1 pb-1">
                  <span className="text-[11px] text-zinc-500">⌘/Ctrl + Enter para enviar</span>
                  <Button type="submit" variant="ai" loading={submit.isPending} disabled={prompt.trim().length < 8 || status.data?.configured === false} icon={<Wand2 className="size-4" />}>Planificar cambio</Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" onClick={() => setPrompt(ex)} className="max-w-full truncate rounded-full bg-white/5 px-3 py-1 text-xs text-zinc-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white">
                    {ex.length > 70 ? ex.slice(0, 68) + '…' : ex}
                  </button>
                ))}
              </div>
            </form>
          ) : (
            <p className="mt-5 text-sm text-zinc-400">Tu rol permite consultar la evolución del CRM. Para pedir cambios necesitas el rol Constructor o superior.</p>
          )}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Peticiones de evolución" padded={false} actions={<Link to="/evolve/releases" className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">Ver versiones</Link>}>
          {list.isLoading ? (
            <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : !list.data!.length ? (
            <EmptyState icon={<Wand2 className="size-5" />} title="Aún no has pedido ningún cambio" description="Describe arriba lo que necesitas o usa uno de los ejemplos." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.data!.map((r) => (
                <li key={r.id}>
                  <Link to={`/evolve/requests/${r.id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', r.source === 'manual' ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800' : 'bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/10')}>
                      {r.source === 'manual' ? <Workflow className="size-4" /> : <Sparkles className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.title ?? r.prompt}</span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">{r.requested_by_name ?? '—'} · {relativeTime(r.created_at)}{r.source === 'manual' ? ' · cambio manual' : ''}</span>
                    </span>
                    <span className="hidden flex-col items-end gap-1 sm:flex">
                      <StatusBadge status={r.status} />
                      <RiskBadge risk={r.risk} />
                    </span>
                    <ArrowRight className="size-4 text-zinc-300" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Así funciona">
            <ol className="space-y-2.5">
              {STEPS.map((s, i) => (
                <li key={s.label} className="flex items-center gap-3 text-sm">
                  <span className={cx('flex size-7 items-center justify-center rounded-lg text-xs font-semibold', i < 6 ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : i === 6 ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300')}>
                    <s.icon className="size-3.5" />
                  </span>
                  <span className="flex-1">{s.label}</span>
                  <span className="text-[11px] text-zinc-400">{i < 6 ? 'IA' : i === 6 ? 'Tú' : 'Sistema'}</span>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-800/40">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              La IA nunca modifica producción directamente: los cambios se prueban en un sandbox, quedan auditados y requieren tu aprobación.
            </div>
          </Card>
          {can('builder') && status.data?.configured && <Advice />}
        </div>
      </div>
    </div>
  );
}
