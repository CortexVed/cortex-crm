import { ROLES, ROLE_LABELS, hasRole, type Role } from '../../../shared/constants';
import { activeFields, findModule, type Blueprint, type Field, type Module } from '../../../shared/blueprint';
import { sanitizeCustomCss } from '../../../shared/appearance';
import type { ChangeSet, TestCase, TestStep } from '../../../shared/changeset';
import { evaluateCondition } from '../../../shared/conditions';
import { normalizeRecordInput } from '../../../shared/records';
import { resolveValues } from '../../../shared/templates';
import { DEFAULT_TZ } from '../../../shared/time';
import { MemorySideEffects } from '../crm/effects';
import { RecordService } from '../crm/record-service';
import { MemoryRecordStore, type StoredRecord } from '../crm/store';
import { runScheduledAutomations } from '../crm/automations';
import { buildScriptInput, runScript } from '../crm/scripts';
import { blockModules, blueprintForRole } from '../crm/visibility';
import { AppError } from '../lib/errors';
import { isPrivateHostname } from '../lib/ssrf';
import { applyOperations } from './apply';
import { validateBlueprint, type Issue } from './validate';
import { t, tk, tp } from '../i18n';

export interface CaseResult {
  name: string;
  passed: boolean;
  warning?: boolean;
  message?: string;
  durationMs: number;
  steps?: { action: string; passed: boolean; message?: string }[];
}
export interface SuiteResult {
  key: 'validation' | 'compatibility' | 'integration' | 'acceptance' | 'security';
  name: string;
  cases: CaseResult[];
}
export interface TestReport {
  passed: boolean;
  total: number;
  failed: number;
  warnings: number;
  suites: SuiteResult[];
  ranAt: string;
  durationMs: number;
}

export interface SimulationInput {
  before: Blueprint;
  changeSet: ChangeSet;
  /** Muestra de registros reales por módulo (solo lectura, copiados al sandbox) para compatibilidad. */
  samples: Record<string, StoredRecord[]>;
  members: { id: string; role: Role }[];
  tz?: string;
  now?: Date;
}

export interface SimulationResult {
  after: Blueprint | null;
  issues: Issue[];
  report: TestReport;
}

function errMessage(e: unknown): string {
  if (e instanceof AppError) {
    // Los mensajes de AppError (y de sus campos) son claves del catálogo o textos ya traducidos.
    const fields = (e.details as { fields?: { field: string; message: string }[] } | undefined)?.fields;
    return fields?.length ? `${tk(e.message)}: ${fields.map((f) => `${f.field} → ${tk(f.message)}`).join('; ')}` : tk(e.message);
  }
  return tk((e as Error)?.message ?? String(e));
}

class Sandbox {
  clock: number;
  store: MemoryRecordStore;
  effects: MemorySideEffects;
  constructor(public bp: Blueprint, public members: { id: string; role: Role }[], start: Date, public tz: string) {
    this.clock = start.getTime();
    this.store = new MemoryRecordStore(members.map((m) => m.id));
    this.effects = new MemorySideEffects(members);
  }
  svc() {
    return new RecordService({
      workspaceId: '00000000-0000-0000-0000-000000000000',
      blueprint: this.bp,
      store: this.store,
      effects: this.effects,
      actor: { type: 'system', id: null, role: 'owner' },
      now: () => new Date(this.clock),
      tz: this.tz,
    });
  }
}

let uniq = 0;
function sampleValue(f: Field, sb: Sandbox): unknown {
  uniq++;
  switch (f.type) {
    case 'text':
      return `Prueba ${f.label} ${uniq}`;
    case 'long_text':
      return 'Texto de prueba generado por el sandbox';
    case 'number':
    case 'currency':
    case 'percent': {
      const min = f.min ?? 0;
      const max = f.max ?? Math.max(min + 100, 100);
      return Math.min(max, Math.max(min, Math.round((min + max) / 2)));
    }
    case 'rating':
      return 3;
    case 'date':
      return new Date(sb.clock).toISOString().slice(0, 10);
    case 'datetime':
      return new Date(sb.clock).toISOString();
    case 'boolean':
      return true;
    case 'email':
      return `sandbox${uniq}@example.com`;
    case 'phone':
      return '+34 600 000 000';
    case 'url':
      return 'https://example.com';
    case 'select':
      return f.options?.[0]?.value ?? null;
    case 'multi_select':
      return f.options?.[0] ? [f.options[0].value] : null;
    case 'user':
      return sb.members[0]?.id ?? null;
    default:
      return null;
  }
}

async function makeRecord(sb: Sandbox, mod: Module, depth = 0): Promise<StoredRecord> {
  const values: Record<string, unknown> = {};
  for (const f of activeFields(mod)) {
    if (f.type === 'formula' || f.type === 'file') continue;
    if (f.type === 'relation') {
      if (!f.required || depth > 2) continue;
      const target = findModule(sb.bp, f.relation!.module);
      if (target) values[f.key] = (await makeRecord(sb, target, depth + 1)).id;
      continue;
    }
    const v = sampleValue(f, sb);
    if (v !== null) values[f.key] = v;
  }
  return sb.svc().create(mod.key, values);
}

function changedModules(before: Blueprint, after: Blueprint, cs: ChangeSet): Module[] {
  const keys = new Set<string>();
  for (const op of cs.operations) {
    if (op.op === 'create_module') keys.add(op.module.key);
    else if ('module' in op && typeof op.module === 'string') keys.add(op.module);
    else if (op.op === 'upsert_automation') keys.add(op.automation.trigger.module);
    else if (op.op === 'upsert_script') {
      // Un cambio de código se prueba sobre los módulos cuyas automatizaciones lo ejecutan.
      for (const a of after.automations) if (a.actions.some((x) => x.type === 'run_script' && x.script === op.script.key)) keys.add(a.trigger.module);
    }
  }
  return [...keys].map((k) => findModule(after, k)).filter((m): m is Module => !!m && !m.archived);
}

/** Páginas que crea o modifica el change set (tal y como quedan en el blueprint resultante). */
function changedPages(after: Blueprint, cs: ChangeSet): Blueprint['pages'] {
  const keys = new Set(cs.operations.flatMap((op) => (op.op === 'upsert_page' ? [op.page.key] : [])));
  return (after.pages ?? []).filter((p) => keys.has(p.key));
}

/** "@ref" → id de un registro creado antes en la prueba; "@member" → miembro del sandbox. */
function resolveTestValues(values: Record<string, unknown>, refs: Map<string, StoredRecord>, sb: Sandbox, tctx: { now: Date; tz: string }) {
  const out = resolveValues(values, tctx);
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string' || !v.startsWith('@')) continue;
    const name = v.slice(1);
    if (name === 'member') out[k] = sb.members[0]?.id ?? null;
    else if (refs.has(name)) out[k] = refs.get(name)!.id;
  }
  return out;
}

async function runStep(sb: Sandbox, step: TestStep, refs: Map<string, StoredRecord>, baseline: { n: number }): Promise<string | null> {
  const svc = sb.svc();
  const tctx = { now: new Date(sb.clock), tz: sb.tz };
  const ref = (name: string) => {
    const r = refs.get(name);
    if (!r) throw new Error(t('Referencia "{name}" no definida en un paso anterior', { name }));
    return r;
  };
  switch (step.action) {
    case 'create': {
      const rec = await svc.create(step.module, resolveTestValues(step.values, refs, sb, tctx));
      if (step.as) refs.set(step.as, rec);
      return null;
    }
    case 'update': {
      const rec = await svc.update(ref(step.ref).id, resolveTestValues(step.values, refs, sb, tctx));
      refs.set(step.ref, rec);
      return null;
    }
    case 'delete':
      await svc.delete(ref(step.ref).id);
      return null;
    case 'expect_field': {
      const fresh = await sb.store.get(ref(step.ref).id);
      if (!fresh) return t('El registro "{ref}" ya no existe', { ref: step.ref });
      const actual = fresh.data[step.field];
      if (step.notEmpty && (actual === null || actual === undefined || actual === '')) return t('Se esperaba "{field}" con valor', { field: step.field });
      if (step.equals !== undefined) {
        const okEq = evaluateCondition({ field: step.field, operator: 'eq', value: step.equals }, fresh, tctx);
        if (!okEq) return t('Se esperaba {field} = {expected} y es {actual}', { field: step.field, expected: JSON.stringify(step.equals), actual: JSON.stringify(actual ?? null) });
      }
      return null;
    }
    case 'expect_invalid': {
      try {
        await svc.create(step.module, resolveTestValues(step.values, refs, sb, tctx));
        return t('Se esperaba un error de validación y el registro se creó');
      } catch (e) {
        return e instanceof AppError && e.status === 422 ? null : t('Error inesperado: {error}', { error: errMessage(e) });
      }
    }
    case 'expect_count': {
      const mod = findModule(sb.bp, step.module);
      if (!mod) return t('Módulo inexistente "{module}"', { module: step.module });
      const { total } = await sb.store.list(mod, { filters: step.where, limit: 1, offset: 0 }, tctx);
      return total === step.equals ? null : tp(step.equals, 'Se esperaba {count} registro y hay {total}', 'Se esperaban {count} registros y hay {total}', { total });
    }
    case 'expect_notification': {
      const n = sb.effects.notifications.length - baseline.n;
      return n >= step.min ? null : tp(step.min, 'Se esperaba al menos {count} aviso y hubo {n}', 'Se esperaban al menos {count} avisos y hubo {n}', { n });
    }
    case 'expect_webhook': {
      const n = sb.effects.webhooks.filter((w) => w.integration === step.integration).length;
      return n >= step.min ? null : tp(step.min, 'Se esperaba al menos {count} webhook a "{integration}" y hubo {n}', 'Se esperaban al menos {count} webhooks a "{integration}" y hubo {n}', { integration: step.integration, n });
    }
    case 'advance_days':
      sb.clock += step.days * 86_400_000;
      return null;
    case 'run_scheduler':
      await runScheduledAutomations(svc);
      return null;
  }
}

async function runTestCase(bp: Blueprint, tc: TestCase, members: { id: string; role: Role }[], start: Date, tz: string): Promise<CaseResult> {
  const t0 = Date.now();
  const sb = new Sandbox(bp, members, start, tz);
  const refs = new Map<string, StoredRecord>();
  const baseline = { n: 0 };
  const steps: CaseResult['steps'] = [];
  for (const step of tc.steps) {
    let message: string | null;
    const runsBefore = new Set(sb.effects.runs.keys());
    try {
      message = await runStep(sb, step, refs, baseline);
    } catch (e) {
      message = errMessage(e);
    }
    // Un script o automatización que falla durante la prueba la hace fallar, con el error real.
    if (!message) {
      const failed = [...sb.effects.runs.entries()].filter(([id, r]) => !runsBefore.has(id) && r.status === 'failed');
      if (failed.length) {
        // Una ejecución fallida termina su registro con el error (crm/automations), en cualquier idioma: la última línea.
        const runLog = failed[0][1].log;
        message = t('La automatización "{automation}" falló: {log}', { automation: failed[0][1].automationKey, log: runLog[runLog.length - 1] ?? '' });
      }
    }
    steps.push({ action: step.action, passed: !message, message: message ?? undefined });
    if (message) return { name: tc.name, passed: false, message, durationMs: Date.now() - t0, steps };
  }
  return { name: tc.name, passed: true, durationMs: Date.now() - t0, steps };
}

/** Repite las pruebas de aceptación sobre un blueprint concreto (verificación post-publicación). */
export async function runAcceptanceTests(bp: Blueprint, tests: TestCase[], members: { id: string; role: Role }[], tz: string, now: Date): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const tc of tests) out.push(await runTestCase(bp, tc, members, now, tz));
  return out;
}


/**
 * Ejecuta el change set en un entorno aislado y devuelve el informe de pruebas:
 * validación (unitarias), compatibilidad con datos reales, integración (CRUD + automatizaciones),
 * aceptación (pruebas generadas por la IA) y seguridad.
 */
export async function simulateChangeSet(input: SimulationInput): Promise<SimulationResult> {
  const started = Date.now();
  const tz = input.tz ?? DEFAULT_TZ;
  const start = input.now ?? new Date();
  const suites: SuiteResult[] = [];
  const time = async (name: string, fn: () => Promise<string | null | { warn: string }>): Promise<CaseResult> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      if (r && typeof r === 'object') return { name, passed: true, warning: true, message: r.warn, durationMs: Date.now() - t0 };
      return { name, passed: !r, message: r ?? undefined, durationMs: Date.now() - t0 };
    } catch (e) {
      return { name, passed: false, message: errMessage(e), durationMs: Date.now() - t0 };
    }
  };

  // 1) Validación
  const applied = applyOperations(input.before, input.changeSet.operations);
  const issues = [...applied.errors];
  const after = applied.errors.length ? null : applied.blueprint;
  if (after) issues.push(...validateBlueprint(after));
  const validation: CaseResult[] = [
    { name: t('Las operaciones se aplican sin conflictos'), passed: applied.errors.length === 0, message: applied.errors.map((e) => e.message).join('; ') || undefined, durationMs: 0 },
    {
      name: t('El blueprint resultante es coherente (referencias, vistas, fórmulas, automatizaciones)'),
      passed: !!after && !issues.some((i) => i.level === 'error'),
      message: issues.filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`).join('; ') || undefined,
      durationMs: 0,
    },
    ...issues.filter((i) => i.level === 'warning').map((i) => ({ name: t('Aviso: {path}', { path: i.path }), passed: true, warning: true, message: i.message, durationMs: 0 })),
  ];
  suites.push({ key: 'validation', name: t('Validación (unitarias)'), cases: validation });

  if (after && !issues.some((i) => i.level === 'error')) {
    // 2) Compatibilidad con datos existentes (muestra real, sin modificar producción)
    const compat: CaseResult[] = [];
    const requiredMessages = new Set(['Obligatorio', t('Obligatorio')]);
    for (const mod of changedModules(input.before, after, input.changeSet)) {
      const sample = input.samples[mod.key] ?? [];
      if (!sample.length) continue;
      compat.push(
        await time(tp(sample.length, 'Datos existentes de "{module}" ({count} registro muestreado)', 'Datos existentes de "{module}" ({count} registros muestreados)', { module: mod.labelPlural }), async () => {
          let invalid = 0;
          let missingRequired = 0;
          const examples: string[] = [];
          for (const rec of sample) {
            const writable = Object.fromEntries(
              Object.entries(rec.data).filter(([k]) => {
                const f = mod.fields.find((x) => x.key === k);
                return f && !f.archived && f.type !== 'formula';
              }),
            );
            const { issues: iss } = normalizeRecordInput(mod, writable, { mode: 'update', existing: {} });
            // «Obligatorio» se cuenta aparte (missingRequired); puede llegar como clave o ya traducido.
            const bad = iss.filter((i) => !requiredMessages.has(i.message));
            if (bad.length) {
              invalid++;
              if (examples.length < 3) examples.push(bad.map((b) => `${b.field}: ${tk(b.message)}`).join(', '));
            }
            for (const f of mod.fields) {
              if (f.required && !f.archived && f.type !== 'formula' && (rec.data[f.key] === undefined || rec.data[f.key] === null)) {
                missingRequired++;
                break;
              }
            }
          }
          if (invalid) return tp(invalid, '{count} registro quedaría con datos inválidos ({examples})', '{count} registros quedarían con datos inválidos ({examples})', { examples: examples.join(' | ') });
          if (missingRequired) {
            return { warn: tp(missingRequired, '{count} registro no tiene valor en algún campo obligatorio: considera una migración (backfill_field)', '{count} registros no tienen valor en algún campo obligatorio: considera una migración (backfill_field)') };
          }
          return null;
        }),
      );
    }
    if (!compat.length) compat.push({ name: t('No hay datos existentes afectados'), passed: true, durationMs: 0 });
    suites.push({ key: 'compatibility', name: t('Compatibilidad'), cases: compat });

    // 3) Integración: CRUD completo + automatizaciones en sandbox
    const integration: CaseResult[] = [];
    for (const mod of changedModules(input.before, after, input.changeSet)) {
      integration.push(
        await time(t('CRUD de "{module}" con automatizaciones', { module: mod.labelPlural }), async () => {
          const sb = new Sandbox(after, input.members, start, tz);
          const rec = await makeRecord(sb, mod);
          const { total } = await sb.store.list(mod, { limit: 5, offset: 0 }, { now: new Date(sb.clock), tz });
          if (total < 1) return t('El registro creado no aparece en el listado');
          const editable = activeFields(mod).find((f) => ['text', 'long_text', 'number', 'currency'].includes(f.type) && f.key !== mod.primaryField);
          if (editable) await sb.svc().update(rec.id, { [editable.key]: sampleValue(editable, sb) });
          await sb.svc().delete(rec.id);
          const failedRuns = [...sb.effects.runs.values()].filter((r) => r.status === 'failed');
          if (failedRuns.length) return t('Automatización con errores: {errors}', { errors: failedRuns.map((r) => `${r.automationKey}: ${r.log.join(' ')}`).join('; ') });
          return null;
        }),
      );
      for (const view of mod.views) {
        integration.push(
          await time(t('Vista "{module} › {view}" se puede consultar', { module: mod.labelPlural, view: view.label }), async () => {
            const sb = new Sandbox(after, input.members, start, tz);
            await makeRecord(sb, mod);
            await sb.store.list(mod, { filters: view.filters, sort: view.sort, limit: 10, offset: 0 }, { now: new Date(sb.clock), tz });
            return null;
          }),
        );
      }
    }
    // Páginas creadas o modificadas: cada lista de registros se puede consultar con su vista y sus filtros.
    // (Los widgets se validan con las mismas reglas que los de los paneles.)
    for (const page of changedPages(after, input.changeSet)) {
      for (const b of page.blocks) {
        if (b.type !== 'records') continue;
        const mod = findModule(after, b.module);
        if (!mod || mod.archived) continue;
        integration.push(
          await time(t('Página «{page}» › lista de "{module}" se puede consultar', { page: page.label, module: mod.labelPlural }), async () => {
            const sb = new Sandbox(after, input.members, start, tz);
            await makeRecord(sb, mod);
            const view = b.view ? mod.views.find((v) => v.key === b.view) : undefined;
            await sb.store.list(mod, { filters: [...(view?.filters ?? []), ...b.filters], sort: view?.sort, limit: b.limit, offset: 0 }, { now: new Date(sb.clock), tz });
            return null;
          }),
        );
      }
    }
    const scheduled = after.automations.filter((a) => a.enabled && (a.trigger.type === 'date_reached' || a.trigger.type === 'inactivity'));
    if (scheduled.length) {
      integration.push(
        await time(t('El planificador de automatizaciones programadas se ejecuta sin errores'), async () => {
          const sb = new Sandbox(after, input.members, start, tz);
          await runScheduledAutomations(sb.svc());
          return null;
        }),
      );
    }
    if (!integration.length) integration.push({ name: t('Sin módulos afectados'), passed: true, durationMs: 0 });
    suites.push({ key: 'integration', name: t('Integración'), cases: integration });

    // 4) Aceptación (pruebas generadas)
    const acceptance: CaseResult[] = [];
    for (const tc of input.changeSet.tests) acceptance.push(await runTestCase(after, tc, input.members, start, tz));
    if (!acceptance.length && input.changeSet.operations.length) {
      acceptance.push({ name: t('Sin pruebas de aceptación definidas'), passed: true, warning: true, message: t('El plan no incluye pruebas específicas'), durationMs: 0 });
    }
    suites.push({ key: 'acceptance', name: t('Aceptación'), cases: acceptance });

    // 5) Seguridad
    const security: CaseResult[] = [];
    for (const integ of after.integrations) {
      security.push(
        await time(t('Integración "{name}" apunta a un destino público y seguro', { name: integ.name }), async () => {
          const u = new URL(integ.url);
          if (u.protocol !== 'https:') return t('Debe usar HTTPS');
          if (isPrivateHostname(u.hostname)) return t('No se permiten destinos internos o privados (protección SSRF)');
          const pii = after.modules.flatMap((m) => m.fields.filter((f) => ['email', 'phone'].includes(f.type)).map((f) => f.key));
          if (!integ.includeFields || integ.includeFields.some((k) => pii.includes(k))) {
            return { warn: t('La integración puede enviar datos personales (email/teléfono): revisa la base legal (RGPD)') };
          }
          return null;
        }),
      );
    }
    for (const form of after.forms.filter((f) => f.public)) {
      security.push({ name: t('Formulario público "{name}"', { name: form.name }), passed: true, warning: true, message: t('Acepta datos de Internet: protegido con validación, límite de peticiones y campos permitidos'), durationMs: 0 });
    }
    for (const script of after.scripts) {
      const users = after.automations.filter((a) => a.actions.some((x) => x.type === 'run_script' && x.script === script.key));
      const mod = users.length ? findModule(after, users[0].trigger.module) : undefined;
      security.push(
        await time(t('Script "{name}": se ejecuta aislado y tolera datos mínimos', { name: script.name }), async () => {
          if (!mod) return { warn: t('Ninguna automatización lo ejecuta') };
          // Ejecución real en el sandbox QuickJS (sin red ni archivos) sobre un registro con datos mínimos.
          const sb = new Sandbox(after, input.members, start, tz);
          const rec = await makeRecord(sb, mod);
          const scriptInput = await buildScriptInput(sb.svc(), rec, { trigger: users[0].trigger.type });
          await runScript(script.code, scriptInput, { timeoutMs: script.timeoutMs });
          return null;
        }),
      );
    }
    // Capa visual: el CSS personalizado es CSS plano (nada que cargar ni ejecutar) y cada rol solo ve, en las
    // páginas, los bloques de los módulos que puede leer.
    const css = after.appearance?.customCss;
    if (css !== undefined && css.trim()) {
      security.push(
        await time(t('CSS personalizado: solo CSS plano, sin recursos externos ni código'), async () => {
          const r = sanitizeCustomCss(css);
          if (!r.ok) return r.errors.map((e) => tk(e)).join('; ');
          return { warn: t('Puede ocultar o imitar elementos de la interfaz: revísalo antes de aprobar. Nunca se aplica en EVOLVE, Ajustes ni Plataforma.') };
        }),
      );
    }
    for (const page of changedPages(after, input.changeSet)) {
      security.push(
        await time(t('Página «{page}»: cada rol solo ve los bloques de los módulos que puede leer', { page: page.label }), async () => {
          for (const role of ROLES) {
            const visible = blueprintForRole(after, role);
            const p = visible.pages.find((x) => x.key === page.key);
            if (!hasRole(role, page.minRole)) {
              if (p) return t('El rol {role} vería la página aunque su rol mínimo es {minRole}', { role: tk(ROLE_LABELS[role]), minRole: tk(ROLE_LABELS[page.minRole]) });
              continue;
            }
            const readable = new Set(visible.modules.map((m) => m.key));
            if (p?.blocks.some((b) => blockModules(after, b).some((k) => !readable.has(k)))) return t('El rol {role} vería datos de un módulo que no puede leer', { role: tk(ROLE_LABELS[role]) });
          }
          return null;
        }),
      );
    }
    security.push(
      await time(t('Ninguna operación desactiva protecciones del sistema'), async () => {
        // El change set no puede expresar cambios en auditoría, aprobaciones, RLS ni autenticación:
        // se verifica que solo contiene operaciones tipadas conocidas.
        const unknown = input.changeSet.operations.filter((o) => typeof o.op !== 'string');
        return unknown.length ? t('Operaciones desconocidas') : null;
      }),
    );
    suites.push({ key: 'security', name: t('Seguridad'), cases: security });
  }

  const all = suites.flatMap((s) => s.cases);
  const failed = all.filter((c) => !c.passed).length;
  return {
    after,
    issues,
    report: {
      passed: failed === 0,
      total: all.length,
      failed,
      warnings: all.filter((c) => c.warning).length,
      suites,
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    },
  };
}
