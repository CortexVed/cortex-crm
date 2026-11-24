import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, History, Save, ShieldCheck } from 'lucide-react';
import { errorMessage, get, patch } from '../../lib/api';
import { useSession, type WorkspaceSettingsView } from '../../lib/session';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, ErrorState, Field, Input, Select, Skeleton, Textarea, Toggle } from '../../components/ui';
import type { Role } from '../../../../shared/constants';
import { RoleBadge } from './TeamTab';

interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  plan: string;
  version: number;
  settings: WorkspaceSettingsView;
  role: Role;
}

interface Draft {
  name: string;
  timezone: string;
  currency: string;
  locale: string;
  industry: string;
  description: string;
}

type SettingsPatch = Partial<Pick<WorkspaceSettingsView, 'timezone' | 'currency' | 'locale' | 'industry' | 'description'>>;
type WorkspacePatch = { name?: string; settings?: SettingsPatch };

const WORKSPACE_KEY = ['workspace'];
const DRAFT_KEYS: (keyof Draft)[] = ['name', 'timezone', 'currency', 'locale', 'industry', 'description'];
const PLAN_LABELS: Record<string, string> = { trial: 'Prueba' };

const toDraft = (ws: WorkspaceInfo): Draft => ({
  name: ws.name,
  timezone: ws.settings.timezone,
  currency: ws.settings.currency,
  locale: ws.settings.locale,
  industry: ws.settings.industry ?? '',
  description: ws.settings.description ?? '',
});

// ---------------------------------------------------------------- opciones regionales (Intl, con alternativas si el navegador no las ofrece)

const FALLBACK_TIMEZONES = ['Europe/Madrid', 'Atlantic/Canary', 'Europe/Lisbon', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Caracas', 'America/New_York', 'America/Los_Angeles', 'UTC'];
const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'MXN', 'COP', 'ARS', 'CLP', 'PEN', 'BRL', 'CHF'];
const LOCALES = ['es-ES', 'es-MX', 'es-AR', 'es-CO', 'es-CL', 'es-PE', 'es-US', 'ca-ES', 'eu-ES', 'gl-ES', 'pt-PT', 'pt-BR', 'en-GB', 'en-US', 'fr-FR', 'de-DE', 'it-IT', 'nl-NL'];

interface Option {
  value: string;
  label: string;
}

function supportedValues(key: 'timeZone' | 'currency'): string[] {
  try {
    return Intl.supportedValuesOf(key);
  } catch {
    return [];
  }
}

function displayNames(type: 'currency' | 'language'): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames(['es'], { type });
  } catch {
    return null;
  }
}

function nameOf(names: Intl.DisplayNames | null, code: string): string | undefined {
  try {
    const n = names?.of(code);
    return n && n !== code ? n : undefined;
  } catch {
    return undefined;
  }
}

function gmtOffset(tz: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

function zoneLabel(tz: string, at: Date): string {
  const offset = gmtOffset(tz, at);
  return `${tz.replace(/_/g, ' ')}${offset ? ` (${offset})` : ''}`;
}

// Construir ~400 formateadores es costoso: la lista se calcula una vez por sesión.
let zoneCache: Option[] | null = null;

function timezoneOptions(current: string): Option[] {
  if (!zoneCache) {
    const list = supportedValues('timeZone');
    const now = new Date();
    zoneCache = (list.length ? list : FALLBACK_TIMEZONES).map((tz) => ({ value: tz, label: zoneLabel(tz, now) }));
  }
  if (!current || zoneCache.some((o) => o.value === current)) return zoneCache;
  return [{ value: current, label: zoneLabel(current, new Date()) }, ...zoneCache];
}

function currencyLabel(code: string, names = displayNames('currency')): string {
  const n = nameOf(names, code);
  return n ? `${code} · ${n}` : code;
}

function currencyOptions(current: string): { common: Option[]; rest: Option[] } {
  const names = displayNames('currency');
  const all = supportedValues('currency');
  const rest = all.filter((c) => !COMMON_CURRENCIES.includes(c));
  if (current && !COMMON_CURRENCIES.includes(current) && !rest.includes(current)) rest.unshift(current);
  const toOption = (c: string) => ({ value: c, label: currencyLabel(c, names) });
  return { common: COMMON_CURRENCIES.map(toOption), rest: rest.map(toOption) };
}

function localeLabel(code: string, names = displayNames('language')): string {
  const n = nameOf(names, code);
  return n ? `${n.charAt(0).toUpperCase()}${n.slice(1)} · ${code}` : code;
}

function localeOptions(current: string): Option[] {
  const names = displayNames('language');
  const list = !current || LOCALES.includes(current) ? LOCALES : [current, ...LOCALES];
  return list.map((l) => ({ value: l, label: localeLabel(l, names) }));
}

// ---------------------------------------------------------------- exportación

/** Descarga la exportación JSON de la organización (la respuesta lleva Content-Disposition). */
async function downloadExport(): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/workspace/export', { credentials: 'same-origin' });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Revisa tu conexión.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? `Error ${res.status}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `evolve-export-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

// ---------------------------------------------------------------- pestaña

export default function GeneralTab() {
  const q = useQuery({ queryKey: WORKSPACE_KEY, queryFn: () => get<WorkspaceInfo>('/workspace') });
  if (q.isLoading) {
    return (
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Skeleton className="h-[26rem]" />
          <Skeleton className="h-32" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-52" />
          <Skeleton className="h-44" />
        </div>
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
  const ws = q.data;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <DetailsCard ws={ws} />
        <ApprovalCard ws={ws} />
      </div>
      <div className="space-y-5">
        <SummaryCard ws={ws} />
        <ExportCard />
      </div>
    </div>
  );
}

function DetailsCard({ ws }: { ws: WorkspaceInfo }) {
  const { can, refresh } = useSession();
  const isAdmin = can('admin');
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const base = toDraft(ws);
  const values = draft ?? base;
  const changed = DRAFT_KEYS.filter((k) => values[k] !== base[k]);
  const dirty = changed.length > 0;

  const tzOptions = useMemo(() => (isAdmin ? timezoneOptions(base.timezone) : []), [isAdmin, base.timezone]);
  const curOptions = useMemo(() => (isAdmin ? currencyOptions(base.currency) : { common: [], rest: [] }), [isAdmin, base.currency]);
  const locOptions = useMemo(() => (isAdmin ? localeOptions(base.locale) : []), [isAdmin, base.locale]);

  const save = useMutation({
    mutationFn: (body: WorkspacePatch) => patch<{ ok: boolean; settings: WorkspaceSettingsView }>('/workspace', body),
    onSuccess: async (r, body) => {
      qc.setQueryData<WorkspaceInfo>(WORKSPACE_KEY, (old) => (old ? { ...old, name: body.name ?? old.name, settings: r.settings } : old));
      setDraft(null);
      toast('Cambios guardados');
      qc.invalidateQueries({ queryKey: WORKSPACE_KEY });
      qc.invalidateQueries({ queryKey: ['blueprint'] });
      if (body.name) await refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const set = (k: keyof Draft, v: string) => {
    setDraft({ ...values, [k]: v });
    if (errors[k]) setErrors({ ...errors, [k]: undefined });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Partial<Record<keyof Draft, string>> = {};
    const name = values.name.trim();
    if (name.length < 2 || name.length > 80) errs.name = 'El nombre debe tener entre 2 y 80 caracteres';
    if (!/^[A-Z]{3}$/.test(values.currency)) errs.currency = 'Usa un código ISO de 3 letras (p. ej. EUR)';
    setErrors(errs);
    if (Object.keys(errs).length || !dirty) return;
    const body: WorkspacePatch = {};
    const settings: SettingsPatch = {};
    for (const k of changed) {
      if (k === 'name') body.name = name;
      else settings[k] = k === 'industry' || k === 'description' ? values[k].trim() : values[k];
    }
    if (Object.keys(settings).length) body.settings = settings;
    save.mutate(body);
  };

  if (!isAdmin) {
    const s = ws.settings;
    return (
      <Card title="Datos de la organización" description="Solo los administradores pueden modificar estos datos.">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <ReadOnly label="Nombre">{ws.name}</ReadOnly>
          <ReadOnly label="Sector">{s.industry || <Muted>Sin indicar</Muted>}</ReadOnly>
          <ReadOnly label="Zona horaria">{s.timezone.replace(/_/g, ' ')}</ReadOnly>
          <ReadOnly label="Moneda">{currencyLabel(s.currency)}</ReadOnly>
          <ReadOnly label="Idioma y región">{localeLabel(s.locale)}</ReadOnly>
          <ReadOnly label="Descripción del negocio" className="sm:col-span-2">
            {s.description ? <span className="whitespace-pre-line">{s.description}</span> : <Muted>Sin descripción</Muted>}
          </ReadOnly>
        </dl>
      </Card>
    );
  }

  return (
    <Card title="Datos de la organización" description="Nombre, contexto del negocio y preferencias regionales.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" required error={errors.name}>
            <Input value={values.name} maxLength={80} invalid={!!errors.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Sector" hint="p. ej. Inmobiliaria, agencia de marketing, clínica dental">
            <Input value={values.industry} maxLength={80} placeholder="Sin indicar" onChange={(e) => set('industry', e.target.value)} />
          </Field>
        </div>
        <Field label="Descripción del negocio" hint={`EVOLVE AI ENGINE usa el sector y la descripción como contexto al proponer cambios · ${values.description.length}/1000`}>
          <Textarea rows={4} maxLength={1000} value={values.description} placeholder="A qué se dedica la organización, qué vende y a qué clientes…" onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Zona horaria" hint="Fechas, vencimientos y automatizaciones.">
            <Select value={values.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {tzOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Moneda" hint="Importes, previsiones e informes." error={errors.currency}>
            <Select value={values.currency} invalid={!!errors.currency} onChange={(e) => set('currency', e.target.value)}>
              <optgroup label="Habituales">
                {curOptions.common.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
              {curOptions.rest.length > 0 && (
                <optgroup label="Todas las monedas">
                  {curOptions.rest.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Idioma y región" hint="Formato regional de la organización.">
            <Select value={values.locale} onChange={(e) => set('locale', e.target.value)}>
              {locOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-zinc-100 pt-4 sm:flex-row sm:items-center sm:justify-end dark:border-zinc-800">
          {dirty && <span className="text-xs text-zinc-500 sm:mr-auto">Tienes cambios sin guardar</span>}
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(null);
              setErrors({});
            }}
          >
            Descartar
          </Button>
          <Button type="submit" variant="primary" icon={<Save className="size-4" />} loading={save.isPending} disabled={!dirty}>
            Guardar cambios
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ReadOnly({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-zinc-500">{label}</dt>
      <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-zinc-400 dark:text-zinc-500">{children}</span>;
}

function ApprovalCard({ ws }: { ws: WorkspaceInfo }) {
  const { me } = useSession();
  const isOwner = me?.workspace?.role === 'owner';
  const qc = useQueryClient();
  const toast = useToast();
  const current = ws.settings.approval.requireDistinctApprover;
  const update = useMutation({
    mutationFn: (value: boolean) => patch<{ ok: boolean; settings: WorkspaceSettingsView }>('/workspace', { settings: { approval: { requireDistinctApprover: value } } }),
    onSuccess: (r, value) => {
      qc.setQueryData<WorkspaceInfo>(WORKSPACE_KEY, (old) => (old ? { ...old, settings: r.settings } : old));
      toast(value ? 'Principio de cuatro ojos activado' : 'Principio de cuatro ojos desactivado');
      qc.invalidateQueries({ queryKey: WORKSPACE_KEY });
      qc.invalidateQueries({ queryKey: ['blueprint'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const checked = update.isPending && update.variables !== undefined ? update.variables : current;
  return (
    <Card title="Política de aprobación" description="Quién puede aprobar los cambios que propone EVOLVE AI ENGINE.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            <ShieldCheck className="size-4 text-brand-600 dark:text-brand-400" />
            Principio de cuatro ojos
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            Exige que cada cambio lo apruebe una persona distinta a quien lo solicitó. Con independencia de esta opción, los cambios de riesgo alto siempre requieren a un propietario.
          </p>
          {!isOwner && <p className="mt-2 text-xs text-zinc-500">Solo los propietarios pueden cambiar esta política.</p>}
        </div>
        <div className="shrink-0">
          {isOwner ? (
            <Toggle checked={checked} disabled={update.isPending} label={checked ? 'Activado' : 'Desactivado'} onChange={(v) => update.mutate(v)} />
          ) : (
            <Badge color={current ? 'emerald' : 'slate'} dot>
              {current ? 'Activado' : 'Desactivado'}
            </Badge>
          )}
        </div>
      </div>
    </Card>
  );
}

function SummaryCard({ ws }: { ws: WorkspaceInfo }) {
  const row = 'flex items-center justify-between gap-3 py-2.5';
  return (
    <Card title="Resumen">
      <dl className="-my-2.5 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        <div className={row}>
          <dt className="text-zinc-500">Identificador</dt>
          <dd className="truncate font-mono text-xs text-zinc-800 dark:text-zinc-200">{ws.slug}</dd>
        </div>
        <div className={row}>
          <dt className="text-zinc-500">Plan</dt>
          <dd>
            <Badge color={ws.plan === 'trial' ? 'amber' : 'emerald'}>{PLAN_LABELS[ws.plan] ?? ws.plan}</Badge>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-zinc-500">Versión de la configuración</dt>
          <dd className="flex items-center gap-2">
            <span className="font-medium tabular-nums">v{ws.version}</span>
            <Link to="/evolve/releases" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
              <History className="size-3.5" /> Historial
            </Link>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-zinc-500">Tu rol</dt>
          <dd>
            <RoleBadge role={ws.role} />
          </dd>
        </div>
      </dl>
      <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        El identificador forma parte de las direcciones de los formularios públicos (<span className="font-mono">/f/{ws.slug}/…</span>).
      </p>
    </Card>
  );
}

function ExportCard() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const exporter = useMutation({
    mutationFn: downloadExport,
    onSuccess: (name) => {
      toast(`Exportación descargada: ${name}`);
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!can('admin')) return null;
  return (
    <Card title="Exportar datos" description="Copia portable de tu información.">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Descarga un archivo JSON con la configuración, los módulos, los registros y las notas de la organización. No incluye los archivos adjuntos. La descarga queda registrada en la auditoría.
      </p>
      <Button className="mt-4 w-full" icon={<Download className="size-4" />} loading={exporter.isPending} onClick={() => exporter.mutate()}>
        Exportar datos (JSON)
      </Button>
    </Card>
  );
}
