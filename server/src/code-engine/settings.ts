import type { AppConfig } from '../config';
import type { Queryable } from '../db/db';
import type { AppDeps } from '../deps';
import { maskSecret } from '../lib/crypto';
import { sourceRoot } from './options';
import { isRailwayId, RailwayClient, type ServiceTarget } from './railway';
import { loadSourceTree } from './source';

/**
 * Configuración de Railway del motor de código fuente:
 * - el token de PROYECTO (cifrado con SecretBox, AAD `platform:railway-token`; nunca se devuelve ni se registra);
 * - los servicios a los que se despliega. Railway define RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID y
 *   RAILWAY_SERVICE_ID en cada servicio; el worker (que es quien despliega) recibe además CORTEX_SERVICE_ID y
 *   CI_SERVICE_ID por referencia. El worker publica lo que ve en platform_settings (`railway.worker`) para que
 *   la pantalla de configuración, servida por el web, pueda decir exactamente qué falta.
 */

export const TOKEN_KEY = 'railway.token';
export const TOKEN_AAD = 'platform:railway-token';
export const WORKER_KEY = 'railway.worker';

export interface WorkerReport {
  role: string;
  projectId: string | null;
  environmentId: string | null;
  serviceId: string | null;
  webServiceId: string | null;
  ciServiceId: string | null;
  sourceVersion: string | null;
  treeHash: string | null;
  reportedAt: string;
}

export interface DeployTargets {
  worker: ServiceTarget;
  web: ServiceTarget;
  ci: ServiceTarget;
}

/** Falta configuración: el mensaje dice exactamente qué. */
export class ConfigMissingError extends Error {
  constructor(readonly missing: string[]) {
    super(`Falta configuración del motor de código: ${missing.join(' · ')}`);
    this.name = 'ConfigMissingError';
  }
}

const NO_RAILWAY = 'No se detecta Railway (faltan RAILWAY_PROJECT_ID y RAILWAY_ENVIRONMENT_ID): el motor de código solo funciona en una instalación desplegada en Railway';

async function readSetting(q: Queryable, key: string) {
  return (await q.query<{ value: any; secret_ciphertext: string | null; secret_hint: string | null; updated_at: string; updated_by: string | null }>(
    `SELECT value, secret_ciphertext, secret_hint, updated_at, updated_by FROM platform_settings WHERE key = $1`,
    [key],
  )).rows[0] ?? null;
}

/** Token descifrado, solo en memoria del servidor (null si no hay). */
export async function loadRailwayToken(deps: Pick<AppDeps, 'db' | 'box'>): Promise<string | null> {
  const row = await readSetting(deps.db, TOKEN_KEY);
  if (!row?.secret_ciphertext) return null;
  return deps.box.decrypt(row.secret_ciphertext, TOKEN_AAD);
}

export async function saveRailwayToken(deps: Pick<AppDeps, 'db' | 'box'>, token: string, userId: string, scope: { projectId: string; environmentId: string }) {
  await deps.db.query(
    `INSERT INTO platform_settings (key, value, secret_ciphertext, secret_hint, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret_ciphertext = EXCLUDED.secret_ciphertext, secret_hint = EXCLUDED.secret_hint, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [TOKEN_KEY, JSON.stringify({ projectId: scope.projectId, environmentId: scope.environmentId, validatedAt: new Date().toISOString() }), deps.box.encrypt(token, TOKEN_AAD), maskSecret(token), userId],
  );
}

export async function deleteRailwayToken(db: Queryable): Promise<boolean> {
  const r = await db.query(`DELETE FROM platform_settings WHERE key = $1`, [TOKEN_KEY]);
  return r.rowCount > 0;
}

/** Lo que ve el worker (o el proceso «all» en desarrollo): se guarda para la pantalla de configuración. */
export async function reportWorkerRuntime(deps: Pick<AppDeps, 'db' | 'config'>): Promise<WorkerReport | null> {
  if (deps.config.role !== 'worker' && deps.config.role !== 'all') return null;
  const tree = (() => {
    try {
      return loadSourceTree(sourceRoot());
    } catch {
      return null;
    }
  })();
  const r = deps.config.railway;
  const report: WorkerReport = {
    role: deps.config.role,
    projectId: r.projectId,
    environmentId: r.environmentId,
    serviceId: r.serviceId,
    webServiceId: r.webServiceId,
    ciServiceId: r.ciServiceId,
    sourceVersion: tree?.label ?? null,
    treeHash: tree?.hash ?? null,
    reportedAt: new Date().toISOString(),
  };
  await deps.db.query(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WORKER_KEY, JSON.stringify(report)],
  );
  return report;
}

export async function readWorkerReport(db: Queryable): Promise<WorkerReport | null> {
  return ((await readSetting(db, WORKER_KEY))?.value as WorkerReport | undefined) ?? null;
}

/** Problemas de una vista de servicios (la del worker, que es quien despliega). */
function serviceProblems(v: { projectId: string | null; environmentId: string | null; serviceId: string | null; webServiceId: string | null; ciServiceId: string | null }): string[] {
  const missing: string[] = [];
  if (!v.projectId || !v.environmentId) return [NO_RAILWAY];
  if (!isRailwayId(v.projectId) || !isRailwayId(v.environmentId)) missing.push('RAILWAY_PROJECT_ID o RAILWAY_ENVIRONMENT_ID no tienen el formato de un id de Railway');
  if (!isRailwayId(v.serviceId)) missing.push('El worker no conoce su propio servicio (RAILWAY_SERVICE_ID)');
  if (!v.webServiceId) missing.push('Falta CORTEX_SERVICE_ID en el servicio Worker (valor: ${{Cortex.RAILWAY_SERVICE_ID}})');
  else if (!isRailwayId(v.webServiceId)) missing.push('CORTEX_SERVICE_ID no tiene el formato de un id de Railway');
  if (!v.ciServiceId) missing.push('Falta el servicio CI: créalo vacío (sin variables, sin dominio y sin repositorio) y añade al Worker CI_SERVICE_ID=${{CI.RAILWAY_SERVICE_ID}}');
  else if (!isRailwayId(v.ciServiceId)) missing.push('CI_SERVICE_ID no tiene el formato de un id de Railway');
  const ids = [v.serviceId, v.webServiceId, v.ciServiceId].filter(Boolean);
  if (new Set(ids).size !== ids.length) missing.push('Los servicios web, worker y CI deben ser distintos (CI_SERVICE_ID nunca puede ser el web ni el worker)');
  return missing;
}

/** Servicios de destino según la configuración de ESTE proceso (el worker). */
export function targetsFromConfig(config: AppConfig): { targets: DeployTargets | null; missing: string[] } {
  const r = config.railway;
  const missing = serviceProblems(r);
  if (missing.length) return { targets: null, missing };
  const base = { projectId: r.projectId!, environmentId: r.environmentId! };
  return { targets: { worker: { ...base, serviceId: r.serviceId! }, web: { ...base, serviceId: r.webServiceId! }, ci: { ...base, serviceId: r.ciServiceId! } }, missing: [] };
}

/** Cliente de Railway y servicios para un trabajo del worker; ConfigMissingError si falta algo. */
export async function railwayForJob(deps: AppDeps, signal?: AbortSignal): Promise<{ client: RailwayClient; targets: DeployTargets }> {
  const { targets, missing } = targetsFromConfig(deps.config);
  const token = await loadRailwayToken(deps);
  if (!token) missing.push('Falta el token de proyecto de Railway');
  if (!targets || !token) throw new ConfigMissingError(missing);
  return { client: new RailwayClient(token, deps.fetchImpl, { signal }), targets };
}

/** Cliente con el token guardado (rutas del web: rollback manual, cancelar el CI). */
export async function railwayClient(deps: AppDeps): Promise<RailwayClient | null> {
  const token = await loadRailwayToken(deps);
  return token ? new RailwayClient(token, deps.fetchImpl) : null;
}

export interface SettingsView {
  configured: boolean;
  missing: string[];
  warnings: string[];
  token: { configured: boolean; hint: string | null; updatedAt: string | null; projectId: string | null; environmentId: string | null };
  railway: { detected: boolean; projectId: string | null; environmentId: string | null; serviceId: string | null; role: string };
  worker: WorkerReport | null;
  services: { web: string | null; worker: string | null; ci: string | null };
  running: { version: string; treeHash: string };
}

/** Estado de la configuración visto desde el proceso que atiende la petición (normalmente el web). */
export async function settingsView(deps: AppDeps): Promise<SettingsView> {
  const cfg = deps.config.railway;
  const tokenRow = await readSetting(deps.db, TOKEN_KEY);
  const worker = await readWorkerReport(deps.db);
  const tree = loadSourceTree(sourceRoot());
  const missing: string[] = [];
  const warnings: string[] = [];
  const detected = !!(cfg.projectId && cfg.environmentId);
  if (!detected) missing.push(NO_RAILWAY);
  const tokenScope = (tokenRow?.value ?? {}) as { projectId?: string; environmentId?: string };
  if (!tokenRow?.secret_ciphertext) missing.push('Falta el token de proyecto de Railway (Railway › proyecto › Settings › Tokens, del mismo entorno)');
  else if (detected && (tokenScope.projectId !== cfg.projectId || tokenScope.environmentId !== cfg.environmentId)) missing.push('El token guardado es de otro proyecto o de otro entorno: guarda uno de este');
  if (detected) {
    if (!worker) missing.push('El worker todavía no ha informado de su configuración: guarda el token o pulsa «Comprobar de nuevo» y espera unos segundos (el servicio Worker debe estar en marcha)');
    else {
      for (const m of serviceProblems(worker)) if (m !== NO_RAILWAY) missing.push(m);
      if (!worker.projectId || worker.projectId !== cfg.projectId || worker.environmentId !== cfg.environmentId) missing.push('El worker está en otro proyecto o entorno de Railway');
      // Solo con servicios separados (en «all», desarrollo, web y worker son el mismo proceso).
      if (deps.config.role === 'web' && worker.webServiceId && cfg.serviceId && worker.webServiceId !== cfg.serviceId) {
        missing.push('CORTEX_SERVICE_ID del Worker no coincide con este servicio web (RAILWAY_SERVICE_ID)');
      }
      if (worker.treeHash && worker.treeHash !== tree.hash) warnings.push('El worker y el servicio web ejecutan versiones distintas del código: espera a que terminen los despliegues en curso');
      if (Date.now() - new Date(worker.reportedAt).getTime() > 7 * 86_400_000) warnings.push('El último informe del worker tiene más de una semana: pulsa «Comprobar de nuevo»');
    }
  }
  return {
    configured: missing.length === 0,
    missing,
    warnings,
    token: {
      configured: !!tokenRow?.secret_ciphertext,
      hint: tokenRow?.secret_hint ?? null,
      updatedAt: tokenRow?.updated_at ? new Date(tokenRow.updated_at).toISOString() : null,
      projectId: tokenScope.projectId ?? null,
      environmentId: tokenScope.environmentId ?? null,
    },
    railway: { detected, projectId: cfg.projectId, environmentId: cfg.environmentId, serviceId: cfg.serviceId, role: deps.config.role },
    worker,
    services: {
      web: worker?.webServiceId ?? (deps.config.role === 'web' ? cfg.serviceId : null),
      worker: worker?.serviceId ?? null,
      ci: worker?.ciServiceId ?? null,
    },
    running: { version: tree.label, treeHash: tree.hash },
  };
}
