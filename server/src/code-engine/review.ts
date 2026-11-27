import { z } from 'zod';
import type { AppDeps } from '../deps';
import { t } from '../i18n';
import { unifiedDiff } from './diff';
import type { Flag, GuardStats } from './guards';
import { reviewSystem } from './prompts';
import type { ReviewResult } from './store';
import type { FileChange } from './workspace';

/**
 * Revisión cruzada de seguridad con IA (tarea `code_review`): preferiblemente con un proveedor distinto del que
 * escribió el código, como hace EVOLVE; si solo hay uno, con el mismo (se indica). Es informativa: la decisión
 * es de la persona que aprueba, y el riesgo de un cambio de código es siempre alto.
 */

const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'concerns', 'reject']),
  summary: z.string().max(4000),
  concerns: z
    .array(z.object({ severity: z.enum(['low', 'medium', 'high', 'critical']), file: z.string().max(240).optional(), message: z.string().max(1500) }))
    .max(30)
    .default([]),
});

const MAX_DIFF_CHARS = 150_000;

export function reviewDiff(changes: FileChange[], maxChars = MAX_DIFF_CHARS): { text: string; truncated: boolean } {
  let text = '';
  let truncated = false;
  for (const c of changes) {
    const d = unifiedDiff(c.path, c.before, c.after);
    if (text.length + d.length > maxChars) {
      truncated = true;
      text += `\n[diff de ${c.path} omitido por tamaño]\n`;
      continue;
    }
    text += `${d}\n`;
  }
  return { text, truncated };
}

export async function runReview(
  deps: AppDeps,
  input: { workspaceId: string; userId: string | null; changeId: string; prompt: string; title: string; summary: string; changes: FileChange[]; flags: Flag[]; stats: Partial<GuardStats>; agentProvider: string | null },
): Promise<ReviewResult> {
  const at = () => deps.now().toISOString();
  const candidates = await deps.ai.plan(input.workspaceId, 'code_review');
  const other = candidates.filter((c) => c.provider !== input.agentProvider);
  const target = other[0] ?? candidates[0];
  if (!target) return { status: 'skipped', message: t('No hay ningún proveedor de IA disponible para la revisión'), at: at() };
  const diff = reviewDiff(input.changes);
  try {
    const res = await deps.ai.runJson(
      input.workspaceId,
      {
        task: 'code_review',
        system: reviewSystem(),
        target,
        maxTokens: 8000,
        userId: input.userId,
        ref: input.changeId,
        messages: [
          {
            role: 'user',
            content: [
              `[PETICIÓN]\n${input.prompt}\n[/PETICIÓN]`,
              `Resumen del autor (otra IA): ${input.title}\n${input.summary}`,
              `Estadísticas: ${JSON.stringify(input.stats)}`,
              `Avisos deterministas: ${input.flags.map((f) => `${f.message}${f.paths?.length ? ` (${f.paths.slice(0, 10).join(', ')})` : ''}`).join(' · ') || 'ninguno'}`,
              `[DIFF]\n${diff.text}${diff.truncated ? '\n[el diff se ha recortado por tamaño]' : ''}\n[/DIFF]`,
            ].join('\n\n'),
          },
        ],
      },
      ReviewSchema,
      1,
    );
    return { status: 'done', ...res.value, provider: res.result.provider, model: res.result.model, sameProvider: res.result.provider === input.agentProvider, truncated: diff.truncated, at: at() };
  } catch (e) {
    return { status: 'error', message: t('No se pudo completar la revisión: {error}', { error: (e as Error).message.slice(0, 300) }), at: at() };
  }
}
