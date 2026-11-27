import { FIELD_TYPE_LABELS, ROLE_LABELS, type FieldType, type Role } from '../../../shared/constants';
import { findModule, findPage, type Blueprint, type Page } from '../../../shared/blueprint';
import type { AppearancePatch, ChangeSet, Operation } from '../../../shared/changeset';
import { DENSITY_LABELS, FONT_LABELS, RADIUS_LABELS, SIDEBAR_LABELS, THEME_LABELS } from '../../../shared/appearance';
import { blockModules } from '../crm/visibility';
import type { RiskAssessment } from './risk';
import { inSentence, listFormat, t, tk, tp } from '../i18n';

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

const typeLabel = (type: string) => {
  const label = FIELD_TYPE_LABELS[type as FieldType];
  return label ? tk(label) : type;
};
const roleLabel = (role: string) => {
  const label = ROLE_LABELS[role as Role];
  return label ? tk(label) : role;
};

/** Cambios de apariencia en lenguaje llano ("color principal #0a7f6b · menú lateral oscuro"). */
function describeAppearance(c: AppearancePatch): string {
  const parts: string[] = [];
  if (c.brandColor) parts.push(t('color principal {color}', { color: c.brandColor }));
  if (c.accentColor) parts.push(t('color de acento {color}', { color: c.accentColor }));
  else if (c.accentColor === null) parts.push(t('sin color de acento propio'));
  if (c.appName) parts.push(t('nombre «{name}»', { name: c.appName }));
  else if (c.appName === null) parts.push(t('nombre por defecto'));
  if (c.font) parts.push(t('tipografía {font}', { font: inSentence(tk(FONT_LABELS[c.font])) }));
  if (c.radius) parts.push(t('bordes: {radius}', { radius: inSentence(tk(RADIUS_LABELS[c.radius])) }));
  if (c.density) parts.push(t('densidad {density}', { density: inSentence(tk(DENSITY_LABELS[c.density])) }));
  if (c.sidebar) parts.push(t('menú lateral {sidebar}', { sidebar: inSentence(tk(SIDEBAR_LABELS[c.sidebar])) }));
  if (c.defaultTheme) parts.push(t('tema por defecto: {theme}', { theme: inSentence(tk(THEME_LABELS[c.defaultTheme])) }));
  if (typeof c.customCss === 'string') parts.push(tp(c.customCss.length, 'CSS personalizado ({count} carácter)', 'CSS personalizado ({count} caracteres)'));
  else if (c.customCss === null) parts.push(t('se quita el CSS personalizado'));
  return parts.join(' · ');
}

/** "2 widgets", "1 lista de registros"… (un tipo de bloque nuevo de la plataforma sale con su clave). */
function blockCount(type: Page['blocks'][number]['type'], n: number): string {
  switch (type) {
    case 'heading':
      return tp(n, '{count} título', '{count} títulos');
    case 'text':
      return tp(n, '{count} texto', '{count} textos');
    case 'widget':
      return tp(n, '{count} widget', '{count} widgets');
    case 'records':
      return tp(n, '{count} lista de registros', '{count} listas de registros');
    case 'form':
      return tp(n, '{count} formulario', '{count} formularios');
    case 'buttons':
      return tp(n, '{count} grupo de botones', '{count} grupos de botones');
    case 'divider':
      return tp(n, '{count} separador', '{count} separadores');
    default:
      return `${n} ${String(type)}`;
  }
}

/** "3 bloques: 2 widgets, 1 lista de registros". */
function describeBlocks(page: Page): string {
  const counts = new Map<Page['blocks'][number]['type'], number>();
  for (const b of page.blocks) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  const parts = [...counts].map(([type, n]) => blockCount(type, n));
  const total = tp(page.blocks.length, '{count} bloque', '{count} bloques');
  return parts.length ? `${total}: ${parts.join(', ')}` : total;
}

export function describeOperation(op: Operation, bp: Blueprint): ImpactChange & { index: number } {
  const modLabel = (k: string) => findModule(bp, k)?.labelPlural ?? k;
  switch (op.op) {
    case 'create_module':
      return {
        index: 0,
        kind: 'add',
        title: t('Nuevo módulo «{module}»', { module: op.module.labelPlural }),
        detail: `${tp(op.module.fields.length, '{count} campo', '{count} campos')}, ${tp(op.module.views.length, '{count} vista', '{count} vistas')}: ${op.module.views.map((v) => v.label).join(', ')}`,
      };
    case 'update_module':
      return { index: 0, kind: 'update', title: t('Ajustes del módulo «{module}»', { module: modLabel(op.module) }), detail: Object.keys(op.changes).join(', ') };
    case 'archive_module':
      return { index: 0, kind: 'remove', title: t('Archivar módulo «{module}»', { module: modLabel(op.module) }), detail: t('Los datos se conservan y se puede restaurar') };
    case 'restore_module':
      return { index: 0, kind: 'update', title: t('Restaurar módulo «{module}»', { module: modLabel(op.module) }) };
    case 'add_field':
      return {
        index: 0,
        kind: 'add',
        title: t('Nuevo campo «{field}» en {module}', { field: op.field.label, module: modLabel(op.module) }),
        detail: [typeLabel(op.field.type), op.field.required ? t('obligatorio') : null, op.field.formula ? t('fórmula: {expression}', { expression: op.field.formula.expression }) : null].filter(Boolean).join(' · '),
      };
    case 'update_field':
      return { index: 0, kind: 'update', title: t('Modificar campo «{field}» en {module}', { field: op.field, module: modLabel(op.module) }), detail: Object.entries(op.changes).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v)}`).join(' · ') };
    case 'archive_field':
      return { index: 0, kind: 'remove', title: t('Archivar campo «{field}» en {module}', { field: op.field, module: modLabel(op.module) }), detail: t('Los datos se conservan') };
    case 'restore_field':
      return { index: 0, kind: 'update', title: t('Restaurar campo «{field}» en {module}', { field: op.field, module: modLabel(op.module) }) };
    case 'add_select_options':
      return { index: 0, kind: 'add', title: t('Nuevas opciones en «{field}» ({module})', { field: op.field, module: modLabel(op.module) }), detail: op.options.map((o) => o.label).join(', ') };
    case 'upsert_view':
      return { index: 0, kind: 'update', title: t('Vista «{view}» ({type}) en {module}', { view: op.view.label, type: op.view.type, module: modLabel(op.module) }) };
    case 'remove_view':
      return { index: 0, kind: 'remove', title: t('Eliminar vista «{view}» de {module}', { view: op.view, module: modLabel(op.module) }) };
    case 'upsert_automation': {
      const a = op.automation;
      return {
        index: 0,
        kind: 'add',
        title: t('Automatización «{name}»', { name: a.name }),
        detail: t('Cuando: {trigger} en {module} → {actions}', { trigger: a.trigger.type, module: modLabel(a.trigger.module), actions: a.actions.map((x) => x.type).join(', ') }),
      };
    }
    case 'remove_automation':
      return { index: 0, kind: 'remove', title: t('Eliminar automatización «{name}»', { name: op.automation }) };
    case 'upsert_dashboard':
      return { index: 0, kind: 'update', title: t('Panel «{dashboard}»', { dashboard: op.dashboard.label }), detail: tp(op.dashboard.widgets.length, '{count} widget', '{count} widgets') };
    case 'remove_dashboard':
      return { index: 0, kind: 'remove', title: t('Eliminar panel «{dashboard}»', { dashboard: op.dashboard }) };
    case 'upsert_integration':
      return { index: 0, kind: 'add', title: t('Integración «{name}»', { name: op.integration.name }), detail: op.integration.url };
    case 'remove_integration':
      return { index: 0, kind: 'remove', title: t('Eliminar integración «{name}»', { name: op.integration }) };
    case 'upsert_form':
      return { index: 0, kind: 'update', title: op.form.public ? t('Formulario «{name}» (público)', { name: op.form.name }) : t('Formulario «{name}»', { name: op.form.name }) };
    case 'remove_form':
      return { index: 0, kind: 'remove', title: t('Eliminar formulario «{name}»', { name: op.form }) };
    case 'upsert_script':
      return { index: 0, kind: (bp.scripts ?? []).some((s) => s.key === op.script.key) ? 'update' : 'add', title: t('Script «{name}» (código en sandbox)', { name: op.script.name }), detail: op.script.description?.slice(0, 200) };
    case 'remove_script':
      return { index: 0, kind: 'remove', title: t('Eliminar script «{name}»', { name: op.script }) };
    case 'update_appearance':
      return { index: 0, kind: 'update', title: t('Apariencia del CRM'), detail: describeAppearance(op.changes) || undefined };
    case 'update_navigation': {
      const n = op.navigation;
      if (!n) return { index: 0, kind: 'update', title: t('Menú de navegación'), detail: t('Vuelve el menú por defecto (todos los módulos en una lista)') };
      const home = n.home
        ? n.home.type === 'page'
          ? t('inicio: página «{label}»', { label: findPage(bp, n.home.key)?.label ?? n.home.key })
          : t('inicio: panel «{label}»', { label: bp.dashboards.find((d) => d.key === n.home!.key)?.label ?? n.home.key })
        : null;
      const groups = n.groups.map((g) => `${g.label} (${g.items.length})`).join(', ');
      return { index: 0, kind: 'update', title: t('Menú de navegación'), detail: [groups ? t('Grupos: {groups}', { groups }) : t('Sin grupos (lista de módulos)'), home].filter(Boolean).join(' · ') };
    }
    case 'upsert_page':
      return {
        index: 0,
        kind: findPage(bp, op.page.key) ? 'update' : 'add',
        title: t('Página «{page}»', { page: op.page.label }),
        detail: `${describeBlocks(op.page)} · ${t('visible desde el rol {role}', { role: roleLabel(op.page.minRole) })}`,
      };
    case 'remove_page':
      return { index: 0, kind: 'remove', title: t('Eliminar página «{page}»', { page: findPage(bp, op.page)?.label ?? op.page }) };
    case 'backfill_field':
      return { index: 0, kind: 'data', title: t('Migración de datos en {module}.{field}', { module: modLabel(op.module), field: op.field }), detail: `${op.onlyEmpty ? t('Solo registros vacíos') : t('Sobrescribe valores')} → ${JSON.stringify(op.value)}` };
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
    const entry = tables.get(key)!;
    if (action !== 'alter') entry.action = action;
    return entry;
  };

  for (const op of cs.operations) {
    switch (op.op) {
      case 'create_module': {
        artifacts.push({ path: `blueprint/modules/${op.module.key}.json`, action: 'create' });
        const created = table(op.module.key, 'create');
        created.columns.push(...op.module.fields.map((f) => ({ key: f.key, label: f.label, type: typeLabel(f.type), action: 'add' as const })));
        touchedModules.add(op.module.key);
        break;
      }
      case 'update_module':
        artifacts.push({ path: `blueprint/modules/${op.module}.json`, action: 'update' });
        touchedModules.add(op.module);
        if (op.changes.permissions) permissions.push(t('Permisos de «{module}»: {changes}', { module: op.module, changes: Object.entries(op.changes.permissions).map(([k, v]) => `${k} → ${roleLabel(String(v))}`).join(', ') }));
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
        if (op.automation.actions.some((a) => a.type === 'send_webhook')) permissions.push(t('La automatización «{name}» enviará datos fuera del CRM', { name: op.automation.name }));
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
        permissions.push(t('Salida de datos a {url} (firmada con HMAC)', { url: op.integration.url }));
        break;
      case 'remove_integration':
        artifacts.push({ path: `blueprint/integrations/${op.integration}.json`, action: 'delete' });
        break;
      case 'upsert_form':
        artifacts.push({ path: `blueprint/forms/${op.form.key}.json`, action: 'update' });
        if (op.form.public) permissions.push(t('Endpoint público de formulario «{name}» (con límite de peticiones)', { name: op.form.name }));
        break;
      case 'remove_form':
        artifacts.push({ path: `blueprint/forms/${op.form}.json`, action: 'delete' });
        break;
      case 'upsert_script':
        artifacts.push({ path: `blueprint/scripts/${op.script.key}.js`, action: (before.scripts ?? []).some((s) => s.key === op.script.key) ? 'update' : 'create' });
        permissions.push(t('El script «{name}» podrá modificar registros de esta organización (solo dentro del sandbox, sin red)', { name: op.script.name }));
        break;
      case 'remove_script':
        artifacts.push({ path: `blueprint/scripts/${op.script}.js`, action: 'delete' });
        break;
      case 'update_appearance':
        artifacts.push({ path: 'blueprint/appearance.json', action: 'update' });
        if (typeof op.changes.customCss === 'string' && op.changes.customCss.trim()) {
          artifacts.push({ path: 'blueprint/appearance/custom.css', action: 'update' });
          permissions.push(t('El CSS personalizado se aplicará a toda la interfaz de la organización, salvo EVOLVE, Ajustes y Plataforma (no puede cargar recursos ni ejecutar código)'));
        }
        break;
      case 'update_navigation':
        artifacts.push({ path: 'blueprint/navigation.json', action: 'update' });
        break;
      case 'upsert_page':
        artifacts.push({ path: `blueprint/pages/${op.page.key}.json`, action: findPage(before, op.page.key) ? 'update' : 'create' });
        break;
      case 'remove_page':
        artifacts.push({ path: `blueprint/pages/${op.page}.json`, action: 'delete' });
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
    if (touchedModules.has(m.key)) for (const v of m.views) affected.add(t('Vista «{module} › {view}»', { module: m.labelPlural, view: v.label }));
  }
  for (const d of ref.dashboards) for (const w of d.widgets) if (touchedModules.has(w.module) || touchedFields.has(`${w.module}.${w.field}`)) affected.add(t('Panel «{dashboard}» › {widget}', { dashboard: d.label, widget: w.title }));
  for (const a of ref.automations) if (touchedModules.has(a.trigger.module)) affected.add(t('Automatización «{name}»', { name: a.name }));
  for (const f of ref.forms) if (touchedModules.has(f.module)) affected.add(t('Formulario «{name}»', { name: f.name }));
  for (const p of ref.pages ?? []) if (p.blocks.some((b) => blockModules(ref, b).some((k) => touchedModules.has(k)))) affected.add(t('Página «{page}»', { page: p.label }));
  if (ref.navigation?.groups.some((g) => g.items.some((it) => it.type === 'module' && touchedModules.has(it.key)))) affected.add(t('Menú de navegación'));
  if (['deals', 'activities', 'contacts', 'companies', 'tasks'].some((k) => touchedModules.has(k))) affected.add(t('Informes comerciales'));

  return {
    changes,
    artifacts,
    tables: [...tables.values()],
    dataMigrations,
    permissions: permissions.length ? permissions : [t('Sin cambios de permisos ni salidas de datos')],
    risks: risk.items.map((r) => ({ level: r.level, message: r.message })),
    affectedFeatures: [...affected].slice(0, 40),
    approverRole: risk.requiresOwner ? tk(ROLE_LABELS.owner) : listFormat([tk(ROLE_LABELS.admin), tk(ROLE_LABELS.owner)], 'disjunction'),
  };
}
