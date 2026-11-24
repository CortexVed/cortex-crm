import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Clock, ExternalLink, Eye, EyeOff, Hash, Inbox, Mail, MessageCircle, Plug, RefreshCw, Send, Trash2, type LucideIcon } from 'lucide-react';
import { del, errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useBlueprint } from '../../lib/hooks';
import { formatDate, relativeTime } from '../../lib/format';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, Card, ConfirmDialog, cx, EmptyState, ErrorState, Field, IconButton, Input, Modal, Skeleton } from '../../components/ui';
import type { Color } from '../../../../shared/constants';
import { CopyField } from './TeamTab';

interface ConnectorField {
  key: string;
  label: string;
  secret: boolean;
  help?: string;
}

interface ConnectorType {
  type: string;
  label: string;
  status: 'available' | 'planned';
  description: string;
  fields: ConnectorField[];
  plannedReason?: string;
  docsUrl: string;
}

interface Connector {
  id: string;
  type: string;
  name: string;
  status: string;
  config: Record<string, unknown> | null;
  lastError: string | null;
  lastEventAt: string | null;
  createdAt: string;
  webhookUrl?: string;
}

interface InboxMessage {
  id: string;
  channel: string;
  direction: 'inbound' | 'outbound';
  from_address: string | null;
  body: string;
  record_id: string | null;
  created_at: string;
}

interface ConnectResult {
  id: string;
  webhookUrl: string;
  verifyToken?: string;
}

const CONNECTORS_KEY = ['comms-connectors'];
const INBOX_KEY = ['comms-inbox'];
const INBOX_PREVIEW = 12;

const TYPE_STYLES: Record<string, { icon: LucideIcon; tone: string }> = {
  whatsapp: { icon: MessageCircle, tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  telegram: { icon: Send, tone: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  gmail: { icon: Mail, tone: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  outlook: { icon: Mail, tone: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  slack: { icon: Hash, tone: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
};
const FALLBACK_STYLE = { icon: Plug, tone: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' };

const CHANNEL_NAMES: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', gmail: 'Gmail', outlook: 'Outlook', slack: 'Slack' };

const STATUS: Record<string, { label: string; color: Color }> = {
  active: { label: 'Activo', color: 'emerald' },
  pending: { label: 'Pendiente', color: 'amber' },
  error: { label: 'Con errores', color: 'red' },
  disabled: { label: 'Desactivado', color: 'slate' },
};

// Lo que hay que preparar en cada proveedor antes de pegar las credenciales.
const SETUP_HINTS: Record<string, ReactNode> = {
  whatsapp: (
    <>
      Necesitas una app en Meta for Developers con el producto WhatsApp. Copia el <b>Phone number ID</b> (WhatsApp › Configuración de la API), un <b>token de acceso permanente</b> de un usuario del sistema y el <b>App secret</b> (Configuración de la app › Básica).
    </>
  ),
  telegram: (
    <>
      Crea un bot con <b>@BotFather</b> en Telegram y pega aquí su token. La aplicación debe estar publicada con una URL pública HTTPS (APP_URL) para que Telegram pueda entregar los mensajes.
    </>
  ),
};

const DEFAULT_NAMES: Record<string, string> = { whatsapp: 'WhatsApp Business', telegram: 'Bot de Telegram' };

function TypeIcon({ type, muted }: { type: string; muted?: boolean }) {
  const s = TYPE_STYLES[type] ?? FALLBACK_STYLE;
  const Icon = s.icon;
  return (
    <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', s.tone, muted && 'opacity-60')}>
      <Icon className="size-5" />
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, color: 'slate' as Color };
  return (
    <Badge color={s.color} dot>
      {s.label}
    </Badge>
  );
}

/** Detalle verificado del proveedor guardado al conectar (número de WhatsApp o usuario del bot). */
function describeConfig(c: Connector): string {
  const cfg = c.config ?? {};
  const str = (k: string) => (typeof cfg[k] === 'string' && cfg[k] ? (cfg[k] as string) : '');
  if (c.type === 'whatsapp') return [str('displayPhone'), str('verifiedName')].filter(Boolean).join(' · ');
  if (c.type === 'telegram') return str('botUsername') ? `@${str('botUsername')}` : '';
  return '';
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">{children}</div>;
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5 text-sm text-zinc-600 dark:text-zinc-400">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">{i + 1}</span>
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ol>
  );
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      <p className="mt-0.5 text-sm text-zinc-500">{description}</p>
    </div>
  );
}

export default function ChannelsTab() {
  const { can } = useSession();
  const isAdmin = can('admin');
  const isMember = can('member');
  const q = useQuery({ queryKey: CONNECTORS_KEY, queryFn: () => get<{ types: ConnectorType[]; connectors: Connector[] }>('/comms/connectors') });
  const [connecting, setConnecting] = useState<ConnectorType | null>(null);

  if (q.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-32" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
        <Skeleton className="h-56" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }

  const { types, connectors } = q.data;
  const available = types.filter((t) => t.status === 'available');
  const planned = types.filter((t) => t.status !== 'available');
  const countOf = (type: string) => connectors.filter((c) => c.type === type).length;

  return (
    <div className="space-y-6">
      <ConnectedCard connectors={connectors} types={types} />

      {available.length > 0 && (
        <section className="space-y-3">
          <SectionTitle title="Canales disponibles" description="Conecta tus propias cuentas: los mensajes llegan a la ficha del contacto y puedes responder desde el CRM." />
          <div className="grid gap-4 md:grid-cols-2">
            {available.map((t) => (
              <TypeCard key={t.type} t={t} connected={countOf(t.type)} canConnect={isAdmin} onConnect={() => setConnecting(t)} />
            ))}
          </div>
        </section>
      )}

      {planned.length > 0 && (
        <section className="space-y-3">
          <SectionTitle title="Próximamente" description="Integraciones en preparación. No se pueden activar hasta que funcionen de verdad con el proveedor." />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {planned.map((t) => (
              <TypeCard key={t.type} t={t} connected={0} canConnect={false} />
            ))}
          </div>
        </section>
      )}

      {isMember && <InboxCard types={types} />}

      {connecting && <ConnectModal def={connecting} onClose={() => setConnecting(null)} />}
    </div>
  );
}

function TypeCard({ t, connected, canConnect, onConnect }: { t: ConnectorType; connected: number; canConnect: boolean; onConnect?: () => void }) {
  const isAvailable = t.status === 'available';
  return (
    <div className="flex flex-col rounded-xl bg-white p-4 shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-start gap-3">
        <TypeIcon type={t.type} muted={!isAvailable} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t.label}</h4>
            {!isAvailable ? (
              <Badge color="slate">Planificado</Badge>
            ) : connected > 0 ? (
              <Badge color="emerald" dot>
                {connected === 1 ? 'Conectado' : `${connected} conectados`}
              </Badge>
            ) : (
              <Badge color="sky">Disponible</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-500">{t.description}</p>
        </div>
      </div>
      {!isAvailable && t.plannedReason && (
        <div className="mt-3 flex gap-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600 ring-1 ring-inset ring-zinc-100 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-800">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Por qué aún no está disponible: </span>
            {t.plannedReason}
          </span>
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <a href={t.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
          Documentación oficial <ExternalLink className="size-3" />
        </a>
        {isAvailable &&
          (canConnect && onConnect ? (
            <Button size="sm" variant="primary" icon={<Plug className="size-3.5" />} onClick={onConnect}>
              {connected ? 'Conectar otro' : 'Conectar'}
            </Button>
          ) : (
            <span className="text-xs text-zinc-500">Solo los administradores pueden conectarlo</span>
          ))}
      </div>
    </div>
  );
}

function ConnectedCard({ connectors, types }: { connectors: Connector[]; types: ConnectorType[] }) {
  const { can } = useSession();
  const isAdmin = can('admin');
  const qc = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState<Connector | null>(null);
  const remove = useMutation({
    mutationFn: (c: Connector) => del(`/comms/connectors/${c.id}`),
    onSuccess: (_r, c) => {
      setDeleting(null);
      toast(`Canal «${c.name}» eliminado`);
      qc.invalidateQueries({ queryKey: CONNECTORS_KEY });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const typeLabel = (type: string) => CHANNEL_NAMES[type] ?? types.find((t) => t.type === type)?.label ?? type;

  return (
    <Card padded={false} title="Canales conectados" description="Cuentas de mensajería activas en esta organización.">
      {!connectors.length ? (
        <EmptyState
          icon={<Plug className="size-5" />}
          title="Ningún canal conectado todavía"
          description={isAdmin ? 'Elige un canal disponible y conéctalo con las credenciales de tu cuenta.' : 'Un administrador puede conectar WhatsApp o Telegram para recibir mensajes en el CRM.'}
        />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {connectors.map((c) => {
            const detail = describeConfig(c);
            return (
              <li key={c.id} className="flex gap-3 px-4 py-4">
                <TypeIcon type={c.type} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {[typeLabel(c.type), detail, c.lastEventAt ? `Último mensaje ${relativeTime(c.lastEventAt)}` : 'Sin mensajes todavía', `Conectado el ${formatDate(c.createdAt)}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {c.lastError && (
                    <Alert tone="danger" title="Último error">
                      {c.lastError}
                    </Alert>
                  )}
                  {c.webhookUrl && (
                    <div className="max-w-2xl">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">URL del webhook</div>
                      <CopyField size="sm" value={c.webhookUrl} label={`URL del webhook de ${c.name}`} />
                    </div>
                  )}
                </div>
                {isAdmin && (
                  <IconButton label={`Eliminar el canal ${c.name}`} onClick={() => setDeleting(c)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        loading={remove.isPending}
        danger
        confirmLabel="Eliminar canal"
        title={`¿Eliminar el canal «${deleting?.name ?? ''}»?`}
        description={`Dejarás de recibir sus mensajes y no podrás responder por él desde el CRM. Los mensajes ya recibidos se conservan.${deleting?.type === 'telegram' ? ' También se retirará el webhook del bot en Telegram.' : ''}`}
      />
    </Card>
  );
}

function ConnectModal({ def, onClose }: { def: ConnectorType; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const formId = useId();
  const blank = () => Object.fromEntries(def.fields.map((f) => [f.key, ''])) as Record<string, string>;
  const [name, setName] = useState(DEFAULT_NAMES[def.type] ?? def.label);
  const [creds, setCreds] = useState<Record<string, string>>(blank);
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<(ConnectResult & { name: string }) | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [warned, setWarned] = useState(false);
  const hasSecrets = def.fields.some((f) => f.secret);

  const create = useMutation({
    mutationFn: (v: { type: string; name: string; credentials: Record<string, string> }) => post<ConnectResult>('/comms/connectors', v),
    onSuccess: (r, v) => {
      setResult({ ...r, name: v.name });
      setCreds(blank()); // no conservar secretos en memoria más de lo necesario
      setServerError(null);
      toast(`Canal «${v.name}» conectado`);
      qc.invalidateQueries({ queryKey: CONNECTORS_KEY });
    },
    onError: (e) => {
      setServerError(errorMessage(e));
      toast(errorMessage(e), 'error');
    },
  });

  // El token de verificación de WhatsApp solo se devuelve una vez: avisamos antes de cerrar sin copiarlo.
  const close = () => {
    if (result?.verifyToken && !tokenCopied && !warned) {
      setWarned(true);
      return;
    }
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const n = name.trim();
    if (n.length < 2) errs.name = 'Indica un nombre de al menos 2 caracteres';
    for (const f of def.fields) if (!creds[f.key]?.trim()) errs[f.key] = `Falta «${f.label}»`;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setServerError(null);
    create.mutate({ type: def.type, name: n, credentials: Object.fromEntries(def.fields.map((f) => [f.key, creds[f.key].trim()])) });
  };

  const whatsappSteps: ReactNode[] = [
    <>En Meta for Developers, abre tu app y ve a <b>WhatsApp › Configuración</b>.</>,
    <>En «Webhook», pulsa <b>Editar</b>, pega la URL de devolución de llamada y el token de verificación, y pulsa <b>Verificar y guardar</b>.</>,
    <>En los campos del webhook, suscríbete a <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-800">messages</code>.</>,
    <>Los mensajes entrantes se asignarán al contacto cuyo teléfono coincida con el del remitente.</>,
  ];
  const telegramSteps: ReactNode[] = [
    <>El webhook se ha configurado automáticamente en Telegram: no tienes que hacer nada más.</>,
    <>Escribe a tu bot para probarlo. Los mensajes se vinculan al contacto cuyo campo «telegram» coincida con el usuario del remitente.</>,
    <>Telegram no permite iniciar conversaciones: el contacto debe escribir primero al bot para poder responderle.</>,
  ];

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={result ? `${def.label}: conectado` : `Conectar ${def.label}`}
      description={result ? undefined : def.description}
      footer={
        result ? (
          <Button variant={warned && !tokenCopied ? 'danger' : 'primary'} onClick={close}>
            {warned && !tokenCopied ? 'Cerrar sin copiar el token' : 'Listo'}
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancelar</Button>
            <Button type="submit" form={formId} variant="primary" icon={<Plug className="size-4" />} loading={create.isPending}>
              Conectar
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <Alert tone="success" title={`«${result.name}» está activo`}>
            Hemos comprobado las credenciales con el proveedor y las hemos guardado cifradas.
          </Alert>
          <div>
            <Label>URL de devolución de llamada (webhook)</Label>
            <CopyField value={result.webhookUrl} label="URL del webhook" />
          </div>
          {result.verifyToken && (
            <div>
              <Label>Token de verificación</Label>
              <CopyField value={result.verifyToken} label="Token de verificación" onCopied={() => setTokenCopied(true)} />
              <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">Solo se muestra ahora. Cópialo antes de cerrar este diálogo.</p>
            </div>
          )}
          {def.type === 'whatsapp' && <Steps items={whatsappSteps} />}
          {def.type === 'telegram' && <Steps items={telegramSteps} />}
          {warned && !tokenCopied && (
            <Alert tone="danger">Aún no has copiado el token de verificación. Sin él no podrás completar la configuración en Meta y tendrías que eliminar y volver a conectar el canal.</Alert>
          )}
        </div>
      ) : (
        <form id={formId} onSubmit={submit} className="space-y-4" noValidate autoComplete="off">
          {SETUP_HINTS[def.type] && <Alert tone="info">{SETUP_HINTS[def.type]}</Alert>}
          <Field label="Nombre del canal" required error={errors.name} hint="Para identificarlo en el CRM, p. ej. «Ventas España».">
            <Input
              value={name}
              maxLength={80}
              invalid={!!errors.name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((x) => ({ ...x, name: '' }));
              }}
            />
          </Field>
          {def.fields.map((f) => (
            <Field key={f.key} label={f.label} required error={errors[f.key] || undefined} hint={f.help}>
              <Input
                type={f.secret && !show ? 'password' : 'text'}
                value={creds[f.key] ?? ''}
                invalid={!!errors[f.key]}
                autoComplete={f.secret ? 'new-password' : 'off'}
                spellCheck={false}
                maxLength={1000}
                className="font-mono"
                data-1p-ignore
                data-lpignore="true"
                onChange={(e) => {
                  const v = e.target.value;
                  setCreds((c) => ({ ...c, [f.key]: v }));
                  if (errors[f.key]) setErrors((x) => ({ ...x, [f.key]: '' }));
                }}
              />
            </Field>
          ))}
          {hasSecrets && (
            <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => setShow((s) => !s)}>
              {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {show ? 'Ocultar valores secretos' : 'Mostrar valores secretos'}
            </button>
          )}
          {serverError && (
            <Alert tone="danger" title="No se ha podido conectar">
              {serverError}
            </Alert>
          )}
        </form>
      )}
    </Modal>
  );
}

function InboxCard({ types }: { types: ConnectorType[] }) {
  const q = useQuery({ queryKey: INBOX_KEY, queryFn: () => get<InboxMessage[]>('/comms/inbox') });
  const blueprint = useBlueprint();
  // Los mensajes se vinculan a fichas de contactos: solo enlazamos si el usuario puede abrir ese módulo.
  const contactsLinkable = !!blueprint.data?.blueprint.modules.some((m) => m.key === 'contacts' && !m.archived);
  const [showAll, setShowAll] = useState(false);
  const messages = q.data ?? [];
  const shown = showAll ? messages : messages.slice(0, INBOX_PREVIEW);
  const channelName = (ch: string) => CHANNEL_NAMES[ch] ?? types.find((t) => t.type === ch)?.label ?? ch;

  return (
    <Card
      padded={false}
      title="Mensajes recientes"
      description="Últimos mensajes recibidos y enviados por los canales conectados."
      actions={
        <IconButton label="Actualizar mensajes" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cx('size-4', q.isFetching && 'animate-spin')} />
        </IconButton>
      }
    >
      {q.isLoading ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !messages.length ? (
        <EmptyState icon={<Inbox className="size-5" />} title="Sin mensajes todavía" description="Cuando tus clientes escriban por un canal conectado, sus mensajes aparecerán aquí y en su ficha." />
      ) : (
        <>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {shown.map((m) => {
              const inbound = m.direction === 'inbound';
              return (
                <li key={m.id} className="flex gap-3 px-4 py-3">
                  <span
                    className={cx('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', inbound ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')}
                    title={inbound ? 'Recibido' : 'Enviado'}
                  >
                    {inbound ? <ArrowDownLeft className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{inbound ? m.from_address || 'Remitente desconocido' : 'Respuesta desde el CRM'}</span>
                      <span className="shrink-0 text-xs text-zinc-400">{channelName(m.channel)}</span>
                      <span className="ml-auto shrink-0 text-xs text-zinc-400" title={formatDate(m.created_at, true)}>
                        {relativeTime(m.created_at)}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 whitespace-pre-line break-words text-sm text-zinc-600 dark:text-zinc-400">{m.body}</p>
                    <div className="mt-1 text-xs">
                      {m.record_id ? (
                        contactsLinkable ? (
                          <Link to={`/m/contacts/${m.record_id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                            Ver ficha del contacto
                          </Link>
                        ) : (
                          <span className="text-zinc-500">Vinculado a una ficha</span>
                        )
                      ) : (
                        <span className="text-amber-700 dark:text-amber-400">Sin vincular: ningún contacto tiene ese {m.channel === 'whatsapp' ? 'teléfono' : m.channel === 'telegram' ? 'usuario de Telegram' : 'remitente'}</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {messages.length > INBOX_PREVIEW && (
            <div className="border-t border-zinc-100 px-4 py-2.5 text-center dark:border-zinc-800">
              <button type="button" className="text-xs font-medium text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => setShowAll((s) => !s)}>
                {showAll ? 'Mostrar menos' : `Mostrar los ${messages.length} mensajes`}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
