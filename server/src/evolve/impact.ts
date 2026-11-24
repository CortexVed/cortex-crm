import { FIELD_TYPE_LABELS, ROLE_LABELS, type FieldType } from '../../../shared/constants';
import { findModule, type Blueprint } from '../../../shared/blueprint';
import type { ChangeSet, Operation } from '../../../shared/changeset';
import type { RiskAssessment } from './risk';

export interface ImpactChange {
  index: number;
  kind: 'add' | 'update' | 'remove' | 'data';
  title: string;
  detail?: string;
}

export interface ImpactReport {
  changes: ImpactChange[];
  artifacts: { path: string; action: 'create' | 'update' | 'archive' | 'delete' }[];
  tables: {
    module: string;
    label: string;
    action: 'create' | 'alter' | 'archive';
    columns: { key: string; label: string; type: string; action: 'add' | 'alter' | 'archive' }[];
  }[];
  dataMigrations: { module: string; field: string; mode: 'only_empty' | 'overwrite'; estimatedRows?: number }[];
  permissions: string[];
  risks: { level: string; message: string }[];
  affectedFeatures: string[];
  approverRole: string;
}

const typeLabel = (t: string) => FIELD_TYPE_LABELS[t as FieldType] ?? t;

export function describeOperation(op: Operation, bp: Blueprint): ImpactChange & { index: number } {
  const modLabel = (k: string) => findModule(bp, k)?.labelPlural ?? k;
  switch (op.op) {
    case 'create_module':
      return { index: 0, kind: 'add', title: `Nuevo módulo «${op.module.labelPlural}»`, detail: `${op.module.fields.length} campos, ${op.module.views.length} vista(s): ${op.module.views.map((v) => v.label).join(', ')}` };
    case 'update_module':
      return { index: 0, kind: 'update', title: `Ajustes del módulo «${modLabel(op.module)}»`, detail: Object.keys(op.changes).join(', ') };
    case 'archive_module':
      return { index: 0, kind: 'remove', title: `Archivar módulo «${modLabel(op.module)}»`, detail: 'Los datos se conservan y se puede restaurar' };
    case 'restore_module':
      return { index: 0, kind: 'update', title: `Restaurar módulo «${modLabel(op.module)}»` };
    case 'add_field':
      return { index: 0, kind: 'add', title: `Nuevo campo «${op.field.label}» en ${modLabel(op.module)}`, detail: `${typeLabel(op.field.type)}${op.field.required ? ' · obligatorio' : ''}${op.field.formula ? ` · fórmula: ${op.field.formula.expression}` : ''}` };
    case 'update_field':
      return { index: 0, kind: 'update', title: `Modificar campo «${op.field}» en ${modLabel(op.module)}`, detail: Object.entries(op.changes).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v)}`).join(' · ') };
    case 'archive_field':
      return { index: 0, kind: 'remove', title: `Archivar campo «${op.field}» en ${modLabel(op.module)}`, detail: 'Los datos se conservan' };
    case 'restore_field':
      return { index: 0, kind: 'update', title: `Restaurar campo «${op.field}» en ${modLabel(op.module)}` };
    case 'add_select_options':
      return { index: 0, kind: 'add', title: `Nuevas opciones en «${op.field}» (${modLabel(op.module)})`, detail: op.options.map((o) => o.label).join(', ') };
    case 'upsert_view':
      return { index: 0, kind: 'update', title: `Vista «${op.view.label}» (${op.view.type}) en ${modLabel(op.module)}` };
    case 'remove_view':
      return { index: 0, kind: 'remove', title: `Eliminar vista «${op.view}» de ${modLabel(op.module)}` };
    case 'upsert_automation': {
      const a = op.automation;
      return { index: 0, kind: 'add', title: `Automatización «${a.name}»`, detail: `Cuando: ${a.trigger.type} en ${modLabel(a.trigger.module)} → ${a.actions.map((x) => x.type).join(', ')}` };
    }
    case 'remove_automation':
      return { index: 0, kind: 'remove', title: `Eliminar automatización «${op.automation}»` };
    case 'upsert_dashboard':
      return { index: 0, kind: 'update', title: `Panel «${op.dashboard.label}»`, detail: `${op.dashboard.widgets.length} widget(s)` };
    case 'remove_dashboard':
      return { index: 0, kind: 'remove', title: `Eliminar panel «${op.dashboard}»` };
    case 'upsert_integration':
      return { index: 0, kind: 'add', title: `Integración «${op.integration.name}»`, detail: op.integration.url };
    case 'remove_integration':
      return { index: 0, kind: 'remove', title: `Eliminar integración «${op.integration}»` };
    case 'upsert_form':
      return { index: 0, kind: 'update', title: `Formulario «${op.form.name}»${op.form.public ? ' (público)' : ''}` };
    case 'remove_form':
      return { index: 0, kind: 'remove', title: `Eliminar formulario «${op.form}»` };
    case 'upsert_script':
      return { index: 0, kind: (bp.scripts ?? []).some((s) => s.key === op.script.key) ? 'update' : 'add', title: `Script «${op.script.name}» (código en sandbox)`, detail: op.script.description?.slice(0, 200) };
    case 'remove_script':
      return { index: 0, kind: 'remove', title: `Eliminar script «${op.script}»` };
    case 'backfill_field':
      return { index: 0, kind: 'data', title: `Migración de datos en ${modLabel(op.module)}.${op.field}`, detail: `${op.onlyEmpty ? 'Solo registros vacíos' : 'Sobrescribe valores'} → ${JSON.stringify(op.value)}` };
  }
}

export function buildImpact(before: Blueprint, after: Blueprint | null, cs: ChangeSet, risk: RiskAssessment, counts: Record<string, number> = {}): ImpactReport {
  const changes = cs.operations.map((op, i) => ({ ...describeOperation(op, before), index: i }));
  const artifacts: ImpactReport['artifacts'] = [];
  const tables = new Map<string, ImpactReport['tables'][number]>();
  const dataMigrations: ImpactReport['dataMigrations'] = [];
  const permissions: string[] = [];
  const touchedModules = new Set<string>();
  const touchedFields = new Set<string>();

  const table = (key: string, action: 'create' | 'alter' | 'archive') => {
    const label = findModule(after ?? before, key)?.labelPlural ?? findModule(before, key)?.labelPlural ?? key;
    if (!tables.has(key)) tables.set(key, { module: key, label, action, columns: [] });
    const t = tables.get(key)!;
    if (action !== 'alter') t.action = action;
    return t;
  };

  for (const op of cs.operations) {
    switch (op.op) {
      case 'create_module': {
        artifacts.push({ path: `blueprint/modules/${op.module.key}.json`, action: 'create' });
        const t = table(op.module.key, 'create');
        t.columns.push(...op.module.fields.map((f) => ({ key: f.key, label: f.label, type: typeLabel(f.type), action: 'add' as const })));
        touchedModules.add(op.module.key);
        break;
      }
      case 'update_module':
        artifacts.push({ path: `blueprint/modules/${op.module}.json`, action: 'update' });
        touchedModules.add(op.module);
        if (op.changes.permissions) permissions.push(`Permisos de «${op.module}»: ${Object.entries(op.changes.permissions).map(([k, v]) => `${k} → ${ROLE_LABELS[v as keyof typeof ROLE_LABELS] ?? v}`).join(', ')}`);
        break;
      case 'archive_module':
        artifacts.push({ path: `blueprint/modules/${op.module}.json`, action: 'archive' });
        table(op.module, 'archive');
        touchedModules.add(op.module);
        break;
      case 'restore_module':
        artifacts.push({ path: `blueprint/modules/${op.module}.json`, action: 'update' });
        touchedModules.add(op.module);
        break;
      case 'add_field':
        artifacts.push({ path: `blueprint/modules/${op.module}/fields/${op.field.key}`, action: 'create' });
        table(op.module, 'alter').columns.push({ key: op.field.key, label: op.field.label, type: typeLabel(op.field.type), action: 'add' });
        touchedModules.add(op.module);
        break;
      case 'update_field':
      case 'add_select_options':
        artifacts.push({ path: `blueprint/modules/${op.module}/fields/${op.field}`, action: 'update' });
        table(op.module, 'alter').columns.push({ key: op.field, label: op.field, type: '', action: 'alter' });
        touchedModules.add(op.module);
        touchedFields.add(`${op.module}.${op.field}`);
        break;
      case 'archive_field':
        artifacts.push({ path: `blueprint/modules/${op.module}/fields/${op.field}`, action: 'archive' });
        table(op.module, 'alter').columns.push({ key: op.field, label: op.field, type: '', action: 'archive' });
        touchedModules.add(op.module);
        touchedFields.add(`${op.module}.${op.field}`);
        break;
      case 'restore_field':
        artifacts.push({ path: `blueprint/modules/${op.module}/fields/${op.field}`, action: 'update' });
        break;
      case 'upsert_view':
      case 'remove_view':
        artifacts.push({ path: `blueprint/modules/${op.module}/views/${typeof op.view === 'string' ? op.view : op.view.key}`, action: op.op === 'remove_view' ? 'delete' : 'update' });
        break;
      case 'upsert_automation':
        artifacts.push({ path: `blueprint/automations/${op.automation.key}.json`, action: 'update' });
        if (op.automation.actions.some((a) => a.type === 'send_webhook')) permissions.push(`La automatización «${op.automation.name}» enviará datos fuera del CRM`);
        break;
      case 'remove_automation':
        artifacts.push({ path: `blueprint/automations/${op.automation}.json`, action: 'delete' });
        break;
      case 'upsert_dashboard':
      case 'remove_dashboard':
        artifacts.push({ path: `blueprint/dashboards/${typeof op.dashboard === 'string' ? op.dashboard : op.dashboard.key}.json`, action: op.op === 'remove_dashboard' ? 'delete' : 'update' });
        break;
      case 'upsert_integration':
        artifacts.push({ path: `blueprint/integrations/${op.integration.key}.json`, action: 'update' });
        permissions.push(`Salida de datos a ${op.integration.url} (firmada con HMAC)`);
        break;
      case 'remove_integration':
        artifacts.push({ path: `blueprint/integrations/${op.integration}.json`, action: 'delete' });
        break;
      case 'upsert_form':
        artifacts.push({ path: `blueprint/forms/${op.form.key}.json`, action: 'update' });
        if (op.form.public) permissions.push(`Endpoint público de formulario «${op.form.name}» (con límite de peticiones)`);
        break;
      case 'remove_form':
        artifacts.push({ path: `blueprint/forms/${op.form}.json`, action: 'delete' });
        break;
      case 'upsert_script':
        artifacts.push({ path: `blueprint/scripts/${op.script.key}.js`, action: (before.scripts ?? []).some((s) => s.key === op.script.key) ? 'update' : 'create' });
        permissions.push(`El script «${op.script.name}» podrá modificar registros de esta organización (solo dentro del sandbox, sin red)`);
        break;
      case 'remove_script':
        artifacts.push({ path: `blueprint/scripts/${op.script}.js`, action: 'delete' });
        break;
      case 'backfill_field':
        dataMigrations.push({ module: op.module, field: op.field, mode: op.onlyEmpty ? 'only_empty' : 'overwrite', estimatedRows: counts[op.module] });
        touchedFields.add(`${op.module}.${op.field}`);
        break;
    }
  }

  // Funcionalidades afectadas: vistas, paneles, automatizaciones, formularios e informes que dependen de lo tocado.
  const affected = new Set<string>();
  const ref = after ?? before;
  for (const m of ref.modules) {
    if (touchedModules.has(m.key)) for (const v of m.views) affected.add(`Vista «${m.labelPlural} › ${v.label}»`);
  }
  for (const d of ref.dashboards) for (const w of d.widgets) if (touchedModules.has(w.module) || touchedFields.has(`${w.module}.${w.field}`)) affected.add(`Panel «${d.label}» › ${w.title}`);
  for (const a of ref.automations) if (touchedModules.has(a.trigger.module)) affected.add(`Automatización «${a.name}»`);
  for (const f of ref.forms) if (touchedModules.has(f.module)) affected.add(`Formulario «${f.name}»`);
  if (['deals', 'activities', 'contacts', 'companies', 'tasks'].some((k) => touchedModules.has(k))) affected.add('Informes comerciales');

  return {
    changes,
    artifacts,
    tables: [...tables.values()],
    dataMigrations,
    permissions: permissions.length ? permissions : ['Sin cambios de permisos ni salidas de datos'],
    risks: risk.items.map((r) => ({ level: r.level, message: r.message })),
    affectedFeatures: [...affected].slice(0, 40),
    approverRole: risk.requiresOwner ? ROLE_LABELS.owner : `${ROLE_LABELS.admin} o ${ROLE_LABELS.owner}`,
  };
}
