import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Check,
  CircleCheck,
  CodeXml,
  Copy,
  Cpu,
  GitBranch,
  Hand,
  Info,
  Lightbulb,
  Lock,
  RotateCcw,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  TriangleAlert,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, PageHeader, Skeleton, Spinner, cx } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { useToast } from '../../components/toast';
import { errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime } from '../../lib/format';
import { DOT } from '../../lib/colors';
import type { Color } from '../../../../shared/constants';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'pass';
type IssueSeverity = Exclude<Severity, 'pass'>;

interface Finding {
  severity: Severity;
  title: string;
  description: string;
  recommendation?: string;
  fix?: { kind: 'config' | 'code' | 'manual'; prompt: string };
  source: 'automatic' | 'ai';
}

interface SecurityReport {
  score: number;
  summary: string;
  findings: Finding[];
  model: string | null;
  aiError: string | null;
  ranAt: string;
}

interface RunSummary {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  requested_by_name: string | null;
}

interface RunDetail extends RunSummary {
  impact: SecurityReport | null;
  error: string | null;
}

/** Mutación "Preparar corrección" (crea una petición de EVOLVE con el prompt del hallazgo). */
interface PrepareFix {
  mutate: (prompt: string) => void;
  isPending: boolean;
  variables?: string;
}

// Mismo espacio de claves que el resto de EVOLVE: ['evolve', 'request', id] es compartida con el detalle de peticiones.
const KEYS = {
  runs: ['evolve', 'security'] as const,
  run: (id: string) => ['evolve', 'request', id] as const,
};

const RUNNING = new Set(['queued', 'planning']);
const STALE_MS = 5 * 60_000;

const RUN_STATUS: Record<string, { label: string; color: Color }> = {
  queued: { label: 'En cola', color: 'slate' },
  planning: { label: 'Analizando', color: 'violet' },
  ready_for_review: { label: 'Completada', color: 'emerald' },
  failed: { label: 'Fallida', color: 'red' },
  cancelled: { label: 'Cancelada', color: 'slate' },
};

const ORDER: IssueSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY: Record<IssueSeverity, { label: string; group: string; color: Color; icon: LucideIcon; tile: string; one: string; many: string }> = {
  critical: { label: 'Crítico', group: 'Críticos', color: 'red', icon: ShieldX, tile: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400', one: 'crítico', many: 'críticos' },
  high: { label: 'Alto', group: 'Riesgo alto', color: 'orange', icon: ShieldAlert, tile: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400', one: 'riesgo alto', many: 'riesgos altos' },
  medium: { label: 'Medio', group: 'Riesgo medio', color: 'amber', icon: TriangleAlert, tile: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400', one: 'riesgo medio', many: 'riesgos medios' },
  low: { label: 'Bajo', group: 'Riesgo bajo', color: 'sky', icon: Shield, tile: 'bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400', one: 'riesgo bajo', many: 'riesgos bajos' },
  info: { label: 'Informativo', group: 'Informativos', color: 'slate', icon: Info, tile: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400', one: 'informativo', many: 'informativos' },
};

// Las acciones manuales automáticas indican la ruta en Ajustes: se enlaza directamente cuando se reconoce.
const MANUAL_LINKS: { match: RegExp; to: string; label: string }[] = [
  { match: /Ajustes\s*›\s*Equipo/i, to: '/settings/team', label: 'Abrir Equipo' },
  { match: /Ajustes\s*›\s*API keys/i, to: '/settings/api-keys', label: 'Abrir API keys' },
  { match: /Proveedores de IA/i, to: '/settings/ai', label: 'Abrir Proveedores de IA' },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const severityOf = (f: Finding): Severity => (f.severity === 'pass' || (ORDER as string[]).includes(f.severity) ? f.severity : 'info');

function scoreTone(score: number) {
  if (score >= 80) return { label: 'Buen nivel', color: 'emerald' as Color, stroke: '#10b981', text: 'text-emerald-600 dark:text-emerald-400' };
  if (score >= 50) return { label: 'Mejorable', color: 'amber' as Color, stroke: '#f59e0b', text: 'text-amber-600 dark:text-amber-400' };
  return { label: 'En riesgo', color: 'red' as Color, stroke: '#ef4444', text: 'text-red-600 dark:text-red-400' };
}

export default function Security() {
  const { can } = useSession();
  if (!can('admin')) {
    return (
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <PageHeader title="Seguridad" description="Auditoría de seguridad de la organización." />
        <Card>
          <EmptyState icon={<Lock className="size-5" />} title="Acceso restringido" description="La auditoría de seguridad está disponible para administradores y propietarios de la organización." />
        </Card>
      </div>
    );
  }
  return <SecurityPage />;
}

function SecurityPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: KEYS.runs,
    queryFn: () => get<RunSummary[]>('/evolve/requests?kind=security'),
    refetchInterval: (query) => (query.state.data?.some((r) => RUNNING.has(r.status)) ? 4000 : false),
  });
  // Por defecto se muestra la auditoría más reciente.
  const activeId = selectedId ?? runs.data?.[0]?.id ?? null;
  const detail = useQuery({
    queryKey: KEYS.run(activeId ?? ''),
    queryFn: () => get<RunDetail>(`/evolve/requests/${activeId}`),
    enabled: !!activeId,
    refetchInterval: (query) => (query.state.data && RUNNING.has(query.state.data.status) ? 2000 : false),
  });

  // Aviso al terminar una auditoría que se estaba siguiendo en esta pantalla.
  const status = detail.data?.status;
  const last = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    if (!activeId || !status) return;
    const prev = last.current;
    if (prev && prev.id === activeId && RUNNING.has(prev.status) && !RUNNING.has(status)) {
      qc.invalidateQueries({ queryKey: KEYS.runs });
      if (status === 'ready_for_review') toast('Auditoría de seguridad completada');
      else if (status === 'failed') toast('La auditoría de seguridad no se ha podido completar', 'error');
    }
    last.current = { id: activeId, status };
  }, [activeId, status, qc, toast]);

  const start = useMutation({
    mutationFn: () => post<{ id: string }>('/evolve/security-review'),
    onSuccess: ({ id }) => {
      setSelectedId(id);
      qc.invalidateQueries({ queryKey: KEYS.runs });
      toast('Auditoría en marcha');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const prepare = useMutation({
    mutationFn: (prompt: string) => post<{ id: string }>('/evolve/requests', { prompt }),
    onSuccess: ({ id }) => {
      toast('Corrección enviada a EVOLVE AI ENGINE');
      qc.invalidateQueries({ queryKey: ['evolve', 'requests'] });
      navigate(`/evolve/requests/${id}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const activeRunning = !!detail.data && RUNNING.has(detail.data.status);
  // Una auditoría "atascada" (worker detenido) no debe bloquear lanzar otra.
  const activeStale = activeRunning && Date.now() - new Date(detail.data!.created_at).getTime() > STALE_MS;
  const busy = start.isPending || (activeRunning && !activeStale);

  const runButton = (
    <Button variant="primary" icon={<ShieldCheck className="size-4" />} loading={busy} onClick={() => start.mutate()}>
      {busy && !start.isPending ? 'Auditando…' : 'Ejecutar auditoría'}
    </Button>
  );

  let main: ReactNode;
  if (runs.isLoading || (activeId && detail.isLoading)) main = <ReportSkeleton />;
  else if (runs.isError)
    main = (
      <Card>
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      </Card>
    );
  else if (!activeId)
    main = (
      <Card>
        <EmptyState
          icon={<ShieldCheck className="size-5" />}
          title="Aún no has ejecutado ninguna auditoría"
          description="Lanza la primera para conocer la puntuación de seguridad de tu organización y qué puedes mejorar."
          action={runButton}
        />
      </Card>
    );
  else if (detail.isError)
    main = (
      <Card>
        <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
      </Card>
    );
  else if (detail.data) {
    const run = detail.data;
    if (RUNNING.has(run.status)) main = <RunningCard run={run} />;
    else if (run.status === 'failed')
      main = (
        <Card>
          <div className="space-y-4">
            <Alert tone="danger" title="La auditoría no se ha podido completar">
              {run.error || 'Se produjo un error inesperado durante el análisis.'}
            </Alert>
            <Button variant="primary" icon={<RotateCcw className="size-4" />} loading={start.isPending} onClick={() => start.mutate()}>
              Volver a ejecutar
            </Button>
          </div>
        </Card>
      );
    else if (run.status === 'ready_for_review' && run.impact) main = <ReportView report={run.impact} run={run} prepare={prepare} />;
    else
      main = (
        <Card>
          <EmptyState icon={<Info className="size-5" />} title="Esta auditoría no tiene informe" description={`Estado: ${RUN_STATUS[run.status]?.label ?? run.status}. Ejecuta una nueva auditoría para obtener resultados.`} />
        </Card>
      );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">
            <ShieldCheck className="size-5" />
          </span>
        }
        title="Seguridad"
        description="Comprobaciones automáticas y revisión con IA de la seguridad de tu organización."
        actions={runButton}
      />

      <HowItWorks />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">{main}</div>
        <aside>
          <HistoryCard runs={runs} activeId={activeId} onSelect={setSelectedId} />
        </aside>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps: { icon: LucideIcon; title: string; text: string }[] = [
    {
      icon: Cpu,
      title: 'Comprobaciones automáticas',
      text: 'Aislamiento entre organizaciones (RLS), roles y propietarios, API keys, permisos de borrado, integraciones con datos personales, formularios públicos e intentos de acceso fallidos.',
    },
    {
      icon: Sparkles,
      title: 'Revisión con IA',
      text: 'La IA de seguridad de tu organización analiza la configuración del CRM (nunca los datos personales) y señala riesgos adicionales.',
    },
    {
      icon: GitBranch,
      title: 'Correcciones con aprobación',
      text: 'Los hallazgos de configuración se convierten en cambios que siguen el flujo habitual: pruebas en sandbox, aprobación humana y versión con rollback.',
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {steps.map((s, i) => {
        const Icon = s.icon;
        return (
          <div key={s.title} className="rounded-xl bg-white p-4 shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
            <div className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
                <Icon className="size-4" />
              </span>
              <h2 className="text-sm font-semibold">
                {i + 1}. {s.title}
              </h2>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">{s.text}</p>
          </div>
        );
      })}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Cargando auditoría">
      <div className="flex flex-col items-center gap-5 rounded-xl bg-white p-4 ring-1 ring-zinc-200/80 sm:flex-row dark:bg-zinc-900 dark:ring-zinc-800">
        <Skeleton className="size-36 shrink-0 rounded-full" />
        <div className="w-full flex-1 space-y-2.5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-32 rounded-xl" />
      ))}
    </div>
  );
}

function RunningCard({ run }: { run: RunDetail }) {
  // Reloj local para refrescar "hace X" y detectar auditorías atascadas sin depender del sondeo.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const slow = now - new Date(run.created_at).getTime() > STALE_MS;
  return (
    <Card>
      <div className="flex flex-col items-center px-2 py-10 text-center" role="status" aria-live="polite">
        <div className="relative flex size-14 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/15" />
          <span className="relative flex size-14 items-center justify-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
            <ShieldCheck className="size-6" />
          </span>
        </div>
        <h3 className="mt-5 text-sm font-semibold">{run.status === 'queued' ? 'Auditoría en cola…' : 'Analizando la seguridad de tu organización…'}</h3>
        <p className="mt-1 max-w-md text-sm text-zinc-500">
          Primero se ejecutan las comprobaciones automáticas y después la revisión con IA. Suele tardar menos de un minuto: puedes salir de esta página y consultar el resultado en el historial.
        </p>
        <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-zinc-500">
          <Spinner className="size-3.5" /> Iniciada {relativeTime(run.created_at)}
        </p>
        {slow && (
          <Alert tone="warning" className="mt-5 max-w-md text-left">
            Está tardando más de lo habitual. Comprueba que el servicio de tareas en segundo plano está activo; también puedes lanzar una nueva auditoría.
          </Alert>
        )}
      </div>
    </Card>
  );
}

function ScoreGauge({ score }: { score: number }) {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const tone = scoreTone(s);
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative size-36 shrink-0" role="img" aria-label={`Puntuación de seguridad: ${s} de 100 (${tone.label})`}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="10" className="stroke-zinc-100 dark:stroke-zinc-800" />
        {s > 0 && <circle cx="60" cy="60" r={R} fill="none" strokeWidth="10" strokeLinecap="round" stroke={tone.stroke} strokeDasharray={`${(s / 100) * C} ${C}`} className="transition-[stroke-dasharray] duration-700" />}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cx('text-4xl font-semibold tracking-tight tabular-nums', tone.text)}>{s}</span>
        <span className="text-[11px] text-zinc-500">de 100</span>
      </div>
    </div>
  );
}

function ReportView({ report, run, prepare }: { report: SecurityReport; run: RunDetail; prepare: PrepareFix }) {
  const findings = report.findings ?? [];
  const passed = findings.filter((f) => severityOf(f) === 'pass');
  const groups = useMemo(
    () =>
      ORDER.map((s) => ({ severity: s, items: findings.filter((f) => severityOf(f) === s) })).filter((g) => g.items.length > 0),
    [findings],
  );
  const tone = scoreTone(report.score);

  return (
    <div className="space-y-5 animate-fade-in">
      <Card>
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
          <ScoreGauge score={report.score} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <h2 className="text-base font-semibold">Puntuación de seguridad</h2>
              <Badge color={tone.color} dot>
                {tone.label}
              </Badge>
            </div>
            {report.summary && <Markdown text={report.summary} className="mt-2 space-y-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300" />}
            <div className="mt-3 flex flex-wrap justify-center gap-1.5 sm:justify-start">
              {groups.map((g) => (
                <Badge key={g.severity} color={SEVERITY[g.severity].color}>
                  {plural(g.items.length, SEVERITY[g.severity].one, SEVERITY[g.severity].many)}
                </Badge>
              ))}
              {passed.length > 0 && <Badge color="emerald">{plural(passed.length, 'control verificado', 'controles verificados')}</Badge>}
            </div>
            <p className="mt-3 text-center text-xs text-zinc-500 sm:text-left">
              Ejecutada el {formatDate(report.ranAt, true)}
              {run.requested_by_name ? ` por ${run.requested_by_name}` : ''} · {report.model ? `Revisión con IA: ${report.model}` : 'Sin revisión con IA'}
            </p>
          </div>
        </div>
      </Card>

      {report.aiError && (
        <Alert tone="warning" title="La revisión con IA no se ha completado">
          <p className="break-words">{report.aiError}</p>
          <p className="mt-1">Las comprobaciones automáticas se muestran igualmente y la puntuación se basa solo en ellas.</p>
          <Link to="/settings/ai" className="mt-2 inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
            <Settings className="size-3.5" /> Revisar proveedores de IA
          </Link>
        </Alert>
      )}

      {groups.length === 0 ? (
        <Alert tone="success" title="No se han detectado riesgos">
          Todas las comprobaciones se han superado. Repite la auditoría periódicamente o tras cambios importantes en el equipo o la configuración.
        </Alert>
      ) : (
        groups.map((g) => {
          const meta = SEVERITY[g.severity];
          return (
            <section key={g.severity} aria-label={meta.group}>
              <h3 className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
                <span className={cx('size-2 rounded-full', DOT[meta.color])} />
                {meta.group}
                <span className="rounded-full bg-zinc-100 px-1.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{g.items.length}</span>
              </h3>
              <div className="space-y-3">
                {g.items.map((f, i) => (
                  <FindingCard key={`${f.source}-${f.title}-${i}`} finding={f} severity={g.severity} prepare={prepare} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {passed.length > 0 && (
        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-4 text-emerald-500" /> Controles verificados
            </span>
          }
          description="Medidas de seguridad comprobadas y activas en tu organización."
        >
          <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {passed.map((f, i) => (
              <li key={`${f.title}-${i}`} className="flex gap-2.5">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{f.title}</p>
                  <p className="text-xs leading-relaxed text-zinc-500">{f.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function SourceChip({ source }: { source: Finding['source'] }) {
  return source === 'ai' ? (
    <span className="inline-flex items-center gap-1 rounded-md bg-fuchsia-50 px-1.5 py-0.5 text-[11px] font-medium text-fuchsia-700 ring-1 ring-inset ring-fuchsia-200 dark:bg-fuchsia-500/10 dark:text-fuchsia-300 dark:ring-fuchsia-500/25">
      <Sparkles className="size-3" /> IA
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700">
      <Cpu className="size-3" /> Automático
    </span>
  );
}

function FindingCard({ finding: f, severity, prepare }: { finding: Finding; severity: IssueSeverity; prepare: PrepareFix }) {
  const meta = SEVERITY[severity];
  const Icon = meta.icon;
  return (
    <article className="rounded-xl bg-white p-4 shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-start gap-3">
        <span className={cx('mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-lg sm:flex', meta.tile)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge color={meta.color} dot>
              {meta.label}
            </Badge>
            <SourceChip source={f.source} />
          </div>
          <h4 className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{f.title}</h4>
          <p className="mt-1 break-words text-sm text-zinc-600 dark:text-zinc-400">{f.description}</p>
          {f.recommendation && (
            <p className="mt-2 flex gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <span className="min-w-0 break-words">
                <span className="font-medium">Recomendación:</span> {f.recommendation}
              </span>
            </p>
          )}
          {f.fix?.kind === 'config' && <ConfigFix prompt={f.fix.prompt} prepare={prepare} />}
          {f.fix?.kind === 'code' && <CodeFix prompt={f.fix.prompt} />}
          {f.fix?.kind === 'manual' && <ManualFix prompt={f.fix.prompt} />}
        </div>
      </div>
    </article>
  );
}

function ConfigFix({ prompt, prepare }: { prompt: string; prepare: PrepareFix }) {
  const mine = prepare.isPending && prepare.variables === prompt;
  return (
    <div className="mt-3 rounded-lg bg-brand-50/70 p-3 ring-1 ring-inset ring-brand-100 dark:bg-brand-500/10 dark:ring-brand-500/20">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
        <WandSparkles className="size-3.5" /> Corrección de configuración disponible
      </div>
      <p className="mt-1 break-words text-sm text-zinc-700 dark:text-zinc-300">«{prompt}»</p>
      <p className="mt-1 text-xs text-zinc-500">EVOLVE AI ENGINE preparará el cambio, lo probará en un entorno aislado y lo dejará pendiente de tu aprobación. Nada se aplica sin tu visto bueno.</p>
      <Button size="sm" variant="ai" className="mt-2.5" icon={<WandSparkles className="size-3.5" />} loading={mine} disabled={prepare.isPending && !mine} onClick={() => prepare.mutate(prompt)}>
        Preparar corrección
      </Button>
    </div>
  );
}

function CodeFix({ prompt }: { prompt: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      toast('Instrucción copiada al portapapeles');
    } catch {
      toast('No se ha podido copiar al portapapeles', 'error');
    }
  };
  return (
    <div className="mt-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-950/40 dark:ring-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
          <CodeXml className="size-3.5" /> Requiere un cambio de código
        </span>
        <Button size="sm" variant="ghost" icon={copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />} onClick={copy}>
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
      <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">{prompt}</pre>
      <p className="mt-2 text-xs text-zinc-500">
        Este ajuste afecta a la plataforma completa (no solo a tu organización), así que lo aplica el equipo de Cortex CRM en una nueva versión de la plataforma. Los cambios que pide cada organización nunca modifican el código común.
      </p>
    </div>
  );
}

function ManualFix({ prompt }: { prompt: string }) {
  const link = MANUAL_LINKS.find((l) => l.match.test(prompt));
  return (
    <div className="mt-3 flex gap-2.5 rounded-lg bg-sky-50 p-3 text-sm text-sky-900 ring-1 ring-inset ring-sky-200 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-500/20">
      <Hand className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-xs font-semibold">Acción manual</div>
        <p className="mt-0.5 break-words">{prompt}</p>
        {link && (
          <Link to={link.to} className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline">
            {link.label} <ArrowUpRight className="size-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}

function HistoryCard({ runs, activeId, onSelect }: { runs: UseQueryResult<RunSummary[]>; activeId: string | null; onSelect: (id: string) => void }) {
  return (
    <Card title="Historial" description="Auditorías anteriores de la organización." padded={false}>
      {runs.isLoading ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} className="py-8" />
      ) : !runs.data?.length ? (
        <p className="px-4 py-8 text-center text-sm text-zinc-500">Todavía no hay auditorías.</p>
      ) : (
        <ul className="max-h-[520px] divide-y divide-zinc-100 overflow-y-auto scrollbar-thin dark:divide-zinc-800">
          {runs.data.map((r) => {
            const st = RUN_STATUS[r.status] ?? { label: r.status, color: 'slate' as Color };
            const active = r.id === activeId;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onSelect(r.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cx('flex w-full items-center gap-3 px-4 py-3 text-left transition', active ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50')}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cx('block truncate text-sm font-medium', active && 'text-brand-700 dark:text-brand-300')}>{formatDate(r.created_at, true)}</span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-500">
                      {relativeTime(r.created_at)}
                      {r.requested_by_name ? ` · ${r.requested_by_name}` : ''}
                    </span>
                  </span>
                  <Badge color={st.color} dot className="shrink-0">
                    {st.label}
                  </Badge>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
