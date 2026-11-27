// Constantes compartidas entre servidor y cliente. Sin dependencias.
import { msg } from './i18n';

export const ROLES = ['owner', 'admin', 'builder', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  viewer: 10,
  member: 20,
  builder: 30,
  admin: 40,
  owner: 50,
};

/**
 * Palabras que hay que escribir para confirmar operaciones de riesgo. La API recibe siempre la palabra en español
 * (es su contrato); la interfaz pide escribirla en el idioma de cada persona (tk) y envía la de la API.
 */
export const CONFIRM_WORDS = { deploy: msg('DESPLEGAR'), revert: msg('REVERTIR'), apply: msg('APLICAR'), restore: msg('RESTAURAR') } as const;

/** Nombre de cada nivel de riesgo de un cambio (para mensajes y etiquetas). */
export const RISK_LABELS: Readonly<Record<string, string>> = { low: msg('Riesgo bajo'), medium: msg('Riesgo medio'), high: msg('Riesgo alto') };

export const ROLE_LABELS: Record<Role, string> = {
  owner: msg('Propietario'),
  admin: msg('Administrador'),
  builder: msg('Constructor'),
  member: msg('Miembro'),
  viewer: msg('Lector'),
};

export function hasRole(role: Role | null | undefined, min: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'boolean',
  'email',
  'phone',
  'url',
  'select',
  'multi_select',
  'relation',
  'user',
  'rating',
  'file',
  'formula',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: msg('Texto'),
  long_text: msg('Texto largo'),
  number: msg('Número'),
  currency: msg('Moneda'),
  percent: msg('Porcentaje'),
  date: msg('Fecha'),
  datetime: msg('Fecha y hora'),
  boolean: msg('Sí / No'),
  email: msg('Email'),
  phone: msg('Teléfono'),
  url: 'URL',
  select: msg('Selección'),
  multi_select: msg('Selección múltiple / etiquetas'),
  relation: msg('Relación'),
  user: msg('Usuario del equipo'),
  rating: msg('Valoración (1-5)'),
  file: msg('Archivos adjuntos'),
  formula: msg('Fórmula calculada'),
};

export const COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
] as const;
export type Color = (typeof COLORS)[number];

// Iconos permitidos para módulos (nombres lógicos que el cliente traduce a componentes).
export const ICONS = [
  'users',
  'user',
  'user-check',
  'building',
  'handshake',
  'check-square',
  'calendar',
  'file-text',
  'briefcase',
  'phone',
  'mail',
  'message',
  'star',
  'tag',
  'folder',
  'package',
  'cart',
  'credit-card',
  'receipt',
  'ticket',
  'truck',
  'home',
  'globe',
  'target',
  'trending-up',
  'megaphone',
  'lightbulb',
  'life-buoy',
  'clipboard',
  'box',
  'layers',
  'chart',
  'zap',
  'heart',
  'map-pin',
  'clock',
  'flag',
  'book',
  'graduation-cap',
  'wrench',
  'shield',
  'activity',
  'file-signature',
  'wallet',
] as const;
export type IconName = (typeof ICONS)[number];

export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'in',
  'changed',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

// Campos de sistema presentes en todos los registros (no se pueden redefinir).
export const SYSTEM_FIELD_KEYS = [
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'deleted_at',
  'workspace_id',
  'module_key',
  'last_activity_at',
] as const;

// Tipos de tareas de IA configurables de forma independiente (AI Provider Manager).
export const AI_TASKS = [
  'chat',
  'crm_analysis',
  'feature_creation',
  'code_modification',
  'code_review',
  'security',
  'sql_generation',
  'automations',
  'document_analysis',
  'customer_classification',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_TASK_LABELS: Record<AiTask, string> = {
  chat: msg('Conversación general'),
  crm_analysis: msg('Análisis de CRM'),
  feature_creation: msg('Creación de funcionalidades'),
  code_modification: msg('Modificación de código'),
  code_review: msg('Revisión de código'),
  security: msg('Seguridad'),
  sql_generation: msg('Generación de SQL'),
  automations: msg('Automatizaciones'),
  document_analysis: msg('Análisis de documentos'),
  customer_classification: msg('Clasificación de clientes'),
};

export const EVOLUTION_STATUSES = [
  'queued',
  'planning',
  'testing',
  'needs_input',
  'ready_for_review',
  'approved',
  'rejected',
  'deploying',
  'applied',
  'failed',
  'rolled_back',
  'cancelled',
] as const;
export type EvolutionStatus = (typeof EVOLUTION_STATUSES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
