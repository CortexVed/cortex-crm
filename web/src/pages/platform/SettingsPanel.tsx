import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, RefreshCw, Server, Trash2, XCircle } from 'lucide-react';
import { del, errorMessage, get, post, put } from '../../lib/api';
import { formatDate, relativeTime } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Field, Input, Skeleton } from '../../components/ui';
import { useToast } from '../../components/toast';
import type { CodeSettings } from './codeTypes';

export const SETTINGS_KEY = ['platform-code', 'settings'];

export function useCodeSettings(enabled = true) {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get<CodeSettings>('/platform/code/settings'), enabled });
}

function ServiceRow({ label, source, value, ok }: { label: string; source: string; value: string | null; ok: boolean }) {
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />}
      <span className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-zinc-500">{source}</span>
      </span>
      <code className="shrink-0 text-xs text-zinc-500">{value ? `${value.slice(0, 8)}…` : t('sin detectar')}</code>
    </li>
  );
}

/** Conexión con Railway: token de proyecto (cifrado, nunca se muestra) y servicios a los que se despliega. */
export function SettingsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useCodeSettings();
  const [token, setToken] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Comprobación en curso: guarda el último informe del worker al empezar. Termina en cuanto llega uno nuevo (antes la
  // rueda giraba siempre 20 s) o, como mucho, a los 20 s.
  const [pendingCheck, setPendingCheck] = useState<{ from: string | null } | null>(null);
  const checking = pendingCheck !== null;
  const refresh = () => qc.invalidateQueries({ queryKey: SETTINGS_KEY });
  const startChecking = () => setPendingCheck({ from: qc.getQueryData<CodeSettings>(SETTINGS_KEY)?.worker?.reportedAt ?? null });
  const reportedAt = settings.data?.worker?.reportedAt ?? null;

  // Tras guardar el token o pedir una comprobación, el worker publica lo que ve en unos segundos.
  useEffect(() => {
    if (!pendingCheck) return;
    const timer = setInterval(refresh, 2500);
    const stop = setTimeout(() => setPendingCheck(null), 20_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCheck]);
  useEffect(() => {
    if (pendingCheck && reportedAt !== pendingCheck.from) setPendingCheck(null);
  }, [reportedAt, pendingCheck]);

  const save = useMutation({
    mutationFn: () => put<CodeSettings>('/platform/code/settings', { token: token.trim() }),
    onSuccess: (s) => {
      qc.setQueryData(SETTINGS_KEY, s);
      setToken('');
      startChecking();
      toast(t('Token validado y guardado cifrado'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => del<CodeSettings>('/platform/code/settings/token'),
    onSuccess: (s) => {
      qc.setQueryData(SETTINGS_KEY, s);
      setConfirmDelete(false);
      toast(t('Token eliminado'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const check = useMutation({
    mutationFn: () => post('/platform/code/settings/check'),
    onSuccess: () => {
      startChecking();
      toast(t('Comprobando la configuración del worker…'), 'info');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (settings.isLoading) return <Skeleton className="h-64" />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const s = settings.data!;
  const w = s.worker;

  return (
    <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <Card
          title={<span className="flex items-center gap-2"><Server className="size-4 text-brand-500" /> {t('Conexión con Railway')}</span>}
          description={t('El motor sube el código al servicio CI para probarlo y, tras tu aprobación, al Worker y al servicio web de esta instalación.')}
          actions={<Badge color={s.configured ? 'emerald' : 'amber'} dot>{s.configured ? t('Listo@@estado') : t('Incompleto')}</Badge>}
        >
          {s.missing.length > 0 && (
            <Alert tone="warning" title={t('Falta configuración')} className="mb-4">
              <ul className="mt-1 list-disc space-y-1 pl-5">{s.missing.map((m) => <li key={m}>{m}</li>)}</ul>
            </Alert>
          )}
          {s.warnings.map((m) => <Alert key={m} tone="info" className="mb-4">{m}</Alert>)}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            <ServiceRow label={t('Proyecto de Railway')} source="RAILWAY_PROJECT_ID" value={s.railway.projectId} ok={!!s.railway.projectId} />
            <ServiceRow label={t('Entorno')} source="RAILWAY_ENVIRONMENT_ID" value={s.railway.environmentId} ok={!!s.railway.environmentId} />
            <ServiceRow label={t('Servicio web (Cortex)')} source={t('CORTEX_SERVICE_ID en el Worker')} value={s.services.web} ok={!!s.services.web} />
            <ServiceRow label={t('Worker (canario)')} source={t('RAILWAY_SERVICE_ID del Worker')} value={s.services.worker} ok={!!s.services.worker} />
            <ServiceRow label={t('CI aislado (sin variables ni dominio)')} source={t('CI_SERVICE_ID en el Worker')} value={s.services.ci} ok={!!s.services.ci} />
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              {w ? t('El worker informó {time} (versión {version})', { time: relativeTime(w.reportedAt), version: w.sourceVersion ?? '—' }) : t('El worker aún no ha informado de su configuración')} · {tx('en ejecución: {version}', { version: <code>{s.running.version}</code> })}
            </span>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={check.isPending || checking} onClick={() => check.mutate()}>
              {t('Comprobar de nuevo')}
            </Button>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-amber-500" /> {t('Token de proyecto de Railway')}</span>} description={t('Se valida contra este proyecto y entorno, se guarda cifrado y nunca se vuelve a mostrar.')}>
          {s.token.configured ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/40">
              <span>
                {tx('Guardado: {hint}', { hint: <code>{s.token.hint}</code> })}
                <span className="ml-2 text-xs text-zinc-500">{s.token.updatedAt ? t('actualizado {date}', { date: formatDate(s.token.updatedAt, true) }) : ''}</span>
              </span>
              <Button size="sm" variant="dangerGhost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>
                {t('Eliminar')}
              </Button>
            </div>
          ) : (
            <p className="mb-3 text-sm text-zinc-500">{t('No hay ningún token guardado.')}</p>
          )}
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim().length >= 16) save.mutate();
            }}
          >
            <Field label={s.token.configured ? t('Sustituir por otro token') : t('Token de proyecto')} hint={t('Railway › tu proyecto › Settings › Tokens (del mismo entorno)')} className="flex-1">
              <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="••••••••-••••-••••-••••-••••••••••••" />
            </Field>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={token.trim().length < 16}>
              {t('Validar y guardar')}
            </Button>
          </form>
        </Card>
      </div>

      <Card title={t('Puesta en marcha')} description={t('Una sola vez por instalación.')}>
        <ol className="list-decimal space-y-3 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
          <li>
            {tx('Crea en el proyecto un servicio <b>vacío</b> llamado {ci}: sin repositorio, <b>sin variables</b> y <b>sin dominio</b>.', { ci: <code>CI</code>, b: (c) => <strong>{c}</strong> })}
            <pre className="mt-1 overflow-x-auto rounded-lg bg-zinc-950 p-2 text-[11px] text-zinc-100">railway add --service CI</pre>
          </li>
          <li>
            {tx('En el servicio {worker}, añade estas variables por referencia:', { worker: <code>Worker</code> })}
            <pre className="mt-1 overflow-x-auto rounded-lg bg-zinc-950 p-2 text-[11px] text-zinc-100">{'CORTEX_SERVICE_ID=${{Cortex.RAILWAY_SERVICE_ID}}\nCI_SERVICE_ID=${{CI.RAILWAY_SERVICE_ID}}'}</pre>
          </li>
          <li>{tx('Crea un token de <b>proyecto</b> para el entorno de la instalación (Proyecto › Settings › Tokens) y pégalo aquí. Solo sirve para desplegar en este proyecto.', { b: (c) => <strong>{c}</strong> })}</li>
          <li>{t('En la organización cuya IA vas a usar, sube el límite de peticiones de IA por hora: el agente hace muchas llamadas por cambio.')}</li>
          <li>{tx('Recomendado: desconecta los servicios {cortex} y {worker} del repositorio de GitHub de la plantilla; si no, una actualización desde el repositorio sustituiría el código modificado aquí.', { cortex: <code>Cortex</code>, worker: <code>Worker</code> })}</li>
        </ol>
        <p className="mt-4 text-xs text-zinc-500">{t('Detalle en docs/CODE_ENGINE.md y docs/RAILWAY_TEMPLATE.md.')}</p>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        danger
        title={t('Eliminar el token de Railway')}
        description={t('El motor no podrá probar ni desplegar cambios hasta que guardes otro. Para invalidarlo del todo, revócalo también en Railway.')}
        confirmLabel={t('Eliminar')}
      />
    </div>
  );
}
