import { useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Mail, Trash2, UserMinus, UserPlus, Users } from 'lucide-react';
import { ApiError, del, errorMessage, get, patch, post } from '../../lib/api';
import { msg, t, tk, tp } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Alert, Avatar, Badge, Button, Card, ConfirmDialog, cx, EmptyState, ErrorState, Field, IconButton, Input, Modal, Select, Skeleton } from '../../components/ui';
import { ROLES, ROLE_LABELS, ROLE_RANK, type Color, type Role } from '../../../../shared/constants';

// ---------------------------------------------------------------- piezas reutilizadas por otras pestañas de ajustes

const ROLE_COLORS: Record<Role, Color> = { owner: 'amber', admin: 'violet', builder: 'fuchsia', member: 'sky', viewer: 'slate' };

/** Insignia de rol con el mismo color en todos los ajustes. */
export function RoleBadge({ role }: { role: string }) {
  return <Badge color={ROLE_COLORS[role as Role] ?? 'slate'}>{tk(ROLE_LABELS[role as Role] ?? role)}</Badge>;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* se prueba el método alternativo */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Valor de solo lectura con botón de copiar: enlaces, claves, URLs de webhook o fragmentos de código. */
export function CopyField({ value, label, multiline, size = 'md', onCopied, className }: { value: string; label: string; multiline?: boolean; size?: 'sm' | 'md'; onCopied?: () => void; className?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copy = async () => {
    if (!(await copyToClipboard(value))) {
      toast(t('No se ha podido copiar. Selecciona el texto y cópialo manualmente.'), 'error');
      return;
    }
    setCopied(true);
    onCopied?.();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  const button = (s: 'sm' | 'md') => (
    <Button type="button" size={s} className="shrink-0" icon={copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />} onClick={copy}>
      {copied ? t('Copiado') : t('Copiar')}
    </Button>
  );
  const surface = 'rounded-lg bg-zinc-50 font-mono text-zinc-800 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-200 dark:ring-zinc-700';
  if (multiline) {
    return (
      <div className={cx('relative', className)}>
        <pre aria-label={label} className={cx(surface, 'overflow-x-auto whitespace-pre-wrap break-all px-3 py-2.5 pr-28 text-xs leading-relaxed')}>
          {value}
        </pre>
        <div className="absolute right-1.5 top-1.5">{button('sm')}</div>
      </div>
    );
  }
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <input
        readOnly
        value={value}
        aria-label={label}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        className={cx(surface, 'min-w-0 flex-1 px-3 focus:outline-none focus:ring-2 focus:ring-brand-500', size === 'sm' ? 'h-8 text-[11px]' : 'h-9 text-xs')}
      />
      {button(size)}
    </div>
  );
}

// ---------------------------------------------------------------- equipo

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

interface InviteRow {
  id: string;
  email: string;
  role: Role;
  created_at: string;
  expires_at: string;
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: msg('Control total. Además, gestiona a otros propietarios, la política de aprobación y aprueba los cambios de riesgo alto.'),
  admin: msg('Gestiona el equipo, las invitaciones, las API keys, los canales y la IA, y aprueba los cambios de riesgo bajo y medio.'),
  builder: msg('Puede pedir cambios a EVOLVE AI ENGINE (campos, módulos, vistas o automatizaciones) además de gestionar registros.'),
  member: msg('Gestiona registros: crea, edita y elimina contactos, oportunidades, tareas y demás fichas de la organización.'),
  viewer: msg('Solo lectura: consulta registros, paneles e informes sin poder modificarlos.'),
};

const MEMBERS_KEY = ['workspace-members'];
const INVITES_KEY = ['workspace-invites'];

/** Errores por campo del servidor: validación zod ({ path, message }[]) o de registros ({ fields }). */
function serverFieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  if (!Array.isArray(e.details)) return e.fieldErrors;
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    if (typeof d?.path === 'string' && typeof d.message === 'string' && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}

export default function TeamTab() {
  const { can } = useSession();
  const isAdmin = can('admin');
  const [inviting, setInviting] = useState(false);
  return (
    <div className="space-y-5">
      <MembersCard onInvite={() => setInviting(true)} />
      <div className={cx('grid gap-5', isAdmin && 'lg:grid-cols-5')}>
        {isAdmin && <InvitesCard className="lg:col-span-3" />}
        <RolesCard className={isAdmin ? 'lg:col-span-2' : undefined} />
      </div>
      {isAdmin && <InviteModal open={inviting} onClose={() => setInviting(false)} />}
    </div>
  );
}

function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="size-8" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="hidden h-8 w-36 sm:block" />
        </div>
      ))}
    </div>
  );
}

function MembersCard({ onInvite }: { onInvite: () => void }) {
  const { me, can, refresh } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const myId = me?.user.id;
  const myRole = me?.workspace?.role;
  const isAdmin = can('admin');
  const isOwner = myRole === 'owner';
  const q = useQuery({ queryKey: MEMBERS_KEY, queryFn: () => get<MemberRow[]>('/workspace/members') });
  const [confirmRole, setConfirmRole] = useState<{ member: MemberRow; role: Role } | null>(null);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const [resetFor, setResetFor] = useState<MemberRow | null>(null);
  const [resetLink, setResetLink] = useState<{ member: MemberRow; link: string; minutes: number } | null>(null);

  const members = q.data ?? [];
  const owners = members.filter((m) => m.role === 'owner').length;
  const roleOptions = ROLES.filter((r) => isOwner || r !== 'owner');

  const invalidateMembers = () => {
    qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    qc.invalidateQueries({ queryKey: ['members-lookup'] });
  };

  const changeRole = useMutation({
    mutationFn: (v: { member: MemberRow; role: Role }) => patch(`/workspace/members/${v.member.id}`, { role: v.role }),
    onSuccess: async (_r, v) => {
      qc.setQueryData<MemberRow[]>(MEMBERS_KEY, (list) => list?.map((m) => (m.id === v.member.id ? { ...m, role: v.role } : m)));
      setConfirmRole(null);
      toast(v.member.id === myId ? t('Ahora eres {role}', { role: tk(ROLE_LABELS[v.role]) }) : t('{name} ahora es {role}', { name: v.member.name, role: tk(ROLE_LABELS[v.role]) }));
      invalidateMembers();
      if (v.member.id === myId) await refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: (m: MemberRow) => del(`/workspace/members/${m.id}`),
    onSuccess: (_r, m) => {
      setRemoving(null);
      toast(t('{name} ya no forma parte de la organización', { name: m.name }));
      invalidateMembers();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const createResetLink = useMutation({
    mutationFn: (m: MemberRow) => post<{ link: string; expiresInMinutes: number }>(`/workspace/members/${m.id}/reset-link`),
    onSuccess: (r, m) => {
      setResetFor(null);
      setResetLink({ member: m, link: r.link, minutes: r.expiresInMinutes });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  // Reflejo de las reglas del servidor para no ofrecer acciones que va a rechazar (el servidor decide).
  const manageable = (m: MemberRow) => {
    if (!isAdmin || !myRole) return false;
    if (m.role === 'owner' && !isOwner) return false;
    if (myRole === 'admin' && ROLE_RANK[m.role] >= ROLE_RANK.admin && m.id !== myId) return false;
    return true;
  };
  const isLastOwner = (m: MemberRow) => m.role === 'owner' && owners <= 1;

  const onRoleChange = (m: MemberRow, role: Role) => {
    if (role === m.role) return;
    if (m.id === myId || role === 'owner') setConfirmRole({ member: m, role });
    else changeRole.mutate({ member: m, role });
  };

  const confirmingSelf = confirmRole?.member.id === myId;

  return (
    <Card
      padded={false}
      title={
        <span className="flex items-center gap-2">
          {t('Miembros')} {q.data && <Badge>{members.length}</Badge>}
        </span>
      }
      description={t('Personas con acceso a esta organización y su rol.')}
      actions={
        isAdmin && (
          <Button variant="primary" size="sm" icon={<UserPlus className="size-3.5" />} onClick={onInvite}>
            {t('Invitar')}
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <RowsSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !members.length ? (
        <EmptyState icon={<Users className="size-5" />} title={t('Sin miembros')} description={t('Invita a tu equipo para empezar a colaborar.')} />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {members.map((m) => {
            const isMe = m.id === myId;
            const editable = manageable(m);
            const pending = changeRole.isPending && changeRole.variables?.member.id === m.id;
            const shownRole = pending && changeRole.variables ? changeRole.variables.role : m.role;
            const lastOwner = isLastOwner(m);
            const canRemove = editable && !isMe && !lastOwner;
            const canReset = isOwner && !isMe;
            return (
              <li key={m.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={m.name} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.name}</span>
                      {isMe && <Badge color="violet">{t('Tú')}</Badge>}
                    </div>
                    <div className="truncate text-xs text-zinc-500">{m.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-11 sm:pl-0">
                  <span className="hidden w-32 text-xs text-zinc-500 md:block" title={formatDate(m.joinedAt, true)}>
                    {t('Desde {date}', { date: formatDate(m.joinedAt) })}
                  </span>
                  {editable ? (
                    <div className="w-40">
                      <Select
                        aria-label={t('Rol de {name}', { name: m.name })}
                        value={shownRole}
                        disabled={pending || lastOwner}
                        title={lastOwner ? t('La organización necesita al menos un propietario') : undefined}
                        onChange={(e) => onRoleChange(m, e.target.value as Role)}
                      >
                        {roleOptions.map((r) => (
                          <option key={r} value={r}>
                            {tk(ROLE_LABELS[r])}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <RoleBadge role={m.role} />
                  )}
                  {isAdmin && (
                    <div className="ml-auto flex w-[4.25rem] shrink-0 justify-end gap-0.5 sm:ml-0">
                      {canReset && (
                        <IconButton label={t('Generar enlace de recuperación para {name}', { name: m.name })} onClick={() => setResetFor(m)}>
                          <KeyRound className="size-4" />
                        </IconButton>
                      )}
                      {canRemove && (
                        <IconButton label={t('Quitar a {name} de la organización', { name: m.name })} onClick={() => setRemoving(m)}>
                          <UserMinus className="size-4" />
                        </IconButton>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!confirmRole}
        onClose={() => setConfirmRole(null)}
        onConfirm={() => confirmRole && changeRole.mutate(confirmRole)}
        loading={changeRole.isPending}
        danger={confirmingSelf}
        confirmLabel={t('Cambiar rol')}
        title={confirmingSelf ? t('Cambiar tu propio rol') : t('Hacer propietario a {name}', { name: confirmRole?.member.name ?? '' })}
        description={
          confirmRole &&
          (confirmingSelf
            ? t('Pasarás a ser {role}. Perderás los permisos que no incluya ese rol y no podrás recuperarlos por tu cuenta.', { role: tk(ROLE_LABELS[confirmRole.role]) })
            : t('{name} tendrá control total de la organización, incluida la gestión de otros propietarios y de la política de aprobación.', { name: confirmRole.member.name }))
        }
      />

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        danger
        confirmLabel={t('Quitar acceso')}
        title={t('¿Quitar a {name} de la organización?', { name: removing?.name ?? '' })}
        description={t('Perderá el acceso de inmediato y se cerrarán sus sesiones en esta organización. Sus registros, notas e historial se conservan.')}
      />

      <ConfirmDialog
        open={!!resetFor}
        onClose={() => setResetFor(null)}
        onConfirm={() => resetFor && createResetLink.mutate(resetFor)}
        loading={createResetLink.isPending}
        confirmLabel={t('Generar enlace')}
        title={t('Generar enlace de recuperación')}
        description={t('Crearás un enlace de un solo uso para que {name} elija una contraseña nueva. La acción queda registrada en la auditoría.', { name: resetFor?.name ?? '' })}
      />

      <Modal
        open={!!resetLink}
        onClose={() => setResetLink(null)}
        title={t('Enlace de recuperación')}
        description={resetLink ? t('Para {name} ({email})', { name: resetLink.member.name, email: resetLink.member.email }) : undefined}
        footer={
          <Button variant="primary" onClick={() => setResetLink(null)}>
            {t('Listo')}
          </Button>
        }
      >
        {resetLink && (
          <div className="space-y-3">
            <CopyField value={resetLink.link} label={t('Enlace de recuperación de contraseña')} />
            <Alert tone="warning" title={t('Solo se muestra ahora')}>
              {tp(
                resetLink.minutes,
                'Caduca en {count} minuto y solo puede usarse una vez. Compártelo por un canal privado y seguro.',
                'Caduca en {count} minutos y solo puede usarse una vez. Compártelo por un canal privado y seguro.',
              )}
            </Alert>
            <p className="text-sm text-zinc-500">
              {t('Es útil cuando el envío de correo no está configurado: la persona abre el enlace, elige una contraseña nueva y se cierran todas sus sesiones abiertas.')}
              {me?.features.emailEnabled && ` ${t('Como el correo está activo, también puede usar «¿Has olvidado la contraseña?» en la pantalla de acceso.')}`}
            </p>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function InvitesCard({ className }: { className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: INVITES_KEY, queryFn: () => get<InviteRow[]>('/workspace/invites') });
  const [revoking, setRevoking] = useState<InviteRow | null>(null);
  const revoke = useMutation({
    mutationFn: (i: InviteRow) => del(`/workspace/invites/${i.id}`),
    onSuccess: (_r, i) => {
      setRevoking(null);
      toast(t('Invitación a {email} revocada', { email: i.email }));
      qc.invalidateQueries({ queryKey: INVITES_KEY });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const invites = q.data ?? [];
  return (
    <Card
      className={className}
      padded={false}
      title={
        <span className="flex items-center gap-2">
          {t('Invitaciones pendientes')} {q.data && <Badge>{invites.length}</Badge>}
        </span>
      }
      description={t('Caducan a los 7 días. El enlace de cada invitación solo se muestra al crearla.')}
    >
      {q.isLoading ? (
        <RowsSkeleton rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !invites.length ? (
        <EmptyState icon={<Mail className="size-5" />} title={t('No hay invitaciones pendientes')} description={t('Usa «Invitar» en la lista de miembros para sumar a alguien al equipo.')} />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                <Mail className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{i.email}</span>
                  <RoleBadge role={i.role} />
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {t('Creada {when} · caduca el {date}', { when: relativeTime(i.created_at), date: formatDate(i.expires_at) })}
                </div>
              </div>
              <IconButton label={t('Revocar la invitación a {email}', { email: i.email })} onClick={() => setRevoking(i)}>
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        loading={revoke.isPending}
        danger
        confirmLabel={t('Revocar invitación')}
        title={t('¿Revocar la invitación?')}
        description={t('El enlace enviado a {email} dejará de funcionar. Podrás invitar de nuevo cuando quieras.', { email: revoking?.email ?? '' })}
      />
    </Card>
  );
}

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useSession();
  const isOwner = me?.workspace?.role === 'owner';
  const qc = useQueryClient();
  const toast = useToast();
  const formId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ email: string; link: string | null; emailSent: boolean } | null>(null);
  const roles: Role[] = isOwner ? ['admin', 'builder', 'member', 'viewer'] : ['builder', 'member', 'viewer'];

  const reset = () => {
    setEmail('');
    setRole('member');
    setErrors({});
    setResult(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: (v: { email: string; role: Role }) => post<{ link: string | null; emailSent: boolean }>('/workspace/invites', v),
    onSuccess: (r, v) => {
      setResult({ email: v.email, link: r.link, emailSent: r.emailSent });
      toast(r.emailSent ? t('Invitación enviada a {email}', { email: v.email }) : t('Invitación creada'));
      qc.invalidateQueries({ queryKey: INVITES_KEY });
    },
    onError: (e) => {
      const fields = serverFieldErrors(e);
      if (e instanceof ApiError && e.status === 409) fields.email = e.message;
      setErrors(fields);
      toast(fields.email ?? fields.role ?? errorMessage(e), 'error');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setErrors({ email: t('Introduce un email válido') });
      return;
    }
    setErrors({});
    create.mutate({ email: value, role });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={result ? t('Invitación lista') : t('Invitar a una persona')}
      description={result ? undefined : t('Recibirá un enlace para unirse a la organización con el rol que elijas.')}
      footer={
        result ? (
          <>
            <Button onClick={reset}>{t('Invitar a otra persona')}</Button>
            <Button variant="primary" onClick={close}>
              {t('Listo')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>{t('Cancelar')}</Button>
            <Button type="submit" form={formId} variant="primary" icon={<UserPlus className="size-4" />} loading={create.isPending}>
              {t('Crear invitación')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          {result.emailSent ? (
            <Alert tone="success" title={t('Correo enviado')}>
              {t('Hemos enviado la invitación a {email}. Por seguridad, el enlace solo llega a su buzón (así se comprueba que el email es suyo).', { email: result.email })}
            </Alert>
          ) : (
            <Alert tone="warning" title={t('No se ha enviado ningún correo')}>
              {me?.features.emailEnabled ? t('El envío del correo ha fallado.') : t('El envío de correo no está configurado en este servidor.')}{' '}
              {t('Comparte tú este enlace con {email}. Su email quedará pendiente de verificar.', { email: result.email })}
            </Alert>
          )}
          {result.link && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">{t('Enlace de invitación')}</div>
              <CopyField value={result.link} label={t('Enlace de invitación')} />
            </div>
          )}
          <p className="text-xs text-zinc-500">
            {t('Caduca en 7 días y solo puede aceptarse con la cuenta de ese email.')}
            {result.link ? ` ${t('No se volverá a mostrar.')}` : ''}
          </p>
        </div>
      ) : (
        <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
          <Field label={t('Email')} required error={errors.email}>
            <Input
              type="email"
              value={email}
              invalid={!!errors.email}
              placeholder={t('nombre@empresa.com')}
              autoComplete="off"
              maxLength={254}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errors.email) setErrors({});
              }}
            />
          </Field>
          <Field label={t('Rol')} error={errors.role} hint={tk(ROLE_DESCRIPTIONS[role])}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {tk(ROLE_LABELS[r])}
                </option>
              ))}
            </Select>
          </Field>
          {!isOwner && <p className="text-xs text-zinc-500">{t('Solo un propietario puede invitar a administradores.')}</p>}
          {!me?.features.emailEnabled && (
            <Alert tone="info">{t('El envío de correo no está configurado: al crear la invitación obtendrás un enlace para compartirlo tú mismo.')}</Alert>
          )}
        </form>
      )}
    </Modal>
  );
}

function RolesCard({ className }: { className?: string }) {
  return (
    <Card className={className} title={t('Roles y permisos')} description={t('Cada rol incluye todos los permisos de los roles inferiores.')}>
      <ul className="space-y-3.5">
        {ROLES.map((r) => (
          <li key={r} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
            <div className="w-28 shrink-0">
              <RoleBadge role={r} />
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{tk(ROLE_DESCRIPTIONS[r])}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
