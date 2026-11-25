import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronDown, CircleDashed, Database, Eye, FileCode2, FileJson, Loader2, MessageSquare, MinusCircle, Pencil, Plus, Rocket, ShieldCheck, Sparkles, Trash2, Users, XCircle } from 'lucide-react';
import { errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useBlueprint } from '../../lib/hooks';
import type { Blueprint, Operation } from '../../lib/types';
import { sanitizeCustomCss } from '../../../../shared/appearance';
import { formatDate, relativeTime } from '../../lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, cx, ErrorState, PageLoader, Skeleton, Textarea } from '../../components/ui';
import { AppearancePreview, PageStructurePreview, previewBlueprint, VISUAL_OPS } from '../../components/AppearancePreview';
import { Segmented } from '../settings/ai/shared';
import { useToast } from '../../components/toast';
import { RiskBadge, RUNNING, StatusBadge } from './shared';

/** Código de los scripts del cambio: se ejecuta solo en el sandbox de esta organización. */
function ScriptsCode({ operations }: { operations: any[] }) {
  const scripts = operations.filter((o) => o.op === 'upsert_script').map((o) => o.script);
  const [open, setOpen] = useState<string | null>(null);
  if (!scripts.length) return null;
  return (
    <Card
      title={<span className="flex items-center gap-2"><FileCode2 className="size-4 text-violet-500" /> Código de los scripts</span>}
      description="Lógica a medida solo para tu organización. Se ejecuta en un sandbox aislado dentro de Cortex CRM (sin red ni archivos, con límite de tiempo y memoria) y se versiona con tu configuración: no se publica en ningún repositorio."
    >
      <ul className="space-y-2">
        {scripts.map((s: any) => (
          <li key={s.key} className="rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
            <button type="button" onClick={() => setOpen(open === s.key ? null : s.key)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
              <ChevronDown className={cx('size-4 text-zinc-400 transition', open === s.key && 'rotate-180')} />
              <span className="font-medium">{s.name}</span>
              <code className="text-xs text-zinc-500">{s.key}</code>
              <span className="ml-auto text-xs text-zinc-400">{s.code ? `${s.code.split('\n').length} líneas` : 'sin código'} · máx. {s.timeoutMs ?? 1000} ms</span>
            </button>
            {open === s.key && (
              <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                {s.description && <p className="mb-2 text-xs text-zinc-500">{s.description}</p>}
                <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-[12px] leading-relaxed text-zinc-100">{s.code || '// El código se escribe al desarrollar el cambio'}</pre>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Vista previa de los cambios VISUALES (apariencia, menú y páginas) sobre la versión en la que se planificó el
 * cambio: una maqueta con los tokens propuestos (antes / después) y la estructura de cada página. El CSS
 * personalizado se muestra como código para revisarlo (no se aplica en la maqueta).
 */
function VisualPreview({ request }: { request: any }) {
  const ops: Operation[] = request.change_set?.operations ?? [];
  const visual = ops.filter((o) => VISUAL_OPS.has(o.op));
  const base = useQuery({
    queryKey: ['evolve', 'version', request.base_version],
    queryFn: () => get<{ blueprint: Blueprint }>(`/evolve/versions/${request.base_version}`),
    enabled: visual.length > 0 && !!request.base_version,
    staleTime: Infinity,
    retry: false,
  });
  const current = useBlueprint();
  const [mode, setMode] = useState<'after' | 'before'>('after');
  if (!visual.length) return null;
  const before = base.data?.blueprint ?? (base.isLoading ? undefined : current.data?.blueprint);
  const look = visual.some((o) => o.op === 'update_appearance' || o.op === 'update_navigation');
  const pages = visual.flatMap((o) => (o.op === 'upsert_page' ? [o.page] : []));
  const removed = visual.flatMap((o) => (o.op === 'remove_page' ? [o.page] : []));
  const cssOp = visual.find((o): o is Extract<Operation, { op: 'update_appearance' }> => o.op === 'update_appearance' && o.changes.customCss !== undefined);
  const css = cssOp?.changes.customCss;
  const cssCheck = typeof css === 'string' && css.trim() ? sanitizeCustomCss(css) : null;
  const after = before ? previewBlueprint(before, ops) : undefined;
  const shown = mode === 'after' ? after : before;
  return (
    <Card
      title={<span className="flex items-center gap-2"><Eye className="size-4 text-brand-500" /> Vista previa</span>}
      description="Maqueta con los cambios visuales propuestos y datos de ejemplo. Nada cambia hasta que se apruebe y se publique."
      actions={look && before ? <Segmented size="sm" value={mode} onChange={setMode} options={[{ key: 'after', label: 'Después' }, { key: 'before', label: 'Antes' }]} /> : undefined}
    >
      {!before || !after || !shown ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="space-y-4">
          {look && <AppearancePreview appearance={shown.appearance} blueprint={shown} navigation={shown.navigation ?? null} />}
          {css === null && <p className="text-sm text-zinc-500">Se quita el CSS personalizado.</p>}
          {cssCheck && (
            <div className="rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <FileCode2 className="size-4 text-amber-500" />
                <span className="font-medium">CSS personalizado</span>
                <Badge color={cssCheck.ok ? 'emerald' : 'red'} dot>{cssCheck.ok ? 'CSS plano, sin recursos externos' : 'No válido'}</Badge>
                <span className="ml-auto text-xs text-zinc-400">{css!.length} caracteres · no se aplica en la maqueta</span>
              </div>
              <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                <p className="mb-2 text-xs text-zinc-500">Puede ocultar o imitar elementos de la interfaz: revísalo antes de aprobar. Nunca se aplica en EVOLVE, Ajustes ni Plataforma.</p>
                {!cssCheck.ok && <ul className="mb-2 list-disc pl-5 text-xs text-red-600 dark:text-red-400">{cssCheck.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
                <pre className="max-h-72 overflow-auto rounded-lg bg-zinc-950 p-3 text-[12px] leading-relaxed text-zinc-100">{css}</pre>
              </div>
            </div>
          )}
          {pages.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Páginas</h4>
              {pages.map((p) => (
                <PageStructurePreview key={p.key} page={p} blueprint={after} />
              ))}
            </div>
          )}
          {removed.length > 0 && <p className="text-sm text-zinc-500">Se eliminan las páginas: {removed.map((k) => before.pages?.find((p) => p.key === k)?.label ?? k).join(', ')}.</p>}
        </div>
      )}
    </Card>
  );
}

function Steps({ steps, progress, status }: { steps: { key: string; label: string }[]; progress: any[]; status: string }) {
  const last = new Map<string, any>();
  for (const p of progress ?? []) last.set(p.step, p);
  return (
    <ol className="space-y-3">
      {steps.map((s) => {
        const p = last.get(s.key);
        const state = p?.status ?? (RUNNING.has(status) ? 'pending' : 'pending');
        return (
          <li key={s.key} className="flex gap-3">
            <span className="mt-0.5">
              {state === 'done' ? <CheckCircle2 className="size-5 text-emerald-500" /> : state === 'running' ? <Loader2 className="size-5 animate-spin text-brand-500" /> : state === 'failed' ? <XCircle className="size-5 text-red-500" /> : state === 'skipped' ? <MinusCircle className="size-5 text-zinc-300 dark:text-zinc-600" /> : <CircleDashed className="size-5 text-zinc-300 dark:text-zinc-700" />}
            </span>
            <div className="min-w-0">
              <div className={cx('text-sm font-medium', state === 'pending' && 'text-zinc-400')}>{s.label}</div>
              {p?.detail && <div className="text-xs text-zinc-500">{p.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TestReport({ report }: { report: any }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="Pruebas en el entorno aislado" description={`${report.total - report.failed}/${report.total} superadas · ${report.warnings} aviso(s) · ${report.durationMs} ms`} actions={<Badge color={report.passed ? 'emerald' : 'red'} dot>{report.passed ? 'Todo correcto' : `${report.failed} fallida(s)`}</Badge>}>
      <div className="space-y-4">
        {report.suites.map((s: any) => (
          <div key={s.key}>
            <div className="mb-1.5 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-zinc-400">
              <span>{s.name}</span>
              <span>{s.cases.filter((c: any) => c.passed).length}/{s.cases.length}</span>
            </div>
            <ul className="space-y-1">
              {s.cases.map((c: any, i: number) => {
                const id = `${s.key}-${i}`;
                return (
                  <li key={id} className="rounded-lg bg-zinc-50/80 dark:bg-zinc-800/40">
                    <button className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-sm" onClick={() => setOpen(open === id ? null : id)}>
                      {!c.passed ? <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" /> : c.warning ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" /> : <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />}
                      <span className="min-w-0 flex-1">
                        <span className="block">{c.name}</span>
                        {c.message && <span className={cx('block text-xs', c.passed ? 'text-zinc-500' : 'text-red-600 dark:text-red-400')}>{c.message}</span>}
                      </span>
                      {c.steps && <ChevronDown className={cx('mt-0.5 size-4 shrink-0 text-zinc-400 transition', open === id && 'rotate-180')} />}
                    </button>
                    {open === id && c.steps && (
                      <ol className="space-y-0.5 px-8 pb-2 text-xs text-zinc-500">
                        {c.steps.map((st: any, j: number) => (
                          <li key={j} className={st.passed ? '' : 'text-red-600 dark:text-red-400'}>{st.passed ? '✓' : '✗'} {st.action}{st.message ? ` — ${st.message}` : ''}</li>
                        ))}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Impact({ impact }: { impact: any }) {
  const kindIcon = (k: string) => (k === 'add' ? <Plus className="size-3.5 text-emerald-500" /> : k === 'remove' ? <Trash2 className="size-3.5 text-red-500" /> : k === 'data' ? <Database className="size-3.5 text-sky-500" /> : <Pencil className="size-3.5 text-amber-500" />);
  return (
    <Card title="Qué va a cambiar" description="Revisa el impacto antes de autorizar la publicación.">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Cambios</h4>
          <ul className="space-y-1.5">
            {impact.changes.map((c: any) => (
              <li key={c.index} className="flex gap-2 text-sm">
                <span className="mt-1">{kindIcon(c.kind)}</span>
                <span className="min-w-0"><span className="font-medium">{c.title}</span>{c.detail && <span className="block text-xs text-zinc-500">{c.detail}</span>}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-5">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Tablas lógicas creadas o modificadas</h4>
            {!impact.tables.length ? <p className="text-sm text-zinc-500">Ninguna</p> : (
              <ul className="space-y-2">
                {impact.tables.map((t: any) => (
                  <li key={t.module} className="rounded-lg bg-zinc-50 p-2.5 text-sm dark:bg-zinc-800/50">
                    <div className="flex items-center gap-2"><Database className="size-3.5 text-zinc-400" /><span className="font-medium">{t.label}</span><Badge color={t.action === 'create' ? 'emerald' : t.action === 'archive' ? 'red' : 'amber'}>{t.action === 'create' ? 'nueva' : t.action === 'archive' ? 'archivada' : 'modificada'}</Badge></div>
                    {t.columns.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{t.columns.map((c: any) => <code key={c.key + c.action} className={cx('rounded px-1 text-[11px]', c.action === 'add' ? 'bg-emerald-100/70 dark:bg-emerald-500/15' : c.action === 'archive' ? 'bg-red-100/70 line-through dark:bg-red-500/15' : 'bg-amber-100/70 dark:bg-amber-500/15')}>{c.key}{c.type ? `: ${c.type}` : ''}</code>)}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {impact.dataMigrations?.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Migraciones de datos (reversibles)</h4>
              {impact.dataMigrations.map((d: any, i: number) => <p key={i} className="text-sm">{d.module}.{d.field} · {d.mode === 'only_empty' ? 'solo vacíos' : 'sobrescribe'}{d.estimatedRows !== undefined ? ` · hasta ${d.estimatedRows} registros` : ''}</p>)}
            </div>
          )}
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Artefactos versionados que se modificarán</h4>
          <ul className="space-y-0.5">{impact.artifacts.map((a: any, i: number) => <li key={i} className="flex items-center gap-2 text-xs"><FileJson className="size-3.5 text-zinc-400" /><code className="truncate">{a.path}</code><span className="text-zinc-400">{a.action}</span></li>)}</ul>
        </div>
        <div className="space-y-5">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Permisos y salida de datos</h4>
            <ul className="space-y-1 text-sm">{impact.permissions.map((p: string, i: number) => <li key={i} className="flex gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />{p}</li>)}</ul>
            <p className="mt-2 text-xs text-zinc-500">Debe aprobarlo: <strong>{impact.approverRole}</strong></p>
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Riesgos</h4>
            <ul className="space-y-1">{impact.risks.map((r: any, i: number) => <li key={i} className="flex items-start gap-2 text-sm"><Badge color={r.level === 'high' ? 'red' : r.level === 'medium' ? 'amber' : 'emerald'}>{r.level === 'high' ? 'alto' : r.level === 'medium' ? 'medio' : 'bajo'}</Badge><span>{r.message}</span></li>)}</ul>
          </div>
          {impact.affectedFeatures?.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Funcionalidades afectadas</h4>
              <div className="flex flex-wrap gap-1">{impact.affectedFeatures.map((f: string) => <Badge key={f}>{f}</Badge>)}</div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function RequestDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, me } = useSession();
  const steps = useQuery({ queryKey: ['evolve-steps'], queryFn: () => get<{ key: string; label: string }[]>('/evolve/steps'), staleTime: Infinity });
  const q = useQuery({ queryKey: ['evolve', 'request', id], queryFn: () => get<any>(`/evolve/requests/${id}`), refetchInterval: (query) => (query.state.data && RUNNING.has(query.state.data.status) ? 2000 : false) });
  const [feedback, setFeedback] = useState('');
  const [comment, setComment] = useState('');
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [deployResult, setDeployResult] = useState<any>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['evolve'] });
  };
  const mut = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body),
    onSuccess: (res, vars) => {
      invalidate();
      if (vars.path.endsWith('/deploy')) {
        setDeployResult(res);
        qc.invalidateQueries({ queryKey: ['blueprint'] });
        toast(res.verification?.ok ? `Publicada la versión v${res.version}` : 'La verificación falló: se ha restaurado la versión anterior', res.verification?.ok ? 'success' : 'error');
      } else if (vars.path.endsWith('/refine')) {
        setFeedback('');
        toast('Replanificando con tus indicaciones');
      } else toast('Hecho');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-24" />;
  const r = q.data;
  if (r.redacted) {
    // El servidor solo envía el resumen cuando el cambio toca módulos o configuración que este rol no puede ver.
    return (
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
        <Link to="/evolve" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="size-4" /> EVOLVE AI ENGINE</Link>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={r.status} />
          <RiskBadge risk={r.risk} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{r.title ?? 'Petición de cambio'}</h1>
        <p className="text-sm text-zinc-500">Pedido por {r.requested_by_name ?? '—'} · {formatDate(r.created_at, true)}</p>
        {r.summary && <Card><p className="whitespace-pre-wrap text-sm">{r.summary}</p></Card>}
        <Alert tone="info" title="Detalle restringido">Este cambio afecta a módulos o a configuración a los que tu rol no tiene acceso, así que solo se muestra el resumen.</Alert>
      </div>
    );
  }
  const cs = r.change_set;
  const running = RUNNING.has(r.status);
  const canRefine = r.source === 'ai' && can('builder') && (r.requested_by === me?.user.id || can('admin')) && ['ready_for_review', 'failed', 'needs_input', 'rejected'].includes(r.status);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <Link to="/evolve" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="size-4" /> EVOLVE AI ENGINE</Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.status} />
            <RiskBadge risk={r.risk} />
            {r.source === 'manual' && <Badge>Cambio manual</Badge>}
          </div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{cs?.title ?? 'Analizando la petición…'}</h1>
          <p className="mt-1 text-sm text-zinc-500">Pedido por {r.requested_by_name ?? '—'} · {formatDate(r.created_at, true)} · sobre la versión v{r.base_version}</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <div className="flex gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800"><MessageSquare className="size-4 text-zinc-500" /></span>
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-500">Petición</div>
                <p className="whitespace-pre-wrap text-sm">{r.prompt}</p>
                {(r.conversation ?? []).filter((c: any) => c.role === 'feedback').map((c: any, i: number) => (
                  <p key={i} className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900 dark:bg-brand-500/10 dark:text-brand-200">↳ {c.content}</p>
                ))}
              </div>
            </div>
          </Card>

          {running && <Alert tone="info" title="EVOLVE AI ENGINE está trabajando">Planificando, desarrollando en un entorno aislado y probando los cambios. Puedes salir de esta página: el proceso continúa en segundo plano.</Alert>}
          {r.status === 'failed' && <Alert tone="danger" title="No supera las pruebas">{r.error ?? 'Revisa el informe de pruebas.'}</Alert>}

          {cs && (
            <Card title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-fuchsia-500" /> Plan propuesto</span>}>
              <p className="whitespace-pre-wrap text-sm">{cs.summary}</p>
              {cs.assumptions?.length > 0 && (
                <div className="mt-3"><div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Supuestos</div><ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-600 dark:text-zinc-400">{cs.assumptions.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></div>
              )}
              {cs.questions?.length > 0 && (
                <Alert tone="warning" title="La IA necesita aclarar" className="mt-3"><ul className="list-disc pl-5">{cs.questions.map((qq: string, i: number) => <li key={i}>{qq}</li>)}</ul></Alert>
              )}
            </Card>
          )}

          {cs?.requiresPlatformChange && (
            <Alert tone="info" title="Necesita una funcionalidad nueva de la plataforma">
              {cs.platformRequest ?? 'Esta parte no se puede resolver solo para tu organización.'} Queda registrada para el equipo de Cortex CRM; el resto del cambio (si lo hay) sigue el proceso normal.
            </Alert>
          )}
          {cs?.operations?.length > 0 && <VisualPreview request={r} />}
          {r.impact && cs?.operations?.length > 0 && <Impact impact={r.impact} />}
          <ScriptsCode operations={cs?.operations ?? []} />
          {r.test_report && <TestReport report={r.test_report} />}

          {r.cross_review && (
            <Card title="Revisión cruzada con otro modelo" description={`${r.cross_review.provider} / ${r.cross_review.model}`} actions={<Badge color={r.cross_review.verdict === 'approve' ? 'emerald' : 'amber'}>{r.cross_review.verdict === 'approve' ? 'Sin objeciones' : 'Con observaciones'}</Badge>}>
              <p className="text-sm">{r.cross_review.summary}</p>
              {r.cross_review.concerns?.map((c: any, i: number) => <p key={i} className="mt-1.5 flex gap-2 text-sm"><Badge color={c.severity === 'high' ? 'red' : c.severity === 'medium' ? 'amber' : 'slate'}>{c.severity}</Badge>{c.message}</p>)}
            </Card>
          )}

          {canRefine && (
            <Card title="Refinar el plan" description="Indica qué quieres cambiar; la IA volverá a planificar y probar.">
              <Textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Ej.: El aviso debe ser 15 días antes, no 30, y también para el responsable de la empresa." />
              <div className="mt-2 flex justify-end"><Button variant="primary" size="sm" disabled={feedback.trim().length < 3} loading={mut.isPending} onClick={() => mut.mutate({ path: `/evolve/requests/${id}/refine`, body: { feedback } })}>Replanificar</Button></div>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Progreso">{steps.data ? <Steps steps={steps.data} progress={r.progress} status={r.status} /> : null}</Card>

          {r.status === 'ready_for_review' && (
            <Card title="Autorizar publicación">
              {r.policy.canApprove ? (
                <div className="space-y-2">
                  <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comentario (opcional)" />
                  <div className="flex gap-2">
                    <Button variant="primary" className="flex-1" loading={mut.isPending} onClick={() => (r.policy.needsConfirmation ? setConfirmApprove(true) : mut.mutate({ path: `/evolve/requests/${id}/approve`, body: { comment } }))}>Aprobar</Button>
                    <Button variant="ghost" className="text-red-600" onClick={() => mut.mutate({ path: `/evolve/requests/${id}/reject`, body: { comment } })}>Rechazar</Button>
                  </div>
                  <p className="text-xs text-zinc-500">Requiere: {r.policy.requiredRoleLabel}{r.policy.requireDistinctApprover ? ' · distinta persona a quien lo pidió' : ''}</p>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">Pendiente de aprobación por: <strong>{r.policy.requiredRoleLabel}</strong>{r.policy.requireDistinctApprover ? ' (distinta persona a quien lo solicitó)' : ''}.</p>
              )}
            </Card>
          )}

          {r.status === 'approved' && (
            <Card title="Publicar">
              <p className="mb-3 text-sm text-zinc-500">Se creará la versión v{r.policy.currentVersion + 1}. Tras publicar se verifica automáticamente y, si algo falla, se restaura la versión anterior.</p>
              {can(r.risk === 'high' ? 'owner' : 'admin') ? (
                <Button variant="ai" className="w-full" icon={<Rocket className="size-4" />} loading={mut.isPending} onClick={() => mut.mutate({ path: `/evolve/requests/${id}/deploy` })}>Publicar ahora</Button>
              ) : (
                <p className="text-sm text-zinc-500">Un {r.risk === 'high' ? 'propietario' : 'administrador'} debe publicarlo.</p>
              )}
            </Card>
          )}

          {(deployResult || r.release) && (
            <Card title={r.status === 'rolled_back' ? 'Versión revertida' : 'Publicado'}>
              <p className="text-sm">Versión <strong>v{deployResult?.version ?? r.release?.to_version}</strong> · {r.release ? relativeTime(r.release.created_at) : 'ahora'}</p>
              {(deployResult?.verification ?? r.release?.verification)?.checks?.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {(deployResult?.verification ?? r.release.verification).checks.map((c: any, i: number) => (
                    <li key={i} className="flex gap-1.5 text-xs">{c.passed ? <Check className="size-3.5 text-emerald-500" /> : <XCircle className="size-3.5 text-red-500" />}<span>{c.name}</span></li>
                  ))}
                </ul>
              )}
              <Link to="/evolve/releases" className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">Ver historial de versiones →</Link>
            </Card>
          )}

          {r.approvals?.length > 0 && (
            <Card title={<span className="flex items-center gap-2"><Users className="size-4" /> Decisiones</span>}>
              <ul className="space-y-2">{r.approvals.map((a: any, i: number) => <li key={i} className="text-sm"><Badge color={a.decision === 'approve' ? 'emerald' : 'red'}>{a.decision === 'approve' ? 'Aprobado' : 'Rechazado'}</Badge> <span className="font-medium">{a.name}</span> <span className="text-xs text-zinc-400">{relativeTime(a.created_at)}</span>{a.comment && <p className="mt-0.5 text-xs text-zinc-500">{a.comment}</p>}</li>)}</ul>
            </Card>
          )}

          {r.llm?.length > 0 && (
            <Card title="Modelos utilizados">
              <ul className="space-y-1.5 text-xs">{r.llm.map((l: any, i: number) => <li key={i} className="flex justify-between gap-2"><span className="truncate"><span className="text-zinc-500">{l.phase}</span> · {l.provider}/{l.model}</span><span className="shrink-0 tabular-nums text-zinc-500">{l.latencyMs ? `${(l.latencyMs / 1000).toFixed(1)} s` : ''}{typeof l.costUsd === 'number' ? ` · $${l.costUsd.toFixed(4)}` : ''}</span></li>)}</ul>
            </Card>
          )}

          {['queued', 'planning', 'testing', 'ready_for_review', 'needs_input', 'failed', 'approved'].includes(r.status) && can('builder') && (
            <button className="w-full text-center text-xs text-zinc-400 hover:text-red-600" onClick={() => mut.mutate({ path: `/evolve/requests/${id}/cancel` })}>Cancelar petición</button>
          )}
        </div>
      </div>
      <ConfirmDialog open={confirmApprove} onClose={() => setConfirmApprove(false)} typed="APLICAR" title="Aprobar cambio de riesgo alto" description="Este cambio incluye operaciones de riesgo alto (salida de datos, cambios destructivos o de permisos). Revisa el impacto antes de continuar." onConfirm={(v) => { setConfirmApprove(false); mut.mutate({ path: `/evolve/requests/${id}/approve`, body: { comment, confirmation: v } }); }} confirmLabel="Aprobar" />
    </div>
  );
}
