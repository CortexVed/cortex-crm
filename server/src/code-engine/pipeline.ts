import type { AppDeps } from '../deps';
import { ProviderError } from '../ai/types';
import { newId } from '../lib/crypto';
import type { Job, JobContext } from '../lib/jobs';
import { runCodeAgent } from './agent';
import { analyzeCiLogs, CI_RAILWAY_JSON, TREE_HASH_EXCLUDE } from './ci';
import { checkChanges, formatViolation } from './guards';
import { engineOptions, sourceRoot } from './options';
import { PathError } from './paths';
import { deploymentOutcome, RailwayError } from './railway';
import { runReview } from './review';
import { ConfigMissingError, railwayForJob, reportWorkerRuntime } from './settings';
import { loadSourceTree, treeHash, type SourceTree, type SourceVersion } from './source';
import { ChangeLease, ChangeStopped, enqueueCodeJob, PLAN_STATUSES, progressEntry, type CiAttempt, type SourceChange } from './store';
import { createTarGz } from './tar';
import { VirtualWorkspace } from './workspace';

/**
 * Trabajo `code.plan`: agente → reglas deterministas → CI aislado en Railway → (auto-corrección) → revisión de
 * IA → listo para aprobar. Cada ejecución hace una fase acotada y se vuelve a encolar; el estado vive en
 * source_changes, así que sobrevive a reinicios del worker.
 */

/** Rondas de auto-corrección tras un CI fallido (como mucho 4 ejecuciones del CI). */
export const MAX_HEAL_ATTEMPTS = 3;
/** Rondas extra del agente para corregir infracciones de las reglas antes de subir nada al CI. */
const MAX_GUARD_ROUNDS = 2;
const MAX_AGENT_RUNS = 10;
const MAX_TRANSIENT = 5;

export const CODE_STEPS = [
  { key: 'prepare', label: 'Preparar el código base' },
  { key: 'develop', label: 'Desarrollar con IA' },
  { key: 'guards', label: 'Reglas de seguridad deterministas' },
  { key: 'ci', label: 'CI aislado en Railway (tipos, pruebas y build)' },
  { key: 'review', label: 'Revisión de seguridad con IA' },
  { key: 'present', label: 'Presentar para aprobación' },
  { key: 'approve', label: 'Aprobación (DESPLEGAR)' },
  { key: 'deploy_worker', label: 'Desplegar en el worker (canario)' },
  { key: 'deploy_web', label: 'Desplegar en el servicio web' },
  { key: 'verify', label: 'Verificar /api/health' },
  { key: 'rollback', label: 'Rollback' },
] as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const mtimeOf = (change: Pick<SourceChange, 'created_at'>) => Math.floor(Date.parse(change.created_at) / 1000) || 0;

/** Árbol completo de una versión: base + cambios + railway.json (del CI o el normal) + source-version.json. */
export function buildVersionTree(ws: VirtualWorkspace, version: SourceVersion, railwayJson: string): Map<string, Buffer> {
  return ws.tree({ 'railway.json': railwayJson, 'source-version.json': `${JSON.stringify(version, null, 2)}\n` });
}

interface RunContext {
  deadline: number;
  signal: AbortSignal;
  /** Si no es null, la siguiente ejecución se encola (tras liberar el lease) con este retraso. */
  next: number | null;
}

/** Otra ejecución tiene el cambio: si nadie más va a continuar, se programa una comprobación posterior. */
export async function requeueIfBusy(deps: AppDeps, changeId: string, type: 'code.plan' | 'code.deploy', statuses: readonly string[]) {
  const r = await deps.db.query<{ status: string; lease_until: string | null }>(`SELECT status, lease_until FROM source_changes WHERE id = $1`, [changeId]);
  const row = r.rows[0];
  if (!row || !statuses.includes(row.status)) return;
  const queued = await deps.db.query(`SELECT 1 FROM jobs WHERE type = $1 AND status = 'queued' AND payload->>'changeId' = $2 LIMIT 1`, [type, changeId]);
  if (queued.rows.length) return;
  const wait = row.lease_until ? Math.max(1000, new Date(row.lease_until).getTime() - Date.now() + 5000) : engineOptions().requeueDelayMs;
  await enqueueCodeJob(deps.db, type, changeId, Math.min(wait, 10 * 60_000));
}

export async function runCodePlanJob(deps: AppDeps, job: Job, ctx?: JobContext): Promise<void> {
  await reportWorkerRuntime(deps).catch(() => undefined);
  const payload = (job.payload ?? {}) as { changeId?: unknown; probe?: unknown };
  if (payload.probe) return; // solo actualiza el informe del worker (pantalla de configuración)
  const changeId = typeof payload.changeId === 'string' && UUID.test(payload.changeId) ? payload.changeId : null;
  if (!changeId) return;
  const opts = engineOptions();
  const lease = await ChangeLease.acquire(deps.db, changeId, PLAN_STATUSES, opts.leaseTtlMs);
  if (!lease) return requeueIfBusy(deps, changeId, 'code.plan', PLAN_STATUSES);
  const run: RunContext = { deadline: ctx?.deadline ?? Date.now() + 45 * 60_000, signal: ctx ? AbortSignal.any([ctx.signal, lease.signal]) : lease.signal, next: null };
  let draft: (() => Promise<void>) | null = null;
  lease.startHeartbeat(opts.heartbeatMs, async () => {
    await draft?.();
  });
  try {
    if (lease.change.status === 'queued' || lease.change.status === 'planning') {
      await planPhase(deps, lease, run, (fn) => (draft = fn));
    } else if (lease.change.status === 'testing') {
      await ciPhase(deps, lease, run);
    }
  } catch (e) {
    await failPlan(deps, lease, e, run);
  } finally {
    await lease.release();
  }
  // Se encola después de soltar el lease: así la siguiente ejecución nunca lo encuentra ocupado.
  if (run.next !== null) await enqueueCodeJob(deps.db, 'code.plan', changeId, run.next);
}

async function planPhase(deps: AppDeps, lease: ChangeLease, run: RunContext, setDraft: (fn: (() => Promise<void>) | null) => void): Promise<void> {
  const tree = loadSourceTree(sourceRoot());
  let change = lease.change;
  if (!change.ai_workspace_id) {
    await lease.save({ status: 'failed', error: 'La organización cuya configuración de IA usa este cambio ya no existe. Crea el cambio de nuevo.' }, [progressEntry('prepare', 'failed', 'Sin organización para la IA')]);
    return;
  }
  if (change.base_tree_hash && change.base_tree_hash !== tree.hash) {
    const error = change.patch.files.length
      ? 'El código en ejecución ha cambiado desde que se preparó este cambio. Refínalo para reconstruirlo sobre la versión actual.'
      : 'El worker y el servicio web ejecutan versiones distintas del código. Espera a que terminen los despliegues en curso y crea el cambio de nuevo.';
    await lease.save({ status: 'failed', error }, [progressEntry('prepare', 'failed', error)]);
    return;
  }
  if (change.status === 'queued') {
    await lease.save({ status: 'planning', base_version: tree.label, base_tree_hash: tree.hash, error: null }, [progressEntry('prepare', 'done', `${tree.files.size} archivos · versión ${tree.label}`, deps.now())]);
    change = lease.change;
  }

  const ws = new VirtualWorkspace(tree, change.patch.files);
  const feedback = change.conversation.filter((c) => c.role === 'feedback').map((c) => c.content);
  let problems = change.problems;
  for (let guardRound = 0; ; guardRound++) {
    change = lease.change;
    if (run.deadline - Date.now() < 10 * 60_000) {
      // Poco margen para una ronda completa del agente: la hace la siguiente ejecución.
      run.next = 1000;
      return;
    }
    const agentRuns = (change.ci.agentRuns ?? 0) + 1;
    if (agentRuns > MAX_AGENT_RUNS) {
      await lease.save({ status: 'failed', error: `Se ha superado el máximo de ${MAX_AGENT_RUNS} rondas del agente. Refina la petición o divídela en cambios más pequeños.` }, [progressEntry('develop', 'failed', 'Demasiadas rondas')]);
      return;
    }
    const detail = problems.length ? `Ronda ${agentRuns}: corrigiendo ${problems.length} problema(s)` : `Ronda ${agentRuns}`;
    await lease.save({ ci: { ...change.ci, agentRuns } }, [progressEntry('develop', 'running', detail, deps.now())]);
    // Borrador: con el latido se guarda lo que lleve hecho el agente (si el proceso muere, no se pierde).
    let saved = ws.version;
    setDraft(async () => {
      if (ws.version === saved) return;
      saved = ws.version;
      await deps.db.query(`UPDATE source_changes SET patch = $1 WHERE id = $2 AND lease_token = $3`, [JSON.stringify({ files: ws.changes() }), lease.id, lease.token]);
    });
    const result = await runCodeAgent(deps, {
      workspaceId: change.ai_workspace_id!,
      userId: change.requested_by,
      changeId: change.id,
      prompt: change.prompt,
      feedback,
      problems,
      round: agentRuns,
      workspace: ws,
      signal: run.signal,
    }).finally(() => setDraft(null));
    const changes = ws.changes();
    const now = deps.now().toISOString();
    const llm = [...lease.change.llm, { phase: `agent_${agentRuns}`, provider: result.provider, model: result.model, costUsd: result.costUsd, steps: result.steps, at: now }];
    const calls = `${result.calls.writes + result.calls.edits} escritura(s), ${result.calls.deletes} borrado(s), ${result.steps} paso(s)`;
    if (!changes.length) {
      await lease.save({ status: 'needs_input', title: result.title, summary: result.summary, llm, patch: { files: [] }, problems: [], error: null }, [
        progressEntry('develop', 'done', `Sin cambios en el código (${calls})`),
        progressEntry('present', 'skipped', 'El agente no ha hecho cambios: lee su resumen y refina la petición'),
      ]);
      return;
    }
    const guards = checkChanges(tree, changes);
    const base = { title: result.title, summary: result.summary, llm, patch: { files: changes, testsAdded: result.testsAdded }, stats: guards.stats, flags: guards.flags, guards: { ok: guards.ok, violations: guards.violations, at: now } };
    if (guards.ok) {
      await lease.save({ ...base, problems: [] }, [
        progressEntry('develop', 'done', `${changes.length} archivo(s): +${guards.stats.linesAdded} −${guards.stats.linesRemoved} líneas (${calls})`),
        progressEntry('guards', 'done', `Sin infracciones · ${guards.flags.length} aviso(s) para quien aprueba`),
      ]);
      break;
    }
    const list = guards.violations.map(formatViolation);
    if (guardRound >= MAX_GUARD_ROUNDS) {
      await lease.save({ ...base, status: 'failed', error: `El cambio incumple las reglas del motor de código: ${list.slice(0, 5).join(' · ')}${list.length > 5 ? ` (y ${list.length - 5} más)` : ''}` }, [
        progressEntry('develop', 'done', `${changes.length} archivo(s)`),
        progressEntry('guards', 'failed', `${list.length} infracción(es) tras ${guardRound + 1} ronda(s): no se sube al CI`),
      ]);
      return;
    }
    problems = ['El cambio incumple estas reglas del motor de código. Corrígelo; si la petición no se puede hacer sin romperlas, deshaz esos cambios y explícalo en finish:', ...list];
    await lease.save(base, [progressEntry('develop', 'done', `${changes.length} archivo(s)`), progressEntry('guards', 'failed', `${list.length} infracción(es): se pide al agente que las corrija`)]);
  }
  await startCi(deps, lease, run, tree, ws);
}

/** Sube el árbol del cambio al servicio CI (con el railway.json del CI) y deja el cambio en «testing». */
async function startCi(deps: AppDeps, lease: ChangeLease, run: RunContext, tree: SourceTree, ws: VirtualWorkspace) {
  const change = lease.change;
  const { client, targets } = await railwayForJob(deps, lease.signal);
  const n = change.ci.attempts.length + 1;
  const sourceVersion: SourceVersion = { id: newId(), base: tree.version?.id ?? tree.label, createdAt: deps.now().toISOString() };
  const files = buildVersionTree(ws, sourceVersion, CI_RAILWAY_JSON);
  const hash = treeHash(files, TREE_HASH_EXCLUDE);
  const archive = createTarGz(files, { mtime: mtimeOf(change) });
  const up = await client.upload(targets.ci, archive, `Cortex CI #${n} · ${change.title ?? 'cambio de código'}`);
  const attempt: CiAttempt = { n, deploymentId: up.deploymentId, status: 'running', startedAt: deps.now().toISOString(), treeHash: hash, sourceVersion, files: files.size, bytes: archive.length };
  await lease.save({ status: 'testing', ci: { ...change.ci, attempts: [...change.ci.attempts, attempt], transientErrors: 0 } }, [
    progressEntry('ci', 'running', `Intento ${n}: ${files.size} archivos (${Math.ceil(archive.length / 1024)} KB comprimidos) subidos al servicio CI`, deps.now()),
  ]);
  run.next = engineOptions().requeueDelayMs;
}

const replaceLast = (attempts: CiAttempt[], a: CiAttempt) => [...attempts.slice(0, -1), a];

/** Sondea el despliegue del CI; con el resultado, revisión (si pasa) o auto-corrección (si falla). */
async function ciPhase(deps: AppDeps, lease: ChangeLease, run: RunContext) {
  const opts = engineOptions();
  const change = lease.change;
  const attempt = change.ci.attempts[change.ci.attempts.length - 1];
  if (!attempt || attempt.status !== 'running' || !attempt.deploymentId) {
    await lease.save({ status: 'failed', error: 'Estado del CI inconsistente: refina el cambio para volver a probarlo.' }, [progressEntry('ci', 'failed', 'Sin ejecución del CI en curso')]);
    return;
  }
  const { client } = await railwayForJob(deps, run.signal);
  const started = Date.now();
  let status = attempt.railwayStatus ?? 'QUEUED';
  for (let polls = 1; ; polls++) {
    status = (await client.deployment(attempt.deploymentId)).status;
    if (deploymentOutcome(status) !== 'pending') break;
    if (Date.now() - Date.parse(attempt.startedAt) > opts.ciTimeoutMs) {
      status = 'TIMEOUT';
      break;
    }
    if (polls >= opts.maxPollsPerRun || Date.now() - started + opts.pollIntervalMs > opts.pollBudgetMs || run.deadline - Date.now() < 2 * 60_000) {
      if (status !== attempt.railwayStatus) await lease.save({ ci: { ...change.ci, attempts: replaceLast(change.ci.attempts, { ...attempt, railwayStatus: status }) } });
      run.next = opts.requeueDelayMs;
      return;
    }
    await opts.sleep(opts.pollIntervalMs);
    if (run.signal.aborted) throw run.signal.reason ?? new ChangeStopped();
  }

  const id = attempt.deploymentId;
  const outcome = status === 'TIMEOUT' ? 'failed' : deploymentOutcome(status);
  let logs: string[] = [];
  try {
    logs = await client.buildLogs(id);
  } catch {
    /* sin logs */
  }
  if (status === 'CRASHED') {
    try {
      logs.push(...(await client.deploymentLogs(id)));
    } catch {
      /* sin logs */
    }
  }
  if (status === 'TIMEOUT') await client.cancel(id).catch(() => false);
  // El CI solo deja un health check en marcha: se retira en cuanto se conoce el resultado.
  const removed = await client.remove(id).catch(() => false);
  const analysis = analyzeCiLogs(logs);
  const finishedAt = deps.now().toISOString();

  if (outcome === 'success') {
    const passed: CiAttempt = { ...attempt, status: 'passed', railwayStatus: status, finishedAt, summary: analysis.testSummary, excerpt: analysis.excerpt, removed };
    await lease.save({ ci: { ...change.ci, attempts: replaceLast(change.ci.attempts, passed) } }, [
      progressEntry('ci', 'done', `Intento ${attempt.n} superado: tipos, pruebas y build${analysis.testSummary.length ? ` (${analysis.testSummary.join(' · ').replace(/\s+/g, ' ')})` : ''}`, deps.now()),
    ]);
    await reviewPhase(deps, lease);
    return;
  }

  const note = status === 'TIMEOUT' ? 'Tiempo máximo del CI superado' : outcome === 'removed' ? `El despliegue del CI terminó como ${status} (cancelado o sustituido)` : undefined;
  const failed: CiAttempt = { ...attempt, status: 'failed', railwayStatus: status, finishedAt, errors: analysis.problems.slice(0, 40), failedTests: analysis.failedTests, summary: analysis.testSummary, excerpt: analysis.excerpt, removed, ...(note ? { note } : {}) };
  const ci = { ...change.ci, attempts: replaceLast(change.ci.attempts, failed) };
  const short = analysis.tsErrors.length ? `${analysis.tsErrors.length} error(es) de TypeScript` : analysis.failedTests.length ? `${analysis.failedTests.length} prueba(s) fallida(s)` : (note ?? 'el build ha fallado');
  const inRound = attempt.n - (change.ci.roundStart ?? 0);
  if (inRound <= MAX_HEAL_ATTEMPTS) {
    await lease.save({ status: 'planning', ci, problems: [`El CI (intento ${attempt.n}) ha fallado: ${short}. Errores extraídos del log:`, ...analysis.problems] }, [
      progressEntry('ci', 'failed', `Intento ${attempt.n}: ${short}. Auto-corrección ${inRound}/${MAX_HEAL_ATTEMPTS}…`, deps.now()),
    ]);
    run.next = 0;
    return;
  }
  await lease.save({ status: 'failed', ci, error: `El CI no se ha superado tras ${inRound} intentos (${short}). Revisa el log y refina la petición.` }, [progressEntry('ci', 'failed', `Intento ${attempt.n}: ${short}. Sin más intentos`, deps.now())]);
}

async function reviewPhase(deps: AppDeps, lease: ChangeLease) {
  const change = lease.change;
  await lease.save({}, [progressEntry('review', 'running', undefined, deps.now())]);
  const agent = [...change.llm].reverse().find((l) => l.phase.startsWith('agent_'));
  const review = await runReview(deps, {
    workspaceId: change.ai_workspace_id!,
    userId: change.requested_by,
    changeId: change.id,
    prompt: change.prompt,
    title: change.title ?? '',
    summary: change.summary ?? '',
    changes: change.patch.files,
    flags: change.flags,
    stats: change.stats,
    agentProvider: agent?.provider ?? null,
  });
  const verdict = review.verdict === 'approve' ? 'sin objeciones' : review.verdict === 'reject' ? 'recomienda NO desplegar' : `${review.concerns?.length ?? 0} observación(es)`;
  const detail = review.status === 'done' ? `${review.provider}/${review.model}: ${verdict}${review.sameProvider ? ' (mismo proveedor que el autor)' : ''}` : (review.message ?? 'Sin revisión');
  const llm = review.status === 'done' ? [...lease.change.llm, { phase: 'review', provider: review.provider!, model: review.model!, costUsd: null, at: review.at }] : lease.change.llm;
  const flags = [
    ...lease.change.flags.filter((f) => !f.key.startsWith('review')),
    ...(review.status !== 'done' ? [{ key: 'review_missing', level: 'warning' as const, message: `Sin revisión de IA: ${review.message ?? ''}` }] : []),
    ...(review.status === 'done' && review.sameProvider ? [{ key: 'review_same_provider', level: 'info' as const, message: 'La revisión la ha hecho el mismo proveedor que escribió el código: configura otro para una revisión cruzada' }] : []),
    ...(review.verdict === 'reject' ? [{ key: 'review_reject', level: 'warning' as const, message: 'La revisión de IA recomienda no desplegar este cambio' }] : []),
  ];
  await lease.save({ status: 'ready_for_review', review, llm, flags, risk: 'high', error: null }, [
    progressEntry('review', review.status === 'done' ? 'done' : 'skipped', detail, deps.now()),
    progressEntry('present', 'done', 'Listo para revisión · riesgo alto (cambio del código de la plataforma)', deps.now()),
  ]);
}

/** Error durante una fase de planificación o CI. */
async function failPlan(deps: AppDeps, lease: ChangeLease, e: unknown, run: RunContext) {
  const signal = run.signal;
  if (e instanceof ChangeStopped || (signal.aborted && signal.reason instanceof ChangeStopped) || lease.lost) return;
  if (e instanceof RailwayError && e.code === 'unavailable') {
    const n = (lease.change.ci.transientErrors ?? 0) + 1;
    if (n <= MAX_TRANSIENT) {
      try {
        await lease.save({ ci: { ...lease.change.ci, transientErrors: n } }, [progressEntry('ci', 'running', `Railway no responde (${n}/${MAX_TRANSIENT}): se reintenta en ${n} min`, deps.now())]);
        run.next = n * 60_000;
      } catch {
        /* el cambio ya no es de esta ejecución */
      }
      return;
    }
  }
  const timedOut = signal.aborted && !(signal.reason instanceof ChangeStopped);
  const msg = timedOut
    ? 'Se ha superado el tiempo máximo de esta fase. Refina la petición o divídela en cambios más pequeños.'
    : e instanceof ProviderError
      ? `IA: ${e.message}`
      : e instanceof RailwayError || e instanceof ConfigMissingError || e instanceof PathError
        ? e.message
        : `Error interno del motor de código: ${(e as Error)?.message ?? String(e)}`;
  const step = lease.change.status === 'testing' ? 'ci' : 'develop';
  try {
    await lease.save({ status: 'failed', error: msg.slice(0, 2000) }, [progressEntry(step, 'failed', msg.slice(0, 300), deps.now())]);
  } catch {
    /* el cambio ya no es de esta ejecución */
  }
  const expected = timedOut || e instanceof ProviderError || e instanceof RailwayError || e instanceof ConfigMissingError || e instanceof PathError;
  if (!expected) throw e;
}
