/**
 * Manejadores de los trabajos del motor de código fuente que registra `createJobHandlers` (server/src/worker.ts):
 * - `code.plan`: agente de IA, reglas deterministas, CI aislado en Railway (con auto-corrección) y revisión;
 * - `code.deploy`: despliegue con canario en el worker, después el web, verificación y rollback.
 * Su plazo (45 min por ejecución) lo fija `timeoutFor()` en lib/jobs.ts.
 */
export { runCodePlanJob } from './pipeline';
export { runCodeDeployJob } from './deploy';
