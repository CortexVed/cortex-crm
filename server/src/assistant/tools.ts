import { z } from 'zod';
import { hasRole, type Role } from '../../../shared/constants';
import { ConditionSchema, SYSTEM_QUERY_FIELDS, activeModules, findModule, type Module } from '../../../shared/blueprint';
import { recordTitle } from '../../../shared/records';
import type { AppDeps } from '../deps';
import { loadWorkspace, makeRecordService } from '../crm/context';
import { computeWidget } from '../crm/dashboards';
import type { ToolCall, ToolSpec } from '../ai/types';

const conditionSchemaJson = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'in'] },
    value: { description: 'Valor a comparar (texto, número, booleano o lista para "in"). Admite {{today}}, {{today-30d}}, {{month_start}}.' },
  },
  required: ['field', 'operator'],
  additionalProperties: false,
};

export const ASSISTANT_TOOLS: ToolSpec[] = [
  {
    name: 'search_records',
    description: 'Busca registros de un módulo del CRM por texto libre y/o filtros. Devuelve id, título y campos clave.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Clave del módulo (p. ej. contacts, companies, deals, tasks)' },
        query: { type: 'string', description: 'Texto a buscar (opcional)' },
        filters: { type: 'array', items: conditionSchemaJson },
        sort_field: { type: 'string' },
        sort_direction: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['module'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_record',
    description: 'Obtiene un registro completo por id, con el resumen de sus registros relacionados (relaciones inversas).',
    inputSchema: { type: 'object', properties: { module: { type: 'string' }, id: { type: 'string' } }, required: ['module', 'id'], additionalProperties: false },
  },
  {
    name: 'list_related',
    description: 'Lista los registros de un módulo relacionados con un registro concreto (p. ej. oportunidades de una empresa).',
    inputSchema: {
      type: 'object',
      properties: { module: { type: 'string', description: 'Módulo del registro origen' }, id: { type: 'string' }, related_module: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['module', 'id', 'related_module'],
      additionalProperties: false,
    },
  },
  {
    name: 'aggregate',
    description: 'Calcula métricas sobre un módulo: count, sum o avg de un campo numérico, opcionalmente agrupado y filtrado.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string' },
        aggregate: { type: 'string', enum: ['count', 'sum', 'avg'] },
        field: { type: 'string' },
        group_by: { type: 'string' },
        filters: { type: 'array', items: conditionSchemaJson },
      },
      required: ['module', 'aggregate'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_record_change',
    description: 'Propone crear o actualizar un registro. NO se ejecuta: el usuario verá un botón para confirmarlo.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update'] },
        module: { type: 'string' },
        id: { type: 'string', description: 'Obligatorio para update' },
        values: { type: 'object', description: 'Valores por clave de campo' },
        summary: { type: 'string', description: 'Descripción breve para el usuario' },
      },
      required: ['action', 'module', 'values', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_evolution',
    description: 'Cuando el usuario pide cambiar la ESTRUCTURA del CRM (módulos, campos, vistas, automatizaciones, integraciones), propone enviar la petición a EVOLVE AI ENGINE. No se ejecuta sin confirmación.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'Petición completa y precisa para el motor' }, reason: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
  },
  {
    name: 'remember',
    description: 'Propone guardar una preferencia o dato útil para futuras conversaciones (memoria auditable). NO se guarda sin confirmación del usuario. scope "user" para preferencias personales, "org" para decisiones de la organización.',
    inputSchema: { type: 'object', properties: { content: { type: 'string' }, scope: { type: 'string', enum: ['user', 'org'] } }, required: ['content', 'scope'], additionalProperties: false },
  },
];

export interface PendingAction {
  type: 'record_change' | 'evolution' | 'memory';
  summary: string;
  payload: Record<string, unknown>;
}

const SearchInput = z.object({
  module: z.string().max(40),
  query: z.string().max(200).optional(),
  filters: z.array(ConditionSchema).max(10).optional(),
  sort_field: z.string().max(60).optional(),
  sort_direction: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

function compact(mod: Module, data: Record<string, unknown>, max = 12) {
  const out: Record<string, unknown> = {};
  for (const f of mod.fields.filter((x) => !x.archived).slice(0, max)) {
    const v = data[f.key];
    if (v === null || v === undefined || v === '') continue;
    out[f.label] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v;
  }
  return out;
}

/** Ejecuta herramientas del asistente con los permisos del usuario y en el contexto RLS de su organización. */
export function createToolExecutor(deps: AppDeps, ctx: { workspaceId: string; userId: string; role: Role }, pending: PendingAction[]) {
  const ws = ctx.workspaceId;
  const tenant = <T>(fn: Parameters<typeof deps.db.tenant<T>>[1]) => deps.db.tenant<T>(ws, fn);

  return async (call: ToolCall): Promise<{ content: string; isError?: boolean }> => {
    const input = call.input ?? {};
    const moduleOf = (bp: Awaited<ReturnType<typeof loadWorkspace>>['blueprint'], key: unknown) => {
      const m = findModule(bp, String(key));
      if (!m || m.archived) throw new Error(`Módulo "${String(key)}" no existe. Módulos disponibles: ${activeModules(bp).map((x) => x.key).join(', ')}`);
      if (!hasRole(ctx.role, m.permissions.read)) throw new Error(`Sin permiso para ver ${m.labelPlural}`);
      return m;
    };
    try {
      switch (call.name) {
        case 'search_records': {
          const p = SearchInput.parse(input);
          return await tenant(async (q) => {
            const loaded = await loadWorkspace(q, ws);
            const mod = moduleOf(loaded.blueprint, p.module);
            const known = (f: string) => (SYSTEM_QUERY_FIELDS as readonly string[]).includes(f) || mod.fields.some((x) => x.key === f);
            const filters = (p.filters ?? []).filter((f) => known(f.field));
            const svc = makeRecordService(q, loaded, { type: 'ai', id: ctx.userId, role: ctx.role });
            const { items, total } = await svc.ctx.store.list(
              mod,
              { search: p.query, filters, sort: p.sort_field && known(p.sort_field) ? { field: p.sort_field, direction: p.sort_direction ?? 'asc' } : undefined, limit: p.limit ?? 10, offset: 0 },
              { now: deps.now(), tz: loaded.settings.timezone },
            );
            return { content: JSON.stringify({ module: mod.key, total, items: items.map((r) => ({ id: r.id, title: recordTitle(mod, r.data), fields: compact(mod, r.data, 8), last_activity_at: r.lastActivityAt })) }) };
          });
        }
        case 'get_record': {
          const p = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(input);
          return await tenant(async (q) => {
            const loaded = await loadWorkspace(q, ws);
            const mod = moduleOf(loaded.blueprint, p.module);
            const svc = makeRecordService(q, loaded, { type: 'ai', id: ctx.userId, role: ctx.role });
            const rec = await svc.ctx.store.get(p.id);
            if (!rec || rec.moduleKey !== mod.key) return { content: 'Registro no encontrado', isError: true };
            const related: Record<string, number> = {};
            for (const m of activeModules(loaded.blueprint).filter((x) => hasRole(ctx.role, x.permissions.read))) {
              for (const f of m.fields.filter((x) => x.type === 'relation' && x.relation?.module === mod.key && !x.archived)) {
                related[`${m.labelPlural} (vía ${f.label})`] = (await svc.ctx.store.list(m, { filters: [{ field: f.key, operator: 'eq', value: p.id }], limit: 1, offset: 0 }, { now: deps.now(), tz: loaded.settings.timezone })).total;
              }
            }
            return { content: JSON.stringify({ id: rec.id, module: mod.key, title: recordTitle(mod, rec.data), fields: compact(mod, rec.data, 40), created_at: rec.createdAt, last_activity_at: rec.lastActivityAt, related_counts: related }) };
          });
        }
        case 'list_related': {
          const p = z.object({ module: z.string().max(40), id: z.string().uuid(), related_module: z.string().max(40), limit: z.number().int().min(1).max(50).optional() }).parse(input);
          return await tenant(async (q) => {
            const loaded = await loadWorkspace(q, ws);
            moduleOf(loaded.blueprint, p.module);
            const rel = moduleOf(loaded.blueprint, p.related_module);
            const fields = rel.fields.filter((f) => f.type === 'relation' && f.relation?.module === p.module && !f.archived);
            if (!fields.length) return { content: `"${rel.key}" no tiene relación con "${p.module}"`, isError: true };
            const svc = makeRecordService(q, loaded, { type: 'ai', id: ctx.userId, role: ctx.role });
            const results = [];
            for (const f of fields) {
              const { items, total } = await svc.ctx.store.list(rel, { filters: [{ field: f.key, operator: 'eq', value: p.id }], limit: p.limit ?? 20, offset: 0, sort: { field: 'created_at', direction: 'desc' } }, { now: deps.now(), tz: loaded.settings.timezone });
              results.push({ via: f.label, total, items: items.map((r) => ({ id: r.id, title: recordTitle(rel, r.data), fields: compact(rel, r.data, 8) })) });
            }
            return { content: JSON.stringify({ module: rel.key, results }) };
          });
        }
        case 'aggregate': {
          const p = z.object({ module: z.string().max(40), aggregate: z.enum(['count', 'sum', 'avg']), field: z.string().max(60).optional(), group_by: z.string().max(60).optional(), filters: z.array(ConditionSchema).max(10).optional() }).parse(input);
          return await tenant(async (q) => {
            const loaded = await loadWorkspace(q, ws);
            const mod = moduleOf(loaded.blueprint, p.module);
            const data = await computeWidget(q, ws, loaded.blueprint, { key: 'ai', title: 'ai', type: p.group_by ? 'bar' : 'metric', module: mod.key, aggregate: p.aggregate, field: p.field, groupBy: p.group_by, interval: 'month', filters: p.filters ?? [], limit: 8, size: 'sm' }, { now: deps.now(), tz: loaded.settings.timezone, canRead: (k) => { const m = findModule(loaded.blueprint, k); return !!m && hasRole(ctx.role, m.permissions.read); } });
            return { content: JSON.stringify(data), isError: data.type === 'error' };
          });
        }
        case 'propose_record_change': {
          const p = z.object({ action: z.enum(['create', 'update']), module: z.string().max(40), id: z.string().uuid().optional(), values: z.record(z.string(), z.unknown()), summary: z.string().max(500) }).parse(input);
          if (p.action === 'update' && !p.id) return { content: 'Falta el id para actualizar', isError: true };
          const loaded = await tenant((q) => loadWorkspace(q, ws));
          const mod = moduleOf(loaded.blueprint, p.module);
          const perm = p.action === 'create' ? mod.permissions.create : mod.permissions.update;
          if (!hasRole(ctx.role, perm)) return { content: `El usuario no tiene permiso para ${p.action === 'create' ? 'crear' : 'editar'} ${mod.labelPlural}`, isError: true };
          pending.push({ type: 'record_change', summary: p.summary, payload: { action: p.action, module: mod.key, moduleLabel: mod.label, id: p.id, values: p.values } });
          return { content: 'Propuesta preparada. El usuario debe confirmarla en la interfaz; no digas que ya está hecho.' };
        }
        case 'propose_evolution': {
          const p = z.object({ prompt: z.string().min(8).max(4000), reason: z.string().max(500).optional() }).parse(input);
          if (!hasRole(ctx.role, 'builder')) return { content: 'El usuario no tiene permiso para proponer cambios de estructura (requiere rol Constructor o superior).', isError: true };
          pending.push({ type: 'evolution', summary: p.reason ?? 'Enviar a EVOLVE AI ENGINE', payload: { prompt: p.prompt } });
          return { content: 'Propuesta preparada para EVOLVE AI ENGINE. El usuario debe confirmarla.' };
        }
        case 'remember': {
          // Nunca se escribe memoria directamente: un texto malicioso en los datos del CRM podría
          // inducir al modelo a "recordar" instrucciones. El usuario confirma cada elemento.
          const p = z.object({ content: z.string().min(3).max(1000), scope: z.enum(['user', 'org']) }).parse(input);
          if (p.scope === 'org' && !hasRole(ctx.role, 'admin')) return { content: 'Solo administradores pueden guardar memoria de organización; propónlo como preferencia personal (user).', isError: true };
          pending.push({ type: 'memory', summary: p.scope === 'org' ? 'Guardar en la memoria de la organización' : 'Guardar como preferencia personal', payload: { scope: p.scope, kind: p.scope === 'org' ? 'decision' : 'preference', content: p.content } });
          return { content: 'Propuesta de memoria preparada. El usuario debe confirmarla; no digas que ya está guardada.' };
        }
        default:
          return { content: `Herramienta desconocida: ${call.name}`, isError: true };
      }
    } catch (e) {
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  };
}
