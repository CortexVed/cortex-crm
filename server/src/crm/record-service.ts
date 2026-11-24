import { hasRole, type Role } from '../../../shared/constants';
import { activeModules, findModule, type Blueprint, type Module } from '../../../shared/blueprint';
import { collectRelatedCalls, computeFormula, parseFormula, relatedKey, type FNode } from '../../../shared/formula';
import { normalizeRecordInput } from '../../../shared/records';
import { forbidden, notFound, unprocessable } from '../lib/errors';
import { newId } from '../lib/crypto';
import type { SideEffects } from './effects';
import type { RecordStore, StoredRecord } from './store';
import { dispatchRecordEvent } from './automations';
import { newAutomationBudget, type AutomationBudget } from './budget';

export interface Actor {
  type: 'user' | 'api' | 'automation' | 'system' | 'ai';
  id: string | null;
  role?: Role;
}

export interface ServiceContext {
  workspaceId: string;
  blueprint: Blueprint;
  store: RecordStore;
  effects: SideEffects;
  actor: Actor;
  now: () => Date;
  tz: string;
  depth?: number;
  /** Desactiva la comprobación de permisos (automatizaciones y sistema). */
  trusted?: boolean;
  /** Presupuesto de la cascada de automatizaciones en curso (se hereda en los servicios hijos). */
  budget?: AutomationBudget;
}

const astCache = new Map<string, FNode>();
function ast(expr: string): FNode {
  let n = astCache.get(expr);
  if (!n) {
    n = parseFormula(expr);
    if (astCache.size > 2000) astCache.clear();
    astCache.set(expr, n);
  }
  return n;
}

export function diffData(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k] ?? null;
    const b = after[k] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}

/**
 * Lógica de negocio de registros. Es IDÉNTICA en producción y en el sandbox: solo cambian
 * el almacén (Postgres/memoria) y los efectos secundarios (persistidos/capturados).
 */
export class RecordService {
  constructor(readonly ctx: ServiceContext) {}

  child(actor: Actor): RecordService {
    return new RecordService({ ...this.ctx, actor, depth: (this.ctx.depth ?? 0) + 1, trusted: true, budget: this.ctx.budget ?? newAutomationBudget() });
  }

  /** El mismo servicio con un presupuesto de automatizaciones propio si aún no lo tiene (evento original). */
  withAutomationBudget(): RecordService {
    return this.ctx.budget ? this : new RecordService({ ...this.ctx, budget: newAutomationBudget() });
  }

  module(key: string): Module {
    const mod = findModule(this.ctx.blueprint, key);
    if (!mod || mod.archived) throw notFound(`Módulo "${key}" no encontrado`);
    return mod;
  }

  private can(mod: Module, action: 'read' | 'create' | 'update' | 'delete') {
    if (this.ctx.trusted || this.ctx.actor.type === 'system' || this.ctx.actor.type === 'automation') return;
    if (!hasRole(this.ctx.actor.role, mod.permissions[action])) {
      throw forbidden(`Tu rol no permite ${{ read: 'ver', create: 'crear', update: 'editar', delete: 'eliminar' }[action]} ${mod.labelPlural.toLowerCase()}`);
    }
  }

  assertCanRead(mod: Module) {
    this.can(mod, 'read');
  }

  private get untrustedActor(): boolean {
    return !this.ctx.trusted && (this.ctx.actor.type === 'user' || this.ctx.actor.type === 'api');
  }

  private async checkReferences(mod: Module, data: Record<string, unknown>, excludeId?: string) {
    const issues: { field: string; message: string }[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) continue;
      const f = mod.fields.find((x) => x.key === key)!;
      if (f.type === 'relation' && f.relation) {
        // Sin permiso de lectura sobre el módulo destino, la relación se trata como inexistente
        // (ni se enlaza a registros restringidos ni se revela si existen).
        const target = findModule(this.ctx.blueprint, f.relation.module);
        const canReadTarget = !this.untrustedActor || (!!target && hasRole(this.ctx.actor.role, target.permissions.read));
        if (!canReadTarget || !(await this.ctx.store.existsInModule(f.relation.module, value as string))) issues.push({ field: key, message: 'El registro relacionado no existe' });
      } else if (f.type === 'user') {
        if (!(await this.ctx.store.isMember(value as string))) issues.push({ field: key, message: 'El usuario no pertenece a la organización' });
      } else if (f.type === 'file') {
        const actorId = this.ctx.actor.type === 'user' ? this.ctx.actor.id : null;
        if (!(await this.ctx.store.filesExist(value as string[], { recordId: excludeId, actorId }))) issues.push({ field: key, message: 'Algún archivo no existe o pertenece a otro registro' });
      }
      if (f.unique && !(await this.ctx.store.isUnique(mod.key, key, value, excludeId))) {
        issues.push({ field: key, message: 'Ya existe un registro con este valor' });
      }
    }
    if (issues.length) throw unprocessable('Datos no válidos', { fields: issues });
  }

  /** Calcula los campos de fórmula (incluidos agregados de registros relacionados). */
  async computeFormulas(mod: Module, rec: { id: string; data: Record<string, unknown>; createdAt?: string; updatedAt?: string; lastActivityAt?: string }) {
    const formulas = mod.fields.filter((f) => f.type === 'formula' && !f.archived && f.formula);
    if (!formulas.length) return rec.data;
    const related = new Map<string, number>();
    for (const f of formulas) {
      for (const c of collectRelatedCalls(ast(f.formula!.expression))) {
        const key = relatedKey(c);
        if (related.has(key)) continue;
        const op = c.fn === 'COUNT_RELATED' ? 'count' : c.fn === 'SUM_RELATED' ? 'sum' : 'avg';
        related.set(key, await this.ctx.store.aggregateRelated(c.module, c.field, rec.id, op, c.valueField));
      }
    }
    const data = { ...rec.data };
    // Pasadas para resolver fórmulas que dependen de otras fórmulas, hasta que nada cambie (máx. 10) y con
    // los árboles ya analizados en caché: el coste ya no crece con el cuadrado del número de fórmulas.
    const maxPasses = Math.min(formulas.length, 10);
    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;
      for (const f of formulas) {
        let next: unknown;
        try {
          next = computeFormula(f.formula!.expression, f.formula!.resultType ?? 'number', {
            data,
            now: this.ctx.now(),
            tz: this.ctx.tz,
            related,
            system: { created_at: rec.createdAt, updated_at: rec.updatedAt, last_activity_at: rec.lastActivityAt },
          }, f.decimals, ast(f.formula!.expression));
        } catch {
          next = null;
        }
        if (JSON.stringify(next ?? null) !== JSON.stringify(data[f.key] ?? null)) changed = true;
        data[f.key] = next;
      }
      if (!changed && pass > 0) break;
    }
    return data;
  }

  /** Vincula los archivos de los campos "file" a su registro: desde entonces se rigen por los permisos del módulo. */
  private async linkFiles(mod: Module, recordId: string, data: Record<string, unknown>) {
    const actorId = this.ctx.actor.type === 'user' ? this.ctx.actor.id : null;
    for (const f of mod.fields) {
      const ids = data[f.key];
      if (f.type === 'file' && Array.isArray(ids) && ids.length) await this.ctx.store.linkFiles(ids as string[], { recordId, moduleKey: mod.key, fieldKey: f.key, actorId });
    }
  }

  private relationTargets(mod: Module, data: Record<string, unknown>): string[] {
    return mod.fields
      .filter((f) => f.type === 'relation' && !f.archived && typeof data[f.key] === 'string')
      .map((f) => data[f.key] as string);
  }

  /** Recalcula fórmulas de registros que dependen (vía *_RELATED) del módulo modificado. */
  private async refreshDependents(changedModule: string, data: Record<string, unknown>, prev?: Record<string, unknown>) {
    if ((this.ctx.depth ?? 0) > 2) return;
    for (const target of activeModules(this.ctx.blueprint)) {
      const formulas = target.fields.filter((f) => f.type === 'formula' && !f.archived && f.formula);
      for (const f of formulas) {
        for (const c of collectRelatedCalls(ast(f.formula!.expression))) {
          if (c.module !== changedModule) continue;
          const ids = new Set([data[c.field], prev?.[c.field]].filter((v): v is string => typeof v === 'string'));
          for (const id of ids) {
            const rec = await this.ctx.store.get(id);
            if (!rec || rec.moduleKey !== target.key) continue;
            const next = await this.computeFormulas(target, rec);
            if (JSON.stringify(next) !== JSON.stringify(rec.data)) {
              await this.ctx.store.update(rec.id, next, rec.updatedBy, rec.updatedAt);
            }
          }
        }
      }
    }
  }

  async create(moduleKey: string, input: Record<string, unknown>): Promise<StoredRecord> {
    const mod = this.module(moduleKey);
    this.can(mod, 'create');
    const now = this.ctx.now();
    const { data, issues } = normalizeRecordInput(mod, input, { mode: 'create', now, tz: this.ctx.tz });
    if (issues.length) throw unprocessable('Datos no válidos', { fields: issues });
    await this.checkReferences(mod, data);
    const at = now.toISOString();
    const rec: StoredRecord = {
      id: newId(),
      moduleKey: mod.key,
      data,
      createdBy: this.ctx.actor.type === 'user' ? this.ctx.actor.id : null,
      updatedBy: this.ctx.actor.type === 'user' ? this.ctx.actor.id : null,
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at,
    };
    rec.data = await this.computeFormulas(mod, rec);
    await this.ctx.store.insert(rec);
    await this.linkFiles(mod, rec.id, rec.data);
    await this.ctx.store.addHistory({ recordId: rec.id, moduleKey: mod.key, action: 'create', changes: { snapshot: rec.data }, actorId: this.ctx.actor.id, actorType: this.ctx.actor.type });
    await this.ctx.store.touch(this.relationTargets(mod, rec.data), at);
    await this.refreshDependents(mod.key, rec.data);
    await dispatchRecordEvent(this, { type: 'record_created', module: mod, record: rec, changed: Object.keys(rec.data) });
    return (await this.ctx.store.get(rec.id)) ?? rec;
  }

  async update(id: string, input: Record<string, unknown>, expectedModule?: string): Promise<StoredRecord> {
    const existing = await this.ctx.store.get(id);
    if (!existing || (expectedModule && existing.moduleKey !== expectedModule)) throw notFound('Registro no encontrado');
    const mod = this.module(existing.moduleKey);
    this.can(mod, 'update');
    const now = this.ctx.now();
    const { data, issues } = normalizeRecordInput(mod, input, { mode: 'update', existing: existing.data, now, tz: this.ctx.tz });
    if (issues.length) throw unprocessable('Datos no válidos', { fields: issues });
    const changedInput = Object.fromEntries(Object.entries(data).filter(([k, v]) => JSON.stringify(existing.data[k] ?? null) !== JSON.stringify(v ?? null)));
    await this.checkReferences(mod, changedInput, id);
    let merged: Record<string, unknown> = { ...existing.data, ...data };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    merged = await this.computeFormulas(mod, { ...existing, data: merged });
    const changes = diffData(existing.data, merged);
    if (!Object.keys(changes).length) return existing;
    const at = now.toISOString();
    const by = this.ctx.actor.type === 'user' ? this.ctx.actor.id : existing.updatedBy;
    await this.ctx.store.update(id, merged, by, at);
    await this.linkFiles(mod, id, changedInput);
    await this.ctx.store.addHistory({ recordId: id, moduleKey: mod.key, action: 'update', changes, actorId: this.ctx.actor.id, actorType: this.ctx.actor.type });
    await this.ctx.store.touch(this.relationTargets(mod, merged), at);
    await this.refreshDependents(mod.key, merged, existing.data);
    const updated: StoredRecord = { ...existing, data: merged, updatedAt: at, lastActivityAt: at, updatedBy: by };
    await dispatchRecordEvent(this, { type: 'record_updated', module: mod, record: updated, previous: existing.data, changed: Object.keys(changes) });
    return (await this.ctx.store.get(id)) ?? updated;
  }

  async delete(id: string, expectedModule?: string): Promise<void> {
    const existing = await this.ctx.store.get(id);
    if (!existing || (expectedModule && existing.moduleKey !== expectedModule)) throw notFound('Registro no encontrado');
    const mod = this.module(existing.moduleKey);
    this.can(mod, 'delete');
    const at = this.ctx.now().toISOString();
    await this.ctx.store.softDelete(id, this.ctx.actor.type === 'user' ? this.ctx.actor.id : null, at);
    await this.ctx.store.addHistory({ recordId: id, moduleKey: mod.key, action: 'delete', changes: { snapshot: existing.data }, actorId: this.ctx.actor.id, actorType: this.ctx.actor.type });
    await this.refreshDependents(mod.key, existing.data);
    await dispatchRecordEvent(this, { type: 'record_deleted', module: mod, record: existing, changed: [] });
  }
}
