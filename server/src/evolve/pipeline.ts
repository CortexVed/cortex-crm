import { z } from 'zod';
import { RISK_LABELS, type Role } from '../../../shared/constants';
import { activeModules, findModule, type Blueprint } from '../../../shared/blueprint';
import { CHANGESET_LIMITS, ChangeSetSchema, type ChangeSet, type Operation, type OutlinePart } from '../../../shared/changeset';
import { describeModules } from '../crm/ai-features';
import { applyOperations } from './apply';
import type { AppDeps } from '../deps';
import type { Queryable } from '../db/db';
import { loadWorkspace } from '../crm/context';
import type { StoredRecord } from '../crm/store';
import { listMemory } from '../ai/memory';
import { ProviderError } from '../ai/types';
import { simulateChangeSet, type TestReport } from './simulator';
import { assessRisk } from './risk';
import { buildImpact } from './impact';
import { plannerSystem, reviewSystem, scriptCodeSystem, selfHealMessage } from './prompts';
import { plannerMessage, plannerPartMessage, type PlannerContextInput } from './planner-context';
import type { Issue } from './validate';
import { inSentence, msg, t, tk, tp } from '../i18n';

/** Pasos del pipeline. Las etiquetas se traducen al mostrarlas (tk). */
export const PIPELINE_STEPS = [
  { key: 'interpret', label: msg('Interpretar la petición') },
  { key: 'analyze', label: msg('Analizar arquitectura, módulos, datos y permisos') },
  { key: 'plan', label: msg('Planificar cambios') },
  { key: 'develop', label: msg('Desarrollar en entorno aislado') },
  { key: 'test', label: msg('Probar (unitarias, integración, compatibilidad, seguridad)') },
  { key: 'review', label: msg('Revisión cruzada con otro modelo') },
  { key: 'present', label: msg('Presentar para aprobación') },
] as const;

type StepKey = (typeof PIPELINE_STEPS)[number]['key'];

interface ProgressEntry {
  step: StepKey;
  status: 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  at: string;
}

const MAX_SELF_HEAL = 2;
/** Tope del change set que ve el revisor cruzado (un plan muy grande se le muestra recortado). */
const REVIEW_MAX_CHARS = 150_000;

/**
 * Palabras que delatan una petición de automatización, en los siete idiomas de Cortex. Es un único patrón lineal
 * (sin cuantificadores anidados). \b no sirve para el japonés, que no separa las palabras con espacios: va aparte.
 */
const AUTOMATION_HINTS = new RegExp(
  String.raw`\b(` +
    [
      // español
      String.raw`automatiza\w*|automátic\w*|automatic\w*|recordatori\w*|recu[eé]rda\w*|av[ií]s\w*|notifica\w*|alerta\w*|webhook\w*|cada (d[ií]a|semana|mes|lunes|martes|mi[eé]rcoles|jueves|viernes)|cuando (se |un |una |el |la |ganemos|perdamos|cambie|pase|llegue|venza|lleve)`,
      // inglés
      String.raw`automat\w*|remind\w*|notif\w*|alert\w*|every (day|week|month|morning|time|monday|tuesday|wednesday|thursday|friday)|whenever|when (a |an |the |someone|we win|we lose)`,
      // portugués de Brasil
      String.raw`lembr\w*|todo dia|todos os dias|toda semana|todas as semanas|todo m[eê]s|todos os meses|toda (segunda|ter[çc]a|quarta|quinta|sexta)|toda vez|sempre que`,
      // portugués e italiano («quando …»)
      String.raw`quando (um |uma |o |a |un |un'|una |il |la |lo |l'|algu[eé]m|qualcuno|ganharmos|perdermos|vinciamo|perdiamo)`,
      // francés
      String.raw`rappel\w*|chaque (jour|semaine|mois|matin|fois|lundi|mardi|mercredi|jeudi|vendredi)|tous les (jours|mois|matins|lundis|mardis|mercredis|jeudis|vendredis)|toutes les semaines|lorsqu\w*|quand (un |une |le |la |l'|on gagne|on perd|quelqu'un)`,
      // alemán
      String.raw`erinner\w*|benachrichtig\w*|warnung\w*|jeden (tag|monat|morgen|montag|dienstag|mittwoch|donnerstag|freitag)|jede woche|jedes mal|sobald|wenn (ein |eine |einer |der |die |das |jemand|wir )`,
      // italiano
      String.raw`promemoria|ricord\w*|avvis\w*|ogni (giorno|settimana|mese|mattina|volta|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì])`,
    ].join('|') +
    // japonés (sin \b)
    String.raw`)|自動(?!車)|リマインド|リマインダ|通知|アラート|毎[日週月朝]|したら|されたら|になったら|のとき`,
  'i',
);

/** Tarea del AI PROVIDER MANAGER con la que se planifica la petición (determina el modelo usado). */
export function planningTask(prompt: string): 'automations' | 'feature_creation' {
  return AUTOMATION_HINTS.test(prompt) ? 'automations' : 'feature_creation';
}

/** La petición se canceló (o desapareció) mientras el pipeline trabajaba: se detiene sin tocar nada más. */
class PipelineStopped extends Error {}

const ScriptCodeSchema = z.object({ code: z.string().min(10).max(20_000), notes: z.string().max(2000).default('') });

/**
 * "Desarrollador" de EVOLVE (tarea code_modification): escribe el código de los scripts que el
 * planificador ha especificado sin código. Solo produce código para el sandbox de ESTA organización.
 */
async function developScripts(
  deps: AppDeps,
  ws: string,
  input: { requestId: string; userId: string | null; prompt: string; before: Blueprint; changeSet: ChangeSet; problems: string[] },
  saveLlm: (entry: Record<string, unknown>) => void,
): Promise<number> {
  const pending = input.changeSet.operations.flatMap((op) => (op.op === 'upsert_script' && !op.script.code.trim() ? [op] : []));
  if (!pending.length) return 0;
  // Estructura resultante (los campos nuevos del mismo cambio también existen para el script).
  const applied = applyOperations(input.before, input.changeSet.operations);
  const structure = describeModules(activeModules(applied.blueprint));
  for (const op of pending) {
    const users = input.changeSet.operations.flatMap((o) =>
      o.op === 'upsert_automation' && o.automation.actions.some((a) => a.type === 'run_script' && a.script === op.script.key) ? [o.automation] : [],
    );
    const res = await deps.ai.runJson(
      ws,
      {
        task: 'code_modification',
        system: scriptCodeSystem(),
        userId: input.userId,
        ref: input.requestId,
        maxTokens: 8000,
        messages: [
          {
            role: 'user',
            content: [
              `Petición original: ${input.prompt}`,
              `Script: ${op.script.key} («${op.script.name}»)\nEspecificación:\n${op.script.description ?? '(sin especificación)'}`,
              `Automatizaciones que lo ejecutan:\n${users.length ? users.map((a) => JSON.stringify({ trigger: a.trigger, conditions: a.conditions })).join('\n') : '(ninguna)'}`,
              `Estructura del CRM (módulo: campos):\n${structure}`,
              `Pruebas de aceptación que debe superar:\n${JSON.stringify(input.changeSet.tests)}`,
              input.problems.length ? `Problemas del intento anterior (corrígelos):\n${input.problems.map((p) => `- ${p}`).join('\n')}` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      },
      ScriptCodeSchema,
      1,
    );
    op.script.code = res.value.code;
    saveLlm({ phase: `code_${op.script.key}`, provider: res.result.provider, model: res.result.model, costUsd: res.result.costUsd, latencyMs: res.result.latencyMs, rounds: res.rounds });
  }
  return pending.length;
}

/**
 * Entradas que cierran los pasos que siguen «en curso» (su última entrada es `running`). Al fallar o cancelar una
 * petición se añaden al progreso para que ningún paso se quede trabajando para siempre.
 */
export function closeOpenSteps(progress: unknown, status: 'failed' | 'skipped', detail: string, at: string): ProgressEntry[] {
  const last = new Map<string, string>();
  for (const p of Array.isArray(progress) ? progress : []) if (p && typeof p.step === 'string') last.set(p.step, String(p.status));
  return [...last].filter(([, s]) => s === 'running').map(([step]) => ({ step: step as StepKey, status, detail, at }));
}

async function progress(deps: AppDeps, ws: string, id: string, entry: Omit<ProgressEntry, 'at'>, status?: string) {
  const e: ProgressEntry = { ...entry, at: deps.now().toISOString() };
  // El estado solo avanza mientras la petición sigue activa: una petición cancelada nunca se "revive" (ni recibe
  // pasos nuevos después de que la cancelación cerrara los abiertos).
  const r = await deps.db.tenant(ws, (q) =>
    q.query<{ status: string }>(
      `UPDATE evolution_requests SET progress = progress || $1::jsonb,
         status = CASE WHEN status IN ('queued','planning','testing') THEN COALESCE($2, status) ELSE status END,
         updated_at = now()
       WHERE id = $3 AND workspace_id = $4 AND status <> 'cancelled' RETURNING status`,
      [JSON.stringify([e]), status ?? null, id, ws],
    ),
  );
  const current = r.rows[0]?.status;
  if (!current || current === 'cancelled') throw new PipelineStopped();
}

async function loadSamples(q: Queryable, ws: string, bp: Blueprint, cs: ChangeSet): Promise<Record<string, StoredRecord[]>> {
  const keys = new Set<string>();
  for (const op of cs.operations) if ('module' in op && typeof op.module === 'string') keys.add(op.module);
  const out: Record<string, StoredRecord[]> = {};
  for (const key of keys) {
    if (!findModule(bp, key)) continue;
    const r = await q.query(
      `SELECT id, module_key, data, created_by, updated_by, created_at, updated_at, last_activity_at FROM records
       WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100`,
      [ws, key],
    );
    out[key] = r.rows.map((row: any) => ({
      id: row.id,
      moduleKey: row.module_key,
      data: row.data,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      lastActivityAt: new Date(row.last_activity_at).toISOString(),
    }));
  }
  return out;
}

/** Una parte generada de un plan grande. */
interface PlanPart {
  part: OutlinePart;
  changeSet: ChangeSet;
}

/** Claves que toca una lista de operaciones (para atribuir los problemas de las pruebas a una parte). */
function touchedKeys(ops: Operation[]): string[] {
  const keys = new Set<string>();
  for (const op of ops) {
    if (op.op === 'create_module') keys.add(op.module.key);
    else if ('module' in op && typeof op.module === 'string') keys.add(op.module);
    if (op.op === 'upsert_automation') keys.add(op.automation.key);
    if (op.op === 'upsert_dashboard') keys.add(op.dashboard.key);
    if (op.op === 'upsert_form') keys.add(op.form.key);
    if (op.op === 'upsert_integration') keys.add(op.integration.key);
    if (op.op === 'upsert_script') keys.add(op.script.key);
    if (op.op === 'upsert_page') keys.add(op.page.key);
    if (op.op === 'remove_page') keys.add(op.page);
    if (op.op === 'update_appearance') keys.add('appearance');
    if (op.op === 'update_navigation') keys.add('navigation');
  }
  return [...keys];
}

/** Une las partes en un solo change set (una sola versión, probada y aprobada entera). */
function mergeParts(outline: ChangeSet, parts: PlanPart[]): ChangeSet {
  const all = parts.map((p) => p.changeSet);
  const platform = all.filter((c) => c.requiresPlatformChange && c.platformRequest).map((c) => c.platformRequest);
  return ChangeSetSchema.parse({
    title: outline.title,
    summary: outline.summary,
    operations: all.flatMap((c) => c.operations),
    tests: all.flatMap((c) => c.tests).slice(0, CHANGESET_LIMITS.tests),
    requiresPlatformChange: all.some((c) => c.requiresPlatformChange) || outline.requiresPlatformChange,
    platformRequest: [outline.platformRequest, ...platform].filter(Boolean).join('\n\n').slice(0, 6000) || undefined,
    questions: [...outline.questions, ...all.flatMap((c) => c.questions)].slice(0, 6),
    assumptions: [...outline.assumptions, ...all.flatMap((c) => c.assumptions)].slice(0, 10),
  });
}

function problemsFrom(issues: Issue[], report: TestReport): string[] {
  const out = issues.filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`);
  for (const s of report.suites) for (const c of s.cases) if (!c.passed) out.push(`[${s.name}] ${c.name}: ${c.message ?? 'falló'}`);
  return out.slice(0, 30);
}

const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'concerns']),
  summary: z.string().max(3000),
  concerns: z.array(z.object({ severity: z.enum(['low', 'medium', 'high']), message: z.string().max(1000) })).max(20).default([]),
});

/**
 * Pipeline de EVOLVE AI ENGINE (se ejecuta en el worker):
 * interpretar → analizar → planificar → desarrollar en sandbox → probar → (auto-corrección) →
 * revisión cruzada → presentar. Nunca toca producción: la publicación exige aprobación humana.
 */
export async function runEvolutionPipeline(deps: AppDeps, workspaceId: string, requestId: string) {
  const ws = workspaceId;
  const req = (await deps.db.tenant(ws, (q) => q.query(`SELECT * FROM evolution_requests WHERE id = $1 AND workspace_id = $2`, [requestId, ws]))).rows[0];
  if (!req || !['queued', 'planning'].includes(req.status)) return;
  const llmLog: unknown[] = Array.isArray(req.llm) ? req.llm : [];
  const saveLlm = (entry: Record<string, unknown>) => llmLog.push({ ...entry, at: deps.now().toISOString() });

  try {
    // 1-2) Interpretar y analizar: contexto determinista del proyecto (arquitectura, datos, permisos, memoria)
    await progress(deps, ws, requestId, { step: 'interpret', status: 'running' }, 'planning');
    const ctx = await deps.db.tenant(ws, async (q) => {
      const loaded = await loadWorkspace(q, ws);
      const members = (await q.query<{ user_id: string; role: Role }>(`SELECT user_id, role FROM memberships WHERE workspace_id = $1`, [ws])).rows.map((m) => ({ id: m.user_id, role: m.role }));
      const releases = (await q.query(`SELECT title, created_at, kind FROM releases WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 10`, [ws])).rows;
      // La memoria propuesta desde el asistente no alimenta al planificador (defensa contra inyección persistente).
      const memory = await listMemory(q, ws, req.requested_by, { includeUser: true, limit: 30, excludeSources: ['assistant'] });
      const counts = Object.fromEntries((await q.query<{ module_key: string; n: number }>(`SELECT module_key, count(*)::int AS n FROM records WHERE workspace_id = $1 AND deleted_at IS NULL GROUP BY 1`, [ws])).rows.map((r) => [r.module_key, r.n]));
      return { loaded, members, releases, memory, counts };
    });
    await progress(deps, ws, requestId, { step: 'interpret', status: 'done', detail: req.source === 'manual' ? t('Cambio manual (sin IA)') : t('Petición recibida') });
    await progress(deps, ws, requestId, {
      step: 'analyze',
      status: 'done',
      detail: [
        tp(ctx.loaded.blueprint.modules.length, '{count} módulo', '{count} módulos'),
        tp(ctx.loaded.blueprint.automations.length, '{count} automatización', '{count} automatizaciones'),
        tp(Object.values(ctx.counts).reduce((a, b) => a + b, 0), '{count} registro', '{count} registros'),
        tp(ctx.members.length, '{count} miembro', '{count} miembros'),
        t('versión {version}', { version: ctx.loaded.version }),
      ].join(', '),
    });

    // 3) Planificar. Las peticiones centradas en automatizaciones usan el modelo configurado para la tarea
    // "automations"; el resto, el de "feature_creation" (cada organización elige el modelo de cada tarea).
    const planTask = planningTask(req.prompt);
    await progress(deps, ws, requestId, { step: 'plan', status: 'running', detail: planTask === 'automations' ? t('Petición de automatización') : undefined });
    let changeSet: ChangeSet;
    const conversation: { role: 'user' | 'assistant'; content: string }[] = [];
    const feedback: string[] = (Array.isArray(req.conversation) ? req.conversation : []).filter((c: any) => c.role === 'feedback').map((c: any) => c.content);
    const plannerInput: PlannerContextInput = {
      orgName: ctx.loaded.name,
      settings: ctx.loaded.settings,
      version: ctx.loaded.version,
      blueprint: ctx.loaded.blueprint,
      releases: ctx.releases,
      memory: ctx.memory,
      prompt: req.prompt,
      feedback,
    };
    // Plan por partes (peticiones grandes): esquema del planificador y cada parte generada aparte.
    let outlineSet: ChangeSet | null = null;
    let parts: PlanPart[] = [];

    /** Genera (o regenera) la parte i sobre el blueprint que dejan las partes anteriores. */
    const generatePart = async (i: number, problems: string[] = []): Promise<void> => {
      const base = applyOperations(ctx.loaded.blueprint, parts.slice(0, i).flatMap((p) => p.changeSet.operations)).blueprint;
      const part = outlineSet!.outline![i];
      let lastProblems = problems;
      for (let round = 0; round < 2; round++) {
        const res = await deps.ai.runJson(
          ws,
          {
            task: planTask,
            system: plannerSystem(),
            messages: [{ role: 'user', content: plannerPartMessage({ ...plannerInput, blueprint: base, outline: outlineSet!.outline!, part, problems: lastProblems }) }],
            maxTokens: 32_000,
            userId: req.requested_by,
            ref: requestId,
          },
          ChangeSetSchema,
        );
        saveLlm({ phase: `plan_part_${part.key}${round ? '_fix' : ''}`, provider: res.result.provider, model: res.result.model, costUsd: res.result.costUsd, latencyMs: res.result.latencyMs, rounds: res.rounds });
        const fragment = { ...res.value, outline: undefined };
        parts[i] = { part, changeSet: fragment };
        // Comprobación rápida: la parte tiene operaciones y se puede aplicar sobre las anteriores.
        if (!fragment.operations.length) {
          lastProblems = ['La parte no contiene operaciones: genera las operaciones de esta parte (no el esquema general).'];
          continue;
        }
        const errors = applyOperations(base, fragment.operations).errors;
        if (!errors.length) return;
        lastProblems = errors.slice(0, 20).map((e) => `${e.path}: ${e.message}`);
      }
    };

    if (req.source === 'manual') {
      changeSet = ChangeSetSchema.parse(req.change_set);
    } else {
      conversation.push({ role: 'user', content: plannerMessage(plannerInput) });
      const planned = await deps.ai.runJson(ws, { task: planTask, system: plannerSystem(), messages: conversation, maxTokens: 32_000, userId: req.requested_by, ref: requestId }, ChangeSetSchema);
      changeSet = planned.value;
      conversation.push({ role: 'assistant', content: JSON.stringify(planned.value) });
      saveLlm({ phase: 'plan', provider: planned.result.provider, model: planned.result.model, costUsd: planned.result.costUsd, latencyMs: planned.result.latencyMs, rounds: planned.rounds });
      if (changeSet.outline?.length && !changeSet.operations.length) {
        outlineSet = changeSet;
        parts = [];
        const total = outlineSet.outline!.length;
        for (let i = 0; i < total; i++) {
          await progress(deps, ws, requestId, { step: 'plan', status: 'running', detail: t('Plan por partes: {part}/{total} · {title}', { part: i + 1, total, title: outlineSet.outline![i].title }) });
          await generatePart(i);
        }
        changeSet = mergeParts(outlineSet, parts);
      }
    }
    const planSize = [tp(changeSet.operations.length, '{count} operación', '{count} operaciones'), tp(changeSet.tests.length, '{count} prueba', '{count} pruebas')].join(', ');
    await progress(deps, ws, requestId, {
      step: 'plan',
      status: 'done',
      detail: outlineSet ? tp(parts.length, '{plan} en {count} parte', '{plan} en {count} partes', { plan: planSize }) : planSize,
    });

    // 4-5) Desarrollar en sandbox y probar, con auto-corrección
    let attempt = 0;
    const develop = async (problems: string[]) => {
      if (req.source === 'manual') return;
      const written = await developScripts(deps, ws, { requestId, userId: req.requested_by, prompt: req.prompt, before: ctx.loaded.blueprint, changeSet, problems }, saveLlm);
      if (written) await progress(deps, ws, requestId, { step: 'develop', status: 'running', detail: tp(written, 'Código escrito para {count} script de la organización', 'Código escrito para {count} scripts de la organización') });
    };
    let sim = await (async () => {
      await progress(deps, ws, requestId, { step: 'develop', status: 'running' }, 'testing');
      await develop([]);
      const samples = await deps.db.tenant(ws, (q) => loadSamples(q, ws, ctx.loaded.blueprint, changeSet));
      return simulateChangeSet({ before: ctx.loaded.blueprint, changeSet, samples, members: ctx.members, tz: ctx.loaded.settings.timezone, now: deps.now() });
    })();
    while (req.source !== 'manual' && attempt < MAX_SELF_HEAL && changeSet.operations.length > 0 && (!sim.report.passed || !sim.after)) {
      attempt++;
      const problems = problemsFrom(sim.issues, sim.report);
      await progress(deps, ws, requestId, { step: 'test', status: 'failed', detail: tp(problems.length, 'Intento {attempt}: {count} problema. Auto-corrección en curso…', 'Intento {attempt}: {count} problemas. Auto-corrección en curso…', { attempt }) });
      if (outlineSet) {
        // Plan por partes: solo se regeneran las partes a las que apuntan los problemas (si no se pueden
        // atribuir, la última), así un plan grande no tiene que reescribirse entero.
        const implicated = parts
          .map((p, i) => ({ i, keys: touchedKeys(p.changeSet.operations) }))
          .filter(({ keys }) => problems.some((pr) => keys.some((k) => pr.includes(k))))
          .map(({ i }) => i);
        const targets = implicated.length ? implicated : [parts.length - 1];
        for (const i of targets) {
          const mine = problems.filter((pr) => touchedKeys(parts[i].changeSet.operations).some((k) => pr.includes(k)));
          await generatePart(i, mine.length ? mine : problems);
        }
        changeSet = mergeParts(outlineSet, parts);
      } else {
        conversation.push({ role: 'user', content: selfHealMessage(problems) });
        const fixed = await deps.ai.runJson(ws, { task: planTask, system: plannerSystem(), messages: conversation, maxTokens: 32_000, userId: req.requested_by, ref: requestId }, ChangeSetSchema);
        changeSet = fixed.value;
        conversation.push({ role: 'assistant', content: JSON.stringify(fixed.value) });
        saveLlm({ phase: `self_heal_${attempt}`, provider: fixed.result.provider, model: fixed.result.model, costUsd: fixed.result.costUsd, latencyMs: fixed.result.latencyMs, rounds: fixed.rounds });
      }
      await develop(problems);
      const samples = await deps.db.tenant(ws, (q) => loadSamples(q, ws, ctx.loaded.blueprint, changeSet));
      sim = await simulateChangeSet({ before: ctx.loaded.blueprint, changeSet, samples, members: ctx.members, tz: ctx.loaded.settings.timezone, now: deps.now() });
    }
    await progress(deps, ws, requestId, { step: 'develop', status: sim.after ? 'done' : 'failed', detail: sim.after ? t('Cambios aplicados en una copia aislada del blueprint') : t('El plan no se puede aplicar') });
    const testsPassed = t('{passed}/{total} pruebas superadas', { passed: sim.report.total - sim.report.failed, total: sim.report.total });
    await progress(deps, ws, requestId, {
      step: 'test',
      status: sim.report.passed ? 'done' : 'failed',
      detail: sim.report.warnings ? [testsPassed, tp(sim.report.warnings, '{count} aviso', '{count} avisos')].join(', ') : testsPassed,
    });

    // 6) Revisión cruzada con un modelo de OTRO proveedor (multi-LLM)
    const risk = assessRisk(ctx.loaded.blueprint, changeSet.operations, { counts: ctx.counts });
    const impact = buildImpact(ctx.loaded.blueprint, sim.after, changeSet, risk, ctx.counts);
    let crossReview: unknown = null;
    const planner = llmLog.length ? (llmLog[llmLog.length - 1] as { provider?: string }).provider : undefined;
    if (req.source !== 'manual' && changeSet.operations.length && sim.report.passed) {
      const reviewJson = JSON.stringify(changeSet);
      const candidates = (await deps.ai.plan(ws, 'code_review')).filter((target) => target.provider !== planner);
      if (candidates.length) {
        await progress(deps, ws, requestId, { step: 'review', status: 'running' });
        try {
          const rev = await deps.ai.runJson(
            ws,
            {
              task: 'code_review',
              system: reviewSystem(),
              target: candidates[0],
              messages: [{ role: 'user', content: `Petición: ${req.prompt}\n\nChange set${reviewJson.length > REVIEW_MAX_CHARS ? ' (recortado por tamaño; revisa con más atención el impacto y los riesgos calculados)' : ''}:\n${reviewJson.slice(0, REVIEW_MAX_CHARS)}\n\nImpacto calculado:\n${JSON.stringify({ risk: risk.items, tables: impact.tables, permissions: impact.permissions }).slice(0, 60_000)}` }],
              maxTokens: 8000,
              userId: req.requested_by,
              ref: requestId,
            },
            ReviewSchema,
            1,
          );
          crossReview = { ...rev.value, provider: rev.result.provider, model: rev.result.model };
          saveLlm({ phase: 'cross_review', provider: rev.result.provider, model: rev.result.model, costUsd: rev.result.costUsd, latencyMs: rev.result.latencyMs });
          const verdict = rev.value.verdict === 'approve' ? t('sin objeciones') : tp(rev.value.concerns.length, '{count} observación', '{count} observaciones');
          await progress(deps, ws, requestId, { step: 'review', status: 'done', detail: `${rev.result.provider}/${rev.result.model}: ${verdict}` });
        } catch (e) {
          await progress(deps, ws, requestId, { step: 'review', status: 'skipped', detail: t('No se pudo completar: {error}', { error: tk((e as Error).message).slice(0, 200) }) });
        }
      } else {
        await progress(deps, ws, requestId, { step: 'review', status: 'skipped', detail: t('Configura un segundo proveedor de IA para activar la revisión cruzada') });
      }
    } else {
      await progress(deps, ws, requestId, { step: 'review', status: 'skipped', detail: req.source === 'manual' ? t('Cambio manual') : t('No aplica') });
    }

    // 7) Presentar
    const needsInput = changeSet.operations.length === 0 && changeSet.questions.length > 0;
    const finalStatus = needsInput ? 'needs_input' : !sim.after || !sim.report.passed ? 'failed' : changeSet.operations.length === 0 ? 'needs_input' : 'ready_for_review';
    await deps.db.tenant(ws, (q) =>
      q.query(
        `UPDATE evolution_requests SET change_set = $1, validation = $2, test_report = $3, impact = $4, risk = $5, cross_review = $6, llm = $7,
           status = $8, error = $9, kind = $10, updated_at = now() WHERE id = $11 AND workspace_id = $12 AND status IN ('queued','planning','testing')`,
        [
          JSON.stringify(changeSet),
          JSON.stringify(sim.issues),
          JSON.stringify(sim.report),
          JSON.stringify({ ...impact, destructive: risk.destructive, dataEgress: risk.dataEgress }),
          risk.level,
          crossReview ? JSON.stringify(crossReview) : null,
          JSON.stringify(llmLog),
          finalStatus,
          finalStatus === 'failed' ? t('El plan no supera las pruebas del sandbox. Revisa el informe y refina la petición.') : null,
          changeSet.requiresPlatformChange && changeSet.operations.length === 0 ? 'platform' : changeSet.operations.some((o) => o.op === 'upsert_script') ? 'script' : 'config',
          requestId,
          ws,
        ],
      ),
    );
    await progress(deps, ws, requestId, {
      step: 'present',
      status: finalStatus === 'ready_for_review' ? 'done' : finalStatus === 'needs_input' ? 'skipped' : 'failed',
      detail: finalStatus === 'ready_for_review' ? t('Listo para revisión · {risk}', { risk: inSentence(tk(RISK_LABELS[risk.level] ?? risk.level)) }) : finalStatus === 'needs_input' ? t('Se necesita más información') : t('No se puede presentar'),
    });
  } catch (e) {
    if (e instanceof PipelineStopped) return;
    // Los mensajes de los proveedores de IA son textos fijos (claves del catálogo) o ya traducidos.
    const errorText = e instanceof ProviderError ? tk(e.message) : t('Error interno del motor: {error}', { error: tk((e as Error).message) });
    await deps.db.tenant(ws, async (q) => {
      const cur = (await q.query<{ progress: unknown }>(`SELECT progress FROM evolution_requests WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [requestId, ws])).rows[0];
      // El paso que estaba trabajando se marca como fallido (antes se quedaba «en curso» para siempre).
      const closing = closeOpenSteps(cur?.progress, 'failed', t('Interrumpido por un error'), deps.now().toISOString());
      await q.query(
        `UPDATE evolution_requests SET status = 'failed', error = $1, llm = $2, progress = progress || $5::jsonb, updated_at = now() WHERE id = $3 AND workspace_id = $4 AND status IN ('queued','planning','testing')`,
        [errorText.slice(0, 2000), JSON.stringify(llmLog), requestId, ws, JSON.stringify(closing)],
      );
    });
    if (!(e instanceof ProviderError)) throw e;
  }
}
