import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Check, Eye, EyeOff, LogOut, MailWarning, Monitor, MonitorSmartphone, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import { ApiError, del, errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Alert, Avatar, Badge, Button, Card, ConfirmDialog, cx, EmptyState, ErrorState, Field, Input, Skeleton } from '../../components/ui';
import { RoleBadge } from './TeamTab';

interface SessionRow {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

type PasswordForm = { current: string; next: string; confirm: string };
type PasswordErrors = Partial<Record<keyof PasswordForm, string>>;

const SESSIONS_KEY = ['auth-sessions'];
const EMPTY_FORM: PasswordForm = { current: '', next: '', confirm: '' };

// Mismas reglas que el servidor (PasswordSchema): 10+ caracteres y letras combinadas con números o símbolos.
const PASSWORD_RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: 'Al menos 10 caracteres', test: (p) => p.length >= 10 },
  { label: 'Contiene letras', test: (p) => /[A-Za-zÀ-ÿ]/.test(p) },
  { label: 'Contiene números o símbolos', test: (p) => /[0-9\W_]/.test(p) },
];

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

/** Descripción legible del dispositivo a partir del user agent ("Chrome en Windows"). */
function describeAgent(ua: string | null): { label: string; kind: 'mobile' | 'tablet' | 'desktop' | 'unknown' } {
  if (!ua) return { label: 'Dispositivo desconocido', kind: 'unknown' };
  const browser = /Edge?\/|EdgA\/|EdgiOS\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : /curl|python|node|axios|okhttp|go-http/i.test(ua)
                ? 'Cliente de API'
                : 'Navegador';
  const os = /iPad/.test(ua)
    ? 'iPadOS'
    : /iPhone|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
  const kind = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet' : /Mobi|iPhone|iPod/.test(ua) ? 'mobile' : 'desktop';
  return { label: os ? `${browser} en ${os}` : browser, kind };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function AccountTab() {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-5">
        <ProfileCard className="lg:col-span-2" />
        <PasswordCard className="lg:col-span-3" />
      </div>
      <PlatformSetupCard />
      <SessionsCard />
    </div>
  );
}

/**
 * Instalación nueva sin administración de la plataforma: quien la desplegó pega el token de instalación
 * (variable PLATFORM_ADMIN_SETUP_TOKEN del servicio web en Railway) y obtiene el panel de plataforma.
 */
function PlatformSetupCard() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const [token, setToken] = useState('');
  const claim = useMutation({
    mutationFn: () => post('/auth/platform-admin/claim', { token: token.trim() }),
    onSuccess: async () => {
      setToken('');
      toast('Ya eres administrador de la plataforma');
      await refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!me?.features.platformSetupAvailable) return null;
  return (
    <Card title="Administración de la plataforma" description="Esta instalación todavía no tiene a nadie que la administre.">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) claim.mutate();
        }}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Si has desplegado tú esta instalación, pega el token de instalación. Lo encontrarás en Railway, en las variables del servicio web, con el nombre <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">PLATFORM_ADMIN_SETUP_TOKEN</code>. Solo funciona una vez: después, la administración se gestiona con la CLI del contenedor.
        </p>
        <Field label="Token de instalación">
          <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Pega aquí el token" />
        </Field>
        <Button type="submit" variant="primary" loading={claim.isPending} disabled={!token.trim()}>
          Convertirme en administrador de la plataforma
        </Button>
      </form>
    </Card>
  );
}

function ProfileCard({ className }: { className?: string }) {
  const { me, refresh } = useSession();
  const toast = useToast();
  const resend = useMutation({
    mutationFn: () => post<{ ok: boolean; alreadyVerified?: boolean; emailEnabled?: boolean }>('/auth/verify-email/resend'),
    onSuccess: async (r) => {
      if (r.alreadyVerified) {
        toast('Tu email ya está verificado');
        await refresh();
      } else {
        toast('Te hemos enviado un nuevo enlace de verificación');
      }
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!me) return null;
  const u = me.user;
  return (
    <Card className={className} title="Perfil" description="Datos de tu cuenta de usuario.">
      <div className="flex items-center gap-3">
        <Avatar name={u.name} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{u.name}</div>
          <div className="truncate text-sm text-zinc-500">{u.email}</div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {u.emailVerified ? (
          <Badge color="emerald">
            <BadgeCheck className="size-3.5" /> Email verificado
          </Badge>
        ) : (
          <Badge color="amber">
            <MailWarning className="size-3.5" /> Email sin verificar
          </Badge>
        )}
        {u.isPlatformAdmin && (
          <Badge color="fuchsia">
            <ShieldCheck className="size-3.5" /> Administrador de la plataforma
          </Badge>
        )}
      </div>
      {!u.emailVerified &&
        (me.features.emailEnabled ? (
          <Alert tone="warning" className="mt-4" title="Verifica tu correo">
            <p>Así proteges tu cuenta y podrás recuperarla si olvidas la contraseña.</p>
            <Button size="sm" className="mt-2.5" loading={resend.isPending} onClick={() => resend.mutate()}>
              Reenviar enlace de verificación
            </Button>
          </Alert>
        ) : (
          <p className="mt-3 text-xs text-zinc-500">El envío de correo no está configurado en este servidor, así que no es posible enviar el enlace de verificación.</p>
        ))}
      {me.workspaces.length > 0 && (
        <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Tus organizaciones</div>
          <ul className="space-y-2">
            {me.workspaces.map((w) => (
              <li key={w.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">{w.name}</span>
                {w.id === me.workspace?.id && <span className="text-xs text-zinc-400">Actual</span>}
                <RoleBadge role={w.role} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function PasswordCard({ className }: { className?: string }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<PasswordForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [show, setShow] = useState(false);

  const change = useMutation({
    mutationFn: (v: { currentPassword: string; newPassword: string }) => post('/auth/password/change', v),
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setErrors({});
      setShow(false);
      toast('Contraseña actualizada. Hemos cerrado tus sesiones en otros dispositivos.');
      qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (e) => {
      const fields = serverFieldErrors(e);
      const next: PasswordErrors = {};
      if (e instanceof ApiError && e.code === 'invalid_password') next.current = e.message;
      if (fields.currentPassword) next.current = fields.currentPassword;
      if (fields.newPassword) next.next = fields.newPassword;
      setErrors(next);
      toast(next.current ?? next.next ?? errorMessage(e), 'error');
    },
  });

  const set = (k: keyof PasswordForm, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: PasswordErrors = {};
    if (!form.current) errs.current = 'Introduce tu contraseña actual';
    if (form.next.length < 10) errs.next = 'La contraseña debe tener al menos 10 caracteres';
    else if (!PASSWORD_RULES.every((r) => r.test(form.next))) errs.next = 'Combina letras con números o símbolos';
    else if (form.next === form.current) errs.next = 'La nueva contraseña debe ser distinta de la actual';
    if (!errs.next && form.confirm !== form.next) errs.confirm = 'Las contraseñas no coinciden';
    setErrors(errs);
    if (Object.keys(errs).length === 0) change.mutate({ currentPassword: form.current, newPassword: form.next });
  };

  const type = show ? 'text' : 'password';
  return (
    <Card
      className={className}
      title="Cambiar contraseña"
      description="Al cambiarla se cerrarán tus sesiones en otros dispositivos."
      actions={
        <Button variant="ghost" size="sm" aria-pressed={show} icon={show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} onClick={() => setShow((s) => !s)}>
          {show ? 'Ocultar' : 'Mostrar'}
        </Button>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {/* Campo oculto para que los gestores de contraseñas asocien el cambio a la cuenta correcta. */}
        <input type="email" name="username" autoComplete="username" value={me?.user.email ?? ''} readOnly hidden />
        <Field label="Contraseña actual" required error={errors.current}>
          <Input type={type} autoComplete="current-password" value={form.current} invalid={!!errors.current} maxLength={200} onChange={(e) => set('current', e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nueva contraseña" required error={errors.next}>
            <Input type={type} autoComplete="new-password" value={form.next} invalid={!!errors.next} maxLength={200} onChange={(e) => set('next', e.target.value)} />
          </Field>
          <Field label="Repite la nueva contraseña" required error={errors.confirm}>
            <Input type={type} autoComplete="new-password" value={form.confirm} invalid={!!errors.confirm} maxLength={200} onChange={(e) => set('confirm', e.target.value)} />
          </Field>
        </div>
        <ul className="grid gap-1.5 text-xs sm:grid-cols-3" aria-label="Requisitos de la contraseña">
          {PASSWORD_RULES.map((r) => {
            const ok = r.test(form.next);
            return (
              <li key={r.label} className={cx('flex items-center gap-1.5', ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-500')}>
                {ok ? <Check className="size-3.5 shrink-0" /> : <span className="mx-1 size-1.5 shrink-0 rounded-full bg-current opacity-60" />}
                {r.label}
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Button type="submit" variant="primary" loading={change.isPending}>
            Actualizar contraseña
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DeviceIcon({ kind }: { kind: ReturnType<typeof describeAgent>['kind'] }) {
  const Icon = kind === 'mobile' ? Smartphone : kind === 'tablet' ? Tablet : kind === 'desktop' ? Monitor : MonitorSmartphone;
  return <Icon className="size-4" />;
}

function SessionsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => get<SessionRow[]>('/auth/sessions') });
  const [revoking, setRevoking] = useState<SessionRow | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const revoke = useMutation({
    mutationFn: (s: SessionRow) => del(`/auth/sessions/${s.id}`),
    onSuccess: () => {
      setRevoking(null);
      toast('Sesión cerrada en ese dispositivo');
      qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const logoutOthers = useMutation({
    mutationFn: () => post('/auth/logout-all'),
    onSuccess: () => {
      setConfirmAll(false);
      toast('Se han cerrado las demás sesiones');
      qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const sessions = [...(q.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current));
  const others = sessions.filter((s) => !s.current).length;
  const revokingAgent = revoking ? describeAgent(revoking.userAgent) : null;

  return (
    <Card
      padded={false}
      title="Sesiones activas"
      description="Dispositivos con tu cuenta abierta. Cierra cualquiera que no reconozcas."
      actions={
        <Button size="sm" icon={<LogOut className="size-3.5" />} disabled={!others} onClick={() => setConfirmAll(true)}>
          <span className="hidden sm:inline">Cerrar las demás sesiones</span>
          <span className="sm:hidden">Cerrar otras</span>
        </Button>
      }
    >
      {q.isLoading ? (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
              <Skeleton className="size-9" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !sessions.length ? (
        <EmptyState icon={<Monitor className="size-5" />} title="Sin sesiones activas" />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sessions.map((s) => {
            const agent = describeAgent(s.userAgent);
            return (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  <DeviceIcon kind={agent.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100" title={s.userAgent ?? undefined}>
                      {agent.label}
                    </span>
                    {s.current && (
                      <Badge color="emerald" dot>
                        Esta sesión
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    <span className="font-mono">{s.ip ?? 'IP desconocida'}</span> · {s.current ? 'Activa ahora' : `Última actividad ${relativeTime(s.lastSeenAt)}`} · Iniciada el {formatDate(s.createdAt, true)}
                  </div>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(s)}>
                    Cerrar sesión
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        loading={revoke.isPending}
        danger
        confirmLabel="Cerrar sesión"
        title="¿Cerrar esta sesión?"
        description={revoking && revokingAgent ? `Se cerrará la sesión de ${revokingAgent.label}${revoking.ip ? ` (${revoking.ip})` : ''}. Habrá que volver a iniciar sesión en ese dispositivo.` : undefined}
      />
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => logoutOthers.mutate()}
        loading={logoutOthers.isPending}
        danger
        confirmLabel="Cerrar las demás"
        title="¿Cerrar las demás sesiones?"
        description={`Se cerrarán ${plural(others, 'sesión', 'sesiones')} en otros dispositivos. Esta sesión seguirá abierta.`}
      />
    </Card>
  );
}
