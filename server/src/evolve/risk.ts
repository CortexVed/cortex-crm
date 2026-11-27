import { ROLE_RANK, type RiskLevel, type Role } from '../../../shared/constants';
import type { Automation, Blueprint, Field } from '../../../shared/blueprint';
import type { Operation } from '../../../shared/changeset';
import { collectRelatedCalls, parseFormula } from '../../../shared/formula';
import { applyOperations } from './apply';
import { listFormat, t, tp } from '../i18n';

/** ¿Copia la plantilla datos del registro que dispara ({{record.campo}}, no solo su id)? */
function copiesRecordData(values: unknown): boolean {
  const text = JSON.stringify(values ?? null);
  for (const m of text.matchAll(/\{\{\s*record\.([a-z][a-z0-9_]{0,39})\s*\}\}/g)) if (m[1] !== 'id') return true;
  return false;
}

/**
 * Módulos MENOS restringidos que el que dispara a los que la automatización copia datos con plantillas:
 * quien solo puede leer el destino acabaría viendo datos que no puede leer en el origen. (Los avisos no
 * cuentan: solo llegan a quien puede leer el registro que los genera.)
 */
function restrictedFlows(bp: Blueprint, a: Automation): string[] {
  const src = bp.modules.find((m) => m.key === a.trigger.module);
  if (!src) return [];
  const out = new Set<string>();
  for (const act of a.actions) {
    if (act.type !== 'create_record') continue;
    const dst = bp.modules.find((m) => m.key === act.module);
    if (dst && ROLE_RANK[dst.permissions.read] < ROLE_RANK[src.permissions.read] && copiesRecordData(act.values)) out.add(`"${dst.labelPlural}"`);
  }
  return [...out];
}

/** Eventos que vuelve a generar crear un registro: lo que puede retroalimentar una automatización. */
const CREATE_TRIGGERS = new Set(['record_created', 'record_updated', 'field_changed']);

/**
 * ¿Participa la automatización en un ciclo "dispara en X → crea en Y → … → crea en X"? Cada vuelta
 * crea registros nuevos (el límite de profundidad y el presupuesto por evento lo frenan en ejecución,
 * pero un ciclo así casi siempre es un error de diseño).
 */
function feedsItself(bp: Blueprint, a: Automation): boolean {
  const edges = new Map<string, Set<string>>();
  for (const x of bp.automations) {
    if (!x.enabled || !CREATE_TRIGGERS.has(x.trigger.type)) continue;
    for (const act of x.actions) {
      if (act.type !== 'create_record') continue;
      if (!edges.has(x.trigger.module)) edges.set(x.trigger.module, new Set());
      edges.get(x.trigger.module)!.add(act.module);
    }
  }
  if (!a.enabled || !CREATE_TRIGGERS.has(a.trigger.type)) return false;
  const start = a.trigger.module;
  const seen = new Set<string>();
  const stack = a.actions.flatMap((act) => (act.type === 'create_record' ? [act.module] : []));
  while (stack.length) {
    const m = stack.pop()!;
    if (m === start) return true;
    if (seen.has(m)) continue;
    seen.add(m);
    for (const n of edges.get(m) ?? []) stack.push(n);
  }
  return false;
}

/** Fórmulas *_RELATED que leen de un módulo con lectura más restringida exponen datos: riesgo alto. */
function formulaLeaks(bp: Blueprint, targetReadRole: Role, field: Pick<Field, 'formula'> | undefined): string[] {
  if (!field?.formula?.expression) return [];
  try {
    return collectRelatedCalls(parseFormula(field.formula.expression))
      .map((c) => bp.modules.find((m) => m.key === c.module))
      .filter((m): m is NonNullable<typeof m> => !!m && ROLE_RANK[m.permissions.read] > ROLE_RANK[targetReadRole])
      .map((m) => m.labelPlural);
  } catch {
    return [];
  }
}

export interface RiskItem {
  level: RiskLevel;
  message: string;
  op?: number;
}

export interface RiskAssessment {
  level: RiskLevel;
  items: RiskItem[];
  destructive: boolean;
  dataEgress: boolean;
  requiresOwner: boolean;
}

const RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };

/**
 * Acciones y bloques que este motor de riesgo sabe clasificar. La plataforma puede crecer (el motor de código
 * fuente puede añadir tipos nuevos, pero no puede tocar este archivo): lo que no esté aquí nunca es riesgo bajo.
 */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(['update_field', 'create_record', 'send_webhook', 'notify', 'run_script']);
const KNOWN_BLOCKS: ReadonlySet<string> = new Set(['heading', 'text', 'widget', 'records', 'form', 'buttons', 'divider']);

/**
 * Clasificación de riesgo DETERMINISTA (no depende de lo que diga la IA). Determina el rol
 * necesario para aprobar: riesgo alto => solo propietarios y confirmación explícita.
 */
export function assessRisk(before: Blueprint, ops: Operation[], opts: { counts?: Record<string, number> } = {}): RiskAssessment {
  const items: RiskItem[] = [];
  let destructive = false;
  let dataEgress = false;
  const add = (level: RiskLevel, message: string, op: number) => items.push({ level, message, op });
  // Las fugas se evalúan sobre el blueprint RESULTANTE: un módulo restringido creado o endurecido en el
  // mismo cambio también cuenta.
  const applied = applyOperations(before, ops);
  const after = applied.errors.length ? before : applied.blueprint;

  ops.forEach((op, i) => {
    const mod = 'module' in op && typeof op.module === 'string' ? before.modules.find((m) => m.key === op.module) : undefined;
    const modAfter = 'module' in op && typeof op.module === 'string' ? after.modules.find((m) => m.key === op.module) : undefined;
    switch (op.op) {
      case 'create_module': {
        const leaks = op.module.fields.flatMap((f) => formulaLeaks(after, op.module.permissions?.read ?? 'viewer', f));
        const orphans = before.modules.some((m) => m.key === op.module.key) ? 0 : (opts.counts?.[op.module.key] ?? 0);
        if (orphans > 0) add('high', tp(orphans, 'La clave "{key}" ya tiene {count} registro de un módulo retirado: el nuevo módulo lo heredaría con sus permisos', 'La clave "{key}" ya tiene {count} registros de un módulo retirado: el nuevo módulo los heredaría con sus permisos', { key: op.module.key }), i);
        else if (leaks.length) add('high', t('Fórmulas del nuevo módulo exponen datos de módulos más restringidos ({modules})', { modules: [...new Set(leaks)].join(', ') }), i);
        else add('low', t('Nuevo módulo "{module}"', { module: op.module.labelPlural }), i);
        break;
      }
      case 'update_module': {
        if (op.changes.permissions && mod) {
          const loosened = (['read', 'create', 'update', 'delete'] as const).some((k) => {
            const nv = op.changes.permissions?.[k];
            return nv !== undefined && ROLE_RANK[nv] < ROLE_RANK[mod.permissions[k]];
          });
          // Restringir la lectura deja expuestos sus datos si otros módulos (más abiertos) los agregan con fórmulas.
          const exposedBy = after.modules.filter((m) => m.key !== mod.key && m.fields.some((f) => formulaLeaks(after, m.permissions.read, f).includes(modAfter?.labelPlural ?? mod.labelPlural))).map((m) => m.labelPlural);
          if (loosened) add('high', t('Se amplían los permisos de "{module}"', { module: mod.labelPlural }), i);
          else if (exposedBy.length) add('high', t('Se restringe "{module}", pero fórmulas de {modules} seguirían mostrando sus datos', { module: mod.labelPlural, modules: exposedBy.join(', ') }), i);
          else add('medium', t('Se restringen los permisos de "{module}"', { module: mod.labelPlural }), i);
        } else add('low', t('Cambios de presentación en "{module}"', { module: mod?.labelPlural ?? op.module }), i);
        break;
      }
      case 'archive_module':
        destructive = true;
        add('high', t('Se archiva el módulo "{module}" (los datos se conservan)', { module: mod?.labelPlural ?? op.module }), i);
        break;
      case 'restore_module':
      case 'restore_field':
        add('low', t('Restauración de elementos archivados'), i);
        break;
      case 'add_field': {
        const leaks = modAfter ? formulaLeaks(after, modAfter.permissions.read, op.field) : [];
        if (leaks.length) add('high', t('La fórmula "{field}" expone datos de módulos más restringidos ({modules})', { field: op.field.label, modules: leaks.join(', ') }), i);
        else add(op.field.required ? 'medium' : 'low', op.field.required ? t('Nuevo campo obligatorio "{field}": los registros existentes no lo tendrán', { field: op.field.label }) : t('Nuevo campo "{field}"', { field: op.field.label }), i);
        break;
      }
      case 'update_field': {
        const f = mod?.fields.find((x) => x.key === op.field);
        const c = op.changes;
        if (c.type && f && c.type !== f.type) {
          destructive = true;
          add('high', t('Cambio de tipo de "{field}" ({from} → {to})', { field: f.label, from: f.type, to: c.type }), i);
        }
        if (c.options && f?.options) {
          const removed = f.options.filter((o) => !c.options!.some((n) => n.value === o.value));
          if (removed.length) {
            destructive = true;
            add('high', t('Se eliminan opciones de "{field}": {options}', { field: f.label, options: removed.map((r) => r.label).join(', ') }), i);
          }
        }
        if (c.formula && modAfter) {
          const leaks = formulaLeaks(after, modAfter.permissions.read, c as Pick<Field, 'formula'>);
          if (leaks.length) add('high', t('La fórmula de "{field}" expone datos de módulos más restringidos ({modules})', { field: f?.label ?? op.field, modules: leaks.join(', ') }), i);
        }
        if (c.required && f && !f.required) add('medium', t('"{field}" pasa a ser obligatorio', { field: f.label }), i);
        if (c.unique && f && !f.unique) add('medium', t('"{field}" pasa a ser único', { field: f.label }), i);
        if (!items.some((x) => x.op === i)) add('low', t('Ajustes del campo "{field}"', { field: f?.label ?? op.field }), i);
        break;
      }
      case 'archive_field':
        destructive = true;
        add('high', t('Se archiva el campo "{module}.{field}" (los datos se conservan)', { module: op.module, field: op.field }), i);
        break;
      case 'add_select_options':
        add('low', t('Nuevas opciones en "{module}.{field}"', { module: op.module, field: op.field }), i);
        break;
      case 'upsert_view':
        add('low', t('Vista "{view}"', { view: op.view.label }), i);
        break;
      case 'remove_view':
        add('low', t('Se elimina la vista "{view}"', { view: op.view }), i);
        break;
      case 'upsert_automation': {
        const kinds = new Set<string>(op.automation.actions.map((a) => a.type));
        // Acciones que esta versión del motor de riesgo no conoce (p. ej. añadidas con el motor de código fuente):
        // no se puede saber qué hacen con los datos, así que nunca cuentan como riesgo bajo.
        const unknownKinds = [...kinds].filter((k) => !KNOWN_ACTIONS.has(k));
        // Versión normalizada (con valores por defecto) de la automatización en el blueprint resultante.
        const auto = after.automations.find((x) => x.key === op.automation.key) ?? op.automation;
        const flows = restrictedFlows(after, auto);
        if (unknownKinds.length) {
          add('high', t('La automatización "{name}" usa una acción nueva de la plataforma ({actions}): revisa qué hace con los datos', { name: op.automation.name, actions: unknownKinds.join(', ') }), i);
        } else if (kinds.has('send_webhook')) {
          dataEgress = true;
          add('high', t('La automatización "{name}" envía datos a un servicio externo', { name: op.automation.name }), i);
        } else if (kinds.has('run_script')) {
          add('high', t('La automatización "{name}" ejecuta código a medida sobre tus datos', { name: op.automation.name }), i);
        } else if (flows.length) {
          // Copiar datos de un módulo restringido hacia un público más amplio es una fuga: lo aprueba un propietario.
          add('high', t('La automatización "{name}" copia datos de un módulo restringido a {modules}', { name: op.automation.name, modules: listFormat(flows) }), i);
        } else if (feedsItself(after, auto)) {
          add('high', t('La automatización "{name}" crea registros que la vuelven a disparar (bucle)', { name: op.automation.name }), i);
        } else if (kinds.has('update_field') || kinds.has('create_record')) {
          add('medium', t('La automatización "{name}" modifica datos automáticamente', { name: op.automation.name }), i);
        } else add('low', t('Automatización de avisos "{name}"', { name: op.automation.name }), i);
        break;
      }
      case 'remove_automation':
        add('medium', t('Se elimina la automatización "{name}"', { name: op.automation }), i);
        break;
      case 'upsert_dashboard':
        add('low', t('Panel "{dashboard}"', { dashboard: op.dashboard.label }), i);
        break;
      case 'remove_dashboard':
        add('low', t('Se elimina el panel "{dashboard}"', { dashboard: op.dashboard }), i);
        break;
      case 'upsert_integration':
        dataEgress = true;
        add('high', t('Integración externa "{name}" ({host})', { name: op.integration.name, host: safeHost(op.integration.url) }), i);
        break;
      case 'remove_integration':
        add('medium', t('Se elimina la integración "{name}"', { name: op.integration }), i);
        break;
      case 'upsert_form':
        add(op.form.public ? 'high' : 'low', op.form.public ? t('Formulario PÚBLICO "{name}" (acepta datos de Internet)', { name: op.form.name }) : t('Formulario "{name}"', { name: op.form.name }), i);
        break;
      case 'remove_form':
        add('low', t('Se elimina el formulario "{name}"', { name: op.form }), i);
        break;
      case 'upsert_script': {
        // Código a medida: aunque se ejecuta en un sandbox aislado y solo puede tocar datos de esta
        // organización, puede modificar registros automáticamente → lo aprueba un propietario. Desactivarlo
        // o ajustar su tiempo máximo sin tocar el código es de riesgo medio.
        const prev = (before.scripts ?? []).find((s) => s.key === op.script.key);
        const codeChanged = !prev || prev.code !== op.script.code;
        const enabling = op.script.enabled && (!prev || !prev.enabled);
        if (!prev) add('high', t('Nuevo script con código a medida "{name}" (sandbox aislado)', { name: op.script.name }), i);
        else if (codeChanged) add('high', t('Se modifica el código del script "{name}"', { name: op.script.name }), i);
        else if (enabling) add('high', t('Se activa el script "{name}"', { name: op.script.name }), i);
        else add('medium', op.script.enabled ? t('Ajustes del script "{name}" (sin cambiar el código)', { name: op.script.name }) : t('Se desactiva el script "{name}"', { name: op.script.name }), i);
        break;
      }
      case 'remove_script':
        add('medium', t('Se elimina el script "{name}"', { name: op.script }), i);
        break;
      case 'update_appearance': {
        // Colores, tipografía, bordes, densidad o menú lateral: solo presentación. El CSS personalizado es de
        // riesgo medio: aunque no puede cargar nada ni ejecutar código, puede ocultar o imitar elementos.
        const css = op.changes.customCss;
        const prev = before.appearance?.customCss;
        if (typeof css === 'string' && css.trim() && css !== prev) add('medium', t('CSS personalizado: puede ocultar o imitar elementos de la interfaz (revísalo antes de aprobar; nunca se aplica en EVOLVE, Ajustes ni Plataforma)'), i);
        else add('low', css === null && prev ? t('Apariencia del CRM (se quita el CSS personalizado)') : t('Apariencia del CRM (colores, tipografía, bordes, menú lateral…)'), i);
        break;
      }
      case 'update_navigation':
        add('low', op.navigation ? tp(op.navigation.groups.length, 'Menú de navegación ({count} grupo)', 'Menú de navegación ({count} grupos)') : t('Vuelve el menú de navegación por defecto'), i);
        break;
      case 'upsert_page': {
        // Cada rol solo ve las páginas de su rol mínimo y los bloques de los módulos que puede leer.
        const unknownBlocks = [...new Set<string>(op.page.blocks.map((b) => b.type))].filter((type) => !KNOWN_BLOCKS.has(type));
        if (unknownBlocks.length) add('medium', t('Página «{page}» con un tipo de bloque nuevo de la plataforma ({blocks})', { page: op.page.label, blocks: unknownBlocks.join(', ') }), i);
        else add('low', t('Página «{page}»', { page: op.page.label }), i);
        break;
      }
      case 'remove_page':
        add('low', t('Se elimina la página "{page}"', { page: op.page }), i);
        break;
      case 'backfill_field':
        if (!op.onlyEmpty) destructive = true;
        add(op.onlyEmpty ? 'medium' : 'high', op.onlyEmpty ? t('Migración de datos: rellenar "{module}.{field}" donde esté vacío', { module: op.module, field: op.field }) : t('Migración de datos: SOBRESCRIBIR "{module}.{field}"', { module: op.module, field: op.field }), i);
        break;
      default: {
        // Operación que esta versión no conoce (p. ej. añadida con el motor de código fuente): riesgo alto.
        const kind = String((op as { op?: unknown }).op ?? t('desconocida'));
        add('high', t('Operación nueva de la plataforma ({kind}): revisa qué cambia', { kind }), i);
      }
    }
  });

  const level = items.reduce<RiskLevel>((acc, it) => (RANK[it.level] > RANK[acc] ? it.level : acc), 'low');
  return { level, items, destructive, dataEgress, requiresOwner: level === 'high' };
}

/**
 * Riesgo de pasar de una configuración a otra SIN un change set (revertir o restaurar una versión):
 * la versión de destino puede reactivar justo lo que se desactivó por seguridad (un webhook, un
 * formulario público, permisos amplios o un script). Se compara el estado actual con el de destino.
 */
export function assessTransition(current: Blueprint, target: Blueprint): RiskAssessment {
  const items: RiskItem[] = [];
  let dataEgress = false;
  const high = (message: string) => items.push({ level: 'high', message });
  for (const m of target.modules) {
    const cur = current.modules.find((x) => x.key === m.key);
    if (!cur) continue;
    const loosened = (['read', 'create', 'update', 'delete'] as const).filter((k) => ROLE_RANK[m.permissions[k]] < ROLE_RANK[cur.permissions[k]]);
    if (loosened.length) high(t('Se amplían los permisos de "{module}" ({permissions})', { module: m.labelPlural, permissions: loosened.join(', ') }));
  }
  for (const i of target.integrations) {
    const cur = current.integrations.find((x) => x.key === i.key);
    if (!i.enabled) continue;
    if (!cur || !cur.enabled || cur.url !== i.url || JSON.stringify(cur.includeFields ?? null) !== JSON.stringify(i.includeFields ?? null)) {
      dataEgress = true;
      high(t('Se reactiva o cambia la integración externa "{name}" ({host})', { name: i.name, host: safeHost(i.url) }));
    }
  }
  for (const f of target.forms) {
    const cur = current.forms.find((x) => x.key === f.key);
    if (f.public && !(cur?.public)) high(t('El formulario "{name}" vuelve a ser PÚBLICO', { name: f.name }));
  }
  for (const s of target.scripts ?? []) {
    const cur = (current.scripts ?? []).find((x) => x.key === s.key);
    if (s.enabled && (!cur || !cur.enabled || cur.code !== s.code)) high(t('Se reactiva o cambia el código del script "{name}"', { name: s.name }));
  }
  for (const a of target.automations) {
    if (!a.enabled) continue;
    const cur = current.automations.find((x) => x.key === a.key);
    // Los tipos de acción que este archivo no conoce cuentan como arriesgados (no se sabe qué hacen).
    const risky = a.actions.some((x) => x.type === 'send_webhook' || x.type === 'run_script' || !KNOWN_ACTIONS.has(x.type));
    if (risky && (!cur || !cur.enabled || JSON.stringify(cur.actions) !== JSON.stringify(a.actions))) {
      if (a.actions.some((x) => x.type === 'send_webhook')) dataEgress = true;
      high(t('Se reactiva la automatización "{name}" (envía datos fuera, ejecuta código o usa una acción nueva de la plataforma)', { name: a.name }));
    }
  }
  const level: RiskLevel = items.length ? 'high' : 'low';
  return { level, items, destructive: false, dataEgress, requiresOwner: level === 'high' };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return t('URL inválida');
  }
}
