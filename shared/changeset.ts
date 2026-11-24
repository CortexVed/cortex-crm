import { z } from 'zod';
import { COLORS, FIELD_TYPES, ICONS, ROLES } from './constants';
import {
  AutomationSchema,
  ConditionSchema,
  DashboardSchema,
  FieldSchema,
  FormSchema,
  IntegrationSchema,
  KeySchema,
  LayoutSectionSchema,
  ModuleSchema,
  ScriptSchema,
  SelectOptionSchema,
  ViewSchema,
} from './blueprint';

/**
 * CHANGE SET: plan de cambios producido por EVOLVE AI ENGINE (o por el editor manual) para UNA
 * organización: operaciones tipadas sobre su blueprint, migraciones de datos reversibles y, si hace
 * falta lógica a medida, scripts que solo se ejecutan en el sandbox aislado de la plataforma.
 * Incluye las pruebas de aceptación que el sandbox ejecuta. Nada se publica en repositorios externos.
 */

// Esquemas de parche EXPLÍCITOS y sin valores por defecto: en zod 4, `.partial()` sobre un esquema
// con `.default()` sigue rellenando las claves omitidas, lo que haría que un cambio de color
// reseteara icono y permisos. Aquí solo existe lo que el plan menciona.
const PatchLabel = z.string().trim().min(1).max(80);
const RoleSchema = z.enum(ROLES);

const ModulePatchSchema = z.object({
  label: PatchLabel.optional(),
  labelPlural: PatchLabel.optional(),
  icon: z.enum(ICONS).optional(),
  color: z.enum(COLORS).optional(),
  description: z.string().max(500).optional(),
  primaryField: KeySchema.optional(),
  layout: z.array(LayoutSectionSchema).max(12).optional(),
  permissions: z
    .object({ read: RoleSchema.optional(), create: RoleSchema.optional(), update: RoleSchema.optional(), delete: RoleSchema.optional() })
    .optional(),
});

const FieldPatchSchema = z.object({
  label: PatchLabel.optional(),
  type: z.enum(FIELD_TYPES).optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  helpText: z.string().max(300).optional(),
  hidden: z.boolean().optional(),
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
  formula: z.object({ expression: z.string().min(1).max(1000), resultType: z.enum(['number', 'text', 'boolean']).optional() }).optional(),
  defaultValue: z.unknown().optional(),
});

const Values = z.record(z.string(), z.unknown());

export const OperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_module'), module: ModuleSchema }),
  z.object({ op: z.literal('update_module'), module: KeySchema, changes: ModulePatchSchema }),
  z.object({ op: z.literal('archive_module'), module: KeySchema }),
  z.object({ op: z.literal('restore_module'), module: KeySchema }),
  z.object({ op: z.literal('add_field'), module: KeySchema, field: FieldSchema, after: z.string().max(60).optional() }),
  z.object({ op: z.literal('update_field'), module: KeySchema, field: KeySchema, changes: FieldPatchSchema }),
  z.object({ op: z.literal('archive_field'), module: KeySchema, field: KeySchema }),
  z.object({ op: z.literal('restore_field'), module: KeySchema, field: KeySchema }),
  z.object({
    op: z.literal('add_select_options'),
    module: KeySchema,
    field: KeySchema,
    options: z.array(SelectOptionSchema).min(1).max(50),
  }),
  z.object({ op: z.literal('upsert_view'), module: KeySchema, view: ViewSchema }),
  z.object({ op: z.literal('remove_view'), module: KeySchema, view: KeySchema }),
  z.object({ op: z.literal('upsert_automation'), automation: AutomationSchema }),
  z.object({ op: z.literal('remove_automation'), automation: KeySchema }),
  z.object({ op: z.literal('upsert_dashboard'), dashboard: DashboardSchema }),
  z.object({ op: z.literal('remove_dashboard'), dashboard: KeySchema }),
  z.object({ op: z.literal('upsert_integration'), integration: IntegrationSchema }),
  z.object({ op: z.literal('remove_integration'), integration: KeySchema }),
  z.object({ op: z.literal('upsert_form'), form: FormSchema }),
  z.object({ op: z.literal('remove_form'), form: KeySchema }),
  // Scripts de la organización (código en sandbox). Si "code" llega vacío, el desarrollador de
  // EVOLVE lo escribe a partir de la especificación (description) antes de probarlo.
  z.object({ op: z.literal('upsert_script'), script: ScriptSchema }),
  z.object({ op: z.literal('remove_script'), script: KeySchema }),
  z.object({
    op: z.literal('backfill_field'),
    module: KeySchema,
    field: KeySchema,
    value: z.unknown(),
    onlyEmpty: z.boolean().default(true),
    where: z.array(ConditionSchema).max(10).default([]),
  }),
]);
export type Operation = z.infer<typeof OperationSchema>;
export type OperationType = Operation['op'];

const Ref = z.string().min(1).max(40);

export const TestStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), module: KeySchema, values: Values, as: Ref.optional() }),
  z.object({ action: z.literal('update'), ref: Ref, values: Values }),
  z.object({ action: z.literal('delete'), ref: Ref }),
  z.object({
    action: z.literal('expect_field'),
    ref: Ref,
    field: z.string().max(60),
    equals: z.unknown().optional(),
    notEmpty: z.boolean().optional(),
  }),
  z.object({ action: z.literal('expect_invalid'), module: KeySchema, values: Values }),
  z.object({
    action: z.literal('expect_count'),
    module: KeySchema,
    equals: z.number().int().min(0),
    where: z.array(ConditionSchema).max(10).default([]),
  }),
  z.object({ action: z.literal('expect_notification'), min: z.number().int().min(1).default(1) }),
  z.object({ action: z.literal('expect_webhook'), integration: KeySchema, min: z.number().int().min(1).default(1) }),
  z.object({ action: z.literal('advance_days'), days: z.number().int().min(1).max(400) }),
  z.object({ action: z.literal('run_scheduler') }),
]);
export type TestStep = z.infer<typeof TestStepSchema>;

export const TestCaseSchema = z.object({
  name: z.string().min(1).max(160),
  steps: z.array(TestStepSchema).min(1).max(40),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const ChangeSetSchema = z.object({
  title: z.string().min(3).max(140),
  summary: z.string().min(1).max(3000),
  operations: z.array(OperationSchema).max(80).default([]),
  tests: z.array(TestCaseSchema).max(20).default([]),
  /** La petición necesita una funcionalidad nueva de la plataforma (no se resuelve por organización). */
  requiresPlatformChange: z.boolean().default(false),
  platformRequest: z.string().max(6000).optional(),
  questions: z.array(z.string().max(500)).max(6).default([]),
  assumptions: z.array(z.string().max(500)).max(10).default([]),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;
