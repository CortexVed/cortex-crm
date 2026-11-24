import { ROLE_RANK, type RiskLevel, type Role } from '../../../shared/constants';
import type { Automation, Blueprint, Field } from '../../../shared/blueprint';
import type { Operation } from '../../../shared/changeset';
import { collectRelatedCalls, parseFormula } from '../../../shared/formula';
import { applyOperations } from './apply';

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
        if (orphans > 0) add('high', `La clave "${op.module.key}" ya tiene ${orphans} registro(s) de un módulo retirado: el nuevo módulo los heredaría con sus permisos`, i);
        else if (leaks.length) add('high', `Fórmulas del nuevo módulo exponen datos de módulos más restringidos (${[...new Set(leaks)].join(', ')})`, i);
        else add('low', `Nuevo módulo "${op.module.labelPlural}"`, i);
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
          if (loosened) add('high', `Se amplían los permisos de "${mod.labelPlural}"`, i);
          else if (exposedBy.length) add('high', `Se restringe "${mod.labelPlural}", pero fórmulas de ${exposedBy.join(', ')} seguirían mostrando sus datos`, i);
          else add('medium', `Se restringen los permisos de "${mod.labelPlural}"`, i);
        } else add('low', `Cambios de presentación en "${mod?.labelPlural ?? op.module}"`, i);
        break;
      }
      case 'archive_module':
        destructive = true;
        add('high', `Se archiva el módulo "${mod?.labelPlural ?? op.module}" (los datos se conservan)`, i);
        break;
      case 'restore_module':
      case 'restore_field':
        add('low', 'Restauración de elementos archivados', i);
        break;
      case 'add_field': {
        const leaks = modAfter ? formulaLeaks(after, modAfter.permissions.read, op.field) : [];
        if (leaks.length) add('high', `La fórmula "${op.field.label}" expone datos de módulos más restringidos (${leaks.join(', ')})`, i);
        else add(op.field.required ? 'medium' : 'low', op.field.required ? `Nuevo campo obligatorio "${op.field.label}": los registros existentes no lo tendrán` : `Nuevo campo "${op.field.label}"`, i);
        break;
      }
      case 'update_field': {
        const f = mod?.fields.find((x) => x.key === op.field);
        const c = op.changes;
        if (c.type && f && c.type !== f.type) {
          destructive = true;
          add('high', `Cambio de tipo de "${f.label}" (${f.type} → ${c.type})`, i);
        }
        if (c.options && f?.options) {
          const removed = f.options.filter((o) => !c.options!.some((n) => n.value === o.value));
          if (removed.length) {
            destructive = true;
            add('high', `Se eliminan opciones de "${f.label}": ${removed.map((r) => r.label).join(', ')}`, i);
          }
        }
        if (c.formula && modAfter) {
          const leaks = formulaLeaks(after, modAfter.permissions.read, c as Pick<Field, 'formula'>);
          if (leaks.length) add('high', `La fórmula de "${f?.label ?? op.field}" expone datos de módulos más restringidos (${leaks.join(', ')})`, i);
        }
        if (c.required && f && !f.required) add('medium', `"${f.label}" pasa a ser obligatorio`, i);
        if (c.unique && f && !f.unique) add('medium', `"${f.label}" pasa a ser único`, i);
        if (!items.some((x) => x.op === i)) add('low', `Ajustes del campo "${f?.label ?? op.field}"`, i);
        break;
      }
      case 'archive_field':
        destructive = true;
        add('high', `Se archiva el campo "${op.module}.${op.field}" (los datos se conservan)`, i);
        break;
      case 'add_select_options':
        add('low', `Nuevas opciones en "${op.module}.${op.field}"`, i);
        break;
      case 'upsert_view':
        add('low', `Vista "${op.view.label}"`, i);
        break;
      case 'remove_view':
        add('low', `Se elimina la vista "${op.view}"`, i);
        break;
      case 'upsert_automation': {
        const kinds = new Set(op.automation.actions.map((a) => a.type));
        // Versión normalizada (con valores por defecto) de la automatización en el blueprint resultante.
        const auto = after.automations.find((x) => x.key === op.automation.key) ?? op.automation;
        const flows = restrictedFlows(after, auto);
        if (kinds.has('send_webhook')) {
          dataEgress = true;
          add('high', `La automatización "${op.automation.name}" envía datos a un servicio externo`, i);
        } else if (kinds.has('run_script')) {
          add('high', `La automatización "${op.automation.name}" ejecuta código a medida sobre tus datos`, i);
        } else if (flows.length) {
          // Copiar datos de un módulo restringido hacia un público más amplio es una fuga: lo aprueba un propietario.
          add('high', `La automatización "${op.automation.name}" copia datos de un módulo restringido a ${flows.join(' y ')}`, i);
        } else if (feedsItself(after, auto)) {
          add('high', `La automatización "${op.automation.name}" crea registros que la vuelven a disparar (bucle)`, i);
        } else if (kinds.has('update_field') || kinds.has('create_record')) {
          add('medium', `La automatización "${op.automation.name}" modifica datos automáticamente`, i);
        } else add('low', `Automatización de avisos "${op.automation.name}"`, i);
        break;
      }
      case 'remove_automation':
        add('medium', `Se elimina la automatización "${op.automation}"`, i);
        break;
      case 'upsert_dashboard':
        add('low', `Panel "${op.dashboard.label}"`, i);
        break;
      case 'remove_dashboard':
        add('low', `Se elimina el panel "${op.dashboard}"`, i);
        break;
      case 'upsert_integration':
        dataEgress = true;
        add('high', `Integración externa "${op.integration.name}" (${safeHost(op.integration.url)})`, i);
        break;
      case 'remove_integration':
        add('medium', `Se elimina la integración "${op.integration}"`, i);
        break;
      case 'upsert_form':
        add(op.form.public ? 'high' : 'low', op.form.public ? `Formulario PÚBLICO "${op.form.name}" (acepta datos de Internet)` : `Formulario "${op.form.name}"`, i);
        break;
      case 'remove_form':
        add('low', `Se elimina el formulario "${op.form}"`, i);
        break;
      case 'upsert_script': {
        // Código a medida: aunque se ejecuta en un sandbox aislado y solo puede tocar datos de esta
        // organización, puede modificar registros automáticamente → lo aprueba un propietario. Desactivarlo
        // o ajustar su tiempo máximo sin tocar el código es de riesgo medio.
        const prev = (before.scripts ?? []).find((s) => s.key === op.script.key);
        const codeChanged = !prev || prev.code !== op.script.code;
        const enabling = op.script.enabled && (!prev || !prev.enabled);
        if (!prev) add('high', `Nuevo script con código a medida "${op.script.name}" (sandbox aislado)`, i);
        else if (codeChanged) add('high', `Se modifica el código del script "${op.script.name}"`, i);
        else if (enabling) add('high', `Se activa el script "${op.script.name}"`, i);
        else add('medium', op.script.enabled ? `Ajustes del script "${op.script.name}" (sin cambiar el código)` : `Se desactiva el script "${op.script.name}"`, i);
        break;
      }
      case 'remove_script':
        add('medium', `Se elimina el script "${op.script}"`, i);
        break;
      case 'backfill_field':
        if (!op.onlyEmpty) destructive = true;
        add(op.onlyEmpty ? 'medium' : 'high', op.onlyEmpty ? `Migración de datos: rellenar "${op.module}.${op.field}" donde esté vacío` : `Migración de datos: SOBRESCRIBIR "${op.module}.${op.field}"`, i);
        break;
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
    if (loosened.length) high(`Se amplían los permisos de "${m.labelPlural}" (${loosened.join(', ')})`);
  }
  for (const i of target.integrations) {
    const cur = current.integrations.find((x) => x.key === i.key);
    if (!i.enabled) continue;
    if (!cur || !cur.enabled || cur.url !== i.url || JSON.stringify(cur.includeFields ?? null) !== JSON.stringify(i.includeFields ?? null)) {
      dataEgress = true;
      high(`Se reactiva o cambia la integración externa "${i.name}" (${safeHost(i.url)})`);
    }
  }
  for (const f of target.forms) {
    const cur = current.forms.find((x) => x.key === f.key);
    if (f.public && !(cur?.public)) high(`El formulario "${f.name}" vuelve a ser PÚBLICO`);
  }
  for (const s of target.scripts ?? []) {
    const cur = (current.scripts ?? []).find((x) => x.key === s.key);
    if (s.enabled && (!cur || !cur.enabled || cur.code !== s.code)) high(`Se reactiva o cambia el código del script "${s.name}"`);
  }
  for (const a of target.automations) {
    if (!a.enabled) continue;
    const cur = current.automations.find((x) => x.key === a.key);
    const risky = a.actions.some((x) => x.type === 'send_webhook' || x.type === 'run_script');
    if (risky && (!cur || !cur.enabled || JSON.stringify(cur.actions) !== JSON.stringify(a.actions))) {
      if (a.actions.some((x) => x.type === 'send_webhook')) dataEgress = true;
      high(`Se reactiva la automatización "${a.name}" (envía datos fuera o ejecuta código)`);
    }
  }
  const level: RiskLevel = items.length ? 'high' : 'low';
  return { level, items, destructive: false, dataEgress, requiresOwner: level === 'high' };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'URL inválida';
  }
}
