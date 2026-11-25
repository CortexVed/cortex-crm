import { hasRole, type Role } from '../../../shared/constants';
import type { Blueprint, Navigation, Page, PageBlock } from '../../../shared/blueprint';

/** Muestra solo el origen de una URL (las rutas de los webhooks suelen llevar tokens secretos). */
export function maskUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '…';
  }
}

/**
 * Módulos a los que hace referencia cualquier objeto de configuración, recorriéndolo entero: propiedades
 * `module` (texto), `modules` (lista), `form` (el módulo del formulario) y destinos `{type: module|new_record, key}`.
 * Sirve para los tipos de bloque o de acción que la plataforma añada en el futuro (p. ej. con el motor de código):
 * aunque este archivo no los conozca, nunca se muestran a un rol que no puede leer los módulos que usan.
 */
export function referencedModules(bp: Blueprint, value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v) => referencedModules(bp, v, depth + 1));
  const out: string[] = [];
  const o = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'module' && typeof v === 'string') out.push(v);
    else if (k === 'modules' && Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
    else if (k === 'form' && typeof v === 'string') {
      const form = bp.forms.find((f) => f.key === v);
      if (form) out.push(form.module);
    } else if (v && typeof v === 'object') out.push(...referencedModules(bp, v, depth + 1));
  }
  if ((o.type === 'module' || o.type === 'new_record') && typeof o.key === 'string') out.push(o.key);
  return [...new Set(out)];
}

/** Módulos de los que un bloque de página muestra datos (o a los que lleva). */
export function blockModules(bp: Blueprint, b: PageBlock): string[] {
  switch (b.type) {
    case 'widget':
      return [b.widget.module];
    case 'records':
      return [b.module];
    case 'form': {
      const form = bp.forms.find((f) => f.key === b.form);
      return form ? [form.module] : [];
    }
    case 'buttons':
      return b.items.flatMap((it) => (it.to.type === 'module' || it.to.type === 'new_record' ? [it.to.key] : []));
    case 'heading':
    case 'text':
    case 'divider':
      return [];
    default:
      // Tipo de bloque que esta versión no conoce: todo lo que referencie.
      return referencedModules(bp, b);
  }
}

/**
 * Páginas que ve un rol: solo las de su rol mínimo y, dentro de ellas, solo los bloques de módulos que puede
 * leer (widgets, listas y formularios); los botones que llevan a algo que no ve desaparecen.
 */
function pagesForRole(bp: Blueprint, role: Role, readable: Set<string>, forms: Set<string>): Page[] {
  const visible = (bp.pages ?? []).filter((p) => hasRole(role, p.minRole));
  const pageKeys = new Set(visible.map((p) => p.key));
  const dashboardKeys = new Set(bp.dashboards.map((d) => d.key));
  return visible.map((p) => ({
    ...p,
    blocks: p.blocks.flatMap((b): PageBlock[] => {
      switch (b.type) {
        case 'widget':
          return readable.has(b.widget.module) ? [b] : [];
        case 'records':
          return readable.has(b.module) ? [b] : [];
        case 'form':
          return forms.has(b.form) ? [b] : [];
        case 'buttons': {
          const items = b.items.filter((it) => (it.to.type === 'page' ? pageKeys.has(it.to.key) : it.to.type === 'dashboard' ? dashboardKeys.has(it.to.key) : readable.has(it.to.key)));
          return items.length ? [{ ...b, items }] : [];
        }
        case 'heading':
        case 'text':
        case 'divider':
          return [b];
        default:
          // Tipo de bloque nuevo (p. ej. añadido con el motor de código): solo si el rol puede leer todo lo que usa.
          return blockModules(bp, b).every((m) => readable.has(m)) ? [b] : [];
      }
    }),
  }));
}

/** Menú que ve un rol: sin enlaces a módulos o páginas que no puede ver (ni grupos que se queden vacíos). */
function navigationForRole(nav: Navigation | undefined, readable: Set<string>, pages: Page[], dashboardKeys: Set<string>): Navigation | undefined {
  if (!nav) return undefined;
  const pageKeys = new Set(pages.map((p) => p.key));
  const groups = nav.groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => (it.type === 'module' ? readable.has(it.key) : it.type === 'page' ? pageKeys.has(it.key) : it.type === 'dashboard' ? dashboardKeys.has(it.key) : true)),
    }))
    .filter((g) => g.items.length > 0);
  const home = nav.home && (nav.home.type === 'page' ? pageKeys.has(nav.home.key) : dashboardKeys.has(nav.home.key)) ? nav.home : undefined;
  return home ? { groups, home } : { groups };
}

/**
 * Blueprint que puede ver un rol:
 *   - nunca módulos sin permiso de lectura (ni lo que depende de ellos: automatizaciones, widgets, formularios,
 *     bloques de páginas y enlaces del menú);
 *   - páginas solo desde su rol mínimo; la apariencia la ven todos los roles;
 *   - constructores y administradores ven la configuración de lo que pueden leer (las URLs completas de
 *     webhooks, solo administradores);
 *   - miembros y lectores ven lo necesario para usar el CRM: sin automatizaciones, integraciones ni scripts.
 */
export function blueprintForRole(bp: Blueprint, role: Role): Blueprint {
  const modules = bp.modules.filter((m) => hasRole(role, m.permissions.read));
  const readable = new Set(modules.map((m) => m.key));
  const dashboards = bp.dashboards.map((d) => ({ ...d, widgets: d.widgets.filter((w) => readable.has(w.module)) }));
  const forms = bp.forms.filter((f) => readable.has(f.module));
  const pages = pagesForRole(bp, role, readable, new Set(forms.map((f) => f.key)));
  // undefined si la organización no tiene menú propio (JSON lo omite y el cliente muestra el de siempre).
  const navigation = navigationForRole(bp.navigation, readable, pages, new Set(dashboards.map((d) => d.key)));
  if (!hasRole(role, 'builder')) return { ...bp, modules, dashboards, forms, pages, navigation, automations: [], integrations: [], scripts: [] };
  // Acciones: también las de tipos que esta versión no conoce, por los módulos que referencian.
  const automations = bp.automations.filter((a) => readable.has(a.trigger.module) && a.actions.every((x) => referencedModules(bp, x).every((m) => readable.has(m))));
  const visibleScripts = new Set(automations.flatMap((a) => a.actions.flatMap((x) => (x.type === 'run_script' ? [x.script] : []))));
  const usedAnywhere = new Set(bp.automations.flatMap((a) => a.actions.flatMap((x) => (x.type === 'run_script' ? [x.script] : []))));
  return {
    ...bp,
    modules,
    dashboards,
    forms,
    pages,
    navigation,
    automations,
    integrations: hasRole(role, 'admin') ? bp.integrations : bp.integrations.map((i) => ({ ...i, url: maskUrl(i.url) })),
    // Scripts que ejecutan automatizaciones visibles (o que no usa ninguna automatización).
    scripts: (bp.scripts ?? []).filter((s) => visibleScripts.has(s.key) || !usedAnywhere.has(s.key)),
  };
}
