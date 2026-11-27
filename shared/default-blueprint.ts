import { BlueprintSchema, type Blueprint } from './blueprint';
import { activeIntlTag, t } from './i18n';
import type { z } from 'zod';

type BlueprintInput = z.input<typeof BlueprintSchema>;

/** País por defecto de las empresas: el de la región del idioma de la organización («España», «Deutschland», «日本»…). */
function defaultCountry(): string | undefined {
  const tag = activeIntlTag();
  try {
    const region = new Intl.Locale(tag).maximize().region;
    const name = region ? new Intl.DisplayNames([tag], { type: 'region' }).of(region) : undefined;
    return name && name !== region ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * CRM por defecto con sus textos (módulos, campos, opciones, vistas, paneles…) en el idioma activo: provision.ts
 * lo llama dentro de withLocale(idioma de la organización). Claves, valores, iconos y colores no cambian.
 */
function defaultBlueprintInput(currency = 'EUR'): BlueprintInput {
  const TAGS = [
    { value: 'vip', label: t('VIP'), color: 'violet' },
    { value: 'partner', label: t('Partner'), color: 'teal' },
    { value: 'newsletter', label: t('Newsletter'), color: 'sky' },
    { value: 'evento', label: t('Evento'), color: 'amber' },
    { value: 'seguimiento', label: t('Seguimiento'), color: 'rose' },
  ] as const;

  const SOURCES = [
    { value: 'web', label: t('Web'), color: 'sky' },
    { value: 'referido', label: t('Referido'), color: 'emerald' },
    { value: 'evento', label: t('Evento'), color: 'amber' },
    { value: 'campana', label: t('Campaña'), color: 'violet' },
    { value: 'llamada', label: t('Llamada en frío'), color: 'slate' },
    { value: 'otro', label: t('Otro'), color: 'slate' },
  ] as const;

  return {
    modules: [
      {
        key: 'companies',
        label: t('Empresa'),
        labelPlural: t('Empresas'),
        icon: 'building',
        color: 'sky',
        description: t('Cuentas y organizaciones con las que trabajas.'),
        system: true,
        primaryField: 'name',
        fields: [
          { key: 'name', label: t('Nombre'), type: 'text', required: true, system: true },
          { key: 'status', label: t('Estado'), type: 'select', defaultValue: 'prospecto', options: [
            { value: 'prospecto', label: t('Prospecto'), color: 'amber' },
            { value: 'cliente', label: t('Cliente'), color: 'emerald' },
            { value: 'partner', label: t('Partner'), color: 'violet' },
            { value: 'ex_cliente', label: t('Ex cliente'), color: 'slate' },
          ] },
          { key: 'tier', label: t('Importancia'), type: 'select', defaultValue: 'media', options: [
            { value: 'estrategica', label: t('Estratégica'), color: 'fuchsia' },
            { value: 'alta', label: t('Alta'), color: 'rose' },
            { value: 'media', label: t('Media'), color: 'amber' },
            { value: 'baja', label: t('Baja'), color: 'slate' },
          ] },
          { key: 'industry', label: t('Sector'), type: 'select', options: [
            { value: 'tecnologia', label: t('Tecnología'), color: 'indigo' },
            { value: 'retail', label: t('Retail'), color: 'orange' },
            { value: 'industria', label: t('Industria'), color: 'slate' },
            { value: 'servicios', label: t('Servicios'), color: 'teal' },
            { value: 'salud', label: t('Salud'), color: 'rose' },
            { value: 'finanzas', label: t('Finanzas'), color: 'emerald' },
            { value: 'educacion', label: t('Educación'), color: 'sky' },
            { value: 'otro', label: t('Otro'), color: 'slate' },
          ] },
          { key: 'size', label: t('Tamaño'), type: 'select', options: [
            { value: 's1_10', label: '1-10', color: 'slate' },
            { value: 's11_50', label: '11-50', color: 'slate' },
            { value: 's51_200', label: '51-200', color: 'slate' },
            { value: 's201_1000', label: '201-1000', color: 'slate' },
            { value: 's1000', label: '+1000', color: 'slate' },
          ] },
          { key: 'website', label: t('Web'), type: 'url' },
          { key: 'email', label: t('Email'), type: 'email' },
          { key: 'phone', label: t('Teléfono'), type: 'phone' },
          { key: 'city', label: t('Ciudad'), type: 'text' },
          { key: 'country', label: t('País'), type: 'text', ...(defaultCountry() ? { defaultValue: defaultCountry() } : {}) },
          { key: 'annual_revenue', label: t('Facturación anual'), type: 'currency', currency, min: 0 },
          { key: 'owner', label: t('Responsable'), type: 'user' },
          { key: 'tags', label: t('Etiquetas'), type: 'multi_select', options: [...TAGS] },
          { key: 'description', label: t('Descripción'), type: 'long_text' },
        ],
        views: [
          { key: 'all', label: t('Todas'), type: 'table', columns: ['name', 'status', 'tier', 'industry', 'city', 'owner', 'last_activity_at'], sort: { field: 'name', direction: 'asc' } },
          { key: 'by_status', label: t('Por estado'), type: 'kanban', groupBy: 'status', cardFields: ['tier', 'industry', 'owner'] },
        ],
        layout: [
          { title: t('Información general'), fields: ['name', 'status', 'tier', 'industry', 'size', 'owner', 'tags'], columns: 2 },
          { title: t('Contacto'), fields: ['website', 'email', 'phone', 'city', 'country'], columns: 2 },
          { title: t('Datos comerciales'), fields: ['annual_revenue', 'description'], columns: 1 },
        ],
      },
      {
        key: 'contacts',
        label: t('Contacto'),
        labelPlural: t('Contactos'),
        icon: 'users',
        color: 'indigo',
        description: t('Personas: clientes, leads y contactos de empresas.'),
        system: true,
        primaryField: 'name',
        fields: [
          { key: 'name', label: t('Nombre completo'), type: 'text', required: true, system: true },
          { key: 'email', label: t('Email'), type: 'email', unique: true },
          { key: 'phone', label: t('Teléfono'), type: 'phone' },
          { key: 'job_title', label: t('Cargo'), type: 'text' },
          { key: 'company', label: t('Empresa'), type: 'relation', relation: { module: 'companies' } },
          { key: 'lifecycle', label: t('Etapa'), type: 'select', defaultValue: 'lead', options: [
            { value: 'lead', label: t('Lead'), color: 'sky' },
            { value: 'cualificado', label: t('Cualificado'), color: 'indigo' },
            { value: 'oportunidad', label: t('Oportunidad@@ciclo de vida'), color: 'violet' },
            { value: 'cliente', label: t('Cliente'), color: 'emerald' },
            { value: 'inactivo', label: t('Inactivo'), color: 'slate' },
          ] },
          { key: 'source', label: t('Origen'), type: 'select', options: [...SOURCES] },
          { key: 'owner', label: t('Responsable'), type: 'user' },
          { key: 'tags', label: t('Etiquetas'), type: 'multi_select', options: [...TAGS] },
          { key: 'telegram', label: t('Usuario de Telegram'), type: 'text', helpText: t('Sin @. Se usa para vincular mensajes de Telegram.') },
          { key: 'city', label: t('Ciudad'), type: 'text' },
          { key: 'about', label: t('Notas internas'), type: 'long_text' },
        ],
        views: [
          { key: 'all', label: t('Todos'), type: 'table', columns: ['name', 'email', 'phone', 'company', 'lifecycle', 'owner', 'last_activity_at'], sort: { field: 'created_at', direction: 'desc' } },
          { key: 'by_lifecycle', label: t('Por etapa'), type: 'kanban', groupBy: 'lifecycle', cardFields: ['company', 'email', 'owner'] },
        ],
        layout: [
          { title: t('Persona'), fields: ['name', 'job_title', 'company', 'lifecycle', 'source', 'owner', 'tags'], columns: 2 },
          { title: t('Contacto'), fields: ['email', 'phone', 'telegram', 'city'], columns: 2 },
          { title: t('Notas'), fields: ['about'], columns: 1 },
        ],
      },
      {
        key: 'deals',
        label: t('Oportunidad'),
        labelPlural: t('Oportunidades'),
        icon: 'handshake',
        color: 'violet',
        description: t('Pipeline comercial con etapas personalizables.'),
        system: true,
        primaryField: 'title',
        fields: [
          { key: 'title', label: t('Nombre'), type: 'text', required: true, system: true },
          { key: 'stage', label: t('Etapa'), type: 'select', required: true, defaultValue: 'nuevo', options: [
            { value: 'nuevo', label: t('Nuevo'), color: 'sky' },
            { value: 'cualificado', label: t('Cualificado'), color: 'indigo' },
            { value: 'propuesta', label: t('Propuesta'), color: 'violet' },
            { value: 'negociacion', label: t('Negociación'), color: 'amber' },
            { value: 'ganado', label: t('Ganado'), color: 'emerald' },
            { value: 'perdido', label: t('Perdido'), color: 'rose' },
          ] },
          { key: 'amount', label: t('Importe'), type: 'currency', currency, min: 0 },
          { key: 'probability', label: t('Probabilidad de cierre'), type: 'percent', min: 0, max: 100, defaultValue: 10 },
          { key: 'weighted_amount', label: t('Importe ponderado'), type: 'formula', currency, formula: { expression: '{amount} * {probability} / 100', resultType: 'number' } },
          { key: 'expected_close', label: t('Fecha de cierre prevista'), type: 'date' },
          { key: 'company', label: t('Empresa'), type: 'relation', relation: { module: 'companies' } },
          { key: 'contact', label: t('Contacto principal'), type: 'relation', relation: { module: 'contacts' } },
          { key: 'owner', label: t('Comercial'), type: 'user' },
          { key: 'source', label: t('Origen'), type: 'select', options: [...SOURCES] },
          { key: 'next_step', label: t('Próximo paso'), type: 'text' },
          { key: 'lost_reason', label: t('Motivo de pérdida'), type: 'text' },
          { key: 'description', label: t('Descripción'), type: 'long_text' },
        ],
        views: [
          { key: 'pipeline', label: t('Pipeline'), type: 'kanban', groupBy: 'stage', cardFields: ['amount', 'company', 'expected_close', 'owner'] },
          { key: 'all', label: t('Todas'), type: 'table', columns: ['title', 'stage', 'amount', 'probability', 'weighted_amount', 'expected_close', 'company', 'owner'], sort: { field: 'expected_close', direction: 'asc' } },
          { key: 'calendar', label: t('Cierres'), type: 'calendar', dateField: 'expected_close', colorBy: 'stage' },
        ],
        layout: [
          { title: t('Oportunidad'), fields: ['title', 'stage', 'amount', 'probability', 'weighted_amount', 'expected_close', 'owner', 'source'], columns: 2 },
          { title: t('Relaciones'), fields: ['company', 'contact'], columns: 2 },
          { title: t('Seguimiento'), fields: ['next_step', 'lost_reason', 'description'], columns: 1 },
        ],
      },
      {
        key: 'tasks',
        label: t('Tarea'),
        labelPlural: t('Tareas'),
        icon: 'check-square',
        color: 'emerald',
        description: t('Tareas, recordatorios y seguimiento del equipo.'),
        system: true,
        primaryField: 'title',
        fields: [
          { key: 'title', label: t('Tarea'), type: 'text', required: true, system: true },
          { key: 'status', label: t('Estado'), type: 'select', required: true, defaultValue: 'pendiente', options: [
            { value: 'pendiente', label: t('Pendiente'), color: 'amber' },
            { value: 'en_curso', label: t('En curso'), color: 'sky' },
            { value: 'completada', label: t('Completada'), color: 'emerald' },
            { value: 'cancelada', label: t('Cancelada'), color: 'slate' },
          ] },
          { key: 'priority', label: t('Prioridad'), type: 'select', defaultValue: 'media', options: [
            { value: 'urgente', label: t('Urgente'), color: 'red' },
            { value: 'alta', label: t('Alta'), color: 'orange' },
            { value: 'media', label: t('Media'), color: 'amber' },
            { value: 'baja', label: t('Baja'), color: 'slate' },
          ] },
          { key: 'due_date', label: t('Vencimiento'), type: 'date' },
          { key: 'reminder_at', label: t('Recordatorio'), type: 'datetime' },
          { key: 'assignee', label: t('Asignada a'), type: 'user' },
          { key: 'contact', label: t('Contacto'), type: 'relation', relation: { module: 'contacts' } },
          { key: 'company', label: t('Empresa'), type: 'relation', relation: { module: 'companies' } },
          { key: 'deal', label: t('Oportunidad'), type: 'relation', relation: { module: 'deals' } },
          { key: 'description', label: t('Descripción'), type: 'long_text' },
        ],
        views: [
          { key: 'open', label: t('Pendientes'), type: 'table', columns: ['title', 'status', 'priority', 'due_date', 'assignee', 'contact', 'deal'], sort: { field: 'due_date', direction: 'asc' }, filters: [{ field: 'status', operator: 'in', value: ['pendiente', 'en_curso'] }] },
          { key: 'board', label: t('Tablero'), type: 'kanban', groupBy: 'status', cardFields: ['priority', 'due_date', 'assignee'] },
          { key: 'calendar', label: t('Calendario'), type: 'calendar', dateField: 'due_date', colorBy: 'priority' },
          { key: 'all', label: t('Todas'), type: 'table', columns: ['title', 'status', 'priority', 'due_date', 'assignee'], sort: { field: 'created_at', direction: 'desc' } },
        ],
        layout: [
          { title: t('Tarea'), fields: ['title', 'status', 'priority', 'due_date', 'reminder_at', 'assignee'], columns: 2 },
          { title: t('Relacionado con'), fields: ['contact', 'company', 'deal'], columns: 2 },
          { title: t('Detalle'), fields: ['description'], columns: 1 },
        ],
      },
      {
        key: 'activities',
        label: t('Actividad'),
        labelPlural: t('Actividades'),
        icon: 'activity',
        color: 'amber',
        description: t('Llamadas, reuniones, emails y visitas comerciales.'),
        system: true,
        primaryField: 'subject',
        fields: [
          { key: 'subject', label: t('Asunto'), type: 'text', required: true, system: true },
          { key: 'type', label: t('Tipo'), type: 'select', required: true, defaultValue: 'llamada', options: [
            { value: 'llamada', label: t('Llamada'), color: 'sky' },
            { value: 'reunion', label: t('Reunión'), color: 'violet' },
            { value: 'email', label: t('Email'), color: 'indigo' },
            { value: 'visita', label: t('Visita'), color: 'emerald' },
            { value: 'otro', label: t('Otro'), color: 'slate' },
          ] },
          { key: 'date', label: t('Fecha'), type: 'datetime', defaultValue: '{{now}}' },
          { key: 'outcome', label: t('Resultado'), type: 'select', options: [
            { value: 'positivo', label: t('Positivo'), color: 'emerald' },
            { value: 'neutral', label: t('Neutral'), color: 'slate' },
            { value: 'negativo', label: t('Negativo'), color: 'rose' },
          ] },
          { key: 'contact', label: t('Contacto'), type: 'relation', relation: { module: 'contacts' } },
          { key: 'company', label: t('Empresa'), type: 'relation', relation: { module: 'companies' } },
          { key: 'deal', label: t('Oportunidad'), type: 'relation', relation: { module: 'deals' } },
          { key: 'owner', label: t('Comercial'), type: 'user' },
          { key: 'details', label: t('Detalle'), type: 'long_text' },
        ],
        views: [
          { key: 'all', label: t('Todas'), type: 'table', columns: ['subject', 'type', 'date', 'outcome', 'contact', 'company', 'owner'], sort: { field: 'date', direction: 'desc' } },
          { key: 'calendar', label: t('Calendario'), type: 'calendar', dateField: 'date', colorBy: 'type' },
        ],
      },
    ],
    automations: [
      {
        key: 'deal_won_probability',
        name: t('Oportunidad ganada → probabilidad 100%'),
        description: t('Al marcar una oportunidad como ganada, la probabilidad pasa a 100%.'),
        trigger: { type: 'field_changed', module: 'deals', field: 'stage', to: 'ganado' },
        actions: [{ type: 'update_field', field: 'probability', value: 100 }],
      },
      {
        key: 'deal_lost_probability',
        name: t('Oportunidad perdida → probabilidad 0%'),
        trigger: { type: 'field_changed', module: 'deals', field: 'stage', to: 'perdido' },
        actions: [{ type: 'update_field', field: 'probability', value: 0 }],
      },
      {
        key: 'task_reminder',
        name: t('Recordatorio de tarea'),
        description: t('Avisa a la persona asignada cuando llega la hora del recordatorio.'),
        trigger: { type: 'date_reached', module: 'tasks', field: 'reminder_at', offsetDays: 0 },
        conditions: [{ field: 'status', operator: 'in', value: ['pendiente', 'en_curso'] }],
        // {{record.title}} es una plantilla de la automatización: va como variable para que ninguna traducción la pierda.
        actions: [{ type: 'notify', to: { type: 'user_field', field: 'assignee' }, title: t('Recordatorio: {name}', { name: '{{record.title}}' }), body: t('Tienes una tarea pendiente.') }],
      },
    ],
    dashboards: [
      {
        key: 'main',
        label: t('Panel principal'),
        widgets: [
          { key: 'open_pipeline', title: t('Pipeline abierto'), type: 'metric', module: 'deals', aggregate: 'sum', field: 'amount', filters: [{ field: 'stage', operator: 'in', value: ['nuevo', 'cualificado', 'propuesta', 'negociacion'] }] },
          { key: 'won_month', title: t('Ganado este mes'), type: 'metric', module: 'deals', aggregate: 'sum', field: 'amount', filters: [{ field: 'stage', operator: 'eq', value: 'ganado' }, { field: 'updated_at', operator: 'gte', value: '{{month_start}}' }] },
          { key: 'contacts_total', title: t('Contactos'), type: 'metric', module: 'contacts', aggregate: 'count' },
          { key: 'open_tasks', title: t('Tareas abiertas'), type: 'metric', module: 'tasks', aggregate: 'count', filters: [{ field: 'status', operator: 'in', value: ['pendiente', 'en_curso'] }] },
          { key: 'pipeline_by_stage', title: t('Pipeline por etapa'), type: 'bar', module: 'deals', aggregate: 'sum', field: 'amount', groupBy: 'stage', size: 'lg' },
          { key: 'contacts_by_stage', title: t('Contactos por etapa'), type: 'donut', module: 'contacts', groupBy: 'lifecycle', size: 'md' },
          { key: 'new_contacts', title: t('Nuevos contactos'), type: 'line', module: 'contacts', dateField: 'created_at', interval: 'month', size: 'lg' },
          { key: 'upcoming_tasks', title: t('Próximas tareas'), type: 'list', module: 'tasks', limit: 6, size: 'md', filters: [{ field: 'status', operator: 'in', value: ['pendiente', 'en_curso'] }] },
        ],
      },
    ],
    integrations: [],
    forms: [
      { key: 'web_lead', name: t('Formulario de contacto web'), module: 'contacts', fields: ['name', 'email', 'phone', 'about'], public: false, defaults: { source: 'web', lifecycle: 'lead' } },
    ],
  };
}

/** El CRM por defecto calculado una vez al cargar el módulo (fuera de cualquier petición: en español). */
export const DEFAULT_BLUEPRINT_INPUT: BlueprintInput = defaultBlueprintInput();

/** El CRM con el que empieza una organización nueva, con los importes en su moneda (por defecto, euros). */
export function defaultBlueprint(opts: { currency?: string } = {}): Blueprint {
  return BlueprintSchema.parse(defaultBlueprintInput(opts.currency));
}
