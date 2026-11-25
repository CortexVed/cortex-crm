import { z } from 'zod';
import type { AppDeps } from '../deps';
import { extractJson } from '../ai/json';
import type { ToolCall, ToolSpec } from '../ai/types';
import { engineOptions } from './options';
import { PathError } from './paths';
import { agentUserMessage, codeAgentSystem } from './prompts';
import type { VirtualWorkspace } from './workspace';

/**
 * Agente de código (tarea `code_modification` del AI PROVIDER MANAGER, con la configuración de IA de la
 * organización activa de quien pidió el cambio). Sus herramientas solo leen y escriben texto en el espacio
 * de trabajo virtual: nada de lo que escribe se ejecuta en este proceso.
 */

export interface AgentSummary {
  title: string;
  summary: string;
  testsAdded: string[];
}

export interface AgentResult extends AgentSummary {
  provider: string;
  model: string;
  costUsd: number;
  steps: number;
  calls: { reads: number; writes: number; edits: number; deletes: number; errors: number };
}

const READ_LINES = 250;
const MAX_LIST = 300;
const MAX_MATCHES = 80;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const AGENT_TOOLS: ToolSpec[] = [
  { name: 'list_files', description: `Lista las rutas del proyecto, opcionalmente bajo un prefijo (p. ej. "server/src/crm/"). Devuelve como mucho ${MAX_LIST}.`, inputSchema: obj({ prefix: { type: 'string', description: 'Prefijo de ruta' } }) },
  {
    name: 'read_file',
    description: `Lee un archivo de texto con números de línea. Sin rango, las primeras ${READ_LINES} líneas; usa start_line y end_line para leer otros tramos.`,
    inputSchema: obj({ path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, ['path']),
  },
  {
    name: 'search_code',
    description: `Busca una expresión regular de JavaScript (sin cuantificadores anidados ni referencias hacia atrás) línea a línea en los archivos de texto. Devuelve hasta ${MAX_MATCHES} coincidencias "ruta:línea: texto".`,
    inputSchema: obj({ pattern: { type: 'string' }, path_prefix: { type: 'string' }, case_insensitive: { type: 'boolean' } }, ['pattern']),
  },
  { name: 'write_file', description: 'Crea un archivo o sustituye su contenido completo.', inputSchema: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
  {
    name: 'edit_file',
    description: 'Reemplaza un texto exacto de un archivo existente. old_string debe aparecer exactamente una vez (incluye contexto suficiente) salvo que replace_all sea true.',
    inputSchema: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
  },
  { name: 'delete_file', description: 'Borra un archivo.', inputSchema: obj({ path: { type: 'string' } }, ['path']) },
  {
    name: 'finish',
    description: 'Termina el trabajo: título corto del cambio, resumen de lo hecho (o de por qué no se puede hacer) y pruebas añadidas.',
    inputSchema: obj({ title: { type: 'string' }, summary: { type: 'string' }, tests_added: { type: 'array', items: { type: 'string' } } }, ['title', 'summary']),
  },
];

const ReadInput = z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() });
const ListInput = z.object({ prefix: z.string().max(240).optional() });
const SearchInput = z.object({ pattern: z.string().min(1).max(200), path_prefix: z.string().max(240).optional(), case_insensitive: z.boolean().optional() });
const WriteInput = z.object({ path: z.string(), content: z.string() });
const EditInput = z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() });
const DeleteInput = z.object({ path: z.string() });
const FinishInput = z.object({ title: z.string().min(1).max(200), summary: z.string().min(1).max(6000), tests_added: z.array(z.string().max(300)).max(50).optional() });

/** Expresión regular para search_code, rechazando las formas con riesgo de backtracking catastrófico. */
export function compileSearch(pattern: string, caseInsensitive = false): RegExp {
  if (/\\[1-9]|\\k</.test(pattern)) throw new PathError('No se admiten referencias hacia atrás');
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/.test(pattern)) throw new PathError('No se admiten cuantificadores anidados como (a+)+');
  try {
    return new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (e) {
    throw new PathError(`Expresión regular no válida: ${(e as Error).message}`);
  }
}

function numbered(text: string, start: number, end: number): string {
  const lines = text.split('\n');
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end);
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${String(i).padStart(5)}\t${lines[i - 1].slice(0, 2000)}`);
  return out.join('\n');
}

export async function runCodeAgent(
  deps: AppDeps,
  input: {
    workspaceId: string;
    userId: string | null;
    changeId: string;
    prompt: string;
    feedback: string[];
    problems: string[];
    round: number;
    workspace: VirtualWorkspace;
    signal?: AbortSignal;
  },
): Promise<AgentResult> {
  const ws = input.workspace;
  const calls = { reads: 0, writes: 0, edits: 0, deletes: 0, errors: 0 };
  // (aserción para que TypeScript no fije el tipo a null: se asigna dentro de la herramienta finish)
  let finished = null as AgentSummary | null;

  const execute = async (call: ToolCall): Promise<{ content: string; isError?: boolean }> => {
    try {
      switch (call.name) {
        case 'list_files': {
          const { prefix } = ListInput.parse(call.input ?? {});
          const all = ws.list(prefix ?? '');
          if (!all.length) return { content: 'No hay archivos con ese prefijo.' };
          return { content: `${all.slice(0, MAX_LIST).join('\n')}${all.length > MAX_LIST ? `\n… y ${all.length - MAX_LIST} más (usa un prefijo más concreto)` : ''}` };
        }
        case 'read_file': {
          const { path, start_line, end_line } = ReadInput.parse(call.input ?? {});
          calls.reads++;
          const text = ws.read(path);
          if (text === null) return { content: `${path} no existe`, isError: true };
          const total = text.split('\n').length;
          const start = start_line ?? 1;
          const end = Math.min(end_line ?? start + READ_LINES - 1, start + 600);
          const body = numbered(text, start, end).slice(0, 28_000);
          return { content: `${path} (líneas ${start}-${Math.min(end, total)} de ${total})\n${body}${end < total ? `\n… quedan ${total - end} líneas (usa start_line=${end + 1})` : ''}` };
        }
        case 'search_code': {
          const { pattern, path_prefix, case_insensitive } = SearchInput.parse(call.input ?? {});
          const re = compileSearch(pattern, case_insensitive);
          const out: string[] = [];
          for (const p of ws.list(path_prefix ?? '')) {
            let text: string | null;
            try {
              text = ws.read(p);
            } catch {
              continue; // binario
            }
            if (!text || text.length > 600_000) continue;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
              const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
              if (re.test(line)) out.push(`${p}:${i + 1}: ${line.trim().slice(0, 300)}`);
            }
            if (out.length >= MAX_MATCHES) break;
          }
          return { content: out.length ? `${out.join('\n')}${out.length >= MAX_MATCHES ? '\n… (hay más coincidencias: acota la búsqueda)' : ''}` : 'Sin coincidencias.' };
        }
        case 'write_file': {
          const { path, content } = WriteInput.parse(call.input ?? {});
          ws.write(path, content);
          calls.writes++;
          return { content: `Escrito ${path} (${content.split('\n').length} líneas).` };
        }
        case 'edit_file': {
          const { path, old_string, new_string, replace_all } = EditInput.parse(call.input ?? {});
          const text = ws.read(path);
          if (text === null) return { content: `${path} no existe`, isError: true };
          const n = text.split(old_string).length - 1;
          if (n === 0) return { content: `old_string no aparece en ${path}: léelo de nuevo y copia el texto exacto`, isError: true };
          if (n > 1 && !replace_all) return { content: `old_string aparece ${n} veces en ${path}: añade contexto para que sea único o usa replace_all`, isError: true };
          ws.write(path, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string));
          calls.edits++;
          return { content: `Editado ${path} (${replace_all ? n : 1} reemplazo(s)).` };
        }
        case 'delete_file': {
          const { path } = DeleteInput.parse(call.input ?? {});
          ws.remove(path);
          calls.deletes++;
          return { content: `Borrado ${path}.` };
        }
        case 'finish': {
          const f = FinishInput.parse(call.input ?? {});
          finished = { title: f.title, summary: f.summary, testsAdded: f.tests_added ?? [] };
          return { content: 'Resumen registrado. Termina sin llamar a más herramientas.' };
        }
        default:
          return { content: `Herramienta desconocida: ${call.name}`, isError: true };
      }
    } catch (e) {
      calls.errors++;
      if (e instanceof z.ZodError) return { content: `Entrada no válida: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
      if (e instanceof PathError) return { content: `Error: ${e.message}`, isError: true };
      throw e;
    }
  };

  const before = new Set(ws.changes().map((c) => c.path));
  const result = await deps.ai.runAgent(input.workspaceId, {
    task: 'code_modification',
    system: codeAgentSystem(ws.base),
    messages: [{ role: 'user', content: agentUserMessage({ prompt: input.prompt, feedback: input.feedback, changedPaths: [...before], problems: input.problems, round: input.round }) }],
    tools: AGENT_TOOLS,
    execute,
    maxSteps: engineOptions().maxAgentSteps,
    maxTokens: 32_000,
    userId: input.userId,
    ref: input.changeId,
    signal: input.signal,
  });

  let summary: AgentSummary | null = finished;
  if (!summary) {
    // Sin finish (p. ej. se agotaron los pasos): se intenta leer un resumen JSON del texto final.
    try {
      const parsed = FinishInput.safeParse(extractJson(result.text));
      if (parsed.success) summary = { title: parsed.data.title, summary: parsed.data.summary, testsAdded: parsed.data.tests_added ?? [] };
    } catch {
      /* texto libre */
    }
  }
  summary ??= { title: input.prompt.slice(0, 120), summary: result.text.trim().slice(0, 4000) || 'El agente terminó sin resumen.', testsAdded: [] };
  return { ...summary, provider: result.provider, model: result.model, costUsd: result.costUsd, steps: result.steps, calls };
}
