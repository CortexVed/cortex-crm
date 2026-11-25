import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bot, CheckCircle2, Code2, FlaskConical, Lock, Rocket, RotateCcw, ShieldCheck, UserCheck } from 'lucide-react';
import { errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { relativeTime } from '../../lib/format';
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, PageHeader, Skeleton, Tabs, Textarea } from '../../components/ui';
import { useToast } from '../../components/toast';
import { hasRole } from '../../../../shared/constants';
import { ACTIVE, changeLink, shortId, type ChangeSummary } from './codeTypes';
import { ChangeDetail, StatusBadge } from './ChangeDetail';
import { PlatformInbox } from './PlatformInbox';
import { SettingsPanel, useCodeSettings } from './SettingsPanel';

/**
 * Motor de código fuente de la instalación (solo administración de la plataforma): pedir cambios del código
 * real en lenguaje natural, ver cómo se desarrollan y prueban en el CI aislado de Railway, revisar el diff,
 * aprobar el despliegue (DESPLEGAR) y revertirlo (REVERTIR). Docs: docs/CODE_ENGINE.md.
 */

const FLOW = [
  { icon: Bot, label: 'El agente edita una copia del código', who: 'IA' },
  { icon: Lock, label: 'Reglas deterministas (núcleo protegido)', who: 'Sistema' },
  { icon: FlaskConical, label: 'CI aislado: tipos, pruebas y build', who: 'Railway' },
  { icon: ShieldCheck, label: 'Revisión de seguridad con IA', who: 'IA' },
  { icon: UserCheck, label: 'Revisas el diff y escribes DESPLEGAR', who: 'Tú' },
  { icon: Rocket, label: 'Worker primero (canario) y después web', who: 'Railway' },
  { icon: CheckCircle2, label: 'Verificación de /api/health', who: 'Sistema' },
  { icon: RotateCcw, label: 'Rollback automático o con REVERTIR', who: 'Sistema' },
];

const EXAMPLES = [
  'Añade una pantalla de previsión de cobros con un gráfico por mes y un filtro por comercial.',
  'Integra un calendario de Google para sincronizar las tareas con fecha de vencimiento.',
  'Rediseña la ficha de un registro con pestañas para datos, actividad y documentos.',
];

function ChangesTab({ blockedReason }: { blockedReason: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { me } = useSession();
  const [prompt, setPrompt] = useState('');
  const list = useQuery({
    queryKey: ['platform-code', 'changes'],
    queryFn: () => get<{ items: ChangeSummary[]; running: { version: string } }>('/platform/code/requests'),
    refetchInterval: (q) => (q.state.data?.items.some((c) => ACTIVE.has(c.status)) ? 4000 : false),
  });
  const submit = useMutation({
    mutationFn: () => post<{ id: string }>('/platform/code/requests', { prompt: prompt.trim() }),
    onSuccess: (r) => {
      setPrompt('');
      qc.invalidateQueries({ queryKey: ['platform-code'] });
      navigate(changeLink(r.id));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const active = list.data?.items.find((c) => ACTIVE.has(c.status));
  const canSubmit = !blockedReason && !active && prompt.trim().length >= 10;

  return (
    <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <Card title={<span className="flex items-center gap-2"><Code2 className="size-4 text-fuchsia-500" /> Nuevo cambio del código</span>} description={`Pantallas, funcionalidades, integraciones o rediseños. Se usa la configuración de IA de ${me?.workspace?.name ?? 'tu organización activa'}.`}>
          {blockedReason && <Alert tone="warning" className="mb-3">{blockedReason}</Alert>}
          {active && (
            <Alert tone="info" className="mb-3">
              Hay un cambio en curso: <Link className="font-medium underline" to={changeLink(active.id)}>{active.title ?? active.prompt.slice(0, 60)}</Link>. Los cambios se preparan de uno en uno.
            </Alert>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submit.mutate();
            }}
          >
            <Textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) submit.mutate();
              }}
              placeholder="Describe el cambio con detalle: qué debe hacer, dónde aparece en la interfaz, quién puede usarlo…"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" onClick={() => setPrompt(ex)} className="max-w-full truncate rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700">
                    {ex.length > 56 ? `${ex.slice(0, 54)}…` : ex}
                  </button>
                ))}
              </div>
              <Button type="submit" variant="ai" loading={submit.isPending} disabled={!canSubmit} icon={<Bot className="size-4" />}>
                Preparar cambio
              </Button>
            </div>
          </form>
        </Card>

        <Card title="Historial de cambios" description={list.data ? `En ejecución: ${list.data.running.version}` : undefined} padded={false}>
          {list.isLoading ? (
            <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : !list.data!.items.length ? (
            <EmptyState icon={<Code2 className="size-5" />} title="Todavía no hay cambios del código" description="Describe arriba el primer cambio o conviértelo desde una petición de una organización." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.data!.items.map((c) => (
                <li key={c.id}>
                  <Link to={changeLink(c.id)} className="flex items-center gap-3 px-4 py-3 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', c.status === 'deployed' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10' : 'bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/10')}>
                      <Code2 className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.title ?? c.prompt}</span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">
                        {c.requested_by_name ?? '—'} · {relativeTime(c.created_at)}
                        {c.stats.files ? ` · ${c.stats.files} archivo(s)` : ''}
                        {c.ci_attempts ? ` · CI ${c.ci_attempts} intento(s)` : ''}
                        {c.source_version ? ` · versión ${shortId(c.source_version)}` : ''}
                        {c.origin ? ` · petición de ${c.origin.workspaceName ?? 'una organización'}` : ''}
                      </span>
                    </span>
                    <span className="hidden flex-col items-end gap-1 sm:flex">
                      <StatusBadge status={c.status} />
                      {c.review_verdict === 'reject' && <Badge color="red">Revisión: no desplegar</Badge>}
                    </span>
                    <ArrowRight className="size-4 text-zinc-300" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Así funciona">
        <ol className="space-y-2.5">
          {FLOW.map((s) => (
            <li key={s.label} className="flex items-center gap-3 text-sm">
              <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-lg', s.who === 'Tú' ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300')}>
                <s.icon className="size-3.5" />
              </span>
              <span className="flex-1">{s.label}</span>
              <span className="text-[11px] text-zinc-400">{s.who}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-800/40">
          El código generado nunca se ejecuta en el web ni en el worker: solo en el CI aislado, hasta que tú lo apruebas. No se publica en GitHub: cada instalación evoluciona por su cuenta.
        </div>
      </Card>
    </div>
  );
}

type Tab = 'changes' | 'requests' | 'settings';

export default function CodeEngine() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const settings = useCodeSettings(!!me?.user.isPlatformAdmin);
  const changeId = params.get('change');
  if (!me?.user.isPlatformAdmin) {
    return <EmptyState className="py-24" icon={<Lock className="size-5" />} title="Solo administración de la plataforma" description="El motor de código fuente modifica el código de toda la instalación." />;
  }
  if (changeId) return <ChangeDetail key={changeId} id={changeId} />;
  const tab = (['changes', 'requests', 'settings'].includes(params.get('tab') ?? '') ? params.get('tab') : 'changes') as Tab;
  const role = me.workspace?.role;
  const blockedReason = !me.workspace
    ? 'Selecciona una organización activa: el motor usa su configuración de IA.'
    : !hasRole(role, 'admin')
      ? `Para usar la IA de ${me.workspace.name} tienes que ser su administrador o propietario.`
      : settings.data && !settings.data.configured
        ? 'Falta configurar la conexión con Railway (pestaña Configuración).'
        : null;

  return (
    <div className="@container mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={<span className="flex size-10 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"><Code2 className="size-5" /></span>}
        title="Código fuente de la instalación"
        description="Cambios del código real de la plataforma con IA, probados en un CI aislado y desplegados en tus servicios de Railway con tu aprobación."
        actions={settings.data ? <Badge color={settings.data.configured ? 'emerald' : 'amber'} dot>{settings.data.configured ? 'Railway conectado' : 'Configuración pendiente'}</Badge> : null}
      />
      <Tabs<Tab>
        tabs={[
          { key: 'changes', label: 'Cambios' },
          { key: 'requests', label: 'Peticiones de organizaciones' },
          { key: 'settings', label: 'Configuración' },
        ]}
        value={tab}
        onChange={(k) => setParams(k === 'changes' ? {} : { tab: k })}
      />
      {tab === 'changes' && <ChangesTab blockedReason={blockedReason} />}
      {tab === 'requests' && <PlatformInbox canCreate={!blockedReason} blockedReason={blockedReason} />}
      {tab === 'settings' && <SettingsPanel />}
    </div>
  );
}
