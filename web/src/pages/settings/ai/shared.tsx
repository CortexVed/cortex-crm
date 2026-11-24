import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage, get } from '../../../lib/api';
import { cx } from '../../../components/ui';
import { useToast } from '../../../components/toast';
import type { ModelInfo, ModelsResponse, ProviderState } from './types';

// ---------------------------------------------------------------- consultas

export const AI_KEYS = {
  providers: ['ai', 'providers'] as const,
  models: (provider: string) => ['ai', 'models', provider] as const,
  settings: ['ai', 'settings'] as const,
  usageAll: ['ai', 'usage'] as const,
  usage: (days: number) => ['ai', 'usage', days] as const,
  memory: ['ai', 'memory'] as const,
};

export function useProviders() {
  return useQuery({ queryKey: AI_KEYS.providers, queryFn: () => get<ProviderState[]>('/ai/providers'), staleTime: 30_000 });
}

/** ¿Se puede consultar el catálogo de modelos de este proveedor? (OpenRouter lo publica sin clave). */
export function catalogAvailable(p: ProviderState | undefined): boolean {
  return !!p && (p.configured || p.capabilities.publicModels);
}

export function useModels(provider: ProviderState | undefined, enabled: boolean) {
  const id = provider?.id ?? '';
  return useQuery({
    queryKey: AI_KEYS.models(id),
    queryFn: () => get<ModelsResponse>(`/ai/providers/${encodeURIComponent(id)}/models?refresh=0`),
    enabled: enabled && catalogAvailable(provider),
    staleTime: 10 * 60_000,
    // Sin reintentos ante 4xx (clave no configurada, límite de peticiones…): el endpoint está limitado.
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
  });
}

/** Fuerza la descarga del catálogo en vivo desde la API del proveedor ("Actualizar catálogo"). */
export function useRefreshModels() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (provider: string) => get<ModelsResponse>(`/ai/providers/${encodeURIComponent(provider)}/models?refresh=1`),
    onSuccess: (data, provider) => {
      qc.setQueryData(AI_KEYS.models(provider), data);
      qc.invalidateQueries({ queryKey: AI_KEYS.providers });
      toast(`Catálogo actualizado: ${data.models.length} modelos`);
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
}

/** Busca un modelo en el catálogo ya descargado (sin red). */
export function cachedModel(qc: QueryClient, provider: string, model: string): ModelInfo | undefined {
  return qc.getQueryData<ModelsResponse>(AI_KEYS.models(provider))?.models.find((m) => m.id === model);
}

/**
 * Invalida el estado de configuración de IA: proveedores, ajustes (rutas efectivas) y el estado
 * global de IA que usan el asistente y el resto de pantallas (`['ai-status']`).
 */
export function invalidateAiConfig(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: AI_KEYS.providers });
  qc.invalidateQueries({ queryKey: AI_KEYS.settings });
  qc.invalidateQueries({ queryKey: ['ai-status'] });
}

export function invalidateUsage(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: AI_KEYS.usageAll });
}

// ---------------------------------------------------------------- errores

/** Mensaje de error de la API más el detalle de validación (si lo hay). */
export function describeError(e: unknown): string {
  const base = errorMessage(e);
  if (e instanceof ApiError && Array.isArray(e.details)) {
    const parts = (e.details as { path?: unknown; message?: unknown }[])
      .filter((d) => d && typeof d.message === 'string')
      .slice(0, 2)
      .map((d) => (typeof d.path === 'string' && d.path ? `${d.path}: ${d.message}` : String(d.message)));
    if (parts.length) return `${base}: ${parts.join(' · ')}`;
  }
  return base;
}

// ---------------------------------------------------------------- formato

const usdFormatters = new Map<string, Intl.NumberFormat>();
function usd(min: number, max: number) {
  const k = `${min}-${max}`;
  let f = usdFormatters.get(k);
  if (!f) {
    f = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', minimumFractionDigits: min, maximumFractionDigits: max });
    usdFormatters.set(k, f);
  }
  return f;
}

/** Importes en USD con precisión suficiente para costes de IA (que suelen ser céntimos). */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs === 0) return usd(2, 2).format(0);
  if (abs < 0.01) return usd(2, 5).format(n);
  if (abs < 1) return usd(2, 4).format(n);
  return usd(2, 2).format(n);
}

/** Precio por millón de tokens. */
export function formatPerM(n: number): string {
  if (n === 0) return 'Gratis';
  return usd(0, 4).format(n);
}

const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

/** Tamaño de contexto o recuento de tokens compacto: 200K, 1M, 1,5M. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${nf1.format(n / 1_000_000)}M`;
  if (n >= 10_000) return `${nf0.format(n / 1000)}K`;
  if (n >= 1000) return `${nf1.format(n / 1000)}K`;
  return nf0.format(n);
}

export function formatMs(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${nf1.format(n / 1000)} s`;
}

export function providerName(providers: ProviderState[] | undefined, id: string): string {
  return providers?.find((p) => p.id === id)?.label ?? id;
}

/** Estado utilizable para el enrutado (igual que el servidor): clave + activo + modelo. */
export function isUsable(p: ProviderState): boolean {
  return p.configured && p.enabled && !!p.defaultModel;
}

export const ERROR_CODE_LABELS: Record<string, string> = {
  auth: 'Clave rechazada',
  rate_limit: 'Límite del proveedor',
  invalid_request: 'Petición inválida',
  unavailable: 'No disponible',
  timeout: 'Tiempo agotado',
  refusal: 'Contenido bloqueado',
  not_configured: 'Sin configurar',
  limit_exceeded: 'Límite superado',
  bad_response: 'Respuesta inválida',
};

// ---------------------------------------------------------------- UI

const MONOGRAM: Record<string, string> = {
  anthropic: 'bg-orange-500/10 text-orange-600 ring-orange-500/20 dark:text-orange-300',
  openai: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-300',
  deepseek: 'bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-300',
  openrouter: 'bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:text-violet-300',
  gemini: 'bg-blue-500/10 text-blue-600 ring-blue-500/20 dark:text-blue-300',
  mistral: 'bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-300',
  groq: 'bg-rose-500/10 text-rose-600 ring-rose-500/20 dark:text-rose-300',
};

export function ProviderMonogram({ provider, size = 'md' }: { provider: Pick<ProviderState, 'id' | 'label'>; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-semibold ring-1 ring-inset',
        MONOGRAM[provider.id] ?? 'bg-zinc-500/10 text-zinc-600 ring-zinc-500/20 dark:text-zinc-300',
        size === 'sm' ? 'size-6 text-[11px]' : 'size-9 text-sm',
      )}
    >
      {provider.label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Control segmentado para sub-secciones (se distingue de las pestañas principales de Ajustes). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = 'md',
}: {
  options: { key: T; label: ReactNode; icon?: ReactNode; count?: number; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" className={cx('inline-flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-zinc-100 p-1 ring-1 ring-inset ring-zinc-200/70 scrollbar-thin dark:bg-zinc-900 dark:ring-zinc-800', className)}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.key)}
            className={cx(
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              active ? 'bg-white text-zinc-900 shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-800 dark:text-white dark:ring-zinc-700' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {o.icon}
            {o.label}
            {o.count !== undefined && <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', active ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300' : 'bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800')}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Grupo de controles con título (para botones/checkbox; <Field> usa <label> y no admite varios controles). */
export function FieldGroup({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}
