import type { AppDeps } from '../deps';
import { audit } from '../lib/audit';
import type { Job, JobContext } from '../lib/jobs';
import { TREE_HASH_EXCLUDE } from './ci';
import { checkChanges, formatViolation } from './guards';
import { engineOptions, sourceRoot } from './options';
import { buildVersionTree, mtimeOf, requeueIfBusy, UUID } from './pipeline';
import { deploymentOutcome, RailwayError, type RailwayClient } from './railway';
import { ConfigMissingError, railwayForJob, reportWorkerRuntime } from './settings';
import { loadSourceTree, treeHash } from './source';
import { ChangeLease, ChangeStopped, DEPLOY_STATUSES, enqueueCodeJob, progressEntry, type DeployState, type SourceChange } from './store';
import { createTarGz } from './tar';
import { VirtualWorkspace } from './workspace';

/**
 * Trabajo `code.deploy`: despliegue con canario y rollback.
 *  1. pending       comprobaciones (aprobación, versión base, mismo árbol que pasó el CI, reglas) y registro de
 *                   los despliegues activos del worker y del web (para poder revertir);
 *  2. worker_*      sube el árbol al servicio Worker PRIMERO (canario: aplica las migraciones y demuestra que
 *                   arranca, conecta con la base de datos y procesa la cola) y espera a SUCCESS;
 *  3. web_*         sube el mismo árbol al servicio web y espera a SUCCESS (lo continúa, normalmente, el worker
 *                   nuevo: Railway sustituye al anterior en cuanto el nuevo está sano);
 *  4. verify        /api/health del web debe responder con la versión nueva (sourceVersion);
 *  si algo falla, rollback (deploymentRollback a los despliegues registrados) y el cambio queda fallido. El
 *  rollback manual (REVERTIR) usa la misma fase de verificación.
 */

const MAX_TRANSIENT = 5;

interface RunContext {
  deadline: number;
  signal: AbortSignal;
  /** Si no es null, la siguiente ejecución se encola (tras liberar el lease) con este retraso. */
  next: number | null;
}

type StepResult = 'continue' | 'stop';

export async function runCodeDeployJob(deps: AppDeps, job: Job, ctx?: JobContext): Promise<void> {
  await reportWorkerRuntime(deps).catch(() => undefined);
  const changeId = typeof job.payload?.changeId === 'string' && UUID.test(job.payload.changeId) ? (job.payload.changeId as string) : null;
  if (!changeId) return;
  const opts = engineOptions();
  const lease = await ChangeLease.acquire(deps.db, changeId, DEPLOY_STATUSES, opts.leaseTtlMs);
  if (!lease) return requeueIfBusy(deps, changeId, 'code.deploy', DEPLOY_STATUSES);
  lease.startHeartbeat(opts.heartbeatMs);
  const run: RunContext = { deadline: ctx?.deadline ?? Date.now() + 45 * 60_000, signal: ctx ? AbortSignal.any([ctx.signal, lease.signal]) : lease.signal, next: null };
  try {
    for (let i = 0; i < 12; i++) {
      if ((await step(deps, lease, run)) === 'stop') break;
    }
  } catch (e) {
    await failDeploy(deps, lease, e, run);
  } finally {
    await lease.release();
  }
  // Se encola después de soltar el lease: así la siguiente ejecución nunca lo encuentra ocupado.
  if (run.next !== null) await enqueueCodeJob(deps.db, 'code.deploy', changeId, run.next);
}

/** Sigue en otra ejecución (dentro de `delayMs`). */
function later(run: RunContext, delayMs = engineOptions().requeueDelayMs): StepResult {
  run.next = delayMs;
  return 'stop';
}

async function saveDeploy(lease: ChangeLease, patch: Partial<DeployState>, progress = [] as ReturnType<typeof progressEntry>[], extra: Record<string, unknown> = {}) {
  await lease.save({ deploy: { ...lease.change.deploy, ...patch }, ...extra }, progress);
}

async function step(deps: AppDeps, lease: ChangeLease, run: RunContext): Promise<StepResult> {
  const change = lease.change;
  const d = change.deploy;
  if (change.status === 'rolling_back') return rollbackVerify(deps, lease);
  switch (d.phase ?? 'pending') {
    case 'pending':
      return preflight(deps, lease);
    case 'worker_upload':
      return upload(deps, lease, 'worker');
    case 'worker_wait':
      return waitFor(deps, lease, run, 'worker');
    case 'web_upload': {
      // El worker nuevo (canario) debería retomar el despliegue: así se comprueba también que procesa la cola.
      const running = loadSourceTree(sourceRoot()).version?.id ?? null;
      const isNew = running === d.sourceVersion?.id;
      const waited = d.workerReadyAt ? Date.now() - Date.parse(d.workerReadyAt) : Infinity;
      if (!isNew && waited < engineOptions().handOffGraceMs) return later(run);
      if (!d.continuedBy) await saveDeploy(lease, { continuedBy: isNew ? 'worker nuevo' : 'worker anterior' });
      return upload(deps, lease, 'web');
    }
    case 'web_wait':
      return waitFor(deps, lease, run, 'web');
    case 'verify':
      return verify(deps, lease);
    default:
      return 'stop';
  }
}

/** Árbol que se despliega: base + cambio + el railway.json normal; debe ser idéntico al que pasó el CI. */
function deployTree(change: SourceChange) {
  const tree = loadSourceTree(sourceRoot());
  const attempt = change.ci.attempts.find((a) => a.n === change.deploy.attempt);
  if (!attempt || attempt.status !== 'passed') throw new DeployAbort('No hay una ejecución del CI superada para desplegar');
  const railwayJson = tree.files.get('railway.json')?.toString('utf8');
  if (!railwayJson) throw new DeployAbort('El código base no tiene railway.json');
  const ws = new VirtualWorkspace(tree, change.patch.files);
  const files = buildVersionTree(ws, attempt.sourceVersion, railwayJson);
  if (treeHash(files, TREE_HASH_EXCLUDE) !== attempt.treeHash) throw new DeployAbort('El código que se iba a desplegar no es el mismo que superó el CI');
  return { tree, ws, files, attempt };
}

/** Error que detiene el despliegue antes de tocar ningún servicio (no hace falta revertir). */
class DeployAbort extends Error {}

async function preflight(deps: AppDeps, lease: ChangeLease): Promise<StepResult> {
  const change = lease.change;
  try {
    const approval = change.approvals[change.approvals.length - 1];
    if (!approval || approval.confirmation !== 'DESPLEGAR') throw new DeployAbort('Falta la aprobación con la confirmación DESPLEGAR');
    const tree = loadSourceTree(sourceRoot());
    if (change.base_tree_hash !== tree.hash) throw new DeployAbort('La instalación ya no está en la versión sobre la que se preparó y probó el cambio: refínalo para reconstruirlo');
    const { ws, attempt } = deployTree(change);
    if (approval.treeHash !== attempt.treeHash) throw new DeployAbort('La aprobación no corresponde al código que superó el CI');
    const guards = checkChanges(tree, ws.changes());
    if (!guards.ok) throw new DeployAbort(`El cambio incumple las reglas del motor de código: ${guards.violations.slice(0, 3).map(formatViolation).join(' · ')}`);
    const { client, targets } = await railwayForJob(deps, lease.signal);
    // Un servicio que sigue conectado a un repositorio (p. ej. el de la plantilla) volvería a desplegar el
    // código del repositorio en el siguiente push y el código modificado se perdería: no se despliega.
    const repos = await Promise.all([client.connectedRepo(targets.worker), client.connectedRepo(targets.web)]);
    const connected = repos.map((r, i) => (r.repo ? `${i === 0 ? 'Worker' : 'web'} (${r.repo})` : null)).filter(Boolean);
    if (connected.length) {
      throw new DeployAbort(`${connected.join(' y ')} sigue conectado a un repositorio de GitHub: un push a ese repositorio sustituiría el código modificado. Desconéctalo en Railway (servicio › Settings › Source › Disconnect) y vuelve a aprobar el cambio`);
    }
    const [worker, web] = await Promise.all([client.activeDeployment(targets.worker), client.activeDeployment(targets.web)]);
    if (!worker || !web) throw new DeployAbort(`No se encuentra el despliegue activo del ${!worker ? 'worker' : 'servicio web'}: sin él no se podría revertir`);
    await saveDeploy(
      lease,
      { phase: 'worker_upload', sourceVersion: attempt.sourceVersion, treeHash: attempt.treeHash, previous: { worker: { serviceId: targets.worker.serviceId, deploymentId: worker.id }, web: { serviceId: targets.web.serviceId, deploymentId: web.id } } },
      [progressEntry('deploy_worker', 'running', `Despliegues actuales registrados para poder revertir (worker ${worker.id.slice(0, 8)}, web ${web.id.slice(0, 8)})`, deps.now())],
    );
    return 'continue';
  } catch (e) {
    if (!(e instanceof DeployAbort || e instanceof ConfigMissingError)) throw e;
    await lease.save({ status: 'failed', error: e.message, deploy: { ...change.deploy, phase: 'done' } }, [progressEntry('deploy_worker', 'failed', e.message, deps.now())]);
    await auditDeploy(deps, change, 'platform.code.deploy_failed', { reason: e.message });
    return 'stop';
  }
}

async function upload(deps: AppDeps, lease: ChangeLease, service: 'worker' | 'web'): Promise<StepResult> {
  const change = lease.change;
  const { files } = deployTree(change);
  const { client, targets } = await railwayForJob(deps, lease.signal);
  const archive = createTarGz(files, { mtime: mtimeOf(change) });
  const up = await client.upload(targets[service], archive, `Cortex · ${change.title ?? 'cambio de código'} (${service === 'worker' ? 'worker' : 'web'})`);
  const now = deps.now().toISOString();
  const step = service === 'worker' ? 'deploy_worker' : 'deploy_web';
  await saveDeploy(lease, { phase: service === 'worker' ? 'worker_wait' : 'web_wait', [service]: { serviceId: targets[service].serviceId, deploymentId: up.deploymentId, startedAt: now } }, [
    progressEntry(step, 'running', `Código subido al ${service === 'worker' ? 'worker' : 'servicio web'}: construyendo (despliegue ${up.deploymentId.slice(0, 8)})${service === 'web' && change.deploy.continuedBy ? ` · continuado por el ${change.deploy.continuedBy}` : ''}`, deps.now()),
  ]);
  return 'continue';
}

async function waitFor(deps: AppDeps, lease: ChangeLease, run: RunContext, service: 'worker' | 'web'): Promise<StepResult> {
  const opts = engineOptions();
  const change = lease.change;
  const dep = change.deploy[service];
  if (!dep) throw new Error(`Sin despliegue del ${service} registrado`);
  const { client } = await railwayForJob(deps, run.signal);
  const started = Date.now();
  let status = 'QUEUED';
  for (let polls = 1; ; polls++) {
    status = (await client.deployment(dep.deploymentId)).status;
    if (deploymentOutcome(status) !== 'pending') break;
    if (Date.now() - Date.parse(dep.startedAt ?? change.updated_at) > opts.deployTimeoutMs) {
      await client.cancel(dep.deploymentId).catch(() => false);
      status = 'TIMEOUT';
      break;
    }
    if (polls >= opts.maxPollsPerRun || Date.now() - started + opts.pollIntervalMs > opts.pollBudgetMs || run.deadline - Date.now() < 2 * 60_000) {
      if (status !== dep.status) await saveDeploy(lease, { [service]: { ...dep, status } });
      return later(run);
    }
    await opts.sleep(opts.pollIntervalMs);
    if (run.signal.aborted) throw run.signal.reason ?? new ChangeStopped();
  }
  const step = service === 'worker' ? 'deploy_worker' : 'deploy_web';
  const finished = { ...dep, status, finishedAt: deps.now().toISOString() };
  if (status !== 'TIMEOUT' && deploymentOutcome(status) === 'success') {
    if (service === 'worker') {
      await saveDeploy(lease, { worker: finished, phase: 'web_upload', workerReadyAt: deps.now().toISOString() }, [progressEntry(step, 'done', 'Worker desplegado y sano (migraciones aplicadas, base de datos y cola en marcha)', deps.now())]);
      // Lo normal es que lo continúe el worker nuevo: Railway retira el anterior en cuanto el nuevo está sano.
      return later(run);
    }
    await saveDeploy(lease, { web: finished, phase: 'verify' }, [progressEntry(step, 'done', 'Servicio web desplegado', deps.now())]);
    return 'continue';
  }
  const why = status === 'TIMEOUT' ? 'superó el tiempo máximo' : `terminó como ${status}`;
  await saveDeploy(lease, { [service]: finished }, [progressEntry(step, 'failed', `El despliegue del ${service === 'worker' ? 'worker' : 'servicio web'} ${why}`, deps.now())]);
  // El web solo sustituye al anterior si el nuevo está sano: si falló, basta con revertir el worker.
  return startRollback(deps, lease, ['worker'], `El despliegue del ${service === 'worker' ? 'worker (canario)' : 'servicio web'} ${why}: se ha revertido`);
}

/** GET /api/health del web hasta que responda con la versión esperada (o se agoten los intentos). */
async function healthVersion(deps: AppDeps, expected: string | null): Promise<{ ok: boolean; detail: string }> {
  const opts = engineOptions();
  if (!deps.config.appUrl) return { ok: false, detail: 'Sin APP_URL no se puede consultar /api/health' };
  let detail = '';
  for (let i = 0; i < opts.verifyAttempts; i++) {
    try {
      const res = await deps.fetchImpl(`${deps.config.appUrl}/api/health`, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => null)) as { status?: string; version?: { sourceVersion?: { id?: string } | null } } | null;
      const got = body?.version?.sourceVersion?.id ?? null;
      if (res.ok && body?.status === 'ok' && got === expected) return { ok: true, detail: `/api/health responde con la versión ${expected ?? 'inicial'}` };
      detail = `/api/health: HTTP ${res.status}, versión ${got ?? 'inicial'} (se espera ${expected ?? 'la inicial'})`;
    } catch (e) {
      detail = `/api/health no responde: ${(e as Error).message.slice(0, 120)}`;
    }
    if (i < opts.verifyAttempts - 1) await opts.sleep(opts.verifyIntervalMs);
  }
  return { ok: false, detail };
}

async function verify(deps: AppDeps, lease: ChangeLease): Promise<StepResult> {
  const change = lease.change;
  const expected = change.deploy.sourceVersion?.id ?? null;
  await lease.save({}, [progressEntry('verify', 'running', undefined, deps.now())]);
  const health = await healthVersion(deps, expected);
  const verification = {
    ok: health.ok,
    at: deps.now().toISOString(),
    checks: [
      { name: 'Worker desplegado primero (canario) y sano', passed: true },
      { name: `Despliegue continuado por el ${change.deploy.continuedBy ?? 'worker'}`, passed: true },
      { name: 'Servicio web desplegado', passed: true },
      { name: 'El web responde con la versión nueva', passed: health.ok, detail: health.detail },
    ],
  };
  if (health.ok) {
    await lease.save({ status: 'deployed', deployed_at: deps.now().toISOString(), error: null, deploy: { ...change.deploy, phase: 'done', verification } }, [progressEntry('verify', 'done', health.detail, deps.now())]);
    await auditDeploy(deps, change, 'platform.code.deployed', { sourceVersion: expected, files: change.patch.files.length });
    return 'stop';
  }
  await saveDeploy(lease, { verification }, [progressEntry('verify', 'failed', health.detail, deps.now())]);
  return startRollback(deps, lease, ['web', 'worker'], `La verificación posterior al despliegue ha fallado (${health.detail}): se ha revertido`);
}

/** Revierte los servicios indicados a los despliegues registrados antes de empezar (web primero). */
export async function rollbackServices(client: RailwayClient, deploy: DeployState, services: ('web' | 'worker')[]) {
  const results: NonNullable<DeployState['rollback']>['services'] = [];
  for (const s of services) {
    const prev = deploy.previous?.[s];
    if (!prev) {
      results.push({ service: s, deploymentId: '', ok: false, error: 'No hay despliegue anterior registrado' });
      continue;
    }
    try {
      results.push({ service: s, deploymentId: prev.deploymentId, ok: await client.rollback(prev.deploymentId) });
    } catch (e) {
      results.push({ service: s, deploymentId: prev.deploymentId, ok: false, error: (e as Error).message.slice(0, 300) });
    }
  }
  return results;
}

async function startRollback(deps: AppDeps, lease: ChangeLease, services: ('web' | 'worker')[], message: string, client?: RailwayClient): Promise<StepResult> {
  const change = lease.change;
  let results: NonNullable<DeployState['rollback']>['services'];
  try {
    const c = client ?? (await railwayForJob(deps, lease.signal)).client;
    results = await rollbackServices(c, change.deploy, services);
  } catch (e) {
    results = services.map((s) => ({ service: s, deploymentId: change.deploy.previous?.[s]?.deploymentId ?? '', ok: false, error: (e as Error).message.slice(0, 300) }));
  }
  const ok = results.every((r) => r.ok);
  await lease.save(
    { status: 'rolling_back', error: ok ? message : `${message}. ATENCIÓN: el rollback automático no se ha completado; revierte manualmente en Railway (${results.filter((r) => !r.ok).map((r) => `${r.service}: ${r.error ?? 'error'}`).join(' · ')})`, deploy: { ...change.deploy, phase: 'rollback_verify', rollback: { reason: 'failure', requestedAt: deps.now().toISOString(), message, services: results } } },
    [progressEntry('rollback', ok ? 'running' : 'failed', `${ok ? 'Rollback solicitado' : 'Rollback incompleto'}: ${results.map((r) => `${r.service} ${r.ok ? '✓' : '✗'}`).join(', ')}`, deps.now())],
  );
  await auditDeploy(deps, change, 'platform.code.deploy_failed', { reason: message, rollback: results });
  return 'continue';
}

/** Tras un rollback (automático o manual): el web debe volver a la versión base. */
async function rollbackVerify(deps: AppDeps, lease: ChangeLease): Promise<StepResult> {
  const change = lease.change;
  const rb = change.deploy.rollback;
  const manual = rb?.reason === 'manual';
  const final = manual ? 'rolled_back' : 'failed';
  const anyOk = !!rb?.services.some((s) => s.ok);
  const webRolledBack = !!rb?.services.some((s) => s.service === 'web' && s.ok);
  let verified = false;
  let detail = anyOk ? 'Rollback solicitado a Railway' : 'Railway no ha aceptado el rollback: revierte manualmente';
  if (webRolledBack) {
    // La versión base es la de source-version.json; la imagen de partida (sin él) se identifica como «inicial-…».
    const base = change.base_version && !change.base_version.startsWith('inicial-') ? change.base_version : null;
    const health = await healthVersion(deps, base);
    verified = health.ok;
    detail = health.ok ? `El web ha vuelto a la versión anterior (${base ?? 'inicial'})` : `No se ha podido confirmar la vuelta atrás: ${health.detail}`;
  } else if (anyOk) {
    verified = true;
    detail = 'Worker revertido (el servicio web no llegó a cambiar)';
  }
  await lease.save(
    {
      status: final,
      ...(manual ? { rolled_back_at: deps.now().toISOString() } : {}),
      deploy: { ...change.deploy, phase: 'done', rollback: rb ? { ...rb, verified, detail } : rb },
    },
    [progressEntry('rollback', verified ? 'done' : 'failed', detail, deps.now())],
    DEPLOY_STATUSES,
  );
  if (manual) await auditDeploy(deps, change, 'platform.code.rolled_back', { verified });
  return 'stop';
}

async function failDeploy(deps: AppDeps, lease: ChangeLease, e: unknown, run: RunContext) {
  if (e instanceof ChangeStopped || lease.lost || (run.signal.aborted && run.signal.reason instanceof ChangeStopped)) return;
  const d = lease.change.deploy;
  if (e instanceof RailwayError && e.code === 'unavailable') {
    const n = (d.transientErrors ?? 0) + 1;
    if (n <= MAX_TRANSIENT) {
      try {
        await saveDeploy(lease, { transientErrors: n }, [progressEntry(lease.change.status === 'rolling_back' ? 'rollback' : 'deploy_worker', 'running', `Railway no responde (${n}/${MAX_TRANSIENT}): se reintenta en ${n} min`, deps.now())]);
        run.next = n * 60_000;
      } catch {
        /* el cambio ya no es de esta ejecución */
      }
      return;
    }
  }
  const msg = e instanceof RailwayError || e instanceof ConfigMissingError || e instanceof DeployAbort ? e.message : `Error interno del motor de código: ${(e as Error)?.message ?? String(e)}`;
  try {
    if (lease.change.status === 'deploying' && (d.worker || d.web)) {
      // Ya se ha subido algo: se revierte todo lo que pudo cambiar.
      const services: ('web' | 'worker')[] = d.web ? ['web', 'worker'] : ['worker'];
      await startRollback(deps, lease, services, `El despliegue se ha interrumpido (${msg}): se ha revertido`);
      run.next = engineOptions().requeueDelayMs;
    } else if (lease.change.status === 'deploying') {
      await lease.save({ status: 'failed', error: msg.slice(0, 2000), deploy: { ...d, phase: 'done' } }, [progressEntry('deploy_worker', 'failed', msg.slice(0, 300), deps.now())]);
    } else {
      await lease.save({ status: d.rollback?.reason === 'manual' ? 'rolled_back' : 'failed', deploy: { ...d, phase: 'done', rollback: d.rollback ? { ...d.rollback, verified: false, detail: msg.slice(0, 300) } : d.rollback } }, [progressEntry('rollback', 'failed', msg.slice(0, 300), deps.now())]);
    }
  } catch {
    /* el cambio ya no es de esta ejecución */
  }
  if (!(e instanceof RailwayError || e instanceof ConfigMissingError || e instanceof DeployAbort)) throw e;
}

export async function auditDeploy(deps: AppDeps, change: SourceChange, action: string, meta: Record<string, unknown>) {
  await audit(deps.db, { workspaceId: null, actorId: null, actorType: 'system', action, targetType: 'source_change', targetId: change.id, meta: { title: change.title, ...meta } }).catch(() => undefined);
}
