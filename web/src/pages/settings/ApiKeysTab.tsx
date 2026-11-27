import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldAlert, Terminal, Trash2, Webhook } from 'lucide-react';
import { useBlueprint } from '../../lib/hooks';
import { del, errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime } from '../../lib/format';
import { msg, t, tk, tp } from '../../lib/i18n';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, Card, ConfirmDialog, cx, EmptyState, ErrorState, Field, IconButton, Input, Modal, Select, Skeleton } from '../../components/ui';
import { ROLE_LABELS, type Role } from '../../../../shared/constants';
import { CopyField, RoleBadge } from './TeamTab';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  role: Role;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by_name: string | null;
}

interface CreatedKey {
  id: string;
  key: string;
  prefix: string;
  name: string;
  role: Role;
}

const KEYS_KEY = ['api-keys'];

// Marcados con msg(): se traducen al mostrarlos con tk().
const KEY_ROLE_HINTS: Record<Exclude<Role, 'owner'>, string> = {
  admin: msg('Acceso de administración, salvo las acciones que exigen una sesión de usuario.'),
  builder: msg('Gestiona registros y puede solicitar cambios a EVOLVE AI ENGINE.'),
  member: msg('Lee, crea y modifica registros. Recomendado para la mayoría de integraciones.'),
  viewer: msg('Solo lectura de registros, paneles e informes.'),
};

const TH = 'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
const TD = 'px-4 py-3 align-middle';

export default function ApiKeysTab() {
  const { can } = useSession();
  const isAdmin = can('admin');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: KEYS_KEY, queryFn: () => get<ApiKeyRow[]>('/workspace/api-keys'), enabled: isAdmin });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const revoke = useMutation({
    mutationFn: (k: ApiKeyRow) => del(`/workspace/api-keys/${k.id}`),
    onSuccess: (_r, k) => {
      setRevoking(null);
      toast(t('Clave «{name}» revocada', { name: k.name }));
      qc.invalidateQueries({ queryKey: KEYS_KEY });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (!isAdmin) {
    return (
      <Card>
        <EmptyState icon={<ShieldAlert className="size-5" />} title={t('Solo para administradores')} description={t('Pide a un administrador de la organización que gestione las API keys.')} />
      </Card>
    );
  }

  const keys = q.data ?? [];
  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);
  const visible = showRevoked ? [...active, ...revoked] : active;

  return (
    <div className="space-y-5">
      <Card
        padded={false}
        title={
          <span className="flex items-center gap-2">
            {t('API keys')} {q.data && <Badge>{tp(active.length, '{count} activa', '{count} activas')}</Badge>}
          </span>
        }
        description={t('Claves para conectar integraciones y scripts con la API de Cortex CRM.')}
        actions={
          <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
            {t('Nueva API key')}
          </Button>
        }
      >
        {q.isLoading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !keys.length ? (
          <EmptyState
            icon={<KeyRound className="size-5" />}
            title={t('Todavía no hay API keys')}
            description={t('Crea una clave para que tus integraciones lean y escriban datos en esta organización.')}
            action={
              <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
                {t('Crear la primera clave')}
              </Button>
            }
          />
        ) : (
          <>
            {visible.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                    <tr>
                      <th className={TH}>{t('Nombre')}</th>
                      <th className={TH}>{t('Clave')}</th>
                      <th className={TH}>{t('Rol')}</th>
                      <th className={TH}>{t('Creada')}</th>
                      <th className={TH}>{t('Último uso')}</th>
                      <th className={cx(TH, 'text-right')}>{t('Estado')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {visible.map((k) => (
                      <tr key={k.id} className={cx(k.revoked_at && 'opacity-60')}>
                        <td className={cx(TD, 'font-medium text-zinc-900 dark:text-zinc-100')}>{k.name}</td>
                        <td className={TD}>
                          <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">evk_{k.prefix}_…</code>
                        </td>
                        <td className={TD}>
                          <RoleBadge role={k.role} />
                        </td>
                        <td className={TD}>
                          <div className="text-zinc-800 dark:text-zinc-200" title={formatDate(k.created_at, true)}>
                            {formatDate(k.created_at)}
                          </div>
                          <div className="text-xs text-zinc-500">{k.created_by_name ? t('por {name}', { name: k.created_by_name }) : t('por un usuario eliminado')}</div>
                        </td>
                        <td className={cx(TD, 'text-zinc-600 dark:text-zinc-400')}>
                          {k.last_used_at ? <span title={formatDate(k.last_used_at, true)}>{relativeTime(k.last_used_at)}</span> : <span className="text-zinc-400">{t('Nunca')}</span>}
                        </td>
                        <td className={TD}>
                          {k.revoked_at ? (
                            <div className="flex justify-end">
                              <Badge color="red">{t('Revocada el {date}', { date: formatDate(k.revoked_at) })}</Badge>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <Badge color="emerald" dot>
                                {t('Activa')}
                              </Badge>
                              <IconButton label={t('Revocar la clave {name}', { name: k.name })} onClick={() => setRevoking(k)}>
                                <Trash2 className="size-4" />
                              </IconButton>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon={<KeyRound className="size-5" />} title={t('No hay claves activas')} description={t('Todas las claves de la organización están revocadas.')} />
            )}
            {revoked.length > 0 && (
              <div className="border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
                <button type="button" className="text-xs font-medium text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => setShowRevoked((s) => !s)}>
                  {showRevoked ? t('Ocultar claves revocadas') : t('Mostrar claves revocadas ({count})', { count: revoked.length })}
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <UsageCard />

      <WebhooksCard />

      <CreateKeyModal open={creating} onClose={() => setCreating(false)} />

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        loading={revoke.isPending}
        danger
        confirmLabel={t('Revocar clave')}
        title={t('¿Revocar «{name}»?', { name: revoking?.name ?? '' })}
        description={t('Las integraciones que usen esta clave dejarán de funcionar de inmediato. Esta acción no se puede deshacer.')}
      />
    </div>
  );
}

function UsageCard() {
  const snippet = `curl -H "Authorization: Bearer evk_..." ${window.location.origin}/api/records/contacts`;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Terminal className="size-4 text-zinc-400" /> {t('Cómo usar una clave')}
        </span>
      }
      description={t('Envía la clave en la cabecera Authorization de cada petición.')}
    >
      <CopyField multiline value={snippet} label={t('Ejemplo de petición con curl')} />
      <ul className="mt-4 list-disc space-y-1.5 pl-5 text-sm text-zinc-600 marker:text-zinc-300 dark:text-zinc-400 dark:marker:text-zinc-600">
        <li>{t('Cada clave actúa solo en esta organización y con el rol que le asignes.')}</li>
        <li>{t('Los cambios en registros hechos con una clave aparecen en el historial como «API».')}</li>
        <li>{t('Por seguridad, algunas acciones sensibles (crear claves, exportar datos, conectar canales o aprobar cambios) exigen una sesión de usuario y no están disponibles con API key.')}</li>
        <li>{t('El último uso se actualiza cada pocos minutos. Si una clave se filtra, revócala y crea otra: dejará de funcionar al instante.')}</li>
      </ul>
    </Card>
  );
}

/** Webhooks salientes (creados con EVOLVE AI ENGINE) y el secreto para verificar su firma en el receptor. */
function WebhooksCard() {
  const bp = useBlueprint();
  const toast = useToast();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const reveal = useMutation({
    mutationFn: (key: string) => post<{ secret: string }>(`/workspace/integrations/${encodeURIComponent(key)}/signing-secret`),
    onSuccess: (r, key) => setSecrets((s) => ({ ...s, [key]: r.secret })),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const integrations = bp.data?.blueprint.integrations ?? [];
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  // Ejemplo de código: al traducirlo solo cambian los comentarios y los nombres de ejemplo (SECRETO, cuerpoSinModificar, valido).
  const verifySnippet = t(`// Node.js: verificar un webhook de Cortex CRM
const crypto = require('node:crypto');
const ts = req.headers['x-cortex-timestamp'];
const expected = 'sha256=' + crypto.createHmac('sha256', SECRETO).update(ts + '.' + cuerpoSinModificar).digest('hex');
const valido = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-cortex-signature']))
  && Math.abs(Date.now() / 1000 - Number(ts)) < 300; // rechaza reenvíos antiguos`);
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Webhook className="size-4 text-zinc-400" /> {t('Webhooks salientes')}
        </span>
      }
      description={t('Integraciones que envían datos a sistemas externos. Cada envío va firmado: el receptor debe verificar la firma con el secreto de su integración.')}
    >
      {bp.isLoading ? (
        <Skeleton className="h-16" />
      ) : integrations.length === 0 ? (
        <p className="text-sm text-zinc-500">{t('No hay webhooks salientes. Pídeselos a EVOLVE AI ENGINE (por ejemplo: «cuando ganemos una oportunidad, envíala a nuestra plataforma contable»).')}</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {integrations.map((i) => (
            <li key={i.key} className="py-3 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {i.name}
                    <Badge color={i.enabled ? 'emerald' : 'slate'} dot>{i.enabled ? t('Activa') : t('Desactivada')}</Badge>
                  </div>
                  <div className="truncate text-xs text-zinc-500">
                    {host(i.url)} · {i.includeFields?.length ? tp(i.includeFields.length, '{count} campo', '{count} campos') : t('todos los campos')}
                  </div>
                </div>
                {!secrets[i.key] && (
                  <Button size="sm" icon={<ShieldAlert className="size-4" />} loading={reveal.isPending && reveal.variables === i.key} onClick={() => reveal.mutate(i.key)}>
                    {t('Mostrar secreto de firma')}
                  </Button>
                )}
              </div>
              {secrets[i.key] && (
                <div className="mt-2">
                  <CopyField size="sm" value={secrets[i.key]} label={t('Secreto de firma de {name}', { name: i.name })} />
                  <p className="mt-1 text-xs text-zinc-500">{t('Guárdalo solo en el sistema receptor. Consultarlo queda registrado en la auditoría.')}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <div className="mb-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">{t('Cómo verificar la firma (cabeceras X-Cortex-Signature y X-Cortex-Timestamp)')}</div>
        <CopyField multiline value={verifySnippet} label={t('Ejemplo de verificación de la firma')} />
      </div>
    </Card>
  );
}

function CreateKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useSession();
  const isOwner = me?.workspace?.role === 'owner';
  const qc = useQueryClient();
  const toast = useToast();
  const formId = useId();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('member');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [warned, setWarned] = useState(false);
  const roles: Exclude<Role, 'owner'>[] = isOwner ? ['admin', 'builder', 'member', 'viewer'] : ['builder', 'member', 'viewer'];

  const reset = () => {
    setName('');
    setRole('member');
    setError(null);
    setCreated(null);
    setCopied(false);
    setWarned(false);
  };
  // La clave completa solo existe en este diálogo: avisamos una vez antes de cerrarlo sin copiarla.
  const close = () => {
    if (created && !copied && !warned) {
      setWarned(true);
      return;
    }
    reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: (v: { name: string; role: Exclude<Role, 'owner'> }) => post<CreatedKey>('/workspace/api-keys', v),
    onSuccess: (k) => {
      setCreated(k);
      toast(t('API key creada'));
      qc.invalidateQueries({ queryKey: KEYS_KEY });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n.length < 2 || n.length > 60) {
      setError(t('El nombre debe tener entre 2 y 60 caracteres'));
      return;
    }
    setError(null);
    create.mutate({ name: n, role });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={created ? t('Tu nueva API key') : t('Nueva API key')}
      description={created ? t('«{name}» · {role}', { name: created.name, role: tk(ROLE_LABELS[created.role]) }) : t('Ponle un nombre que identifique la integración que la usará.')}
      footer={
        created ? (
          <Button variant={warned && !copied ? 'danger' : 'primary'} onClick={close}>
            {warned && !copied ? t('Cerrar sin copiar') : copied ? t('Listo, la he guardado') : t('Cerrar')}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{t('Cancelar')}</Button>
            <Button type="submit" form={formId} variant="primary" icon={<KeyRound className="size-4" />} loading={create.isPending}>
              {t('Crear clave')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-3">
          <Alert tone="warning" title={t('Cópiala ahora')}>
            {t('Por seguridad, la clave completa no se volverá a mostrar. Si la pierdes, revócala y crea otra.')}
          </Alert>
          <CopyField value={created.key} label={t('API key completa')} onCopied={() => setCopied(true)} />
          {warned && !copied && <Alert tone="danger">{t('Todavía no has copiado la clave. Si cierras ahora, no podrás recuperarla.')}</Alert>}
        </div>
      ) : (
        <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
          <Field label={t('Nombre')} required error={error ?? undefined} hint={t('p. ej. «Zapier», «Web corporativa» o «Script de facturación»')}>
            <Input
              value={name}
              maxLength={60}
              invalid={!!error}
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
            />
          </Field>
          <Field label={t('Rol de la clave')} hint={tk(KEY_ROLE_HINTS[role])}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, 'owner'>)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {tk(ROLE_LABELS[r])}
                </option>
              ))}
            </Select>
          </Field>
          {!isOwner && <p className="text-xs text-zinc-500">{t('Solo un propietario puede crear claves con rol de administrador.')}</p>}
        </form>
      )}
    </Modal>
  );
}
