import { hasRole, type Role } from '../../../shared/constants';
import type { Blueprint } from '../../../shared/blueprint';

/** Muestra solo el origen de una URL (las rutas de los webhooks suelen llevar tokens secretos). */
export function maskUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '…';
  }
}

/**
 * Blueprint que puede ver un rol:
 *   - nunca módulos sin permiso de lectura (ni lo que depende de ellos: automatizaciones, widgets, formularios);
 *   - constructores y administradores ven la configuración de lo que pueden leer (las URLs completas de
 *     webhooks, solo administradores);
 *   - miembros y lectores ven lo necesario para usar el CRM: sin automatizaciones, integraciones ni scripts.
 */
export function blueprintForRole(bp: Blueprint, role: Role): Blueprint {
  const modules = bp.modules.filter((m) => hasRole(role, m.permissions.read));
  const readable = new Set(modules.map((m) => m.key));
  const dashboards = bp.dashboards.map((d) => ({ ...d, widgets: d.widgets.filter((w) => readable.has(w.module)) }));
  const forms = bp.forms.filter((f) => readable.has(f.module));
  if (!hasRole(role, 'builder')) return { ...bp, modules, dashboards, forms, automations: [], integrations: [], scripts: [] };
  const automations = bp.automations.filter((a) => readable.has(a.trigger.module) && a.actions.every((x) => x.type !== 'create_record' || readable.has(x.module)));
  const visibleScripts = new Set(automations.flatMap((a) => a.actions.flatMap((x) => (x.type === 'run_script' ? [x.script] : []))));
  const usedAnywhere = new Set(bp.automations.flatMap((a) => a.actions.flatMap((x) => (x.type === 'run_script' ? [x.script] : []))));
  return {
    ...bp,
    modules,
    dashboards,
    forms,
    automations,
    integrations: hasRole(role, 'admin') ? bp.integrations : bp.integrations.map((i) => ({ ...i, url: maskUrl(i.url) })),
    // Scripts que ejecutan automatizaciones visibles (o que no usa ninguna automatización).
    scripts: (bp.scripts ?? []).filter((s) => visibleScripts.has(s.key) || !usedAnywhere.has(s.key)),
  };
}
