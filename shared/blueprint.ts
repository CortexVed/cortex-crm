import { z } from 'zod';
import { COLORS, CONDITION_OPERATORS, FIELD_TYPES, ICONS, ROLES, SYSTEM_FIELD_KEYS } from './constants';

/**
 * BLUEPRINT: definición versionada de la estructura del CRM de una organización
 * (módulos, campos, vistas, diseño de fichas, permisos, automatizaciones, paneles,
 * integraciones y formularios). EVOLVE AI ENGINE modifica el blueprint mediante
 * "change sets" que se validan, prueban en sandbox, aprueban y publican como versiones.
 */

export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
// Nombres que coinciden con propiedades de Object.prototype: como clave de campo romperían los accesos por objeto.
const RESERVED_KEYS = new Set(['constructor', 'prototype']);
export const KeySchema = z
  .string()
  .regex(KEY_RE, 'Clave inválida: usa snake_case (a-z, 0-9, _) empezando por letra, máximo 40 caracteres')
  .refine((k) => !RESERVED_KEYS.has(k), 'Clave reservada: elige otro nombre');
const Label = z.string().trim().min(1).max(80);
const Text = (max: number) => z.string().max(max);

/** Valores de condición acotados (texto ≤ 500, listas ≤ 100): se procesan en cada consulta. */
const ConditionValueSchema = z.unknown().superRefine((v, ctx) => {
  const tooLong = (s: unknown) => typeof s === 'string' && s.length > 500;
  if (tooLong(v) || (Array.isArray(v) && (v.length > 100 || v.some(tooLong))) || (v !== null && typeof v === 'object' && !Array.isArray(v))) {
    ctx.addIssue({ code: 'custom', message: 'Valor de condición no válido o demasiado largo' });
  }
});

export const ConditionSchema = z.object({
  field: z.string().min(1).max(60),
  operator: z.enum(CONDITION_OPERATORS),
  value: ConditionValueSchema.optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const SelectOptionSchema = z.object({
  value: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, 'Valor de opción inválido (minúsculas, números, _ o -)'),
  label: Label,
  color: z.enum(COLORS).default('slate'),
});
export type SelectOption = z.infer<typeof SelectOptionSchema>;

export const FieldBaseSchema = z.object({
  key: KeySchema,
  label: Label,
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  helpText: Text(300).optional(),
  hidden: z.boolean().default(false),
  archived: z.boolean().default(false),
  system: z.boolean().default(false),
  options: z.array(SelectOptionSchema).max(100).optional(),
  relation: z.object({ module: KeySchema }).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  decimals: z.number().int().min(0).max(6).optional(),
  maxFiles: z.number().int().min(1).max(20).optional(),
  formula: z
    .object({
      expression: z.string().min(1).max(1000),
      resultType: z.enum(['number', 'text', 'boolean']).default('number'),
    })
    .optional(),
  defaultValue: z.unknown().optional(),
});

export const FieldSchema = FieldBaseSchema.superRefine((f, ctx) => {
  if ((SYSTEM_FIELD_KEYS as readonly string[]).includes(f.key)) {
    ctx.addIssue({ code: 'custom', message: `"${f.key}" es una clave reservada del sistema`, path: ['key'] });
  }
  if ((f.type === 'select' || f.type === 'multi_select') && (!f.options || f.options.length === 0)) {
    ctx.addIssue({ code: 'custom', message: `El campo "${f.key}" necesita al menos una opción`, path: ['options'] });
  }
  if (f.options) {
    const seen = new Set<string>();
    for (const o of f.options) {
      if (seen.has(o.value)) ctx.addIssue({ code: 'custom', message: `Opción duplicada "${o.value}"`, path: ['options'] });
      seen.add(o.value);
    }
  }
  if (f.type === 'relation' && !f.relation) {
    ctx.addIssue({ code: 'custom', message: `El campo "${f.key}" necesita indicar el módulo relacionado`, path: ['relation'] });
  }
  if (f.type === 'formula') {
    if (!f.formula) ctx.addIssue({ code: 'custom', message: `El campo "${f.key}" necesita una fórmula`, path: ['formula'] });
    if (f.required || f.unique) ctx.addIssue({ code: 'custom', message: 'Un campo calculado no puede ser obligatorio ni único', path: ['type'] });
  }
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
    ctx.addIssue({ code: 'custom', message: 'min no puede ser mayor que max', path: ['min'] });
  }
});
export type Field = z.infer<typeof FieldSchema>;

export const ViewSchema = z.object({
  key: KeySchema,
  label: Label,
  type: z.enum(['table', 'kanban', 'calendar']),
  columns: z.array(z.string().max(60)).max(40).optional(),
  groupBy: z.string().max(60).optional(),
  cardFields: z.array(z.string().max(60)).max(8).optional(),
  dateField: z.string().max(60).optional(),
  colorBy: z.string().max(60).optional(),
  sort: z
    .object({ field: z.string().max(60), direction: z.enum(['asc', 'desc']).default('asc') })
    .optional(),
  filters: z.array(ConditionSchema).max(10).default([]),
});
export type View = z.infer<typeof ViewSchema>;

export const LayoutSectionSchema = z.object({
  title: Label,
  fields: z.array(z.string().max(60)).max(80),
  columns: z.union([z.literal(1), z.literal(2)]).default(2),
});
export type LayoutSection = z.infer<typeof LayoutSectionSchema>;

export const PermissionsSchema = z.object({
  read: z.enum(ROLES).default('viewer'),
  create: z.enum(ROLES).default('member'),
  update: z.enum(ROLES).default('member'),
  delete: z.enum(ROLES).default('member'),
});
export type ModulePermissions = z.infer<typeof PermissionsSchema>;

export const ModuleBaseSchema = z.object({
  key: KeySchema,
  label: Label,
  labelPlural: Label,
  icon: z.enum(ICONS).default('box'),
  color: z.enum(COLORS).default('indigo'),
  description: Text(500).optional(),
  system: z.boolean().default(false),
  archived: z.boolean().default(false),
  primaryField: KeySchema,
  fields: z.array(FieldSchema).min(1).max(120),
  views: z.array(ViewSchema).min(1).max(20),
  layout: z.array(LayoutSectionSchema).max(12).optional(),
  permissions: PermissionsSchema.prefault({}),
});
export const ModuleSchema = ModuleBaseSchema;
export type Module = z.infer<typeof ModuleSchema>;

export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('record_created'), module: KeySchema }),
  z.object({ type: z.literal('record_updated'), module: KeySchema }),
  z.object({ type: z.literal('field_changed'), module: KeySchema, field: KeySchema, to: z.unknown().optional() }),
  z.object({ type: z.literal('record_deleted'), module: KeySchema }),
  z.object({
    type: z.literal('date_reached'),
    module: KeySchema,
    field: KeySchema,
    offsetDays: z.number().int().min(-365).max(365).default(0),
  }),
  z.object({ type: z.literal('inactivity'), module: KeySchema, days: z.number().int().min(1).max(365) }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const NotifyTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_field'), field: KeySchema }),
  z.object({ type: z.literal('role'), role: z.enum(ROLES) }),
  z.object({ type: z.literal('all') }),
]);

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_field'), field: KeySchema, value: z.unknown() }),
  z.object({
    type: z.literal('create_record'),
    module: KeySchema,
    values: z.record(z.string(), z.unknown()).default({}),
    linkField: KeySchema.optional(),
  }),
  z.object({ type: z.literal('send_webhook'), integration: KeySchema }),
  z.object({
    type: z.literal('notify'),
    to: NotifyTargetSchema,
    title: z.string().min(1).max(140),
    body: Text(500).optional(),
  }),
  // Ejecuta un script de la organización (sandbox aislado) sobre el registro que dispara.
  z.object({ type: z.literal('run_script'), script: KeySchema }),
]);
export type Action = z.infer<typeof ActionSchema>;

/**
 * Script de una organización: lógica a medida (JavaScript) que se ejecuta en un sandbox aislado
 * (QuickJS en WebAssembly, sin red ni archivos) dentro de la propia plataforma. Forma parte del
 * blueprint de ESA organización: se versiona, se prueba, se aprueba y se puede revertir como el
 * resto de la configuración, y nunca se publica en un repositorio ni afecta a otras organizaciones.
 */
export const ScriptSchema = z.object({
  key: KeySchema,
  name: Label,
  /** Especificación funcional: qué hace el script (a partir de ella se genera el código). */
  description: Text(2000).optional(),
  code: z.string().max(20_000).default(''),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(50).max(3000).default(1000),
});
export type Script = z.infer<typeof ScriptSchema>;

export const AutomationSchema = z.object({
  key: KeySchema,
  name: Label,
  description: Text(500).optional(),
  enabled: z.boolean().default(true),
  trigger: TriggerSchema,
  conditions: z.array(ConditionSchema).max(15).default([]),
  actions: z.array(ActionSchema).min(1).max(10),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const WidgetSchema = z.object({
  key: KeySchema,
  title: Label,
  type: z.enum(['metric', 'bar', 'donut', 'line', 'list']),
  module: KeySchema,
  aggregate: z.enum(['count', 'sum', 'avg']).default('count'),
  field: z.string().max(60).optional(),
  groupBy: z.string().max(60).optional(),
  dateField: z.string().max(60).optional(),
  interval: z.enum(['day', 'week', 'month']).default('month'),
  filters: z.array(ConditionSchema).max(10).default([]),
  limit: z.number().int().min(1).max(50).default(8),
  size: z.enum(['sm', 'md', 'lg', 'xl']).default('sm'),
});
export type Widget = z.infer<typeof WidgetSchema>;

export const DashboardSchema = z.object({
  key: KeySchema,
  label: Label,
  widgets: z.array(WidgetSchema).max(30).default([]),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const IntegrationSchema = z.object({
  key: KeySchema,
  name: Label,
  type: z.literal('webhook').default('webhook'),
  url: z.string().url().max(2000),
  description: Text(500).optional(),
  includeFields: z.array(z.string().max(60)).max(100).optional(),
  enabled: z.boolean().default(true),
});
export type Integration = z.infer<typeof IntegrationSchema>;

export const FormSchema = z.object({
  key: KeySchema,
  name: Label,
  module: KeySchema,
  fields: z.array(KeySchema).min(1).max(40),
  public: z.boolean().default(false),
  submitLabel: z.string().max(40).default('Enviar'),
  successMessage: Text(300).default('¡Gracias! Hemos recibido tus datos.'),
  defaults: z.record(z.string(), z.unknown()).default({}),
});
export type Form = z.infer<typeof FormSchema>;

export const BlueprintSchema = z.object({
  modules: z.array(ModuleSchema).max(60),
  automations: z.array(AutomationSchema).max(200).default([]),
  dashboards: z.array(DashboardSchema).max(20).default([]),
  integrations: z.array(IntegrationSchema).max(50).default([]),
  forms: z.array(FormSchema).max(50).default([]),
  scripts: z.array(ScriptSchema).max(50).default([]),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

// Campos de sistema consultables en vistas, filtros y paneles.
export const SYSTEM_QUERY_FIELDS = ['id', 'created_at', 'updated_at', 'last_activity_at', 'created_by'] as const;

export function findModule(bp: Blueprint, key: string): Module | undefined {
  return bp.modules.find((m) => m.key === key);
}

export function findField(mod: Module, key: string): Field | undefined {
  return mod.fields.find((f) => f.key === key);
}

export function activeFields(mod: Module): Field[] {
  return mod.fields.filter((f) => !f.archived);
}

export function activeModules(bp: Blueprint): Module[] {
  return bp.modules.filter((m) => !m.archived);
}
