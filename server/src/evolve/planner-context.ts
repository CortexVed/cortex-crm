import type { Blueprint, Module } from '../../../shared/blueprint';
import type { OutlinePart } from '../../../shared/changeset';
import { compactBlueprint } from './prompts';

/**
 * CONTEXTO DEL PLANIFICADOR PARA BLUEPRINTS GRANDES. Sin límite de módulos, el blueprint completo puede no caber
 * en el contexto del modelo. Hasta `PLANNER_FULL_BLUEPRINT_CHARS` se envía completo (como siempre); por encima,
 * un ÍNDICE de todo (claves, etiquetas y campos `clave:tipo`) más el DETALLE completo de los módulos relevantes
 * para la petición: los que nombra (por clave o etiqueta) y los relacionados con ellos.
 */
export const PLANNER_FULL_BLUEPRINT_CHARS = 120_000;
export const PLANNER_DETAIL_CHARS = 90_000;
/** Presupuesto del índice: con miles de módulos se muestran menos campos por módulo (mínimo 3). */
export const PLANNER_INDEX_CHARS = 150_000;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]+/g, ' ');

/** Módulos que la petición nombra (clave, etiqueta o plural) y sus relaciones directas en ambos sentidos. */
export function relevantModules(bp: Blueprint, text: string): string[] {
  const words = ` ${normalize(text)} `;
  const named = bp.modules.filter((m) => [m.key, m.key.replace(/_/g, ' '), m.label, m.labelPlural].some((n) => n && words.includes(` ${normalize(n).trim()} `)));
  const out = new Set(named.map((m) => m.key));
  for (const m of named) {
    for (const f of m.fields) if (f.type === 'relation' && f.relation) out.add(f.relation.module);
    for (const other of bp.modules) if (other.fields.some((f) => f.type === 'relation' && f.relation?.module === m.key)) out.add(other.key);
  }
  return [...out].filter((k) => bp.modules.some((m) => m.key === k));
}

function moduleIndexLine(m: Module, fieldsPerModule: number): string {
  const fields = m.fields.filter((f) => !f.archived);
  const shown = fields.slice(0, fieldsPerModule).map((f) => `${f.key}:${f.type}${f.relation ? `→${f.relation.module}` : ''}`);
  const more = fields.length > shown.length ? `, …(+${fields.length - shown.length})` : '';
  return `- ${m.key}${m.archived ? ' [archivado]' : ''} (${m.label} / ${m.labelPlural}; lectura ${m.permissions.read}): ${shown.join(', ')}${more}`;
}

/** Blueprint para el planificador: completo si cabe; si no, índice + detalle de los módulos relevantes. */
export function blueprintForPlanner(bp: Blueprint, text: string): { mode: 'full' | 'index'; content: string; detailed: string[] } {
  const full = JSON.stringify(compactBlueprint(bp));
  if (full.length <= PLANNER_FULL_BLUEPRINT_CHARS) return { mode: 'full', content: full, detailed: bp.modules.map((m) => m.key) };

  const detailed: string[] = [];
  const detailParts: string[] = [];
  let used = 0;
  for (const key of relevantModules(bp, text)) {
    const m = bp.modules.find((x) => x.key === key)!;
    // compactBlueprint() compacta cualquier objeto (quita valores por defecto), también un módulo suelto.
    const moduleJson = JSON.stringify(compactBlueprint(m as unknown as Blueprint));
    if (used + moduleJson.length > PLANNER_DETAIL_CHARS) break;
    used += moduleJson.length;
    detailed.push(key);
    detailParts.push(moduleJson);
  }
  const fieldsPerModule = Math.max(3, Math.min(80, Math.floor((PLANNER_INDEX_CHARS / Math.max(1, bp.modules.length) - 60) / 16)));
  const automations = bp.automations.map((a) => `- ${a.key}: ${a.trigger.type} en ${a.trigger.module} → ${a.actions.map((x) => x.type).join(', ')}${a.enabled ? '' : ' [desactivada]'}`);
  const lines = [
    `(El blueprint es grande: ${bp.modules.length} módulos. Se muestra un ÍNDICE de todo y el DETALLE completo solo de los módulos relevantes para la petición. Los módulos del índice existen con los campos listados: reutilízalos y no los dupliques. Si necesitas modificar un módulo que solo aparece en el índice, basa los cambios en sus claves de campo.)`,
    `### Índice de módulos\n${bp.modules.map((m) => moduleIndexLine(m, fieldsPerModule)).join('\n')}`,
    `### Detalle de los módulos relevantes (${detailed.length})\n${detailParts.length ? `[${detailParts.join(',')}]` : '(ninguno nombrado en la petición)'}`,
    `### Automatizaciones (${bp.automations.length})\n${automations.slice(0, 400).join('\n') || '- (ninguna)'}${automations.length > 400 ? `\n- …(+${automations.length - 400})` : ''}`,
    `### Paneles: ${bp.dashboards.map((d) => d.key).join(', ') || '(ninguno)'}`,
    `### Formularios: ${bp.forms.map((f) => `${f.key}→${f.module}${f.public ? ' (público)' : ''}`).join(', ') || '(ninguno)'}`,
    `### Integraciones: ${bp.integrations.map((i) => i.key).join(', ') || '(ninguna)'}`,
    `### Scripts: ${(bp.scripts ?? []).map((s) => s.key).join(', ') || '(ninguno)'}`,
    // Capa visual: es pequeña, va completa (el planificador la necesita para cambios de aspecto).
    `### Apariencia\n${bp.appearance ? JSON.stringify(compactBlueprint(bp.appearance as unknown as Blueprint)) : '(la de por defecto)'}`,
    `### Menú\n${bp.navigation ? JSON.stringify(compactBlueprint(bp.navigation as unknown as Blueprint)).slice(0, 20_000) : '(el de por defecto)'}`,
    `### Páginas (${bp.pages?.length ?? 0}): ${(bp.pages ?? []).map((p) => `${p.key} (${p.label}; ${p.blocks.length} bloques)`).join(', ') || '(ninguna)'}`,
  ];
  return { mode: 'index', content: lines.join('\n\n'), detailed };
}

export interface PlannerContextInput {
  orgName: string;
  settings: { timezone: string; currency: string; industry?: string; description?: string };
  version: number;
  blueprint: Blueprint;
  releases: { title: string; created_at: string; kind: string }[];
  memory: { kind: string; content: string }[];
  prompt: string;
  feedback?: string[];
}

function header(input: PlannerContextInput, blueprintText: string, mode: 'full' | 'index'): string[] {
  return [
    `## Organización\n${input.orgName} · sector: ${input.settings.industry ?? 'no indicado'} · zona horaria: ${input.settings.timezone} · moneda: ${input.settings.currency}${input.settings.description ? `\n${input.settings.description}` : ''}`,
    `## Blueprint actual (versión ${input.version}${mode === 'index' ? ', resumido por tamaño' : ''})\n${blueprintText}`,
    `## Historial reciente de cambios\n${input.releases.length ? input.releases.map((r) => `- ${String(r.created_at).slice(0, 10)} · ${r.kind} · ${r.title}`).join('\n') : '- (sin cambios previos)'}`,
    `## Memoria de decisiones y preferencias\n${input.memory.length ? input.memory.map((m) => `- [${m.kind}] ${m.content}`).join('\n') : '- (vacía)'}`,
  ];
}

/** Mensaje del planificador para la petición completa (primer paso). */
export function plannerMessage(input: PlannerContextInput): string {
  const view = blueprintForPlanner(input.blueprint, `${input.prompt}\n${(input.feedback ?? []).join('\n')}`);
  const lines = [...header(input, view.content, view.mode), `## Petición del usuario\n${input.prompt}`];
  if (input.feedback?.length) lines.push(`## Indicaciones adicionales del usuario sobre el plan anterior\n${input.feedback.map((f) => `- ${f}`).join('\n')}`);
  lines.push('Devuelve el ChangeSet en JSON.');
  return lines.join('\n\n');
}

/**
 * Mensaje para generar UNA parte de un plan grande. El blueprint que recibe ya incluye las partes anteriores,
 * de modo que puede referenciar sus módulos y campos.
 */
export function plannerPartMessage(input: PlannerContextInput & { outline: OutlinePart[]; part: OutlinePart; problems?: string[] }): string {
  const view = blueprintForPlanner(input.blueprint, `${input.part.title}\n${input.part.description}`);
  const index = input.outline.findIndex((p) => p.key === input.part.key);
  const lines = [
    ...header(input, view.content, view.mode),
    `## Petición original del usuario\n${input.prompt}`,
    `## Plan por partes\n${input.outline.map((p, i) => `${i + 1}. ${p.title}${i < index ? ' (ya generada: está en el blueprint de arriba)' : i === index ? ' ← ESTA PARTE' : ''}`).join('\n')}`,
    `## Parte que debes generar ahora: ${input.part.title}\n${input.part.description}`,
  ];
  if (input.feedback?.length) lines.push(`## Indicaciones adicionales del usuario\n${input.feedback.map((f) => `- ${f}`).join('\n')}`);
  if (input.problems?.length) lines.push(`## Problemas de tu intento anterior de esta parte (corrígelos)\n${input.problems.map((p) => `- ${p}`).join('\n')}`);
  lines.push('Devuelve un ChangeSet en JSON SOLO con las operaciones y de 1 a 3 pruebas de ESTA parte (sin "outline"). No repitas operaciones de partes anteriores; puedes usar sus módulos y campos.');
  return lines.join('\n\n');
}
