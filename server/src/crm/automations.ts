import type { z } from 'zod';
import { ROLE_RANK } from '../../../shared/constants';
import type { Automation, Blueprint, Module, NotifyTargetSchema } from '../../../shared/blueprint';
import { buildScriptInput, runScript } from './scripts';
import { evaluateConditions } from '../../../shared/conditions';
import { resolveTemplate, resolveValues } from '../../../shared/templates';
import { addDays, localDate } from '../../../shared/time';
import { recordTitle } from '../../../shared/records';
import type { RecordService } from './record-service';
import { AUTOMATION_BUDGET, type AutomationBudget } from './budget';
import type { StoredRecord } from './store';
import { t, tp } from '../i18n';

export const MAX_AUTOMATION_DEPTH = 3;

class BudgetExceeded extends Error {}

/** Descuenta del presupuesto de la cascada; al agotarse se detiene la automatización con un error claro. */
function spend(b: AutomationBudget, kind: keyof AutomationBudget, n = 1) {
  if (b[kind] + n > AUTOMATION_BUDGET[kind]) {
    const max = AUTOMATION_BUDGET[kind];
    const reason =
      kind === 'actions'
        ? t('Límite de la cascada de automatizaciones alcanzado ({max} acciones por evento): se detiene para evitar bucles', { max })
        : kind === 'created'
          ? t('Límite de la cascada de automatizaciones alcanzado ({max} registros creados por evento): se detiene para evitar bucles', { max })
          : t('Límite de la cascada de automatizaciones alcanzado ({max} ms de scripts por evento): se detiene para evitar bucles', { max });
    throw new BudgetExceeded(reason);
  }
  b[kind] += n;
}

/**
 * Datos de contexto que recibe un script: solo de módulos cuya lectura NO es más restringida que la del
 * módulo que dispara. Así lo que el script escriba en el registro (visible para quien lee ese módulo) no
 * puede sacar datos de módulos a los que esas personas no tienen acceso.
 */
function scopeScriptInput<T extends { related: Record<string, unknown[]>; refs: Record<string, { module: string }> }>(bp: Blueprint, moduleKey: string, input: T): T {
  const src = bp.modules.find((m) => m.key === moduleKey);
  if (!src) return { ...input, related: {}, refs: {} };
  const allowed = (key: string) => {
    const m = bp.modules.find((x) => x.key === key);
    return !!m && ROLE_RANK[m.permissions.read] <= ROLE_RANK[src.permissions.read];
  };
  return {
    ...input,
    related: Object.fromEntries(Object.entries(input.related).filter(([k]) => allowed(k))),
    refs: Object.fromEntries(Object.entries(input.refs).filter(([, v]) => allowed(v.module))),
  };
}

export interface RecordEvent {
  type: 'record_created' | 'record_updated' | 'record_deleted';
  module: Module;
  record: StoredRecord;
  previous?: Record<string, unknown>;
  changed: string[];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.includes(b as never);
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

function matches(a: Automation, ev: RecordEvent): boolean {
  if (!a.enabled || a.trigger.module !== ev.module.key) return false;
  const trg = a.trigger;
  switch (trg.type) {
    case 'record_created':
    case 'record_updated':
    case 'record_deleted':
      return trg.type === ev.type;
    case 'field_changed': {
      if (ev.type === 'record_deleted') return false;
      if (!ev.changed.includes(trg.field)) return false;
      const v = ev.record.data[trg.field];
      if (ev.type === 'record_created' && (v === null || v === undefined)) return false;
      return trg.to === undefined || sameValue(v, trg.to);
    }
    default:
      return false; // date_reached / inactivity: los evalúa el planificador
  }
}

async function notifyTarget(svc: RecordService, rec: StoredRecord, to: z.infer<typeof NotifyTargetSchema>, title: string, body?: string): Promise<number> {
  const { effects, blueprint } = svc.ctx;
  const link = `/m/${rec.moduleKey}/${rec.id}`;
  // El aviso puede llevar datos del registro ({{record.campo}}): solo lo recibe quien puede leer su módulo.
  const readRole = blueprint.modules.find((m) => m.key === rec.moduleKey)?.permissions.read ?? 'owner';
  if (to.type === 'user_field') {
    const uid = rec.data[to.field];
    return typeof uid === 'string' ? effects.notify({ userIds: [uid], title, body, link, readRole }) : 0;
  }
  if (to.type === 'role') return effects.notify({ minRole: to.role, title, body, link, readRole });
  return effects.notify({ all: true, title, body, link, readRole });
}

/** Ejecuta las acciones de una automatización sobre un registro. */
export async function executeAutomation(
  svc: RecordService,
  a: Automation,
  rec: StoredRecord,
  trigger: string,
  opts: { previous?: Record<string, unknown>; dedupeKey?: string } = {},
): Promise<'success' | 'failed' | 'skipped' | 'duplicate'> {
  const { effects, now, tz, blueprint } = svc.ctx;
  const depth = svc.ctx.depth ?? 0;
  const runId = await effects.startRun({ automationKey: a.key, recordId: rec.id, trigger, dedupeKey: opts.dedupeKey });
  if (!runId) return 'duplicate';
  const log: string[] = [];
  if (depth >= MAX_AUTOMATION_DEPTH) {
    log.push(t('Omitida: profundidad máxima ({max}) alcanzada para evitar bucles', { max: MAX_AUTOMATION_DEPTH }));
    await effects.finishRun(runId, 'skipped', log);
    return 'skipped';
  }
  const tctx = { now: now(), tz, record: { id: rec.id, data: rec.data } };
  const mod = blueprint.modules.find((m) => m.key === rec.moduleKey)!;
  const child = svc.child({ type: 'automation', id: null });
  const budget = child.ctx.budget!;
  try {
    for (const action of a.actions) {
      spend(budget, 'actions');
      switch (action.type) {
        case 'update_field': {
          const value = resolveTemplate(action.value, tctx);
          await child.update(rec.id, { [action.field]: value });
          log.push(t('Campo "{field}" actualizado', { field: action.field }));
          break;
        }
        case 'create_record': {
          const values = resolveValues(action.values, tctx);
          if (action.linkField) values[action.linkField] = rec.id;
          spend(budget, 'created');
          const created = await child.create(action.module, values);
          log.push(t('Registro creado en "{module}" ({id})', { module: action.module, id: created.id }));
          break;
        }
        case 'send_webhook': {
          const integration = blueprint.integrations.find((i) => i.key === action.integration && i.enabled);
          if (!integration) {
            log.push(t('Integración "{key}" no disponible', { key: action.integration }));
            break;
          }
          const data = integration.includeFields
            ? Object.fromEntries(Object.entries(rec.data).filter(([k]) => integration.includeFields!.includes(k)))
            : rec.data;
          await effects.webhook(integration, {
            event: trigger,
            automation: a.key,
            module: rec.moduleKey,
            record: { id: rec.id, title: recordTitle(mod, rec.data), data },
            occurredAt: now().toISOString(),
          });
          log.push(t('Webhook "{key}" encolado', { key: integration.key }));
          break;
        }
        case 'notify': {
          const title = String(resolveTemplate(action.title, tctx)).slice(0, 140);
          const body = action.body ? String(resolveTemplate(action.body, tctx)) : undefined;
          const n = await notifyTarget(svc, rec, action.to, title, body);
          log.push(tp(n, 'Aviso enviado a {count} persona', 'Aviso enviado a {count} personas'));
          break;
        }
        case 'run_script': {
          const script = blueprint.scripts.find((s) => s.key === action.script);
          if (!script || !script.enabled) {
            log.push(t('Script "{key}" no disponible', { key: action.script }));
            break;
          }
          // Datos actuales (otras acciones previas pueden haber cambiado el registro).
          const current = (await svc.ctx.store.get(rec.id)) ?? rec;
          const input = scopeScriptInput(blueprint, current.moduleKey, await buildScriptInput(svc, current, { trigger, previous: opts.previous }));
          const remaining = AUTOMATION_BUDGET.scriptMs - budget.scriptMs;
          if (remaining < 50) spend(budget, 'scriptMs', remaining + 1);
          const { output, logs, ms } = await runScript(script.code, input, { timeoutMs: Math.min(script.timeoutMs, remaining) });
          budget.scriptMs += Math.max(1, Math.ceil(ms));
          log.push(t('Script "{key}" ejecutado en {ms} ms', { key: script.key, ms }));
          for (const line of [...logs, ...(output.log ?? [])]) log.push(`[script] ${line}`);
          if (output.update && Object.keys(output.update).length) {
            spend(budget, 'actions');
            await child.update(rec.id, output.update);
            log.push(tp(Object.keys(output.update).length, 'Script: {count} campo actualizado', 'Script: {count} campos actualizados'));
          }
          for (const c of output.create ?? []) {
            spend(budget, 'actions');
            spend(budget, 'created');
            const created = await child.create(c.module, c.values);
            log.push(t('Script: registro creado en "{module}" ({id})', { module: c.module, id: created.id }));
          }
          for (const n of output.notify ?? []) {
            spend(budget, 'actions');
            const sent = await notifyTarget(svc, current, n.to, n.title, n.body);
            log.push(tp(sent, 'Script: aviso enviado a {count} persona', 'Script: aviso enviado a {count} personas'));
          }
          break;
        }
      }
    }
    await effects.finishRun(runId, 'success', log);
    return 'success';
  } catch (e) {
    log.push(t('Error: {message}', { message: (e as Error).message }));
    await effects.finishRun(runId, 'failed', log);
    return 'failed';
  }
}

/** Despacha eventos de registro a las automatizaciones que coinciden (en el mismo contexto). */
export async function dispatchRecordEvent(svc: RecordService, ev: RecordEvent) {
  const { blueprint, now, tz } = svc.ctx;
  // Todas las automatizaciones de este evento (y lo que desencadenen) comparten un presupuesto.
  const root = svc.withAutomationBudget();
  for (const a of blueprint.automations) {
    if (!matches(a, ev)) continue;
    if (a.conditions.length && !evaluateConditions(a.conditions, ev.record, { now: now(), tz, previous: ev.previous })) continue;
    await executeAutomation(root, a, ev.record, ev.type, { previous: ev.previous });
  }
}

/**
 * Automatizaciones programadas (las ejecuta el worker periódicamente y el sandbox con
 * run_scheduler): "date_reached" (p. ej. 30 días antes del vencimiento) e "inactivity"
 * (p. ej. cliente importante sin actividad en 15 días). Deduplicadas por registro y periodo.
 */
export async function runScheduledAutomations(svc: RecordService, maxPerAutomation = 100): Promise<{ fired: number; checked: number }> {
  const { blueprint, store, now, tz } = svc.ctx;
  let fired = 0;
  let checked = 0;
  const current = now();
  for (const a of blueprint.automations) {
    if (!a.enabled) continue;
    const mod = blueprint.modules.find((m) => m.key === a.trigger.module && !m.archived);
    if (!mod) continue;
    const trg = a.trigger;
    if (trg.type === 'date_reached') {
      const field = mod.fields.find((f) => f.key === trg.field);
      if (!field) continue;
      // Ventana de 3 días para no disparar avisos de fechas muy antiguas al crear la regla.
      const upper = field.type === 'date' ? localDate(addDays(current, -trg.offsetDays), tz) : addDays(current, -trg.offsetDays).toISOString();
      const lower = field.type === 'date' ? localDate(addDays(current, -trg.offsetDays - 3), tz) : addDays(current, -trg.offsetDays - 3).toISOString();
      const { items } = await store.list(mod, {
        filters: [
          { field: trg.field, operator: 'lte', value: upper },
          { field: trg.field, operator: 'gte', value: lower },
          ...a.conditions,
        ],
        limit: maxPerAutomation,
        offset: 0,
      }, { now: current, tz });
      for (const rec of items) {
        checked++;
        const r = await executeAutomation(svc, a, rec, 'date_reached', { dedupeKey: `${a.key}:${rec.id}:${String(rec.data[trg.field])}` });
        if (r === 'success') fired++;
      }
    } else if (trg.type === 'inactivity') {
      const threshold = addDays(current, -trg.days).toISOString();
      const { items } = await store.list(mod, {
        filters: [{ field: 'last_activity_at', operator: 'lt', value: threshold }, ...a.conditions],
        limit: maxPerAutomation,
        offset: 0,
        sort: { field: 'last_activity_at', direction: 'asc' },
      }, { now: current, tz });
      for (const rec of items) {
        checked++;
        const r = await executeAutomation(svc, a, rec, 'inactivity', { dedupeKey: `${a.key}:${rec.id}:${rec.lastActivityAt}` });
        if (r === 'success') fired++;
      }
    }
  }
  return { fired, checked };
}
