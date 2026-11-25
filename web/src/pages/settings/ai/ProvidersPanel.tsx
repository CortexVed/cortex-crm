import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, KeyRound, Lock, Minus, PlugZap, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { Alert, Badge, Button, ConfirmDialog, cx, Input, Spinner, Toggle } from '../../../components/ui';
import { useToast } from '../../../components/toast';
import { del, post, put } from '../../../lib/api';
import { formatDate, relativeTime } from '../../../lib/format';
import { ModelPicker } from './ModelPicker';
import { AI_KEYS, catalogAvailable, describeError, FieldGroup, formatMs, invalidateAiConfig, invalidateUsage, ProviderMonogram, useRefreshModels } from './shared';
import type { ProviderState, ProviderTestResult } from './types';

const CAPABILITIES: { key: keyof ProviderState['capabilities']; label: string; hint: string }[] = [
  { key: 'tools', label: 'Herramientas', hint: 'Puede llamar a herramientas (necesario para el asistente con acciones).' },
  { key: 'json', label: 'Modo JSON', hint: 'Fuerza respuestas JSON válidas (planes del motor de evolución).' },
  { key: 'pdf', label: 'PDF nativo', hint: 'Lee documentos PDF adjuntos directamente.' },
  { key: 'publicModels', label: 'Catálogo público', hint: 'El catálogo de modelos (con precios) se consulta en vivo incluso sin API key.' },
  { key: 'reportsCost', label: 'Coste real por llamada', hint: 'El proveedor informa del coste exacto de cada llamada.' },
];

function StatusBadge({ p }: { p: ProviderState }) {
  if (!p.configured) return <Badge color="slate">Sin API key</Badge>;
  if (!p.enabled) return <Badge color="amber" dot>Desactivado</Badge>;
  if (!p.defaultModel) return <Badge color="amber" dot>Falta modelo</Badge>;
  return (
    <Badge color="emerald" dot>
      Activo
    </Badge>
  );
}

function KeyForm({ p, onDone, onSaved }: { p: ProviderState; onDone: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (apiKey: string) => put<ProviderState | undefined>(`/ai/providers/${encodeURIComponent(p.id)}`, { apiKey }),
    // La clave viaja como variable de la mutación: no se conserva en la caché una vez resuelta.
    gcTime: 0,
    onSuccess: (next) => {
      setValue('');
      if (next) qc.setQueryData<ProviderState[]>(AI_KEYS.providers, (list) => list?.map((x) => (x.id === next.id ? next : x)));
      invalidateAiConfig(qc);
      qc.invalidateQueries({ queryKey: AI_KEYS.models(p.id) });
      toast(`API key de ${p.label} guardada. Prueba la conexión para verificarla.`);
      onSaved();
      onDone();
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (key.length < 8 || key.length > 400 || /\s/.test(key)) {
      setError('La clave debe tener entre 8 y 400 caracteres y no contener espacios.');
      return;
    }
    setError(null);
    save.mutate(key);
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:ring-zinc-800">
      <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300" htmlFor={`key-${p.id}`}>
        {p.keySource === 'workspace' ? 'Nueva API key (sustituye a la actual)' : `API key de ${p.label}`}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={`key-${p.id}`}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={p.keyHint || 'Pega aquí la clave'}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          invalid={!!error}
          className="font-mono"
          autoFocus
        />
        <div className="flex shrink-0 gap-2">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!value.trim()}>
            Guardar
          </Button>
          <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
            Cancelar
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Lock className="size-3" /> Se guarda cifrada en el servidor y nunca se vuelve a mostrar: solo verás sus últimos 4 caracteres.
        </p>
      )}
    </form>
  );
}

function ProviderCard({ p }: { p: ProviderState }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editingKey, setEditingKey] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const isMock = p.id === 'mock';
  const refresh = useRefreshModels();

  const applyState = (next: ProviderState | undefined) => {
    if (next) qc.setQueryData<ProviderState[]>(AI_KEYS.providers, (list) => list?.map((x) => (x.id === next.id ? next : x)));
    invalidateAiConfig(qc);
  };
  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => put<ProviderState | undefined>(`/ai/providers/${encodeURIComponent(p.id)}`, { enabled }),
    onSuccess: (next, enabled) => {
      applyState(next);
      toast(enabled ? `${p.label} activado` : `${p.label} desactivado: las tareas usarán el siguiente proveedor de su ruta`);
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
  const setModel = useMutation({
    mutationFn: (defaultModel: string | null) => put<ProviderState | undefined>(`/ai/providers/${encodeURIComponent(p.id)}`, { defaultModel }),
    onSuccess: (next) => {
      applyState(next);
      setTest(null);
      toast('Modelo por defecto actualizado');
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
  const revoke = useMutation({
    mutationFn: () => del(`/ai/providers/${encodeURIComponent(p.id)}/key`),
    onSuccess: () => {
      setConfirmRevoke(false);
      setTest(null);
      invalidateAiConfig(qc);
      qc.invalidateQueries({ queryKey: AI_KEYS.models(p.id) });
      toast(`API key de ${p.label} revocada`);
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
  const runTest = useMutation({
    mutationFn: () => post<ProviderTestResult>(`/ai/providers/${encodeURIComponent(p.id)}/test`),
    onSuccess: (r) => {
      setTest(r);
      qc.invalidateQueries({ queryKey: AI_KEYS.providers });
      invalidateUsage(qc);
      toast(r.ok ? `${p.label}: conexión correcta (${formatMs(r.latencyMs)})` : `${p.label}: la prueba ha fallado`, r.ok ? 'success' : 'error');
    },
    onError: (e) => {
      setTest(null);
      toast(describeError(e), 'error');
    },
  });

  const canCatalog = catalogAvailable(p);
  const testBlocked = !p.configured ? 'Añade una API key para probar la conexión' : !p.enabled ? 'Activa el proveedor para probar la conexión' : !p.defaultModel ? 'Elige un modelo por defecto para probar la conexión' : null;

  let keyArea: ReactNode;
  if (isMock) {
    keyArea = <p className="text-sm text-zinc-500">Proveedor de pruebas automáticas: no necesita clave ni configuración.</p>;
  } else if (editingKey) {
    keyArea = <KeyForm p={p} onDone={() => setEditingKey(false)} onSaved={() => setTest(null)} />;
  } else {
    keyArea = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', p.configured ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800')}>
            <KeyRound className="size-4" />
          </span>
          <div className="min-w-0 text-sm">
            {p.keySource === 'workspace' ? (
              <>
                <div className="font-medium">Clave de la organización</div>
                <div className="font-mono text-xs text-zinc-500">{p.keyHint_masked ?? '••••'}</div>
              </>
            ) : p.keySource === 'platform' ? (
              <>
                <div className="font-medium">Clave de la plataforma</div>
                <div className="text-xs text-zinc-500">Gestionada por EVOLVE. Usa una propia para controlar costes y límites.</div>
              </>
            ) : (
              <>
                <div className="font-medium">Sin API key</div>
                <div className="text-xs text-zinc-500">Necesaria para usar este proveedor.</div>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.keySource === 'workspace' ? (
            <>
              <Button size="sm" onClick={() => setEditingKey(true)}>
                Reemplazar
              </Button>
              <Button size="sm" variant="dangerGhost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmRevoke(true)}>
                Revocar
              </Button>
            </>
          ) : (
            <Button size="sm" variant={p.keySource === 'platform' ? 'secondary' : 'primary'} icon={<KeyRound className="size-3.5" />} onClick={() => setEditingKey(true)}>
              {p.keySource === 'platform' ? 'Usar clave propia' : 'Añadir API key'}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className={cx('flex flex-col rounded-xl bg-white shadow-xs ring-1 dark:bg-zinc-900', p.configured && p.enabled ? 'ring-zinc-200/80 dark:ring-zinc-800' : 'ring-zinc-200/60 dark:ring-zinc-800/80')}>
      <header className="flex items-start gap-3 border-b border-zinc-100 px-4 py-3.5 dark:border-zinc-800">
        <ProviderMonogram provider={p} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{p.label}</h3>
            <StatusBadge p={p} />
            {p.tier === 'experimental' && <Badge color="amber">Experimental (no verificado)</Badge>}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{p.description}</p>
        </div>
        {!isMock && (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            {setEnabled.isPending && <Spinner className="size-3.5" />}
            <Toggle checked={p.enabled} onChange={(v) => setEnabled.mutate(v)} disabled={setEnabled.isPending} label={p.enabled ? 'Activo' : 'Inactivo'} />
          </span>
        )}
      </header>

      <div className="flex-1 space-y-4 px-4 py-4">
        {keyArea}

        {!isMock && (
          <FieldGroup
            label="Modelo por defecto"
            hint={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{p.modelsCount > 0 ? `Catálogo: ${p.modelsCount} modelos · actualizado ${relativeTime(p.modelsCachedAt)}` : canCatalog ? 'Catálogo aún no descargado: ábrelo o actualízalo.' : 'El catálogo estará disponible al añadir la API key.'}</span>
              </span>
            }
          >
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <ModelPicker provider={p} value={p.defaultModel} onChange={(m) => m && m !== p.defaultModel && setModel.mutate(m)} loading={setModel.isPending} ariaLabel={`Modelo por defecto de ${p.label}`} />
              </div>
              <span className="inline-flex shrink-0" title={canCatalog ? 'Descargar de nuevo el catálogo desde la API del proveedor' : 'Añade la API key para consultar el catálogo'}>
                <Button type="button" icon={<RefreshCw className={cx('size-3.5', refresh.isPending && 'animate-spin')} />} disabled={!canCatalog || refresh.isPending} onClick={() => refresh.mutate(p.id)} aria-label="Actualizar catálogo">
                  <span className="hidden sm:inline">Actualizar catálogo</span>
                </Button>
              </span>
            </div>
          </FieldGroup>
        )}

        <div>
          <div className="mb-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">Capacidades</div>
          <ul className="flex flex-wrap gap-1.5">
            {CAPABILITIES.map((c) => {
              const on = p.capabilities[c.key];
              return (
                <li
                  key={c.key}
                  title={c.hint}
                  className={cx(
                    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ring-1 ring-inset',
                    on ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25' : 'bg-zinc-50 text-zinc-400 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-500 dark:ring-zinc-700',
                  )}
                >
                  {on ? <CheckCircle2 className="size-3" /> : <Minus className="size-3" />}
                  <span className={on ? '' : 'line-through decoration-zinc-300 dark:decoration-zinc-600'}>{c.label}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {test ? (
          test.ok ? (
            <Alert tone="success" title="Conexión correcta">
              {test.model} respondió en {formatMs(test.latencyMs)}.
            </Alert>
          ) : (
            <Alert tone="danger" title="La prueba ha fallado">
              <span className="break-words">{test.error ?? 'Error desconocido'}</span>
            </Alert>
          )
        ) : (
          <>
            {p.lastError && (
              <Alert tone="danger" title="Último error registrado">
                <span className="break-words">{p.lastError}</span>
              </Alert>
            )}
            {p.lastTestAt && (
              <p className="flex items-center gap-1.5 text-xs text-zinc-500" title={formatDate(p.lastTestAt, true)}>
                {p.lastTestOk ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <XCircle className="size-3.5 text-red-500" />}
                Última prueba {p.lastTestOk ? 'correcta' : 'fallida'} {relativeTime(p.lastTestAt)}
              </p>
            )}
          </>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-zinc-100 bg-zinc-50/60 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60">
        {p.docsUrl ? (
          <a href={p.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
            Obtener una API key <ExternalLink className="size-3" />
          </a>
        ) : (
          <span />
        )}
        <span title={testBlocked ?? 'Envía una petición mínima al modelo por defecto'} className="inline-flex">
          <Button size="sm" icon={<PlugZap className="size-3.5" />} loading={runTest.isPending} disabled={!!testBlocked} onClick={() => runTest.mutate()}>
            Probar conexión
          </Button>
        </span>
      </footer>

      <ConfirmDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => revoke.mutate()}
        loading={revoke.isPending}
        danger
        title={`¿Revocar la API key de ${p.label}?`}
        description="La clave se elimina de forma permanente de EVOLVE. Las tareas que la usaban pasarán automáticamente al siguiente proveedor de su ruta."
        confirmLabel="Revocar clave"
      >
        <p className="text-sm text-zinc-500">Recuerda revocarla también en la consola del proveedor si crees que se ha expuesto.</p>
      </ConfirmDialog>
    </section>
  );
}

export function ProvidersPanel({ providers }: { providers: ProviderState[] }) {
  const core = providers.filter((p) => p.tier === 'core');
  const experimental = providers.filter((p) => p.tier !== 'core' && p.id !== 'mock');
  const mock = providers.filter((p) => p.id === 'mock');
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2.5 rounded-lg bg-zinc-50 px-3.5 py-3 text-xs leading-relaxed text-zinc-600 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-900/60 dark:text-zinc-400 dark:ring-zinc-800">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        <span>
          Cada organización usa sus propias API keys. Se cifran en el servidor, nunca se devuelven al navegador y cada cambio queda registrado en la auditoría. Los modelos se descubren en vivo desde la API de cada proveedor.
        </span>
      </div>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Proveedores principales</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          {core.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        </div>
      </section>
      {experimental.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Proveedores experimentales</h3>
            <p className="mt-0.5 text-xs text-zinc-500">Usan endpoints compatibles con OpenAI. Funcionan, pero no están verificados en producción: úsalos como alternativas, no como modelo principal de tareas críticas.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {experimental.map((p) => (
              <ProviderCard key={p.id} p={p} />
            ))}
          </div>
        </section>
      )}
      {mock.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Entorno de pruebas</h3>
          <div className="grid gap-4 lg:grid-cols-2">
            {mock.map((p) => (
              <ProviderCard key={p.id} p={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
