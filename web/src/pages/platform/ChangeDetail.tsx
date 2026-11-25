import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCircle2, ChevronDown, CircleDashed, CircleDot, FlaskConical, Info, Loader2, MessageSquare, MinusCircle, Rocket, RotateCcw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { errorMessage, get, post } from '../../lib/api';
import { formatBytes, formatDate, relativeTime } from '../../lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, cx, ErrorState, Field, PageLoader, Textarea } from '../../components/ui';
import { useToast } from '../../components/toast';
import { ACTIVE, shortId, STATUS, type ChangeDetail as Detail, type CiAttempt, type ProgressEntry } from './codeTypes';
import { DiffViewer } from './DiffViewer';

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, color: 'slate' };
  return <Badge color={s.color} dot>{s.label}</Badge>;
}

const StepIcon = ({ status }: { status: ProgressEntry['status'] | 'pending' }) =>
  status === 'done' ? <CheckCircle2 className="size-4 text-emerald-500" /> : status === 'running' ? <Loader2 className="size-4 animate-spin text-brand-500" /> : status === 'failed' ? <XCircle className="size-4 text-red-500" /> : status === 'skipped' ? <MinusCircle className="size-4 text-zinc-300 dark:text-zinc-600" /> : <CircleDashed className="size-4 text-zinc-300 dark:text-zinc-700" />;

/** Línea de tiempo completa (las fases pueden repetirse: auto-corrección, refinados, rollback). */
function Timeline({ change }: { change: Detail }) {
  const labels = new Map(change.steps.map((s) => [s.key, s.label]));
  const entries = [...change.progress].reverse();
  const last = new Map<string, ProgressEntry>();
  for (const p of change.progress) last.set(p.step, p);
  const active = ACTIVE.has(change.status);
  // Solo gira lo que de verdad está en curso: la última entrada de cada fase de un cambio activo.
  const live = (p: ProgressEntry) => p.status === 'running' && active && last.get(p.step) === p;
  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-1 gap-1.5">
        {change.steps.map((s) => {
          const p = last.get(s.key);
          return (
            <li key={s.key} className="flex items-center gap-2 text-xs">
              {p && p.status === 'running' && !live(p) ? <CircleDot className="size-4 text-zinc-400" /> : <StepIcon status={p?.status ?? 'pending'} />}
              <span className={cx(!p && 'text-zinc-400')}>{s.label}</span>
            </li>
          );
        })}
      </ol>
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Historial</div>
        {/* Línea y nodos en rem (siguen la densidad): el icono de 1rem queda centrado sobre la línea de 1px. */}
        <ol className="relative space-y-3 before:absolute before:inset-y-1 before:left-2 before:w-px before:-translate-x-1/2 before:bg-zinc-200 dark:before:bg-zinc-800">
          {entries.slice(0, 40).map((p, i) => (
            <li key={`${p.at}-${i}`} className="relative pl-6">
              <span className="absolute left-0 top-0.5 rounded-full bg-white dark:bg-zinc-900">
                {p.status === 'running' && !live(p) ? <CircleDot className="size-4 text-zinc-400" /> : <StepIcon status={p.status} />}
              </span>
              <div className="text-xs font-medium">{labels.get(p.step) ?? p.step}</div>
              {p.detail && <div className="text-xs text-zinc-500">{p.detail}</div>}
              <div className="text-[11px] text-zinc-400">{formatDate(p.at, true)}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function CiCard({ attempts, active }: { attempts: CiAttempt[]; active: boolean }) {
  const [open, setOpen] = useState<number | null>(attempts.length ? attempts[attempts.length - 1].n : null);
  if (!attempts.length) return null;
  return (
    <Card title={<span className="flex items-center gap-2"><FlaskConical className="size-4 text-sky-500" /> CI aislado en Railway</span>} description="npm ci · npm run typecheck · npx vitest run · npm run build, en el servicio CI (sin variables, secretos ni dominio). El despliegue del CI se retira al terminar.">
      <ul className="space-y-2">
        {attempts.map((a) => {
          const isOpen = open === a.n;
          const duration = a.finishedAt ? Math.round((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 1000) : null;
          return (
            <li key={a.n} className="rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
              <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm" onClick={() => setOpen(isOpen ? null : a.n)}>
                {a.status === 'passed' ? <CheckCircle2 className="size-4 text-emerald-500" /> : a.status === 'failed' ? <XCircle className="size-4 text-red-500" /> : a.status === 'running' ? (active ? <Loader2 className="size-4 animate-spin text-brand-500" /> : <CircleDot className="size-4 text-zinc-400" aria-label="Interrumpido" />) : <MinusCircle className="size-4 text-zinc-400" />}
                <span className="font-medium">Intento {a.n}</span>
                <span className="text-xs text-zinc-500">
                  {a.railwayStatus ?? 'en cola'} · {a.files} archivos · {formatBytes(a.bytes)}
                  {duration !== null ? ` · ${duration} s` : ''}
                </span>
                <ChevronDown className={cx('ml-auto size-4 text-zinc-400 transition', isOpen && 'rotate-180')} />
              </button>
              {isOpen && (
                <div className="space-y-2 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                  <p className="text-xs text-zinc-500">
                    Despliegue <code>{shortId(a.deploymentId)}</code> · versión <code>{shortId(a.sourceVersion.id)}</code> · {formatDate(a.startedAt, true)}
                    {a.removed ? ' · retirado' : ''}
                  </p>
                  {a.note && <Alert tone="warning">{a.note}</Alert>}
                  {a.summary && a.summary.length > 0 && <p className="text-xs">{a.summary.join(' · ')}</p>}
                  {a.errors && a.errors.length > 0 && (
                    <div>
                      <div className="mb-1 text-xs font-semibold text-red-600 dark:text-red-400">Errores extraídos del log (los recibe el agente para auto-corregirse)</div>
                      <pre className="max-h-64 overflow-auto rounded-lg bg-red-50 p-2 text-[11px] leading-relaxed text-red-900 scrollbar-thin dark:bg-red-500/10 dark:text-red-200">{a.errors.join('\n\n')}</pre>
                    </div>
                  )}
                  {a.excerpt && (
                    <details>
                      <summary className="cursor-pointer text-xs text-zinc-500">Final del log del build</summary>
                      <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-zinc-950 p-2 text-[11px] leading-relaxed text-zinc-100 scrollbar-thin">{a.excerpt}</pre>
                    </details>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ReviewCard({ change }: { change: Detail }) {
  const r = change.review;
  if (!r) return null;
  if (r.status !== 'done') return <Alert tone="warning" title="Sin revisión de seguridad con IA">{r.message}</Alert>;
  const color = r.verdict === 'approve' ? 'emerald' : r.verdict === 'reject' ? 'red' : 'amber';
  const label = r.verdict === 'approve' ? 'Sin objeciones' : r.verdict === 'reject' ? 'Recomienda no desplegar' : 'Con observaciones';
  const sev = { low: 'slate', medium: 'amber', high: 'red', critical: 'red' } as const;
  return (
    <Card
      title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-emerald-500" /> Revisión de seguridad con IA</span>}
      description={`${r.provider} / ${r.model}${r.sameProvider ? ' · mismo proveedor que escribió el código' : ' · otro proveedor'}${r.truncated ? ' · diff recortado por tamaño' : ''}`}
      actions={<Badge color={color}>{label}</Badge>}
    >
      <p className="whitespace-pre-wrap text-sm">{r.summary}</p>
      {r.concerns?.map((c, i) => (
        <div key={i} className="mt-2 flex gap-2 text-sm">
          <Badge color={sev[c.severity]} className="h-fit shrink-0">{c.severity}</Badge>
          <span>
            {c.file && <code className="mr-1 text-xs">{c.file}</code>}
            {c.message}
          </span>
        </div>
      ))}
      <p className="mt-3 text-xs text-zinc-500">La revisión es orientativa: la decisión es tuya. El riesgo de un cambio del código de la plataforma es siempre alto.</p>
    </Card>
  );
}

function DeployCard({ change }: { change: Detail }) {
  const d = change.deploy;
  if (!d.phase && !d.previous) return null;
  const Row = ({ label, value }: { label: string; value: ReactNode }) => (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
  return (
    <Card title={<span className="flex items-center gap-2"><Rocket className="size-4 text-brand-500" /> Despliegue</span>}>
      <div className="space-y-1.5">
        {d.previous && (
          <>
            <Row label="Worker anterior" value={<code>{shortId(d.previous.worker?.deploymentId)}</code>} />
            <Row label="Web anterior" value={<code>{shortId(d.previous.web?.deploymentId)}</code>} />
          </>
        )}
        {d.worker && <Row label="Worker (canario)" value={<><code>{shortId(d.worker.deploymentId)}</code> {d.worker.status ?? '…'}</>} />}
        {d.web && <Row label="Servicio web" value={<><code>{shortId(d.web.deploymentId)}</code> {d.web.status ?? '…'}</>} />}
        {d.sourceVersion && <Row label="Versión" value={<code>{shortId(d.sourceVersion.id)}</code>} />}
      </div>
      {d.verification && (
        <ul className="mt-3 space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          {d.verification.checks.map((c, i) => (
            <li key={i} className="flex gap-1.5 text-xs">
              {c.passed ? <Check className="size-3.5 shrink-0 text-emerald-500" /> : <XCircle className="size-3.5 shrink-0 text-red-500" />}
              <span>
                {c.name}
                {c.detail && <span className="block text-zinc-500">{c.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {d.rollback && (
        <div className="mt-3 rounded-lg bg-orange-50 p-2 text-xs text-orange-900 dark:bg-orange-500/10 dark:text-orange-200">
          <div className="font-semibold">{d.rollback.reason === 'manual' ? 'Rollback manual' : 'Rollback automático'} · {relativeTime(d.rollback.requestedAt)}</div>
          {d.rollback.services.map((s) => (
            <div key={s.service}>
              {s.service === 'web' ? 'Web' : 'Worker'} → <code>{shortId(s.deploymentId)}</code> {s.ok ? '✓' : `✗ ${s.error ?? ''}`}
            </div>
          ))}
          {d.rollback.detail && <div className="mt-1">{d.rollback.detail}</div>}
        </div>
      )}
    </Card>
  );
}

export function ChangeDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['platform-code', 'change', id],
    queryFn: () => get<Detail>(`/platform/code/requests/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data && ACTIVE.has(query.state.data.status) ? 3000 : false),
  });
  const [feedback, setFeedback] = useState('');
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState<'approve' | 'rollback' | null>(null);
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(`/platform/code/requests/${encodeURIComponent(id)}/${path}`, body),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['platform-code'] });
      setConfirm(null);
      if (vars.path === 'refine') setFeedback('');
      toast(vars.path === 'approve' ? 'Aprobado: desplegando primero en el worker' : vars.path === 'rollback' ? 'Rollback solicitado' : vars.path === 'refine' ? 'Rehaciendo el cambio con tus indicaciones' : 'Cambio cancelado');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-24" />;
  const c = q.data!;
  const running = ACTIVE.has(c.status);
  const warnings = c.flags.filter((f) => f.level === 'warning');
  const infos = c.flags.filter((f) => f.level === 'info');

  return (
    <div className="@container mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      <Link to="/platform/code" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Código fuente
      </Link>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={c.status} />
          <Badge color="red">Riesgo alto</Badge>
          {c.origin && <Badge color="indigo">Petición de {c.origin.workspaceName ?? 'una organización'}</Badge>}
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{c.title ?? 'Preparando el cambio…'}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {c.requested_by_name ?? '—'} · {formatDate(c.created_at, true)} · IA de {c.workspace_name ?? '—'} · sobre <code>{c.base_version ?? c.policy.runningVersion}</code>
        </p>
      </div>

      <div className="grid gap-5 @5xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <div className="flex gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
                <MessageSquare className="size-4 text-zinc-500" />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-500">Petición</div>
                <p className="whitespace-pre-wrap text-sm">{c.prompt}</p>
                {c.conversation.filter((m) => m.role === 'feedback').map((m, i) => (
                  <p key={i} className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900 dark:bg-brand-500/10 dark:text-brand-200">
                    ↳ {m.content} <span className="text-xs opacity-70">— {m.byName ?? ''}</span>
                  </p>
                ))}
              </div>
            </div>
          </Card>

          {running && c.status !== 'deploying' && c.status !== 'rolling_back' && (
            <Alert tone="info" title="El motor de código está trabajando">El agente desarrolla el cambio sobre una copia del código y lo prueba en el CI aislado de Railway. Puedes salir de esta página: el proceso continúa en el worker.</Alert>
          )}
          {c.status === 'deploying' && !c.policy.stalled && <Alert tone="info" title="Desplegando">Primero en el worker (canario) y, si está sano, en el servicio web. Si algo falla se revierte automáticamente.</Alert>}
          {c.policy.stalled && (
            <Alert tone="danger" title="El despliegue se ha detenido">Nadie procesa este despliegue desde hace más de 10 minutos (puede que el worker nuevo no arranque o no procese la cola). Revierte para volver a los despliegues anteriores.</Alert>
          )}
          {c.error && (c.status === 'failed' || c.status === 'rolled_back') && <Alert tone="danger" title={c.status === 'failed' ? 'No se ha podido completar' : 'Revertido'}>{c.error}</Alert>}
          {!c.policy.baseMatches && c.status === 'ready_for_review' && (
            <Alert tone="warning" title="La instalación ha cambiado de versión">Este cambio se preparó sobre <code>{c.base_version}</code> y ahora se ejecuta <code>{c.policy.runningVersion}</code>. Refínalo para reconstruirlo sobre la versión actual.</Alert>
          )}

          {(c.summary || c.testsAdded.length > 0) && (
            <Card title={<span className="flex items-center gap-2"><Bot className="size-4 text-fuchsia-500" /> Resumen del agente</span>}>
              {c.summary && <p className="whitespace-pre-wrap text-sm">{c.summary}</p>}
              {c.testsAdded.length > 0 && (
                <p className="mt-2 text-xs text-zinc-500">
                  Pruebas añadidas: {c.testsAdded.map((t) => <code key={t} className="mr-1">{t}</code>)}
                </p>
              )}
              {c.stats.files !== undefined && (
                <p className="mt-2 text-xs text-zinc-500">
                  {c.stats.added ?? 0} nuevo(s) · {c.stats.modified ?? 0} modificado(s) · {c.stats.deleted ?? 0} borrado(s) · +{c.stats.linesAdded ?? 0} −{c.stats.linesRemoved ?? 0} líneas
                </p>
              )}
            </Card>
          )}

          {c.guards && !c.guards.ok && (
            <Card title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-red-500" /> Infracciones de las reglas del motor</span>} description="Reglas deterministas: un cambio que las incumple no llega al CI ni se puede aprobar.">
              <ul className="space-y-1.5 text-sm">
                {c.guards.violations.map((v, i) => (
                  <li key={i} className="flex gap-2">
                    <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
                    <span>
                      {v.path && <code className="mr-1 text-xs">{v.path}{v.line ? `:${v.line}` : ''}</code>}
                      {v.message}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {(warnings.length > 0 || infos.length > 0) && (
            <Card title="Avisos para quien aprueba" description="Calculados por reglas deterministas sobre el diff.">
              <ul className="space-y-2 text-sm">
                {[...warnings, ...infos].map((f) => (
                  <li key={f.key} className="flex gap-2">
                    {f.level === 'warning' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-sky-500" />}
                    <span className="min-w-0">
                      {f.message}
                      {f.paths && f.paths.length > 0 && <span className="block break-all text-xs text-zinc-500">{f.paths.slice(0, 8).join(', ')}{f.paths.length > 8 ? ` y ${f.paths.length - 8} más` : ''}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <DiffViewer files={c.files} />
          <CiCard attempts={c.ci.attempts} active={running} />
          <ReviewCard change={c} />

          {c.policy.canRefine && (
            <Card title="Refinar el cambio" description="Indica qué quieres ajustar: el agente parte de lo ya hecho y el cambio vuelve a pasar por las reglas, el CI y la revisión.">
              <Textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Ej.: El listado debe paginarse de 25 en 25 y el botón tiene que estar también en la ficha." />
              <div className="mt-2 flex justify-end">
                <Button variant="primary" size="sm" disabled={feedback.trim().length < 3} loading={action.isPending && action.variables?.path === 'refine'} onClick={() => action.mutate({ path: 'refine', body: { feedback } })}>
                  Rehacer con estas indicaciones
                </Button>
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          {c.status === 'ready_for_review' && (
            <Card title="Aprobar y desplegar">
              {c.policy.canApprove ? (
                <div className="space-y-2">
                  <p className="text-sm text-zinc-500">Se desplegará primero en el worker (canario) y después en el servicio web, con verificación de /api/health y rollback automático si algo falla.</p>
                  <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comentario (opcional)" />
                  <Button variant="ai" className="w-full" icon={<Rocket className="size-4" />} onClick={() => setConfirm('approve')}>
                    Aprobar y desplegar
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No se puede aprobar todavía: el CI debe estar superado y la instalación en la misma versión sobre la que se preparó.</p>
              )}
            </Card>
          )}
          <DeployCard change={c} />
          {c.policy.canRollback && (
            <Card title="Revertir">
              <p className="mb-3 text-sm text-zinc-500">Vuelve a publicar los despliegues del web y del worker que había antes de este cambio. Las migraciones de base de datos (aditivas) no se deshacen.</p>
              <Button variant="danger" className="w-full" icon={<RotateCcw className="size-4" />} onClick={() => setConfirm('rollback')}>
                Revertir este cambio
              </Button>
            </Card>
          )}
          <Card title="Progreso">
            <Timeline change={c} />
          </Card>
          {c.approvals.length > 0 && (
            <Card title="Aprobaciones">
              <ul className="space-y-2">
                {c.approvals.map((a, i) => (
                  <li key={i} className="text-sm">
                    <Badge color="emerald">{a.confirmation}</Badge> <span className="font-medium">{a.name}</span> <span className="text-xs text-zinc-400">{relativeTime(a.at)} · CI #{a.attempt}</span>
                    {a.comment && <p className="mt-0.5 text-xs text-zinc-500">{a.comment}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {c.llm.length > 0 && (
            <Card title="Modelos utilizados">
              <ul className="space-y-1.5 text-xs">
                {c.llm.map((l, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">
                      <span className="text-zinc-500">{l.phase}</span> · {l.provider}/{l.model}
                    </span>
                    <span className="shrink-0 tabular-nums text-zinc-500">
                      {l.steps ? `${l.steps} pasos` : ''}
                      {typeof l.costUsd === 'number' ? ` · $${l.costUsd.toFixed(4)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {c.policy.canCancel && (
            <button className="w-full text-center text-xs text-zinc-400 hover:text-red-600" onClick={() => action.mutate({ path: 'cancel' })}>
              Cancelar este cambio
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'approve'}
        onClose={() => setConfirm(null)}
        typed={c.policy.approveConfirmation}
        loading={action.isPending}
        title="Desplegar un cambio del código de la plataforma"
        description="Afecta a toda la instalación y a todas sus organizaciones. Confirma que has revisado el diff completo, el resultado del CI y la revisión de seguridad."
        confirmLabel="Desplegar"
        onConfirm={(v) => action.mutate({ path: 'approve', body: { confirmation: v, ...(comment.trim() ? { comment: comment.trim() } : {}) } })}
      >
        <Field label="Resumen">
          <p className="text-sm">{c.title} · {c.files.length} archivo(s)</p>
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'rollback'}
        onClose={() => setConfirm(null)}
        typed={c.policy.rollbackConfirmation}
        danger
        loading={action.isPending}
        title="Revertir el cambio"
        description="Railway volverá a publicar los despliegues anteriores del web y del worker."
        confirmLabel="Revertir"
        onConfirm={(v) => action.mutate({ path: 'rollback', body: { confirmation: v } })}
      />
    </div>
  );
}
