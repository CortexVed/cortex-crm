import { Globe, LayoutDashboard, Link2 } from 'lucide-react';
import { ModuleIcon } from '../lib/icons';
import { MODULE_ACCENT } from '../lib/colors';
import type { Blueprint, Dashboard, Module, Navigation, Page } from '../lib/types';
import type { Color } from '../../../shared/constants';
import { navHrefKind } from '../../../shared/appearance';
import { cx } from './ui';

/** Elemento del menú ya resuelto contra el blueprint (módulo, página, panel o enlace). */
export interface NavEntry {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Ruta interna. */
  to?: string;
  /** Enlace externo (solo https; se abre en otra pestaña). */
  href?: string;
  active?: boolean;
}
export interface NavSectionData {
  key: string;
  label: string;
  entries: NavEntry[];
  collapsible: boolean;
}

const moduleEntry = (m: Module, label?: string): NavEntry => ({
  id: `m:${m.key}`,
  to: `/m/${m.key}`,
  label: label ?? m.labelPlural,
  icon: <span className={cx('flex size-5 items-center justify-center rounded-md', MODULE_ACCENT[m.color as Color])}><ModuleIcon name={m.icon} className="size-3.5" /></span>,
});
const pageEntry = (p: Page, label?: string): NavEntry => ({
  id: `p:${p.key}`,
  to: `/p/${p.key}`,
  label: label ?? p.label,
  icon: <span className="flex size-5 items-center justify-center rounded-md bg-brand-500/10 text-brand-600 dark:text-brand-300"><ModuleIcon name={p.icon} className="size-3.5" /></span>,
});
const dashboardEntry = (d: Dashboard, panel: string | null, label?: string): NavEntry => ({
  id: `d:${d.key}`,
  to: `/?panel=${encodeURIComponent(d.key)}`,
  label: label ?? d.label,
  icon: <LayoutDashboard className="size-4" />,
  active: panel === d.key,
});

/**
 * Secciones del menú (barra lateral y vistas previas). Sin `navigation.groups`, el menú de siempre (páginas propias y módulos). Con grupos, cada
 * grupo con sus elementos y, al final, «Otros» con los módulos y páginas que no estén en ningún grupo (así un
 * módulo nuevo nunca queda inaccesible).
 */
export function buildSections(bp: Blueprint | undefined, panel: string | null, navigation: Navigation | null | undefined = bp?.navigation): NavSectionData[] {
  if (!bp) return [];
  const modules = bp.modules.filter((m) => !m.archived);
  const pages = bp.pages ?? [];
  const homeKey = navigation?.home?.type === 'page' ? navigation.home.key : null;
  const groups = navigation?.groups ?? [];
  if (!groups.length) {
    const own = pages.filter((p) => p.key !== homeKey);
    return [
      ...(own.length ? [{ key: '__pages', label: 'Páginas', entries: own.map((p) => pageEntry(p)), collapsible: false }] : []),
      { key: '__modules', label: 'Módulos', entries: modules.map((m) => moduleEntry(m)), collapsible: false },
    ];
  }
  const listedModules = new Set<string>();
  const listedPages = new Set<string>();
  const sections: NavSectionData[] = groups.map((g) => {
    const entries: NavEntry[] = [];
    g.items.forEach((it, i) => {
      if (it.type === 'module') {
        const m = modules.find((x) => x.key === it.key);
        if (m) {
          listedModules.add(m.key);
          entries.push({ ...moduleEntry(m, it.label), id: `m:${m.key}:${i}` });
        }
      } else if (it.type === 'page') {
        const p = pages.find((x) => x.key === it.key);
        if (p) {
          listedPages.add(p.key);
          entries.push({ ...pageEntry(p, it.label), id: `p:${p.key}:${i}` });
        }
      } else if (it.type === 'dashboard') {
        const d = bp.dashboards.find((x) => x.key === it.key);
        if (d) entries.push({ ...dashboardEntry(d, panel, it.label), id: `d:${d.key}:${i}` });
      } else {
        // Mismas reglas que el servidor: ruta interna o https; cualquier otra cosa no se muestra.
        const kind = navHrefKind(it.href);
        if (kind === 'internal') entries.push({ id: `l:${i}`, to: it.href, label: it.label, icon: <Link2 className="size-4" /> });
        else if (kind === 'external') entries.push({ id: `l:${i}`, href: it.href, label: it.label, icon: <Globe className="size-4" /> });
      }
    });
    return { key: g.key, label: g.label, entries, collapsible: true };
  });
  const others = [...pages.filter((p) => !listedPages.has(p.key) && p.key !== homeKey).map((p) => pageEntry(p)), ...modules.filter((m) => !listedModules.has(m.key)).map((m) => moduleEntry(m))];
  if (others.length) sections.push({ key: '__others', label: 'Otros', entries: others, collapsible: true });
  return sections.filter((s) => s.entries.length > 0);
}
