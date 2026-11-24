import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Calendar,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  Database,
  Download,
  Eye,
  FileCode,
  FlaskConical,
  HardDrive,
  History,
  ListChecks,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Modal, PageHeader, Skeleton, StatTile, Tabs, Textarea, cx } from '../../components/ui';
import { useToast } from '../../components/toast';
import { errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatBytes, formatDate, relativeTime } from '../../lib/format';
import { ModuleIcon } from '../../lib/icons';
import { MODULE_ACCENT } from '../../lib/colors';
import type { Blueprint } from '../../lib/types';
import type { Color } from '../../../../shared/constants';

type ReleaseKind = 'initial' | 'apply' | 'rollback' | 'restore';
type ReleaseStatus = 'applied' | 'verified' | 'failed' | 'rolled_back';

interface Release {
  id: string;
  kind: ReleaseKind;
  status: ReleaseStatus;
  from_version: number;
  to_version: number;
  title: string;
  summary: string | null;
  artifacts: { path: string; action: string }[] | null;
  tests: { total?: number; failed?: number; warnings?: number; suites?: { name: string; cases: number; failed: number }[] } | null;
  validation: Record<string, unknown> | null;
  verification: { ok?: boolean; checks?: { name: string; passed: boolean; message?: string }[]; at?: string } | null;
  data_changes_count: number | null;
  created_at: string;
  rolled_back_at: string | null;
  request_id: string | null;
  approved_by_name: string | null;
  applied_by_name: string | null;
  rolled_back_by_name: string | null;
}

interface ReleasesResponse {
  currentVersion: number;
  items: Release[];
}

interface Backup {
  id: string;
  release_id: string | null;
  reason: string;
  size: number;
  created_at: string;
}

interface VersionDefinition {
  version: number;
  createdAt: string;
  blueprint: Blueprint;
}

const KEYS = {
  releases: ['evolve', 'releases'] as const,
  backups: ['evolve', 'backups'] as const,
  version: (v: number) => ['evolve', 'version', v] as const,
};

const KIND: Record<ReleaseKind, { label: string; color: Color; icon: LucideIcon; actor: string }> = {
  initial: { label: 'Versión inicial', color: 'sky', icon: Rocket, actor: 'Creada por' },
  apply: { label: 'Evolución', color: 'violet', icon: Sparkles, actor: 'Publicada por' },
  rollback: { label: 'Rollback', color: 'orange', icon: RotateCcw, actor: 'Ejecutado por' },
  restore: { label: 'Restauración', color: 'blue', icon: History, actor: 'Restaurada por' },
};

const STATUS: Record<ReleaseStatus, { label: string; color: Color; node: string }> = {
  verified: { label: 'Verificada', color: 'emerald', node: 'bg-emerald-500 text-white' },
  applied: { label: 'Aplicada', color: 'amber', node: 'bg-amber-500 text-white' },
  failed: { label: 'Verificación fallida', color: 'red', node: 'bg-red-500 text-white' },
  rolled_back: { label: 'Revertida', color: 'slate', node: 'bg-zinc-300 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300' },
};

const ARTIFACT_ACTION: Record<string, { label: string; color: Color }> = {
  create: { label: 'Nuevo', color: 'emerald' },
  update: { label: 'Modificado', color: 'sky' },
  archive: { label: 'Archivado', color: 'amber' },
  delete: { label: 'Eliminado', color: 'red' },
};

const VALIDATION_LABELS: Record<string, string> = {
  issues: 'Avisos de validación',
  errors: 'Errores de validación',
  rebased: 'Adaptado a una versión más reciente',
  backupId: 'Copia de seguridad previa',
  revertedRecords: 'Registros restaurados',
  skippedRecords: 'Registros conservados (modificados después del cambio)',
};

const TRIGGER_LABELS: Record<string, string> = {
  record_created: 'Al crear un registro',
  record_updated: 'Al actualizar un registro',
  field_changed: 'Al cambiar un campo',
  record_deleted: 'Al eliminar un registro',
  date_reached: 'Al llegar una fecha',
  inactivity: 'Por inactividad',
};

const ROLLBACKABLE: ReleaseStatus[] = ['verified', 'applied', 'failed'];

// Estilo de botón "ghost" pequeño para enlaces de navegación (mismo aspecto que <Button variant="ghost" size="sm">).
const ghostLink =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function copyText(text: string, toast: (m: string, t?: 'success' | 'error' | 'info') => void) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado al portapapeles');
  } catch {
    toast('No se ha podido copiar al portapapeles', 'error');
  }
}

export default function Releases() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEYS.releases, queryFn: () => get<ReleasesResponse>('/evolve/releases') });
  const [rollbackTarget, setRollbackTarget] = useState<Release | null>(null);
  const [reason, setReason] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [definition, setDefinition] = useState<number | null>(null);

  const isAdmin = can('admin');
  const isOwner = can('owner');

  const items = useMemo(() => [...(q.data?.items ?? [])].sort((a, b) => b.to_version - a.to_version || b.created_at.localeCompare(a.created_at)), [q.data]);
  const current = q.data?.currentVersion ?? 0;
  const currentRelease = items.find((r) => r.to_version === current);
  const stats = useMemo(
    () => ({
      evolutions: items.filter((r) => r.kind === 'apply').length,
      reversions: items.filter((r) => r.kind === 'rollback' || r.kind === 'restore').length,
      tests: items.reduce((acc, r) => acc + (Number(r.tests?.total) || 0), 0),
    }),
    [items],
  );

  const refresh = () => {
    // ['evolve'] cubre el historial de versiones y las peticiones afectadas (quedan como revertidas).
    qc.invalidateQueries({ queryKey: ['blueprint'] });
    qc.invalidateQueries({ queryKey: ['evolve'] });
    qc.invalidateQueries({ queryKey: ['me'] });
  };

  const rollback = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      post<{ version: number; revertedRecords: number; skippedRecords: number }>(`/evolve/releases/${v.id}/rollback`, { confirmation: 'REVERTIR', reason: v.reason.trim() || undefined }),
    onSuccess: (res) => {
      const parts = [`Cambio revertido: tu CRM está ahora en la v${res.version}`];
      if (res.revertedRecords) parts.push(plural(res.revertedRecords, 'registro restaurado', 'registros restaurados'));
      if (res.skippedRecords) parts.push(plural(res.skippedRecords, 'registro conservado por cambios posteriores', 'registros conservados por cambios posteriores'));
      toast(parts.join(' · '));
      setRollbackTarget(null);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const restore = useMutation({
    mutationFn: (v: number) => post<{ version: number }>(`/evolve/versions/${v}/restore`, { confirmation: 'RESTAURAR' }),
    onSuccess: (res, v) => {
      toast(`Configuración de la v${v} restaurada como nueva versión v${res.version}`);
      setRestoreTarget(null);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white shadow-sm shadow-fuchsia-500/20 evolve-gradient">
            <History className="size-5" />
          </span>
        }
        title="Cómo ha evolucionado tu CRM"
        description="Cada cambio publicado queda registrado como una versión, con sus pruebas, su verificación y la posibilidad de revertirlo."
      />

      {q.isLoading ? (
        <ReleasesSkeleton />
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Versión actual" value={`v${current}`} icon={<Sparkles className="size-3.5 text-fuchsia-500" />} hint={currentRelease ? `Publicada ${relativeTime(currentRelease.created_at)}` : undefined} />
            <StatTile label="Evoluciones publicadas" value={stats.evolutions} icon={<Rocket className="size-3.5 text-zinc-400" />} hint="Aprobadas y desplegadas" />
            <StatTile label="Rollbacks y restauraciones" value={stats.reversions} icon={<RotateCcw className="size-3.5 text-zinc-400" />} hint="Vueltas a una versión anterior" />
            <StatTile label="Pruebas automáticas" value={stats.tests} icon={<FlaskConical className="size-3.5 text-zinc-400" />} hint="Ejecutadas antes de publicar" />
          </div>

          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <section aria-label="Historial de versiones">
              {items.length === 0 ? (
                <Card>
                  <EmptyState icon={<History className="size-5" />} title="Todavía no hay versiones" description="Cuando EVOLVE AI ENGINE publique un cambio aprobado, aparecerá aquí con todo su detalle." />
                </Card>
              ) : (
                <ol>
                  {items.map((r, i) => {
                    const isCurrent = r.to_version === current;
                    return (
                      <li key={r.id} className="relative pb-5 pl-12 last:pb-0">
                        {i < items.length - 1 && <span aria-hidden className="absolute -bottom-3 left-[17px] top-12 w-0.5 rounded-full bg-zinc-200 dark:bg-zinc-800" />}
                        <TimelineNode release={r} />
                        <ReleaseCard
                          release={r}
                          isCurrent={isCurrent}
                          showBackupLink={isOwner}
                          canRollback={isAdmin && isCurrent && r.kind === 'apply' && ROLLBACKABLE.includes(r.status)}
                          canRestore={isOwner && !isCurrent}
                          onRollback={() => {
                            setReason('');
                            setRollbackTarget(r);
                          }}
                          onRestore={() => setRestoreTarget(r.to_version)}
                          onViewDefinition={() => setDefinition(r.to_version)}
                        />
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <aside className="space-y-5">
              <HowItWorks />
              {isOwner && <BackupsCard releases={items} />}
            </aside>
          </div>
        </>
      )}

      {definition !== null && <DefinitionModal version={definition} current={definition === current} onClose={() => setDefinition(null)} />}

      <ConfirmDialog
        open={!!rollbackTarget}
        onClose={() => !rollback.isPending && setRollbackTarget(null)}
        onConfirm={() => rollbackTarget && rollback.mutate({ id: rollbackTarget.id, reason })}
        title={rollbackTarget ? `Revertir la v${rollbackTarget.to_version}` : 'Revertir versión'}
        description={rollbackTarget ? `«${rollbackTarget.title}»` : undefined}
        confirmLabel="Revertir cambio"
        danger
        typed="REVERTIR"
        loading={rollback.isPending}
      >
        {rollbackTarget && (
          <div className="space-y-3">
            <Alert tone="warning">
              Se publicará una nueva versión v{current + 1} con la configuración de la v{rollbackTarget.from_version}
              {(rollbackTarget.data_changes_count ?? 0) > 0 ? ' y se desharán sus migraciones de datos (los registros modificados después se conservan).' : '.'}
            </Alert>
            <Field label="Motivo (opcional)" hint="Quedará registrado en el historial de versiones y en la auditoría.">
              <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: el nuevo campo confunde al equipo comercial" />
            </Field>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={restoreTarget !== null}
        onClose={() => !restore.isPending && setRestoreTarget(null)}
        onConfirm={() => restoreTarget !== null && restore.mutate(restoreTarget)}
        title={restoreTarget !== null ? `Restaurar la v${restoreTarget}` : 'Restaurar versión'}
        confirmLabel="Restaurar versión"
        typed="RESTAURAR"
        loading={restore.isPending}
      >
        {restoreTarget !== null && (
          <Alert tone="info">
            Se creará la versión v{current + 1} con la configuración completa de la v{restoreTarget} (módulos, campos, vistas, automatizaciones y paneles). Los datos de tus registros no se modifican.
          </Alert>
        )}
      </ConfirmDialog>
    </div>
  );
}

function ReleasesSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Cargando versiones">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <Skeleton className="h-36 flex-1 rounded-xl" />
            </div>
          ))}
        </div>
        <Skeleton className="h-56 rounded-xl" />
      </div>
    </div>
  );
}

function TimelineNode({ release }: { release: Release }) {
  const kind = KIND[release.kind] ?? KIND.apply;
  const status = STATUS[release.status] ?? STATUS.applied;
  const Icon = kind.icon;
  return (
    <span className={cx('absolute left-0 top-3 flex size-9 items-center justify-center rounded-full ring-4 ring-zinc-50 dark:ring-zinc-950', status.node)}>
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

function VersionChip({ version, current }: { version: number; current?: boolean }) {
  return (
    <span className={cx('inline-flex h-6 items-center rounded-md px-2 font-mono text-xs font-semibold tabular-nums', current ? 'text-white shadow-sm shadow-fuchsia-500/20 evolve-gradient' : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900')}>
      v{version}
    </span>
  );
}

function ReleaseCard({
  release: r,
  isCurrent,
  canRollback,
  canRestore,
  showBackupLink,
  onRollback,
  onRestore,
  onViewDefinition,
}: {
  release: Release;
  isCurrent: boolean;
  canRollback: boolean;
  canRestore: boolean;
  showBackupLink: boolean;
  onRollback: () => void;
  onRestore: () => void;
  onViewDefinition: () => void;
}) {
  const [open, setOpen] = useState(false);
  const kind = KIND[r.kind] ?? KIND.apply;
  const status = STATUS[r.status] ?? STATUS.applied;
  const rolledBack = r.status === 'rolled_back';
  // En rollbacks, restauraciones y la versión inicial aprueba y ejecuta la misma persona.
  const showApprover = r.kind === 'apply' && !!r.approved_by_name;

  return (
    <article className={cx('rounded-xl bg-white shadow-xs dark:bg-zinc-900', isCurrent ? 'ring-2 ring-brand-500/50 dark:ring-brand-400/40' : 'ring-1 ring-zinc-200/80 dark:ring-zinc-800')}>
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <VersionChip version={r.to_version} current={isCurrent} />
          {r.from_version > 0 && <span className="text-xs text-zinc-400">desde v{r.from_version}</span>}
          <Badge color={kind.color}>{kind.label}</Badge>
          <Badge color={status.color} dot>
            {status.label}
          </Badge>
          {isCurrent && <Badge color="fuchsia">Versión actual</Badge>}
          <span className="ml-auto text-xs text-zinc-500" title={formatDate(r.created_at, true)}>
            {relativeTime(r.created_at)}
          </span>
        </div>

        <h3 className={cx('mt-2 text-[15px] font-semibold', rolledBack ? 'text-zinc-500 line-through decoration-zinc-400' : 'text-zinc-900 dark:text-zinc-100')}>{r.title}</h3>
        {r.summary && <p className={cx('mt-1 whitespace-pre-line text-sm', rolledBack ? 'text-zinc-400' : 'text-zinc-600 dark:text-zinc-400')}>{r.summary}</p>}

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
          {showApprover && (
            <span className="inline-flex items-center gap-1">
              <UserCheck className="size-3.5" /> Aprobada por <span className="font-medium text-zinc-700 dark:text-zinc-300">{r.approved_by_name}</span>
            </span>
          )}
          {r.applied_by_name && (
            <span className="inline-flex items-center gap-1">
              <Rocket className="size-3.5" /> {kind.actor} <span className="font-medium text-zinc-700 dark:text-zinc-300">{r.applied_by_name}</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Calendar className="size-3.5" /> {formatDate(r.created_at, true)}
          </span>
          {r.rolled_back_at && (
            <span className="inline-flex items-center gap-1 text-orange-700 dark:text-orange-300">
              <RotateCcw className="size-3.5" /> Revertida el {formatDate(r.rolled_back_at, true)}
              {r.rolled_back_by_name && <> por {r.rolled_back_by_name}</>}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-zinc-100 px-2.5 py-2 dark:border-zinc-800">
        <Button size="sm" variant="ghost" aria-expanded={open} icon={<ChevronDown className={cx('size-3.5 transition', open && 'rotate-180')} />} onClick={() => setOpen((o) => !o)}>
          Detalles
        </Button>
        <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={onViewDefinition}>
          Ver definición
        </Button>
        {r.request_id && (
          <Link to={`/evolve/requests/${r.request_id}`} className={ghostLink}>
            <ArrowUpRight className="size-3.5" /> Ver petición
          </Link>
        )}
        {(canRestore || canRollback) && (
          <div className="ml-auto flex flex-wrap items-center gap-2 pl-1">
            {canRestore && (
              <Button size="sm" icon={<History className="size-3.5" />} onClick={onRestore}>
                Restaurar esta versión
              </Button>
            )}
            {canRollback && (
              <Button size="sm" variant="danger" icon={<RotateCcw className="size-3.5" />} onClick={onRollback}>
                Revertir
              </Button>
            )}
          </div>
        )}
      </div>

      {open && <ReleaseDetails release={r} showBackupLink={showBackupLink} />}
    </article>
  );
}

function DetailSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        <Icon className="size-3.5" /> {title}
      </h4>
      {children}
    </section>
  );
}

function ReleaseDetails({ release: r, showBackupLink }: { release: Release; showBackupLink: boolean }) {
  const artifacts = r.artifacts ?? [];
  const tests = r.tests && typeof r.tests.total === 'number' ? r.tests : null;
  const validation = Object.entries(r.validation ?? {}).filter(([, v]) => v !== null && v !== undefined);
  const checks = r.verification?.checks ?? [];
  const dataChanges = r.data_changes_count ?? 0;
  const showData = r.kind === 'apply' || dataChanges > 0;
  const empty = !artifacts.length && !tests && !validation.length && !checks.length && !showData;

  const renderValidation = (key: string, value: unknown): ReactNode => {
    if (key === 'backupId' && typeof value === 'string') {
      return showBackupLink ? (
        <a href={`/api/evolve/backups/${value}/download`} download className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400">
          <Download className="size-3.5" /> Descargar
        </a>
      ) : (
        'Sí'
      );
    }
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (typeof value === 'number' || typeof value === 'string') return String(value);
    return JSON.stringify(value);
  };

  return (
    <div className="animate-fade-in rounded-b-xl border-t border-zinc-100 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
      {empty ? (
        <p className="text-sm text-zinc-500">No hay detalles técnicos registrados para esta versión.</p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {artifacts.length > 0 && (
            <DetailSection icon={FileCode} title={`Artefactos (${artifacts.length})`}>
              <ul className="max-h-56 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
                {artifacts.map((a, i) => {
                  const action = ARTIFACT_ACTION[a.action] ?? { label: a.action, color: 'slate' as Color };
                  return (
                    <li key={`${a.path}-${i}`} className="flex items-center gap-2 text-xs">
                      <Badge color={action.color} className="shrink-0">
                        {action.label}
                      </Badge>
                      <code className="min-w-0 truncate font-mono text-zinc-700 dark:text-zinc-300" title={a.path}>
                        {a.path}
                      </code>
                    </li>
                  );
                })}
              </ul>
            </DetailSection>
          )}

          {tests && (
            <DetailSection icon={FlaskConical} title="Pruebas en sandbox">
              <p className="text-sm">
                <span className="font-medium">{(tests.total ?? 0) - (tests.failed ?? 0)}</span>
                <span className="text-zinc-500">/{tests.total} superadas</span>
                {!!tests.failed && <span className="text-red-600 dark:text-red-400"> · {plural(tests.failed, 'fallida', 'fallidas')}</span>}
                {!!tests.warnings && <span className="text-amber-600 dark:text-amber-400"> · {plural(tests.warnings, 'aviso', 'avisos')}</span>}
              </p>
              {!!tests.suites?.length && (
                <ul className="mt-2 space-y-1">
                  {tests.suites.map((s, i) => (
                    <li key={`${s.name}-${i}`} className="flex items-center gap-2 text-xs">
                      {s.failed ? <CircleX className="size-3.5 shrink-0 text-red-500" /> : <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />}
                      <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">{s.name}</span>
                      <span className="tabular-nums text-zinc-500">
                        {s.cases - s.failed}/{s.cases}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
          )}

          {validation.length > 0 && (
            <DetailSection icon={ListChecks} title="Validación">
              <dl className="space-y-1 text-xs">
                {validation.map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3">
                    <dt className="text-zinc-500">{VALIDATION_LABELS[k] ?? k}</dt>
                    <dd className="shrink-0 font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{renderValidation(k, v)}</dd>
                  </div>
                ))}
              </dl>
            </DetailSection>
          )}

          {checks.length > 0 && (
            <DetailSection icon={ShieldCheck} title="Verificación tras publicar">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge color={r.verification?.ok ? 'emerald' : 'red'} dot>
                  {r.verification?.ok ? 'Todo correcto' : 'Con fallos'}
                </Badge>
                {r.verification?.at && <span className="text-xs text-zinc-500">{formatDate(r.verification.at, true)}</span>}
              </div>
              <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
                {checks.map((c, i) => (
                  <li key={`${c.name}-${i}`} className="flex gap-2 text-xs">
                    {c.passed ? <CircleCheck className="mt-px size-3.5 shrink-0 text-emerald-500" /> : <CircleX className="mt-px size-3.5 shrink-0 text-red-500" />}
                    <span className="min-w-0">
                      <span className="text-zinc-700 dark:text-zinc-300">{c.name}</span>
                      {c.message && <span className={cx('block', c.passed ? 'text-zinc-500' : 'text-red-600 dark:text-red-400')}>{c.message}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          )}

          {showData && (
            <DetailSection icon={Database} title="Migraciones de datos">
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                {dataChanges > 0 ? `${plural(dataChanges, 'migración aplicada', 'migraciones aplicadas')} a registros existentes.` : 'Este cambio no modificó datos de registros.'}
              </p>
            </DetailSection>
          )}
        </div>
      )}
    </div>
  );
}

function HowItWorks() {
  const items: { icon: LucideIcon; color: string; title: string; text: string }[] = [
    { icon: Sparkles, color: 'text-fuchsia-500', title: 'Cada cambio es una versión.', text: 'Solo se publica tras pruebas automáticas y aprobación humana, y se verifica justo después: si la verificación falla, se revierte sola.' },
    { icon: RotateCcw, color: 'text-orange-500', title: 'Revertir', text: 'deshace la última versión publicada, incluidas sus migraciones de datos. Para administradores.' },
    { icon: History, color: 'text-sky-500', title: 'Restaurar', text: 'recupera la configuración de cualquier versión anterior como una versión nueva, sin tocar los datos. Solo propietarios.' },
    { icon: HardDrive, color: 'text-emerald-500', title: 'Copias de seguridad', text: 'automáticas antes de cualquier cambio con migraciones o destructivo.' },
  ];
  return (
    <Card title="Cómo funcionan las versiones">
      <ul className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <li key={it.title} className="flex gap-2.5">
              <Icon className={cx('mt-0.5 size-4 shrink-0', it.color)} />
              <span>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">{it.title}</span> {it.text}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function BackupsCard({ releases }: { releases: Release[] }) {
  const q = useQuery({ queryKey: KEYS.backups, queryFn: () => get<Backup[]>('/evolve/backups') });
  const versionOf = (releaseId: string | null) => (releaseId ? releases.find((r) => r.id === releaseId)?.to_version : undefined);
  return (
    <Card title="Copias de seguridad" description="Datos afectados por un cambio, guardados antes de publicarlo." padded={false}>
      {q.isLoading ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-8" />
      ) : !q.data?.length ? (
        <EmptyState className="py-8" icon={<HardDrive className="size-5" />} title="Sin copias todavía" description="Se crean automáticamente al publicar cambios con migraciones de datos o destructivos." />
      ) : (
        <ul className="max-h-[420px] divide-y divide-zinc-100 overflow-y-auto scrollbar-thin dark:divide-zinc-800">
          {q.data.map((b) => {
            const v = versionOf(b.release_id);
            return (
              <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  <HardDrive className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={b.reason}>
                    {b.reason}
                  </p>
                  <p className="truncate text-xs text-zinc-500">
                    {v !== undefined && <span className="font-mono">v{v} · </span>}
                    {formatBytes(b.size)} · {formatDate(b.created_at, true)}
                  </p>
                </div>
                <a
                  href={`/api/evolve/backups/${b.id}/download`}
                  download
                  aria-label={`Descargar copia: ${b.reason}`}
                  title="Descargar copia (JSON)"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  <Download className="size-4" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DefinitionModal({ version, current, onClose }: { version: number; current: boolean; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<'summary' | 'json'>('summary');
  // Las versiones publicadas son inmutables: no hace falta volver a pedirlas.
  const q = useQuery({ queryKey: KEYS.version(version), queryFn: () => get<VersionDefinition>(`/evolve/versions/${version}`), staleTime: Infinity });
  const json = useMemo(() => (q.data ? JSON.stringify(q.data.blueprint, null, 2) : ''), [q.data]);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={
        <span className="flex flex-wrap items-center gap-2">
          Definición de la versión <VersionChip version={version} current={current} />
        </span>
      }
      description={q.data ? `Instantánea completa de la configuración creada el ${formatDate(q.data.createdAt, true)}.` : 'Instantánea completa de la configuración del CRM.'}
    >
      {q.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-48" />
          <div className="grid gap-2 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data ? (
        <div className="space-y-4">
          <Tabs
            tabs={[
              { key: 'summary', label: 'Resumen' },
              { key: 'json', label: 'JSON' },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === 'summary' ? (
            <DefinitionSummary blueprint={q.data.blueprint} />
          ) : (
            <div className="relative">
              <Button size="sm" className="absolute right-2 top-2 z-10" icon={<Copy className="size-3.5" />} onClick={() => copyText(json, toast)}>
                Copiar
              </Button>
              <pre className="max-h-[60vh] overflow-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-100 ring-1 ring-zinc-800 scrollbar-thin">{json}</pre>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

function DefinitionSummary({ blueprint: bp }: { blueprint: Blueprint }) {
  const activeModules = bp.modules.filter((m) => !m.archived);
  const moduleLabel = (key: string) => bp.modules.find((m) => m.key === key)?.labelPlural ?? key;
  const counters: [string, number][] = [
    ['Módulos activos', activeModules.length],
    ['Automatizaciones', bp.automations.length],
    ['Paneles', bp.dashboards.length],
    ['Formularios', bp.forms.length],
    ['Integraciones', bp.integrations.length],
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {counters.map(([label, n]) => (
          <div key={label} className="rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-800/40 dark:ring-zinc-800">
            <div className="text-lg font-semibold tabular-nums">{n}</div>
            <div className="text-xs text-zinc-500">{label}</div>
          </div>
        ))}
      </div>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Módulos</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {bp.modules.map((m) => {
            const fields = m.fields.filter((f) => !f.archived).length;
            return (
              <li key={m.key} className={cx('rounded-lg p-3 ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800', m.archived && 'opacity-60')}>
                <div className="flex items-center gap-2.5">
                  <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', MODULE_ACCENT[m.color] ?? MODULE_ACCENT.slate)}>
                    <ModuleIcon name={m.icon} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.labelPlural}</div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">{m.key}</div>
                  </div>
                  {m.archived && <Badge>Archivado</Badge>}
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  {plural(fields, 'campo', 'campos')} · {plural(m.views.length, 'vista', 'vistas')}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.views.map((v) => (
                    <Badge key={v.key} color="slate">
                      {v.label}
                    </Badge>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Automatizaciones</h3>
        {bp.automations.length === 0 ? (
          <p className="text-sm text-zinc-500">Esta versión no tiene automatizaciones.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-inset ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
            {bp.automations.map((a) => (
              <li key={a.key} className="flex items-center gap-3 px-3 py-2.5">
                <Zap className="size-4 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="truncate text-xs text-zinc-500">
                    {TRIGGER_LABELS[a.trigger.type] ?? a.trigger.type} · {moduleLabel(a.trigger.module)} · {plural(a.actions.length, 'acción', 'acciones')}
                  </div>
                </div>
                <Badge color={a.enabled ? 'emerald' : 'slate'} dot className="shrink-0">
                  {a.enabled ? 'Activa' : 'Pausada'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
