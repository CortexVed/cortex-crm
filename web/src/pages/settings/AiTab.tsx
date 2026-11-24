import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Activity, ExternalLink, GitCompareArrows, Plug, Route, Sparkles } from 'lucide-react';
import { Alert, ErrorState, Skeleton } from '../../components/ui';
import { ComparePanel } from './ai/ComparePanel';
import { ProvidersPanel } from './ai/ProvidersPanel';
import { RoutingPanel } from './ai/RoutingPanel';
import { UsagePanel } from './ai/UsagePanel';
import { isUsable, Segmented, useProviders } from './ai/shared';
import type { ProviderState } from './ai/types';

type Section = 'providers' | 'routing' | 'usage' | 'compare';

const SECTIONS: { key: Section; label: string; icon: ReactNode }[] = [
  { key: 'providers', label: 'Proveedores', icon: <Plug className="size-4" /> },
  { key: 'routing', label: 'Enrutado y límites', icon: <Route className="size-4" /> },
  { key: 'usage', label: 'Consumo', icon: <Activity className="size-4" /> },
  { key: 'compare', label: 'Comparar modelos', icon: <GitCompareArrows className="size-4" /> },
];

function Onboarding({ providers }: { providers: ProviderState[] }) {
  const real = providers.filter((p) => p.id !== 'mock');
  if (real.some(isUsable)) return null;
  const core = real.filter((p) => p.tier === 'core' && p.docsUrl);
  if (real.some((p) => p.configured)) {
    return (
      <Alert tone="warning" title="EVOLVE AI no tiene ningún proveedor listo">
        Hay API keys guardadas, pero ningún proveedor está activo con un modelo por defecto. Activa uno y elige su modelo para que el asistente y el motor de evolución puedan trabajar.
      </Alert>
    );
  }
  return (
    <Alert tone="warning" title="EVOLVE AI necesita al menos una API key">
      <p>
        El asistente, el análisis del CRM y el motor de evolución usan modelos de IA con las claves de tu organización. Añade la API key de cualquiera de estos proveedores (con <strong>OpenRouter</strong> una sola clave da acceso a cientos de modelos):
      </p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {core.map((p) => (
          <li key={p.id}>
            <a href={p.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
              {p.label} <ExternalLink className="size-3" />
            </a>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** AI PROVIDER MANAGER: proveedores, enrutado por tarea, límites, consumo y comparativa de modelos. */
export default function AiTab() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('section');
  const section: Section = SECTIONS.some((s) => s.key === raw) ? (raw as Section) : 'providers';
  const go = (s: Section) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('section', s);
        return next;
      },
      { replace: true },
    );
  const q = useProviders();
  const providers = q.data ?? [];
  const ready = providers.filter((p) => p.id !== 'mock' && isUsable(p)).length;
  const total = providers.filter((p) => p.id !== 'mock').length;

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-2xl bg-white p-5 ring-1 ring-zinc-200/80 shadow-xs dark:bg-zinc-900 dark:ring-zinc-800">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-24 right-24 size-48 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl evolve-gradient text-white shadow-sm shadow-fuchsia-500/25">
              <Sparkles className="size-5" />
            </span>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider">
                <span className="evolve-text">AI Provider Manager</span>
              </div>
              <h2 className="text-base font-semibold tracking-tight">Proveedores y modelos de IA</h2>
              <p className="mt-0.5 max-w-2xl text-sm text-zinc-500">Conecta Claude, OpenAI, DeepSeek u OpenRouter con tus propias claves, decide qué modelo resuelve cada tarea y controla el gasto. EVOLVE cambia de proveedor automáticamente si uno falla.</p>
            </div>
          </div>
          {q.data && (
            <div className="shrink-0 rounded-xl bg-zinc-50 px-3.5 py-2 text-right ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:ring-zinc-800">
              <div className="text-xl font-semibold tabular-nums">
                {ready}
                <span className="text-sm font-normal text-zinc-400"> / {total}</span>
              </div>
              <div className="text-[11px] text-zinc-500">proveedores listos</div>
            </div>
          )}
        </div>
      </div>

      {q.data && <Onboarding providers={providers} />}

      <Segmented options={SECTIONS} value={section} onChange={go} />

      {q.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : section === 'providers' ? (
        <ProvidersPanel providers={providers} />
      ) : section === 'routing' ? (
        <RoutingPanel providers={providers} />
      ) : section === 'usage' ? (
        <UsagePanel providers={providers} onConfigurePrices={() => go('routing')} />
      ) : (
        <ComparePanel providers={providers} onGoToProviders={() => go('providers')} />
      )}
    </div>
  );
}
