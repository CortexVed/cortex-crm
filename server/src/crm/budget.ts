/**
 * Presupuesto de una cascada de automatizaciones: lo comparten todas las que desencadena un mismo evento
 * original (y las que a su vez desencadenan éstas), para que una configuración mal hecha no pueda crear
 * miles de registros o consumir CPU sin límite con un solo cambio.
 */
export interface AutomationBudget {
  actions: number;
  created: number;
  scriptMs: number;
}

export const AUTOMATION_BUDGET: Readonly<AutomationBudget> = { actions: 100, created: 25, scriptMs: 6000 };

export const newAutomationBudget = (): AutomationBudget => ({ actions: 0, created: 0, scriptMs: 0 });
