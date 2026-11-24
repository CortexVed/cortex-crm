import type { AiTask } from '../../../../../shared/constants';

/** Respuestas de la API del AI PROVIDER MANAGER (ver server/src/ai/manager.ts y routes.ts). */

export interface ProviderCapabilities {
  tools: boolean;
  json: boolean;
  pdf: boolean;
  publicModels: boolean;
  reportsCost: boolean;
}

export interface ProviderState {
  id: string;
  label: string;
  tier: 'core' | 'experimental';
  description: string;
  docsUrl: string;
  keyHint: string;
  configured: boolean;
  keySource: 'workspace' | 'platform' | null;
  /** Solo los últimos caracteres enmascarados (p. ej. ••••1234). La clave real nunca sale del servidor. */
  keyHint_masked: string | null;
  enabled: boolean;
  defaultModel: string | null;
  modelsCount: number;
  modelsCachedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  capabilities: ProviderCapabilities;
}

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number | null;
  pricing?: ModelPricing | null;
  description?: string;
}

export interface ModelsResponse {
  models: ModelInfo[];
  cachedAt: string | null;
}

export interface RouteTarget {
  provider: string;
  model: string;
}

export type Routing = Partial<Record<AiTask, RouteTarget[]>>;

export interface AiLimits {
  monthlyBudgetUsd: number | null;
  maxRequestsPerHour: number;
  maxOutputTokens: number;
  disabledTasks: AiTask[];
}

export interface AiSettings {
  defaultProvider: string | null;
  defaultModel: string | null;
  routing: Routing;
  limits: AiLimits;
  pricing: Record<string, ModelPricing>;
}

export interface AiSettingsResponse {
  settings: AiSettings;
  tasks: { key: AiTask; label: string }[];
  effectiveRoutes: Partial<Record<AiTask, RouteTarget[]>>;
}

export interface AiSettingsInput {
  defaultProvider?: string | null;
  defaultModel?: string | null;
  routing?: Routing;
  limits?: Partial<AiLimits>;
  pricing?: Record<string, ModelPricing>;
}

export interface ProviderTestResult {
  ok: boolean;
  error: string | null;
  latencyMs: number;
  model: string;
}

export interface UsageTotals {
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unpriced: number;
  p50: number;
  p95: number;
}

export interface UsageByModel {
  provider: string;
  model: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  avg_latency_ms: number;
}

export interface UsageByTask {
  task: string;
  requests: number;
  cost_usd: number;
}

export interface UsageDaily {
  day: string;
  requests: number;
  cost_usd: number;
}

export interface UsageError {
  created_at: string;
  task: string;
  provider: string;
  model: string;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number | null;
}

export interface UsageResponse {
  days: number;
  totals: UsageTotals;
  byModel: UsageByModel[];
  byTask: UsageByTask[];
  daily: UsageDaily[];
  recentErrors: UsageError[];
}

export type CompareResult = RouteTarget &
  (
    | { ok: true; text: string; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number | null; servedModel: string }
    | { ok: false; error: string }
  );
