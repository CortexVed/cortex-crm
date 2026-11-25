import { resolveLockfileWithNpm } from './lockfile';
import { resolveSourceRoot } from './source';

/** Parámetros de funcionamiento del motor de código fuente (plazos, sondeos y ubicación del código). */
export interface CodeEngineOptions {
  /** Raíz del paquete de código fuente (null = /app/source o, en desarrollo, el directorio de trabajo). */
  sourceRoot: string | null;
  /** Cada cuánto se consulta el estado de un despliegue de Railway. */
  pollIntervalMs: number;
  /** Cuánto sondea como mucho una ejecución del trabajo antes de devolverse a la cola. */
  pollBudgetMs: number;
  /** Consultas como máximo por ejecución (cota adicional al tiempo). */
  maxPollsPerRun: number;
  /** Espera antes de la siguiente ejecución encadenada del trabajo. */
  requeueDelayMs: number;
  /** Tiempo que se espera a que el worker nuevo (canario) retome el despliegue antes de seguir con cualquiera. */
  handOffGraceMs: number;
  /** Duración del lease de un cambio (se renueva con el latido). */
  leaseTtlMs: number;
  heartbeatMs: number;
  /** Plazo máximo de una ejecución del CI y de cada despliegue. */
  ciTimeoutMs: number;
  deployTimeoutMs: number;
  /** Verificación de /api/health tras desplegar (y tras revertir). */
  verifyAttempts: number;
  verifyIntervalMs: number;
  /** Pasos del bucle del agente por ronda (una funcionalidad completa necesita leer y escribir bastantes archivos). */
  maxAgentSteps: number;
  /** Calcula package-lock.json para un package.json con dependencias nuevas (npm; los tests lo sustituyen). */
  resolveLockfile: (packageJson: string, baseLock: string, signal?: AbortSignal) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULTS: CodeEngineOptions = {
  sourceRoot: null,
  pollIntervalMs: 15_000,
  pollBudgetMs: 8 * 60_000,
  maxPollsPerRun: 60,
  requeueDelayMs: 20_000,
  handOffGraceMs: 3 * 60_000,
  leaseTtlMs: 3 * 60_000,
  heartbeatMs: 45_000,
  ciTimeoutMs: 45 * 60_000,
  deployTimeoutMs: 30 * 60_000,
  verifyAttempts: 18,
  verifyIntervalMs: 10_000,
  maxAgentSteps: 60,
  resolveLockfile: (packageJson, baseLock, signal) => resolveLockfileWithNpm(packageJson, baseLock, { signal }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let current: CodeEngineOptions = { ...DEFAULTS };

export function engineOptions(): CodeEngineOptions {
  return current;
}

/** Ajusta los parámetros (lo usan los tests para acortar plazos y apuntar a un árbol de prueba). */
export function configureCodeEngine(partial: Partial<CodeEngineOptions>): void {
  current = { ...current, ...partial };
}

export function resetCodeEngine(): void {
  current = { ...DEFAULTS };
}

export function sourceRoot(): string {
  return current.sourceRoot ?? resolveSourceRoot();
}
