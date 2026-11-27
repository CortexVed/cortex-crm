import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RefreshCw, ScrollText, ShieldAlert } from 'lucide-react';
import { get } from '../../lib/api';
import { msg, t, tk, tp, tx } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { useDebounced } from '../../lib/hooks';
import { formatDate, relativeTime } from '../../lib/format';
import { Badge, Button, Card, cx, EmptyState, ErrorState, IconButton, Input, Select, Skeleton, Spinner } from '../../components/ui';
import type { Color } from '../../../../shared/constants';

interface AuditItem {
  id: string;
  action: string;
  actor_type: string;
  target_type: string | null;
  target_id: string | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
  actor_name: string | null;
}

/** Tamaño de página fijo del servidor (GET /workspace/audit). */
const PAGE_SIZE = 50;
const CUSTOM = '__custom__';

const CATEGORIES: { value: string; label: string }[] = [
  { value: '', label: msg('Todas las acciones') },
  { value: 'auth.', label: msg('Accesos y cuentas (auth.)') },
  { value: 'member.', label: msg('Equipo (member.)') },
  { value: 'workspace.', label: msg('Organización (workspace.)') },
  { value: 'evolve.', label: 'EVOLVE AI ENGINE (evolve.)' }, // i18n-ignore: nombre del producto
  { value: 'ai.', label: msg('Inteligencia artificial (ai.)') },
  { value: 'record.', label: msg('Registros (record.)') },
  { value: 'file.', label: msg('Archivos (file.)') },
  { value: 'api_key.', label: msg('API keys (api_key.)') },
  { value: 'connector.', label: msg('Canales (connector.)') },
  { value: 'backup.', label: msg('Copias de seguridad (backup.)') },
  { value: 'security.', label: msg('Seguridad (security.)') },
  { value: CUSTOM, label: msg('Otro prefijo…') },
];

const ACTION_LABELS: Record<string, string> = {
  'auth.register': msg('Registro de la cuenta'),
  'auth.login': msg('Inicio de sesión'),
  'auth.login_failed': msg('Intento de acceso fallido'),
  'auth.account_locked': msg('Cuenta bloqueada temporalmente'),
  'auth.session_revoked': msg('Sesión cerrada en otro dispositivo'),
  'auth.logout_all': msg('Cierre de las demás sesiones'),
  'auth.password_changed': msg('Contraseña cambiada'),
  'auth.password_reset_requested': msg('Recuperación de contraseña solicitada'),
  'auth.password_reset': msg('Contraseña restablecida'),
  'workspace.create': msg('Organización creada'),
  'workspace.updated': msg('Ajustes de la organización actualizados'),
  'workspace.exported': msg('Datos exportados'),
  'workspace.invite_accepted': msg('Invitación aceptada'),
  'member.invited': msg('Persona invitada'),
  'member.role_changed': msg('Rol cambiado'),
  'member.removed': msg('Miembro retirado de la organización'),
  'member.reset_link_created': msg('Enlace de recuperación generado'),
  'api_key.created': msg('API key creada'),
  'api_key.revoked': msg('API key revocada'),
  'connector.created': msg('Canal conectado'),
  'connector.deleted': msg('Canal eliminado'),
  'record.deleted': msg('Registro eliminado'),
  'record.restored': msg('Registro restaurado'),
  'file.deleted': msg('Archivo eliminado'),
  'backup.downloaded': msg('Copia de seguridad descargada'),
  'security.review_requested': msg('Revisión de seguridad solicitada'),
  'evolve.requested': msg('Cambio solicitado a EVOLVE'),
  'evolve.refined': msg('Propuesta refinada'),
  'evolve.approved': msg('Cambio aprobado'),
  'evolve.rejected': msg('Cambio rechazado'),
  'evolve.deployed': msg('Cambio aplicado'),
  'evolve.rolled_back': msg('Cambio revertido'),
  'evolve.version_restored': msg('Versión restaurada'),
  'evolve.manual_change': msg('Cambio manual de la configuración'),
  // Acciones del antiguo motor de código (ya retirado): se mantienen para leer el historial.
  'code.proposed': msg('Cambio de código propuesto (motor anterior)'),
  'code.pr_opened': msg('Pull request abierta (motor anterior)'),
  'code.merged': msg('Cambio de código fusionado (motor anterior)'),
  'code.revert_opened': msg('Reversión de código abierta (motor anterior)'),
  'ai.settings_updated': msg('Ajustes de IA actualizados'),
  'ai.provider_updated': msg('Proveedor de IA actualizado'),
  'ai.provider_key_set': msg('Clave de proveedor de IA guardada'),
  'ai.provider_key_revoked': msg('Clave de proveedor de IA revocada'),
  'ai.memory_added': msg('Memoria de IA añadida'),
  'ai.memory_updated': msg('Memoria de IA actualizada'),
  'ai.memory_archived': msg('Memoria de IA archivada'),
  'ai.memory_confirmed': msg('Propuesta de memoria confirmada'),
  'auth.email_verified': msg('Email verificado'),
  'auth.owner_reset_link_refused': msg('Enlace de recuperación rechazado (ya no era válido)'),
};

const PREFIX_COLORS: Record<string, Color> = {
  auth: 'sky',
  member: 'violet',
  workspace: 'blue',
  evolve: 'fuchsia',
  code: 'indigo',
  ai: 'purple',
  record: 'emerald',
  file: 'teal',
  api_key: 'amber',
  connector: 'cyan',
  backup: 'slate',
  security: 'rose',
};

const ACTOR_TYPES: Record<string, string> = { user: msg('Usuario'), api: msg('API key'), system: msg('Sistema'), automation: msg('Automatización'), ai: 'EVOLVE AI' };

const TARGET_TYPES: Record<string, string> = {
  user: msg('Usuario'),
  api_key: msg('API key'),
  connector: msg('Canal'),
  evolution_request: msg('Solicitud de EVOLVE'),
  code_change: msg('Cambio de código'),
  release: msg('Versión'),
  file: msg('Archivo'),
};

const TH = 'px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
const TD = 'px-3 py-2.5 align-top';

const shortId = (id: string) => (id.length > 10 ? `${id.slice(0, 8)}…` : id);

export default function AuditTab() {
  const { can } = useSession();
  const isAdmin = can('admin');
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState('');
  const [custom, setCustom] = useState('');
  const debouncedCustom = useDebounced(custom.trim(), 350);
  const action = category === CUSTOM ? debouncedCustom : category;

  const q = useQuery({
    queryKey: ['audit', action, page],
    queryFn: () => get<{ items: AuditItem[]; page: number }>(`/workspace/audit?page=${page}${action ? `&action=${encodeURIComponent(action)}` : ''}`),
    placeholderData: keepPreviousData,
    enabled: isAdmin,
  });
  // Misma consulta que la pestaña Equipo: permite mostrar el nombre del usuario afectado.
  const members = useQuery({ queryKey: ['workspace-members'], queryFn: () => get<{ id: string; name: string }[]>('/workspace/members'), enabled: isAdmin, staleTime: 60_000 });
  const memberNames = new Map((members.data ?? []).map((m) => [m.id, m.name]));

  if (!isAdmin) {
    return (
      <Card>
        <EmptyState icon={<ShieldAlert className="size-5" />} title={t('Solo para administradores')} description={t('El registro de auditoría solo está disponible para administradores de la organización.')} />
      </Card>
    );
  }

  const items = q.data?.items ?? [];
  const changingPage = q.isFetching && q.isPlaceholderData;

  return (
    <Card
      padded={false}
      title={t('Registro de auditoría')}
      description={t('Acciones de seguridad y administración de la organización, de la más reciente a la más antigua.')}
      actions={
        <IconButton label={t('Actualizar')} onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cx('size-4', q.isFetching && 'animate-spin')} />
        </IconButton>
      }
    >
      <div className="flex flex-col gap-2 border-b border-zinc-100 px-4 py-3 sm:flex-row sm:items-center dark:border-zinc-800">
        <div className="sm:w-72">
          <Select
            aria-label={t('Filtrar por tipo de acción')}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {tk(c.label)}
              </option>
            ))}
          </Select>
        </div>
        {category === CUSTOM && (
          <div className="sm:w-64">
            <Input
              aria-label={t('Prefijo de la acción')}
              placeholder={t('p. ej. evolve.approved')}
              value={custom}
              maxLength={60}
              autoFocus
              spellCheck={false}
              className="font-mono"
              onChange={(e) => {
                setCustom(e.target.value);
                setPage(1);
              }}
            />
          </div>
        )}
        {action && (
          <span className="text-xs text-zinc-500 sm:ml-auto">
            {tx('Acciones que empiezan por <code>{action}</code>', { action, code: (c) => <code className="font-mono text-zinc-700 dark:text-zinc-300">{c}</code> })}
          </span>
        )}
      </div>

      {q.isLoading ? (
        <div className="space-y-2.5 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={<ScrollText className="size-5" />}
          title={page > 1 ? t('No hay más eventos') : action ? t('Sin eventos con ese filtro') : t('Todavía no hay eventos')}
          description={page > 1 ? t('Has llegado al final del registro.') : action ? t('Ninguna acción registrada empieza por «{action}».', { action }) : t('Aquí aparecerán los accesos, los cambios de permisos y las acciones administrativas.')}
        />
      ) : (
        <div className={cx('overflow-x-auto transition-opacity', changingPage && 'opacity-60')}>
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className="w-10 py-2.5 pl-3" aria-label={t('Detalles')} />
                <th className={TH}>{t('Fecha')}</th>
                <th className={TH}>{t('Autor')}</th>
                <th className={TH}>{t('Acción')}</th>
                <th className={TH}>{t('Objetivo')}</th>
                <th className={TH}>IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.map((item) => (
                <AuditRow key={item.id} item={item} targetName={item.target_type === 'user' && item.target_id ? memberNames.get(item.target_id) : undefined} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <span className="flex items-center gap-2 text-xs text-zinc-500">
          {t('Página {page}', { page })}
          {q.data && items.length > 0 && ` · ${tp(items.length, '{count} evento', '{count} eventos')}`}
          {changingPage && <Spinner className="size-3.5" />}
        </span>
        <div className="flex gap-2">
          <Button size="sm" icon={<ChevronLeft className="size-3.5" />} disabled={page <= 1 || q.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {t('Anterior')}
          </Button>
          <Button size="sm" disabled={items.length < PAGE_SIZE || q.isFetching} onClick={() => setPage((p) => p + 1)}>
            {t('Siguiente')} <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AuditRow({ item, targetName }: { item: AuditItem; targetName?: string }) {
  const [open, setOpen] = useState(false);
  const hasMeta = !!item.meta && typeof item.meta === 'object' && Object.keys(item.meta).length > 0;
  const label = ACTION_LABELS[item.action];
  const typeLabel = tk(ACTOR_TYPES[item.actor_type] ?? item.actor_type);
  return (
    <Fragment>
      <tr className={cx('transition-colors hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30', open && 'bg-zinc-50/70 dark:bg-zinc-800/30')}>
        <td className="py-2 pl-3 align-top">
          {hasMeta && (
            <IconButton label={open ? t('Ocultar detalles') : t('Ver detalles')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <ChevronRight className={cx('size-4 transition-transform', open && 'rotate-90')} />
            </IconButton>
          )}
        </td>
        <td className={cx(TD, 'whitespace-nowrap')}>
          <div className="text-zinc-800 dark:text-zinc-200">{formatDate(item.created_at, true)}</div>
          <div className="text-xs text-zinc-500">{relativeTime(item.created_at)}</div>
        </td>
        <td className={TD}>
          <div className="text-zinc-800 dark:text-zinc-200">{item.actor_name ?? (item.actor_type === 'user' ? t('Usuario eliminado') : typeLabel)}</div>
          {item.actor_type !== 'user' && item.actor_name && <div className="text-xs text-zinc-500">{typeLabel}</div>}
        </td>
        <td className={TD}>
          {label && <div className="text-zinc-800 dark:text-zinc-200">{tk(label)}</div>}
          <Badge color={PREFIX_COLORS[item.action.split('.')[0]] ?? 'slate'} className="mt-0.5 font-mono">
            {item.action}
          </Badge>
        </td>
        <td className={TD}>
          {item.target_type || item.target_id ? (
            <div className="min-w-0">
              <div className="text-zinc-700 dark:text-zinc-300">{targetName ?? (item.target_type ? tk(TARGET_TYPES[item.target_type] ?? item.target_type) : t('Elemento'))}</div>
              {item.target_id && (
                <div className="font-mono text-[11px] text-zinc-400" title={item.target_id}>
                  {targetName ? `${tk(TARGET_TYPES.user)} · ` : ''}
                  {shortId(item.target_id)}
                </div>
              )}
            </div>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </td>
        <td className={cx(TD, 'whitespace-nowrap font-mono text-xs text-zinc-500')}>{item.ip ?? '—'}</td>
      </tr>
      {open && hasMeta && (
        <tr className="bg-zinc-50/70 dark:bg-zinc-800/30">
          <td />
          <td colSpan={5} className="px-3 pb-3">
            <pre className="max-h-72 overflow-auto rounded-lg bg-white p-3 font-mono text-xs leading-relaxed text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-300 dark:ring-zinc-800">
              {JSON.stringify(item.meta, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
