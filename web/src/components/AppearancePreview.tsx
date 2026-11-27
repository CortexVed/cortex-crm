import { Bell, BarChart3, Columns3, FileText, FormInput, Heading, LayoutDashboard, List, Minus, MousePointerClick, Plus, Search, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Appearance, Blueprint, Navigation, Operation, Page, PageBlock } from '../lib/types';
import { formatCurrency } from '../lib/format';
import { msg, t, tk, tp } from '../lib/i18n';
import { appearanceStyle, resolveAppearance, sidebarClass } from '../lib/theme';
import { ModuleIcon } from '../lib/icons';
import { BLOCK_WIDTH_LABELS, type BlockWidth } from '../../../shared/appearance';
import { ROLE_LABELS } from '../../../shared/constants';
import { buildSections } from './navigation';
import { Button, cx } from './ui';

/**
 * Maqueta de la interfaz con una apariencia concreta (borrador del editor o cambio propuesto): menú lateral,
 * cabecera, botones y una tarjeta, con los componentes reales y las variables CSS de esa apariencia aplicadas al
 * contenedor (se heredan). El CSS personalizado NO se aplica aquí: se muestra como código para revisarlo.
 */
export function AppearancePreview({ appearance, blueprint, navigation, className }: { appearance: Partial<Appearance> | null | undefined; blueprint?: Blueprint; navigation?: Navigation | null; className?: string }) {
  const a = resolveAppearance(appearance);
  const sections = blueprint ? buildSections(blueprint, null, navigation === undefined ? blueprint.navigation : navigation) : [];
  const homeKey = (navigation === undefined ? blueprint?.navigation : navigation)?.home;
  const homePage = homeKey?.type === 'page' ? blueprint?.pages?.find((p) => p.key === homeKey.key) : undefined;
  let budget = 9; // líneas del menú que caben en la maqueta
  return (
    // Consultas de contenedor (@container): la maqueta se adapta a su propio ancho, no al de la ventana.
    <div style={appearanceStyle(a)} className={cx('@container overflow-hidden rounded-xl font-sans ring-1 ring-zinc-200 dark:ring-zinc-800', className)} role="img" aria-label={t('Vista previa de la apariencia')}>
      <div className="flex h-[22rem] text-zinc-900 dark:text-zinc-100">
        <div className={cx('flex w-36 shrink-0 flex-col gap-3 overflow-hidden border-r p-2.5 @lg:w-44', sidebarClass(a.sidebar, true))}>
          <div className="flex min-w-0 items-center gap-2 px-1">
            {a.appName ? (
              <>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-600 text-xs font-bold text-white">{a.appName.slice(0, 1).toUpperCase()}</span>
                <span className="truncate text-[13px] font-bold tracking-tight">{a.appName}</span>
              </>
            ) : (
              <>
                <img src="/favicon.svg" alt="" className="size-6" />
                <span className="text-[13px] font-bold tracking-tight">
                  Cortex <span className="evolve-text">CRM</span>
                </span>
              </>
            )}
          </div>
          <div className="space-y-0.5">
            <MockItem active icon={homePage ? <ModuleIcon name={homePage.icon} className="size-3.5" /> : <LayoutDashboard className="size-3.5" />} label={homePage?.label ?? t('Panel')} />
            <MockItem icon={<BarChart3 className="size-3.5" />} label={t('Informes')} />
          </div>
          <div className="min-h-0 flex-1 space-y-2.5 overflow-hidden">
            {sections.map((s) => {
              if (budget <= 0) return null;
              const entries = s.entries.slice(0, Math.max(1, budget - 1));
              budget -= entries.length + 1;
              return (
                <div key={s.key}>
                  <div className="mb-0.5 truncate px-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-400">{s.label}</div>
                  <div className="space-y-0.5">
                    {entries.map((e) => (
                      <MockItem key={e.id} icon={e.icon} label={e.label} />
                    ))}
                    {s.entries.length > entries.length && <div className="px-1.5 text-[10px] text-zinc-400">{t('+{count} más', { count: s.entries.length - entries.length })}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col bg-zinc-50 dark:bg-zinc-950">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200/70 bg-white/80 px-3 dark:border-zinc-800 dark:bg-zinc-950/80">
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-zinc-100/80 px-2 text-xs text-zinc-500 dark:bg-zinc-900">
              <Search className="size-3.5 shrink-0" />
              <span className="hidden truncate @xl:inline">{t('Buscar o ejecutar un comando…')}</span>
            </div>
            <Button size="sm" variant="ai" className="shrink-0 whitespace-nowrap" icon={<Sparkles className="size-3.5" />} tabIndex={-1}>
              EVOLVE AI
            </Button>
            <span className="relative text-zinc-500">
              <Bell className="size-4" />
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent" />
            </span>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-hidden p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold tracking-tight">{t('Oportunidades')}</div>
                <div className="text-xs text-zinc-500">{tp(24, '{count} registro', '{count} registros')}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <span className="hidden @lg:inline-flex">
                  <Button size="sm" tabIndex={-1}>
                    {t('Filtro')}
                  </Button>
                </span>
                <Button size="sm" variant="primary" className="whitespace-nowrap" icon={<Plus className="size-3.5" />} tabIndex={-1}>
                  {t('Nuevo')}
                </Button>
              </div>
            </div>
            <div className="flex gap-1 rounded-lg bg-zinc-100/80 p-0.5 text-[12px] font-medium dark:bg-zinc-900">
              <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-zinc-900 shadow-xs dark:bg-zinc-800 dark:text-white">
                <Columns3 className="size-3" /> {t('Pipeline')}
              </span>
              <span className="px-2 py-1 text-zinc-500">{t('Todas')}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2">
              <div className="rounded-xl bg-white p-3 shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
                <div className="text-xs font-medium text-zinc-500">{t('Pipeline abierto')}</div>
                <div className="mt-1 truncate text-lg font-semibold tabular-nums tracking-tight">{formatCurrency(48250, 'EUR')}</div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full w-2/3 rounded-full bg-brand-500" />
                </div>
              </div>
              <div className="rounded-xl bg-white p-3 shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
                <div className="text-xs font-medium text-zinc-500">{t('Etapas')}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-500/30">{t('Propuesta')}</span>
                  <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">{t('Nuevo')}</span>
                </div>
                <div className="mt-2 text-xs text-brand-600 underline-offset-2 dark:text-brand-400">{t('Ver todas →')}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-white p-3 shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
              <div className="h-8 min-w-0 flex-1 rounded-lg bg-white px-2.5 py-1.5 text-xs text-zinc-400 ring-2 ring-inset ring-brand-500 dark:bg-zinc-900">{t('Nombre de la empresa')}</div>
              <span className="relative inline-flex h-5 w-9 shrink-0 rounded-full bg-brand-600">
                <span className="absolute left-[18px] top-0.5 size-4 rounded-full bg-white shadow" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MockItem({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <div className={cx('flex items-center gap-2 rounded-md px-1.5 py-1 text-[11.5px] font-medium', active ? 'bg-zinc-900/[0.06] text-zinc-900 dark:bg-white/10 dark:text-white' : 'text-zinc-600 dark:text-zinc-400')}>
      <span className="flex shrink-0 [&_svg]:size-3.5 [&>span]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

/** Operaciones de la capa visual (las que tienen vista previa). */
export const VISUAL_OPS = new Set(['update_appearance', 'update_navigation', 'upsert_page', 'remove_page']);

/**
 * Blueprint de partida con las operaciones VISUALES del cambio aplicadas (más los módulos, paneles y formularios
 * nuevos, para resolver sus nombres). Solo para la vista previa: el cambio real lo aplica el servidor.
 */
export function previewBlueprint(before: Blueprint, ops: Operation[]): Blueprint {
  const bp: Blueprint = { ...before, modules: [...before.modules], dashboards: [...before.dashboards], forms: [...before.forms], pages: [...(before.pages ?? [])] };
  const upsert = <T extends { key: string }>(list: T[], item: T) => {
    const i = list.findIndex((x) => x.key === item.key);
    if (i >= 0) list[i] = item;
    else list.push(item);
  };
  for (const op of ops) {
    if (op.op === 'create_module') upsert(bp.modules, op.module);
    else if (op.op === 'upsert_dashboard') upsert(bp.dashboards, op.dashboard);
    else if (op.op === 'upsert_form') upsert(bp.forms, op.form);
    else if (op.op === 'upsert_page') upsert(bp.pages, op.page);
    else if (op.op === 'remove_page') bp.pages = bp.pages.filter((p) => p.key !== op.page);
    else if (op.op === 'update_navigation') bp.navigation = op.navigation ?? undefined;
    else if (op.op === 'update_appearance') {
      const next: Record<string, unknown> = { ...(bp.appearance ?? {}) };
      for (const [k, v] of Object.entries(op.changes)) {
        if (v === undefined) continue;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      bp.appearance = resolveAppearance(next as Partial<Appearance>);
    }
  }
  return bp;
}

// ---------------------------------------------------------------- estructura de una página

/** Rejilla fija de 6 columnas (para ver la estructura aunque la pantalla sea estrecha). */
const SPAN6: Record<BlockWidth, string> = { full: 'col-span-6', half: 'col-span-3', third: 'col-span-2', two_thirds: 'col-span-4' };
// Marcados con msg(): se traducen al mostrarlos, con tk().
const WIDGET_TYPES: Record<string, string> = { metric: msg('Métrica'), bar: msg('Barras'), donut: msg('Donut'), line: msg('Evolución@@gráfico'), list: msg('Lista') };
const AGGREGATES: Record<string, string> = { count: msg('Recuento'), sum: msg('Suma'), avg: msg('Media@@promedio') };

function blockInfo(b: PageBlock, bp: Blueprint | undefined): { icon: ReactNode; kind: string; detail: string } {
  const mod = (key: string) => bp?.modules.find((m) => m.key === key);
  const modLabel = (key: string) => mod(key)?.labelPlural ?? key;
  switch (b.type) {
    case 'heading':
      return { icon: <Heading className="size-3.5" />, kind: t('Título {level}', { level: b.level }), detail: b.text };
    case 'text':
      return { icon: <FileText className="size-3.5" />, kind: t('Texto'), detail: b.markdown.replace(/[#*`>_-]/g, '').trim().split('\n')[0] ?? '' };
    case 'widget': {
      const w = b.widget;
      const field = w.field ? mod(w.module)?.fields.find((f) => f.key === w.field)?.label ?? w.field : null;
      const vars = { title: w.title, aggregate: tk(AGGREGATES[w.aggregate] ?? w.aggregate), field, module: modLabel(w.module) };
      return {
        icon: <BarChart3 className="size-3.5" />,
        kind: t('Widget · {type}', { type: tk(WIDGET_TYPES[w.type] ?? w.type) }),
        detail: field && w.aggregate !== 'count' ? t('{title} — {aggregate} de {field} en {module}', vars) : t('{title} — {aggregate} en {module}', vars),
      };
    }
    case 'records': {
      const view = b.view ? mod(b.module)?.views.find((v) => v.key === b.view)?.label ?? b.view : null;
      return { icon: <List className="size-3.5" />, kind: t('Lista de registros'), detail: `${b.title ? `${b.title} — ` : ''}${modLabel(b.module)}${view ? ` › ${view}` : ''} · ${tp(b.limit, '{count} fila', '{count} filas')}${b.filters.length ? ` · ${tp(b.filters.length, '{count} filtro', '{count} filtros')}` : ''}` };
    }
    case 'form':
      return { icon: <FormInput className="size-3.5" />, kind: t('Formulario'), detail: bp?.forms.find((f) => f.key === b.form)?.name ?? b.form };
    case 'buttons':
      return { icon: <MousePointerClick className="size-3.5" />, kind: t('Botones'), detail: b.items.map((i) => i.label).join(' · ') };
    case 'divider':
      return { icon: <Minus className="size-3.5" />, kind: t('Separador'), detail: '' };
  }
}

/** Vista previa estructural de una página: cada bloque en su ancho, con su tipo y su contenido. */
export function PageStructurePreview({ page, blueprint }: { page: Page; blueprint: Blueprint | undefined }) {
  return (
    <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200/80 dark:bg-zinc-900/60 dark:ring-zinc-800">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-brand-500/10 text-brand-600 dark:text-brand-300">
          <ModuleIcon name={page.icon} className="size-3.5" />
        </span>
        <span className="text-sm font-semibold">{page.label}</span>
        <code className="text-[11px] text-zinc-500">/p/{page.key}</code>
        <span className="ml-auto text-[11px] text-zinc-500">{t('Visible desde el rol {role}', { role: tk(ROLE_LABELS[page.minRole]) })}</span>
      </div>
      {page.description && <p className="mb-2 text-xs text-zinc-500">{page.description}</p>}
      {page.blocks.length === 0 ? (
        <p className="text-xs text-zinc-500">{t('Sin bloques.')}</p>
      ) : (
        <div className="grid grid-cols-6 gap-1.5">
          {page.blocks.map((b, i) => {
            const info = blockInfo(b, blueprint);
            return (
              <div key={i} className={cx(SPAN6[b.width], 'min-w-0 rounded-lg border border-dashed border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900')} title={tk(BLOCK_WIDTH_LABELS[b.width])}>
                <div className="flex items-center gap-1 text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                  <span className="text-zinc-400">{info.icon}</span>
                  <span className="truncate">{info.kind}</span>
                </div>
                {info.detail && <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{info.detail}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
