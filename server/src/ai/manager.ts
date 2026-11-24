import { z, type ZodType } from 'zod';
import { AI_TASKS, type AiTask } from '../../../shared/constants';
import type { AppConfig } from '../config';
import type { Db } from '../db/db';
import { maskSecret, newId, SecretBox } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { anthropicAdapter } from './providers/anthropic';
import { createOpenAiCompatibleAdapter } from './providers/openai-compatible';
import { MOCK_PROVIDER, PROVIDERS, type ProviderDefinition } from './providers/registry';
import { computeCost, resolvePrice, type Price } from './pricing';
import { extractJson } from './json';
import {
  ProviderError,
  type ChatMessage,
  type ChatResponse,
  type Credentials,
  type Effort,
  type ModelInfo,
  type ProviderAdapter,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
} from './types';

export interface RouteTarget {
  provider: string;
  model: string;
}

export interface AiSettings {
  defaultProvider: string | null;
  defaultModel: string | null;
  routing: Partial<Record<AiTask, RouteTarget[]>>;
  limits: { monthlyBudgetUsd: number | null; maxRequestsPerHour: number; maxOutputTokens: number; disabledTasks: AiTask[] };
  pricing: Record<string, Price>;
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
  keyHint_masked: string | null;
  enabled: boolean;
  defaultModel: string | null;
  modelsCount: number;
  modelsCachedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  capabilities: { tools: boolean; json: boolean; pdf: boolean; publicModels: boolean; reportsCost: boolean };
}

export interface AttemptLog {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  code?: string;
}

export interface AiRunRequest {
  task: AiTask;
  system?: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  tools?: ToolSpec[];
  effort?: Effort;
  userId?: string | null;
  ref?: string;
  target?: RouteTarget;
  signal?: AbortSignal;
}

export interface AiRunResult extends ChatResponse {
  provider: string;
  latencyMs: number;
  costUsd: number | null;
  attempts: AttemptLog[];
}

const DEFAULT_EFFORT: Record<AiTask, Effort> = {
  chat: 'medium',
  crm_analysis: 'medium',
  feature_creation: 'high',
  code_modification: 'high',
  code_review: 'high',
  security: 'high',
  sql_generation: 'medium',
  automations: 'medium',
  document_analysis: 'medium',
  customer_classification: 'low',
};

/** Herramientas que se ejecutan como mucho en un mismo paso del bucle de agente. */
export const MAX_TOOL_CALLS_PER_STEP = 8;

const RouteTargetSchema = z.object({ provider: z.string().min(1).max(40), model: z.string().min(1).max(200) });
export const AiSettingsInputSchema = z.object({
  defaultProvider: z.string().max(40).nullable().optional(),
  defaultModel: z.string().max(200).nullable().optional(),
  routing: z.partialRecord(z.enum(AI_TASKS), z.array(RouteTargetSchema).max(5)).optional(),
  limits: z
    .object({
      monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
      maxRequestsPerHour: z.number().int().min(1).max(10_000).optional(),
      maxOutputTokens: z.number().int().min(256).max(128_000).optional(),
      disabledTasks: z.array(z.enum(AI_TASKS)).optional(),
    })
    .optional(),
  pricing: z.record(z.string().max(250), z.object({ inputPerM: z.number().min(0).max(10_000), outputPerM: z.number().min(0).max(10_000) })).optional(),
});

/**
 * AI PROVIDER MANAGER: punto único de acceso a modelos de IA.
 * Ninguna otra parte de la aplicación llama directamente a un proveedor.
 */
export class AiManager {
  private adapters: Record<string, ProviderAdapter>;
  private definitions: Record<string, ProviderDefinition>;

  constructor(
    private deps: { db: Db; box: SecretBox; config: AppConfig; adapters?: Record<string, ProviderAdapter>; fetchImpl?: typeof fetch },
  ) {
    const f = deps.fetchImpl ?? fetch;
    this.definitions = { ...PROVIDERS };
    if (deps.config.llmEnableMock) this.definitions.mock = MOCK_PROVIDER;
    this.adapters = {};
    for (const def of Object.values(this.definitions)) {
      this.adapters[def.id] = def.adapter === 'anthropic' ? anthropicAdapter : createOpenAiCompatibleAdapter(def, f);
    }
    Object.assign(this.adapters, deps.adapters ?? {});
  }

  definition(id: string): ProviderDefinition {
    const d = this.definitions[id];
    if (!d) throw badRequest(`Proveedor desconocido "${id}"`);
    return d;
  }

  listDefinitions(): ProviderDefinition[] {
    return Object.values(this.definitions);
  }

  private aad(ws: string, provider: string) {
    return `ai:${ws}:${provider}`;
  }

  // ---------------------------------------------------------------- configuración

  async getSettings(ws: string): Promise<AiSettings> {
    const r = await this.deps.db.tenant(ws, (q) => q.query(`SELECT * FROM ai_settings WHERE workspace_id = $1`, [ws]));
    const row = r.rows[0];
    return {
      defaultProvider: row?.default_provider ?? null,
      defaultModel: row?.default_model ?? null,
      routing: row?.routing ?? {},
      limits: {
        monthlyBudgetUsd: row?.limits?.monthlyBudgetUsd ?? null,
        maxRequestsPerHour: row?.limits?.maxRequestsPerHour ?? this.deps.config.aiMaxRequestsPerHour,
        maxOutputTokens: row?.limits?.maxOutputTokens ?? 32_000,
        disabledTasks: row?.limits?.disabledTasks ?? [],
      },
      pricing: row?.pricing ?? {},
    };
  }

  async saveSettings(ws: string, input: z.infer<typeof AiSettingsInputSchema>, actorId: string) {
    const current = await this.getSettings(ws);
    for (const targets of Object.values(input.routing ?? {})) for (const t of targets ?? []) this.definition(t.provider);
    if (input.defaultProvider) this.definition(input.defaultProvider);
    const next = {
      defaultProvider: input.defaultProvider !== undefined ? input.defaultProvider : current.defaultProvider,
      defaultModel: input.defaultModel !== undefined ? input.defaultModel : current.defaultModel,
      routing: input.routing ?? current.routing,
      limits: { ...current.limits, ...(input.limits ?? {}) },
      pricing: input.pricing ?? current.pricing,
    };
    await this.deps.db.tenant(ws, (q) =>
      q.query(
        `INSERT INTO ai_settings (workspace_id, default_provider, default_model, routing, limits, pricing, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (workspace_id) DO UPDATE SET default_provider = EXCLUDED.default_provider, default_model = EXCLUDED.default_model,
           routing = EXCLUDED.routing, limits = EXCLUDED.limits, pricing = EXCLUDED.pricing, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ws, next.defaultProvider, next.defaultModel, JSON.stringify(next.routing), JSON.stringify(next.limits), JSON.stringify(next.pricing), actorId],
      ),
    );
    return next;
  }

  private async providerRows(ws: string): Promise<Map<string, any>> {
    const r = await this.deps.db.tenant(ws, (q) => q.query(`SELECT * FROM ai_providers WHERE workspace_id = $1`, [ws]));
    return new Map(r.rows.map((row: any) => [row.provider, row]));
  }

  private platformKey(provider: string): string | undefined {
    return this.deps.config.allowPlatformLlmKeys ? this.deps.config.platformLlmKeys[provider] : undefined;
  }

  async getProviderStates(ws: string): Promise<ProviderState[]> {
    const rows = await this.providerRows(ws);
    return this.listDefinitions().map((def) => {
      const row = rows.get(def.id);
      const wsKey = !!row?.api_key_ciphertext;
      const platform = !wsKey && !!this.platformKey(def.id);
      const isMock = def.id === 'mock';
      return {
        id: def.id,
        label: def.label,
        tier: def.tier,
        description: def.description,
        docsUrl: def.docsUrl,
        keyHint: def.keyHint,
        configured: wsKey || platform || isMock,
        keySource: wsKey ? 'workspace' : platform ? 'platform' : null,
        keyHint_masked: row?.api_key_hint ?? null,
        enabled: row ? row.enabled : true,
        defaultModel: row?.default_model ?? def.defaultModel,
        modelsCount: Array.isArray(row?.models_cache) ? row.models_cache.length : 0,
        modelsCachedAt: row?.models_cached_at ? new Date(row.models_cached_at).toISOString() : null,
        lastTestAt: row?.last_test_at ? new Date(row.last_test_at).toISOString() : null,
        lastTestOk: row?.last_test_ok ?? null,
        lastError: row?.last_error ?? null,
        capabilities: { tools: def.supportsTools, json: def.supportsJsonMode, pdf: def.supportsPdf, publicModels: !!def.publicModels, reportsCost: !!def.reportsCost },
      };
    });
  }

  async saveProvider(ws: string, providerId: string, input: { apiKey?: string | null; enabled?: boolean; defaultModel?: string | null }) {
    const def = this.definition(providerId);
    if (def.id === 'mock') throw badRequest('El proveedor simulado no se configura');
    const rows = await this.providerRows(ws);
    const row = rows.get(def.id);
    let cipher: string | null = row?.api_key_ciphertext ?? null;
    let hint: string | null = row?.api_key_hint ?? null;
    if (input.apiKey !== undefined) {
      if (input.apiKey === null || input.apiKey === '') {
        cipher = null;
        hint = null;
      } else {
        const key = input.apiKey.trim();
        if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw badRequest('API key con formato inválido');
        cipher = this.deps.box.encrypt(key, this.aad(ws, def.id));
        hint = maskSecret(key);
      }
    }
    await this.deps.db.tenant(ws, (q) =>
      q.query(
        `INSERT INTO ai_providers (workspace_id, provider, enabled, api_key_ciphertext, api_key_hint, default_model, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (workspace_id, provider) DO UPDATE SET enabled = EXCLUDED.enabled, api_key_ciphertext = EXCLUDED.api_key_ciphertext,
           api_key_hint = EXCLUDED.api_key_hint, default_model = EXCLUDED.default_model, updated_at = now(),
           last_error = CASE WHEN EXCLUDED.api_key_ciphertext IS DISTINCT FROM ai_providers.api_key_ciphertext THEN NULL ELSE ai_providers.last_error END`,
        [ws, def.id, input.enabled ?? row?.enabled ?? true, cipher, hint, input.defaultModel !== undefined ? input.defaultModel : row?.default_model ?? def.defaultModel],
      ),
    );
  }

  /** Credenciales descifradas SOLO en memoria del servidor; nunca se devuelven al cliente ni se registran. */
  async credentials(ws: string, providerId: string): Promise<(Credentials & { source: 'workspace' | 'platform' | 'mock' }) | null> {
    const def = this.definition(providerId);
    if (def.id === 'mock') return { apiKey: 'mock', baseUrl: def.baseUrl, source: 'mock' };
    const row = (await this.providerRows(ws)).get(def.id);
    if (row && !row.enabled) return null;
    if (row?.api_key_ciphertext) {
      return { apiKey: this.deps.box.decrypt(row.api_key_ciphertext, this.aad(ws, def.id)), baseUrl: def.baseUrl, appUrl: this.deps.config.appUrl, source: 'workspace' };
    }
    const platform = this.platformKey(def.id);
    return platform ? { apiKey: platform, baseUrl: def.baseUrl, appUrl: this.deps.config.appUrl, source: 'platform' } : null;
  }

  async listModels(ws: string, providerId: string, refresh = false): Promise<{ models: ModelInfo[]; cachedAt: string | null }> {
    const def = this.definition(providerId);
    const rows = await this.providerRows(ws);
    const row = rows.get(def.id);
    const fresh = row?.models_cached_at && Date.now() - new Date(row.models_cached_at).getTime() < 6 * 3_600_000;
    if (!refresh && fresh && Array.isArray(row.models_cache)) {
      return { models: row.models_cache, cachedAt: new Date(row.models_cached_at).toISOString() };
    }
    const cred = (await this.credentials(ws, def.id)) ?? { apiKey: '', baseUrl: def.baseUrl, appUrl: this.deps.config.appUrl };
    const models = await this.adapters[def.id].listModels(cred);
    await this.deps.db.tenant(ws, (q) =>
      q.query(
        `INSERT INTO ai_providers (workspace_id, provider, models_cache, models_cached_at, default_model) VALUES ($1,$2,$3,now(),$4)
         ON CONFLICT (workspace_id, provider) DO UPDATE SET models_cache = EXCLUDED.models_cache, models_cached_at = now()`,
        [ws, def.id, JSON.stringify(models), def.defaultModel],
      ),
    );
    return { models, cachedAt: new Date().toISOString() };
  }

  // ---------------------------------------------------------------- enrutado y límites

  /** Orden de candidatos para una tarea: ruta específica → modelo por defecto → resto de proveedores configurados. */
  async plan(ws: string, task: AiTask): Promise<RouteTarget[]> {
    const settings = await this.getSettings(ws);
    const states = await this.getProviderStates(ws);
    const usable = states.filter((s) => s.configured && s.enabled && (s.id !== 'mock' || this.deps.config.llmEnableMock));
    const out: RouteTarget[] = [];
    const push = (t: RouteTarget | null | undefined) => {
      if (t && t.model && usable.some((s) => s.id === t.provider) && !out.some((o) => o.provider === t.provider && o.model === t.model)) out.push(t);
    };
    for (const t of settings.routing[task] ?? []) push(t);
    if (settings.defaultProvider) push({ provider: settings.defaultProvider, model: settings.defaultModel ?? usable.find((s) => s.id === settings.defaultProvider)?.defaultModel ?? '' });
    for (const s of usable) if (s.defaultModel) push({ provider: s.id, model: s.defaultModel });
    return out;
  }

  private async checkLimits(ws: string, task: AiTask, settings: AiSettings) {
    if (settings.limits.disabledTasks.includes(task)) {
      throw new ProviderError('limit_exceeded', 'Esta tarea de IA está desactivada por el administrador', false);
    }
    const r = await this.deps.db.tenant(ws, (q) =>
      q.query<{ hour: number; month: string | number | null }>(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
                COALESCE(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::float8 AS month
         FROM llm_usage WHERE workspace_id = $1 AND created_at >= date_trunc('month', now()) - interval '1 hour'`,
        [ws],
      ),
    );
    const hour = r.rows[0]?.hour ?? 0;
    const month = Number(r.rows[0]?.month ?? 0);
    if (hour >= settings.limits.maxRequestsPerHour) {
      throw new ProviderError('limit_exceeded', `Límite de ${settings.limits.maxRequestsPerHour} peticiones de IA por hora alcanzado`, false);
    }
    if (settings.limits.monthlyBudgetUsd !== null && month >= settings.limits.monthlyBudgetUsd) {
      throw new ProviderError('limit_exceeded', `Presupuesto mensual de IA agotado (${settings.limits.monthlyBudgetUsd} USD)`, false);
    }
    return { hour };
  }

  private async logUsage(ws: string, e: { userId?: string | null; task: string; provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs: number; ok: boolean; errorCode?: string; errorMessage?: string; isFallback: boolean; ref?: string }) {
    await this.deps.db.tenant(ws, (q) =>
      q.query(
        `INSERT INTO llm_usage (id, workspace_id, user_id, task, provider, model, input_tokens, output_tokens, cost_usd, latency_ms, ok, error_code, error_message, is_fallback, ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [newId(), ws, e.userId ?? null, e.task, e.provider, e.model, e.inputTokens, e.outputTokens, e.costUsd, e.latencyMs, e.ok, e.errorCode ?? null, e.errorMessage?.slice(0, 500) ?? null, e.isFallback, e.ref ?? null],
      ),
    );
  }

  // ---------------------------------------------------------------- ejecución

  async run(ws: string, req: AiRunRequest): Promise<AiRunResult> {
    const settings = await this.getSettings(ws);
    const { hour } = await this.checkLimits(ws, req.task, settings);
    const candidates = req.target ? [req.target] : await this.plan(ws, req.task);
    if (!candidates.length) {
      throw new ProviderError('not_configured', 'No hay ningún proveedor de IA configurado. Añade una API key en Ajustes › Proveedores de IA.', false);
    }
    const rows = await this.providerRows(ws);
    const attempts: AttemptLog[] = [];
    for (const [i, target] of candidates.entries()) {
      const def = this.definitions[target.provider];
      if (!def) continue;
      const cred = await this.credentials(ws, def.id);
      if (!cred) {
        attempts.push({ provider: def.id, model: target.model, ok: false, latencyMs: 0, error: 'Sin credenciales', code: 'not_configured' });
        continue;
      }
      if (req.tools?.length && !def.supportsTools) {
        attempts.push({ provider: def.id, model: target.model, ok: false, latencyMs: 0, error: 'No soporta herramientas', code: 'invalid_request' });
        continue;
      }
      // Con claves de la PLATAFORMA manda un techo que la organización no puede ampliar.
      if (cred.source === 'platform' && hour >= Math.min(settings.limits.maxRequestsPerHour, this.deps.config.aiMaxRequestsPerHour)) {
        attempts.push({ provider: def.id, model: target.model, ok: false, latencyMs: 0, error: 'Límite de uso de las claves de la plataforma alcanzado', code: 'limit_exceeded' });
        continue;
      }
      const t0 = Date.now();
      try {
        const res = await this.adapters[def.id].chat(
          {
            model: target.model,
            system: req.system,
            messages: req.messages,
            json: req.json,
            maxTokens: Math.min(req.maxTokens ?? 16_000, settings.limits.maxOutputTokens),
            tools: req.tools,
            effort: req.effort ?? DEFAULT_EFFORT[req.task],
            signal: req.signal,
          },
          cred,
        );
        const latencyMs = Date.now() - t0;
        // Con claves de plataforma se ignoran los precios definidos por la organización.
        const { price } = resolvePrice(def.id, res.model, cred.source === 'platform' ? {} : settings.pricing, rows.get(def.id)?.models_cache ?? null);
        const costUsd = res.reportedCostUsd ?? computeCost(def.id, res.usage, price);
        await this.logUsage(ws, { userId: req.userId, task: req.task, provider: def.id, model: res.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd, latencyMs, ok: true, isFallback: i > 0, ref: req.ref });
        attempts.push({ provider: def.id, model: res.model, ok: true, latencyMs });
        return { ...res, provider: def.id, latencyMs, costUsd, attempts };
      } catch (e) {
        const latencyMs = Date.now() - t0;
        const pe = e instanceof ProviderError ? e : new ProviderError('unavailable', (e as Error).message, true);
        attempts.push({ provider: def.id, model: target.model, ok: false, latencyMs, error: pe.message, code: pe.code });
        await this.logUsage(ws, { userId: req.userId, task: req.task, provider: def.id, model: target.model, inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs, ok: false, errorCode: pe.code, errorMessage: pe.message, isFallback: i > 0, ref: req.ref });
        if (pe.code === 'auth') {
          await this.deps.db.tenant(ws, (q) => q.query(`UPDATE ai_providers SET last_error = $1 WHERE workspace_id = $2 AND provider = $3`, [pe.message, ws, def.id]));
        }
        if (req.signal?.aborted) break;
      }
    }
    const summary = attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join(' · ');
    const err = new ProviderError('unavailable', `Ningún proveedor de IA pudo completar la tarea. ${summary}`, false);
    (err as any).attempts = attempts;
    throw err;
  }

  /** Ejecuta una tarea que debe devolver JSON validado por un esquema, con reintentos de reparación. */
  async runJson<T>(ws: string, req: AiRunRequest, schema: ZodType<T>, repairs = 2): Promise<{ value: T; result: AiRunResult; rounds: number }> {
    const messages = [...req.messages];
    let last: AiRunResult | null = null;
    let lockedTarget = req.target;
    for (let round = 0; round <= repairs; round++) {
      last = await this.run(ws, { ...req, messages, json: true, target: lockedTarget });
      lockedTarget = { provider: last.provider, model: last.model };
      let problem: string;
      try {
        const parsed = schema.safeParse(extractJson(last.text));
        if (parsed.success) return { value: parsed.data, result: last, rounds: round + 1 };
        problem = parsed.error.issues
          .slice(0, 15)
          .map((i) => `- ${i.path.join('.') || '(raíz)'}: ${i.message}`)
          .join('\n');
      } catch (e) {
        problem = `- ${(e as Error).message}`;
      }
      messages.push({ role: 'assistant', content: last.text.slice(0, 20_000) });
      messages.push({ role: 'user', content: `Tu respuesta no cumple el esquema requerido:\n${problem}\n\nDevuelve de nuevo el objeto JSON COMPLETO corregido, sin texto adicional.` });
    }
    throw new ProviderError('bad_response', `El modelo no generó un JSON válido tras ${repairs + 1} intentos`, false);
  }

  /** Bucle de herramientas independiente del proveedor (el mismo para Claude, OpenAI, DeepSeek u OpenRouter). */
  async runAgent(
    ws: string,
    req: AiRunRequest & { tools: ToolSpec[]; execute: (call: ToolCall) => Promise<{ content: string; isError?: boolean }>; maxSteps?: number },
  ): Promise<{ text: string; provider: string; model: string; toolLog: { name: string; input: unknown; isError?: boolean }[]; costUsd: number; steps: number }> {
    const messages = [...req.messages];
    const toolLog: { name: string; input: unknown; isError?: boolean }[] = [];
    let target = req.target;
    let cost = 0;
    const maxSteps = req.maxSteps ?? 6;
    for (let step = 0; step < maxSteps; step++) {
      const res = await this.run(ws, { ...req, messages, target });
      target = { provider: res.provider, model: res.model };
      cost += res.costUsd ?? 0;
      if (res.stopReason !== 'tool_use' || !res.toolCalls.length) {
        return { text: res.text, provider: res.provider, model: res.model, toolLog, costUsd: cost, steps: step + 1 };
      }
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, native: res.native });
      // Como mucho MAX_TOOL_CALLS_PER_STEP herramientas por paso, de una en una: un modelo (o un texto
      // inyectado) no puede lanzar decenas de consultas en paralelo. Las demás reciben un error explícito.
      const results: ToolResult[] = [];
      for (const [i, call] of res.toolCalls.entries()) {
        if (i >= MAX_TOOL_CALLS_PER_STEP) {
          toolLog.push({ name: call.name, input: call.input ?? null, isError: true });
          results.push({ toolCallId: call.id, name: call.name, content: `Error: demasiadas herramientas en un mismo paso (máx. ${MAX_TOOL_CALLS_PER_STEP}); pídelas en el siguiente`, isError: true });
          continue;
        }
        if (!call.input) {
          toolLog.push({ name: call.name, input: null, isError: true });
          results.push({ toolCallId: call.id, name: call.name, content: `Error: ${call.parseError ?? 'entrada inválida'}`, isError: true });
          continue;
        }
        try {
          const out = await req.execute(call);
          toolLog.push({ name: call.name, input: call.input, isError: out.isError });
          results.push({ toolCallId: call.id, name: call.name, content: out.content.slice(0, 30_000), isError: out.isError });
        } catch (e) {
          toolLog.push({ name: call.name, input: call.input, isError: true });
          results.push({ toolCallId: call.id, name: call.name, content: `Error: ${(e as Error).message}`, isError: true });
        }
      }
      messages.push({ role: 'tool', results });
    }
    // Último turno sin herramientas para forzar una respuesta final.
    const final = await this.run(ws, { ...req, messages: [...messages, { role: 'user', content: 'Resume la respuesta final con la información obtenida.' }], tools: undefined, target });
    cost += final.costUsd ?? 0;
    return { text: final.text, provider: final.provider, model: final.model, toolLog, costUsd: cost, steps: maxSteps + 1 };
  }

  async compare(ws: string, input: { system?: string; prompt: string; targets: RouteTarget[]; userId: string }) {
    return Promise.all(
      input.targets.map(async (t) => {
        try {
          const r = await this.run(ws, { task: 'chat', system: input.system, messages: [{ role: 'user', content: input.prompt }], target: t, userId: input.userId, ref: 'compare', maxTokens: 4000 });
          return { ...t, ok: true, text: r.text, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: r.costUsd, servedModel: r.model };
        } catch (e) {
          return { ...t, ok: false, error: (e as Error).message };
        }
      }),
    );
  }

  async testProvider(ws: string, providerId: string) {
    const states = await this.getProviderStates(ws);
    const st = states.find((s) => s.id === providerId);
    if (!st?.configured) throw badRequest('El proveedor no tiene API key configurada');
    const model = st.defaultModel;
    if (!model) throw badRequest('Selecciona primero un modelo por defecto para este proveedor');
    let ok = false;
    let error: string | null = null;
    let latencyMs = 0;
    try {
      const r = await this.run(ws, { task: 'chat', messages: [{ role: 'user', content: 'Responde únicamente: OK' }], target: { provider: providerId, model }, maxTokens: 512, effort: 'low', ref: 'provider_test' });
      ok = true;
      latencyMs = r.latencyMs;
    } catch (e) {
      error = (e as Error).message;
    }
    await this.deps.db.tenant(ws, (q) =>
      q.query(`UPDATE ai_providers SET last_test_at = now(), last_test_ok = $1, last_error = $2 WHERE workspace_id = $3 AND provider = $4`, [ok, error, ws, providerId]),
    );
    return { ok, error, latencyMs, model };
  }

  async usage(ws: string, days = 30) {
    return this.deps.db.tenant(ws, async (q) => {
      const params = [ws, days];
      const totals = await q.query(
        `SELECT count(*)::int AS requests, count(*) FILTER (WHERE NOT ok)::int AS errors,
                COALESCE(sum(input_tokens),0)::int AS input_tokens, COALESCE(sum(output_tokens),0)::int AS output_tokens,
                COALESCE(sum(cost_usd),0)::float8 AS cost_usd, count(*) FILTER (WHERE ok AND cost_usd IS NULL)::int AS unpriced,
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok), 0)::int AS p50,
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok), 0)::int AS p95
         FROM llm_usage WHERE workspace_id = $1 AND created_at > now() - make_interval(days => $2)`,
        params,
      );
      const byModel = await q.query(
        `SELECT provider, model, count(*)::int AS requests, count(*) FILTER (WHERE NOT ok)::int AS errors,
                COALESCE(sum(input_tokens),0)::int AS input_tokens, COALESCE(sum(output_tokens),0)::int AS output_tokens,
                COALESCE(sum(cost_usd),0)::float8 AS cost_usd, COALESCE(avg(latency_ms) FILTER (WHERE ok),0)::int AS avg_latency_ms
         FROM llm_usage WHERE workspace_id = $1 AND created_at > now() - make_interval(days => $2)
         GROUP BY provider, model ORDER BY requests DESC LIMIT 50`,
        params,
      );
      const byTask = await q.query(
        `SELECT task, count(*)::int AS requests, COALESCE(sum(cost_usd),0)::float8 AS cost_usd
         FROM llm_usage WHERE workspace_id = $1 AND created_at > now() - make_interval(days => $2) GROUP BY task ORDER BY requests DESC`,
        params,
      );
      const daily = await q.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS requests, COALESCE(sum(cost_usd),0)::float8 AS cost_usd
         FROM llm_usage WHERE workspace_id = $1 AND created_at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 1`,
        params,
      );
      const errors = await q.query(
        `SELECT created_at, task, provider, model, error_code, error_message, latency_ms FROM llm_usage
         WHERE workspace_id = $1 AND NOT ok ORDER BY created_at DESC LIMIT 25`,
        [ws],
      );
      return { days, totals: totals.rows[0], byModel: byModel.rows, byTask: byTask.rows, daily: daily.rows, recentErrors: errors.rows };
    });
  }
}
