import { z } from 'zod';
import { COLORS, CONDITION_OPERATORS, FIELD_TYPES, ICONS, ROLES, SYSTEM_FIELD_KEYS } from './constants';
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_DENSITIES,
  APPEARANCE_FONTS,
  APPEARANCE_RADII,
  BLOCK_WIDTHS,
  BUTTON_STYLES,
  BUTTON_TARGETS,
  HEX_COLOR_RE,
  MAX_CUSTOM_CSS,
  SIDEBAR_STYLES,
  THEME_MODES,
} from './appearance';

/**
 * BLUEPRINT: definición versionada de la estructura del CRM de una organización
 * (módulos, campos, vistas, diseño de fichas, permisos, automatizaciones, paneles,
 * integraciones, formularios, scripts y su capa visual: apariencia, menú y páginas
 * propias). EVOLVE AI ENGINE modifica el blueprint mediante
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

/**
 * Límites del blueprint de una organización. Son deliberadamente muy altos (en la práctica, sin límite para
 * un CRM real) y existen solo para que una petición desmedida o malintencionada no pueda agotar la memoria o
 * la base de datos. Además, `validateBlueprint` limita el tamaño total del blueprint (`maxBlueprintBytes`).
 */
export const BLUEPRINT_LIMITS = {
  modules: 2000,
  fieldsPerModule: 1000,
  viewsPerModule: 100,
  layoutSections: 100,
  layoutSectionFields: 1000,
  viewColumns: 300,
  selectOptions: 2000,
  automations: 5000,
  dashboards: 500,
  widgetsPerDashboard: 200,
  integrations: 500,
  forms: 1000,
  formFields: 300,
  scripts: 1000,
  /** Capa visual: páginas propias, bloques por página, grupos del menú y elementos por grupo. */
  pages: 500,
  blocksPerPage: 200,
  navigationGroups: 100,
  navigationItems: 2000,
  maxBlueprintBytes: 25 * 1024 * 1024,
} as const;
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
  options: z.array(SelectOptionSchema).max(BLUEPRINT_LIMITS.selectOptions).optional(),
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
  columns: z.array(z.string().max(60)).max(BLUEPRINT_LIMITS.viewColumns).optional(),
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
  fields: z.array(z.string().max(60)).max(BLUEPRINT_LIMITS.layoutSectionFields),
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
  fields: z.array(FieldSchema).min(1).max(BLUEPRINT_LIMITS.fieldsPerModule),
  views: z.array(ViewSchema).min(1).max(BLUEPRINT_LIMITS.viewsPerModule),
  layout: z.array(LayoutSectionSchema).max(BLUEPRINT_LIMITS.layoutSections).optional(),
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
  widgets: z.array(WidgetSchema).max(BLUEPRINT_LIMITS.widgetsPerDashboard).default([]),
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
  fields: z.array(KeySchema).min(1).max(BLUEPRINT_LIMITS.formFields),
  public: z.boolean().default(false),
  submitLabel: z.string().max(40).default('Enviar'),
  successMessage: Text(300).default('¡Gracias! Hemos recibido tus datos.'),
  defaults: z.record(z.string(), z.unknown()).default({}),
});
export type Form = z.infer<typeof FormSchema>;

// ---------------------------------------------------------------- capa visual: apariencia, menú y páginas
// Solo presentación: no cambia datos ni permisos. Se versiona, prueba, aprueba y revierte como el resto.

/** Color #rrggbb (se normaliza a minúsculas). */
export const HexColorSchema = z.string().trim().regex(HEX_COLOR_RE, 'Color inválido: usa el formato #rrggbb').toLowerCase();
export const AppNameSchema = z.string().trim().min(1).max(40);
/**
 * Aquí solo se limita la longitud: que sea CSS plano y seguro lo comprueba `validateBlueprint` con
 * `sanitizeCustomCss` (shared/appearance.ts), y el navegador lo vuelve a comprobar antes de inyectarlo. Así,
 * si las reglas se endurecen, una versión antigua sigue cargando (y su CSS simplemente no se aplica).
 */
export const CustomCssSchema = z.string().max(MAX_CUSTOM_CSS, `El CSS personalizado no puede superar ${MAX_CUSTOM_CSS} caracteres`);

export const AppearanceSchema = z.object({
  /** Color principal (tono 600 de la paleta: botones, enlaces, selección). */
  brandColor: HexColorSchema.default(APPEARANCE_DEFAULTS.brandColor),
  /** Color de acento (avisos y degradados). */
  accentColor: HexColorSchema.optional(),
  /** Nombre que se muestra en el menú lateral y en la pestaña del navegador. */
  appName: AppNameSchema.optional(),
  font: z.enum(APPEARANCE_FONTS).default(APPEARANCE_DEFAULTS.font),
  radius: z.enum(APPEARANCE_RADII).default(APPEARANCE_DEFAULTS.radius),
  density: z.enum(APPEARANCE_DENSITIES).default(APPEARANCE_DEFAULTS.density),
  sidebar: z.enum(SIDEBAR_STYLES).default(APPEARANCE_DEFAULTS.sidebar),
  /** Tema inicial para quien no ha elegido uno (la elección de cada persona manda). */
  defaultTheme: z.enum(THEME_MODES).default(APPEARANCE_DEFAULTS.defaultTheme),
  customCss: CustomCssSchema.optional(),
});
export type Appearance = z.infer<typeof AppearanceSchema>;

export const NavItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('module'), key: KeySchema, label: Label.optional() }),
  z.object({ type: z.literal('dashboard'), key: KeySchema, label: Label.optional() }),
  z.object({ type: z.literal('page'), key: KeySchema, label: Label.optional() }),
  // Ruta interna de la aplicación ("/m/deals") o URL https (lo comprueba validateBlueprint con navHrefKind).
  z.object({ type: z.literal('link'), href: z.string().trim().min(1).max(500), label: Label }),
]);
export type NavItem = z.infer<typeof NavItemSchema>;

export const NavGroupSchema = z.object({
  key: KeySchema,
  label: Label,
  items: z.array(NavItemSchema).max(BLUEPRINT_LIMITS.navigationItems).default([]),
});
export type NavGroup = z.infer<typeof NavGroupSchema>;

export const NavigationSchema = z.object({
  /** Grupos del menú lateral. Sin grupos, el menú es la lista de módulos de siempre. */
  groups: z.array(NavGroupSchema).max(BLUEPRINT_LIMITS.navigationGroups).default([]),
  /** Lo que se muestra en "/" (por defecto, el primer panel). */
  home: z.object({ type: z.enum(['dashboard', 'page']), key: KeySchema }).optional(),
});
export type Navigation = z.infer<typeof NavigationSchema>;

const BlockWidthSchema = z.enum(BLOCK_WIDTHS).default('full');

export const PageButtonSchema = z.object({
  label: z.string().trim().min(1).max(60),
  to: z.object({ type: z.enum(BUTTON_TARGETS), key: KeySchema }),
  style: z.enum(BUTTON_STYLES).optional(),
});
export type PageButton = z.infer<typeof PageButtonSchema>;

export const PageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().trim().min(1).max(200), level: z.number().int().min(1).max(3).default(2), width: BlockWidthSchema }),
  z.object({ type: z.literal('text'), markdown: z.string().trim().min(1).max(10_000), width: BlockWidthSchema }),
  z.object({ type: z.literal('widget'), widget: WidgetSchema, width: BlockWidthSchema }),
  z.object({
    type: z.literal('records'),
    module: KeySchema,
    view: KeySchema.optional(),
    title: Label.optional(),
    filters: z.array(ConditionSchema).max(10).default([]),
    limit: z.number().int().min(1).max(100).default(10),
    columns: z.array(z.string().max(60)).max(BLUEPRINT_LIMITS.viewColumns).optional(),
    width: BlockWidthSchema,
  }),
  z.object({ type: z.literal('form'), form: KeySchema, width: BlockWidthSchema }),
  z.object({ type: z.literal('buttons'), items: z.array(PageButtonSchema).min(1).max(12), width: BlockWidthSchema }),
  z.object({ type: z.literal('divider'), width: BlockWidthSchema }),
]);
export type PageBlock = z.infer<typeof PageBlockSchema>;

/** Página propia de la organización (/p/<key>): una pantalla hecha de bloques. */
export const PageSchema = z.object({
  key: KeySchema,
  label: Label,
  icon: z.enum(ICONS).default('layers'),
  description: Text(500).optional(),
  /** Rol mínimo para verla. Además, cada rol solo ve los bloques de los módulos que puede leer. */
  minRole: z.enum(ROLES).default('viewer'),
  blocks: z.array(PageBlockSchema).max(BLUEPRINT_LIMITS.blocksPerPage).default([]),
});
export type Page = z.infer<typeof PageSchema>;

export const BlueprintSchema = z.object({
  modules: z.array(ModuleSchema).max(BLUEPRINT_LIMITS.modules),
  automations: z.array(AutomationSchema).max(BLUEPRINT_LIMITS.automations).default([]),
  dashboards: z.array(DashboardSchema).max(BLUEPRINT_LIMITS.dashboards).default([]),
  integrations: z.array(IntegrationSchema).max(BLUEPRINT_LIMITS.integrations).default([]),
  forms: z.array(FormSchema).max(BLUEPRINT_LIMITS.forms).default([]),
  scripts: z.array(ScriptSchema).max(BLUEPRINT_LIMITS.scripts).default([]),
  // Capa visual (opcional: los blueprints anteriores siguen siendo válidos tal cual).
  appearance: AppearanceSchema.optional(),
  navigation: NavigationSchema.optional(),
  pages: z.array(PageSchema).max(BLUEPRINT_LIMITS.pages).default([]),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

// Campos de sistema consultables en vistas, filtros y paneles.
export const SYSTEM_QUERY_FIELDS = ['id', 'created_at', 'updated_at', 'last_activity_at', 'created_by'] as const;

export function findModule(bp: Blueprint, key: string): Module | undefined {
  return bp.modules.find((m) => m.key === key);
}

export function findPage(bp: Blueprint, key: string): Page | undefined {
  return (bp.pages ?? []).find((p) => p.key === key);
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
