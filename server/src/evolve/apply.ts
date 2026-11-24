import { BlueprintSchema, type Blueprint } from '../../../shared/blueprint';
import type { Operation } from '../../../shared/changeset';
import type { Issue } from './validate';

/** Cambios de tipo que preservan los datos existentes (el resto se rechaza). */
export const COMPATIBLE_TYPE_CHANGES: Record<string, string[]> = {
  text: ['long_text', 'email', 'phone', 'url', 'select'],
  long_text: ['text'],
  number: ['currency', 'percent', 'rating'],
  currency: ['number', 'percent'],
  percent: ['number', 'currency'],
  rating: ['number'],
  select: ['multi_select', 'text'],
  email: ['text'],
  phone: ['text'],
  url: ['text'],
  date: ['datetime'],
  datetime: ['date'],
};

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Aplica operaciones sobre una COPIA del blueprint (función pura: se usa igual en el sandbox
 * y en la publicación real). Devuelve el blueprint resultante normalizado y los errores.
 */
export function applyOperations(input: Blueprint, ops: Operation[]): { blueprint: Blueprint; errors: Issue[] } {
  const bp: Blueprint = structuredClone(input);
  const errors: Issue[] = [];

  ops.forEach((op, i) => {
    const path = `operations[${i}]`;
    const fail = (message: string) => errors.push({ level: 'error', path, message });
    const mod = 'module' in op && typeof op.module === 'string' ? bp.modules.find((m) => m.key === op.module) : undefined;
    const needModule = () => {
      if (!mod) fail(`No existe el módulo "${(op as { module: string }).module}"`);
      return mod;
    };

    switch (op.op) {
      case 'create_module': {
        if (bp.modules.some((m) => m.key === op.module.key)) fail(`Ya existe un módulo "${op.module.key}"`);
        else bp.modules.push(structuredClone({ ...op.module, system: false, archived: false }));
        break;
      }
      case 'update_module': {
        const m = needModule();
        if (m) {
          const { permissions, ...rest } = defined(op.changes);
          Object.assign(m, rest);
          // Los permisos se fusionan: cambiar uno no altera los demás.
          if (permissions) m.permissions = { ...m.permissions, ...defined(permissions) };
        }
        break;
      }
      case 'archive_module': {
        const m = needModule();
        if (m) m.archived = true;
        break;
      }
      case 'restore_module': {
        const m = needModule();
        if (m) m.archived = false;
        break;
      }
      case 'add_field': {
        const m = needModule();
        if (!m) break;
        const existing = m.fields.find((f) => f.key === op.field.key);
        if (existing) {
          fail(existing.archived ? `El campo "${op.field.key}" existe archivado: usa restore_field` : `Ya existe el campo "${op.field.key}"`);
          break;
        }
        const field = structuredClone({ ...op.field, system: false, archived: false });
        const idx = op.after ? m.fields.findIndex((f) => f.key === op.after) : -1;
        if (idx >= 0) m.fields.splice(idx + 1, 0, field);
        else m.fields.push(field);
        break;
      }
      case 'update_field': {
        const m = needModule();
        const f = m?.fields.find((x) => x.key === op.field);
        if (!m) break;
        if (!f) {
          fail(`No existe el campo "${op.module}.${op.field}"`);
          break;
        }
        const changes = defined(op.changes);
        if (changes.type && changes.type !== f.type) {
          if (f.system) {
            fail(`No se puede cambiar el tipo del campo de sistema "${f.key}"`);
            break;
          }
          if (!COMPATIBLE_TYPE_CHANGES[f.type]?.includes(changes.type)) {
            fail(`Cambio de tipo no compatible (${f.type} → ${changes.type}): crea un campo nuevo y migra los datos`);
            break;
          }
        }
        Object.assign(f, changes);
        break;
      }
      case 'archive_field': {
        const m = needModule();
        const f = m?.fields.find((x) => x.key === op.field);
        if (!m) break;
        if (!f) fail(`No existe el campo "${op.module}.${op.field}"`);
        else if (f.system || m.primaryField === f.key) fail(`El campo "${f.key}" es esencial y no se puede archivar`);
        else f.archived = true;
        break;
      }
      case 'restore_field': {
        const f = needModule()?.fields.find((x) => x.key === op.field);
        if (f) f.archived = false;
        else if (mod) fail(`No existe el campo "${op.module}.${op.field}"`);
        break;
      }
      case 'add_select_options': {
        const f = needModule()?.fields.find((x) => x.key === op.field);
        if (!mod) break;
        if (!f || (f.type !== 'select' && f.type !== 'multi_select')) {
          fail(`"${op.module}.${op.field}" no es un campo de selección`);
          break;
        }
        f.options ??= [];
        for (const o of op.options) if (!f.options.some((x) => x.value === o.value)) f.options.push(o);
        break;
      }
      case 'upsert_view': {
        const m = needModule();
        if (!m) break;
        const idx = m.views.findIndex((v) => v.key === op.view.key);
        if (idx >= 0) m.views[idx] = structuredClone(op.view);
        else m.views.push(structuredClone(op.view));
        break;
      }
      case 'remove_view': {
        const m = needModule();
        if (!m) break;
        if (!m.views.some((v) => v.key === op.view)) fail(`No existe la vista "${op.view}"`);
        else if (m.views.length === 1) fail('Un módulo necesita al menos una vista');
        else m.views = m.views.filter((v) => v.key !== op.view);
        break;
      }
      case 'upsert_automation': {
        const idx = bp.automations.findIndex((a) => a.key === op.automation.key);
        if (idx >= 0) bp.automations[idx] = structuredClone(op.automation);
        else bp.automations.push(structuredClone(op.automation));
        break;
      }
      case 'remove_automation': {
        if (!bp.automations.some((a) => a.key === op.automation)) fail(`No existe la automatización "${op.automation}"`);
        bp.automations = bp.automations.filter((a) => a.key !== op.automation);
        break;
      }
      case 'upsert_dashboard': {
        const idx = bp.dashboards.findIndex((d) => d.key === op.dashboard.key);
        if (idx >= 0) bp.dashboards[idx] = structuredClone(op.dashboard);
        else bp.dashboards.push(structuredClone(op.dashboard));
        break;
      }
      case 'remove_dashboard': {
        if (!bp.dashboards.some((d) => d.key === op.dashboard)) fail(`No existe el panel "${op.dashboard}"`);
        bp.dashboards = bp.dashboards.filter((d) => d.key !== op.dashboard);
        break;
      }
      case 'upsert_integration': {
        const idx = bp.integrations.findIndex((x) => x.key === op.integration.key);
        if (idx >= 0) bp.integrations[idx] = structuredClone(op.integration);
        else bp.integrations.push(structuredClone(op.integration));
        break;
      }
      case 'remove_integration': {
        if (!bp.integrations.some((x) => x.key === op.integration)) fail(`No existe la integración "${op.integration}"`);
        bp.integrations = bp.integrations.filter((x) => x.key !== op.integration);
        break;
      }
      case 'upsert_form': {
        const idx = bp.forms.findIndex((x) => x.key === op.form.key);
        if (idx >= 0) bp.forms[idx] = structuredClone(op.form);
        else bp.forms.push(structuredClone(op.form));
        break;
      }
      case 'remove_form': {
        if (!bp.forms.some((x) => x.key === op.form)) fail(`No existe el formulario "${op.form}"`);
        bp.forms = bp.forms.filter((x) => x.key !== op.form);
        break;
      }
      case 'upsert_script': {
        const scripts = (bp.scripts ??= []);
        const idx = scripts.findIndex((x) => x.key === op.script.key);
        if (idx >= 0) scripts[idx] = structuredClone(op.script);
        else scripts.push(structuredClone(op.script));
        break;
      }
      case 'remove_script': {
        const scripts = (bp.scripts ??= []);
        if (!scripts.some((x) => x.key === op.script)) fail(`No existe el script "${op.script}"`);
        bp.scripts = scripts.filter((x) => x.key !== op.script);
        break;
      }
      case 'backfill_field': {
        const f = needModule()?.fields.find((x) => x.key === op.field);
        if (mod && (!f || f.archived || f.type === 'formula' || f.type === 'file')) {
          fail(`No se puede rellenar el campo "${op.module}.${op.field}"`);
        }
        break;
      }
    }
  });

  const parsed = BlueprintSchema.safeParse(bp);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      errors.push({ level: 'error', path: issue.path.join('.'), message: issue.message });
    }
    return { blueprint: bp, errors };
  }
  return { blueprint: parsed.data, errors };
}
