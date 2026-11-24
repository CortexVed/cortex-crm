import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type ChatRequest, type ChatResponse, type Credentials, type ModelInfo, type ProviderAdapter, type ToolCall } from '../types';

/** Modelos que aceptan output_config.effort. */
export function supportsEffort(model: string): boolean {
  return (
    /^claude-(fable|mythos)-/.test(model) ||
    /^claude-(opus|sonnet|haiku)-5/.test(model) ||
    /^claude-opus-4-[6-9]/.test(model) ||
    /^claude-sonnet-4-6/.test(model)
  );
}

/** Modelos con fallback de rechazos en el servidor (server-side refusal fallback). */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus-5(-5)?|fable-5-[12]|sonnet-5-5)$/.test(model);
}

function toAnthropicMessages(req: ChatRequest): any[] {
  const out: any[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      const blocks: any[] = [];
      for (const a of m.attachments ?? []) {
        if (a.kind === 'pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name });
        else blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: a.data }, title: a.name });
      }
      blocks.push({ type: 'text', text: m.content || '(vacío)' });
      out.push({ role: 'user', content: blocks });
    } else if (m.role === 'assistant') {
      // En bucles de herramientas se reenvía el contenido nativo sin cambios (incluye bloques de razonamiento).
      if (m.native) out.push({ role: 'assistant', content: m.native });
      else {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input ?? {} });
        out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '…' }] });
      }
    } else {
      // Todos los resultados de un mismo paso van en un único mensaje de usuario.
      out.push({
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content, is_error: r.isError ?? false })),
      });
    }
  }
  return out;
}

function mapError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('auth', 'Anthropic rechazó la API key (revisa que sea válida y tenga permisos)', false, (e as any).status);
  }
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', 'Límite de peticiones de Anthropic alcanzado', true, 429);
  if (e instanceof Anthropic.NotFoundError) return new ProviderError('invalid_request', `Modelo o recurso no encontrado en Anthropic: ${e.message}`, false, 404);
  if (e instanceof Anthropic.BadRequestError) return new ProviderError('invalid_request', `Petición rechazada por Anthropic: ${e.message}`, false, 400);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'Tiempo de espera agotado con Anthropic', true);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('unavailable', 'No se pudo conectar con Anthropic', true);
  if (e instanceof Anthropic.APIError) return new ProviderError('unavailable', `Error de Anthropic (${e.status ?? '?'}): ${e.message}`, true, e.status ?? undefined);
  return new ProviderError('unavailable', (e as Error)?.message ?? 'Error desconocido', true);
}

export const anthropicAdapter: ProviderAdapter = {
  async chat(req: ChatRequest, cred: Credentials): Promise<ChatResponse> {
    const client = new Anthropic({ apiKey: cred.apiKey, baseURL: cred.baseUrl || undefined, maxRetries: 1, timeout: 300_000 });
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 16_000,
      messages: toAnthropicMessages(req),
      cache_control: { type: 'ephemeral' },
    };
    if (req.system) params.system = req.system;
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true }));
    }
    if (req.effort && supportsEffort(req.model)) params.output_config = { effort: req.effort };
    if (supportsServerFallback(req.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    if (req.json) {
      params.system = `${req.system ?? ''}\n\nResponde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni bloques de código.`.trim();
    }
    try {
      const stream = client.beta.messages.stream(params as any, { signal: req.signal });
      const msg: any = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') {
        throw new ProviderError('refusal', `El modelo declinó la petición${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}`, true);
      }
      let text = '';
      const toolCalls: ToolCall[] = [];
      for (const block of msg.content ?? []) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          const ok = block.input && typeof block.input === 'object' && !Array.isArray(block.input);
          toolCalls.push({ id: block.id, name: block.name, input: ok ? block.input : null, parseError: ok ? undefined : 'Entrada de herramienta inválida' });
        }
      }
      const u = msg.usage ?? {};
      return {
        text,
        toolCalls,
        stopReason: msg.stop_reason === 'tool_use' ? 'tool_use' : msg.stop_reason === 'max_tokens' ? 'max_tokens' : msg.stop_reason === 'end_turn' ? 'end' : 'other',
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
        native: msg.content,
        model: msg.model ?? req.model,
      };
    } catch (e) {
      throw mapError(e);
    }
  },

  async listModels(cred): Promise<ModelInfo[]> {
    if (!cred.apiKey) throw new ProviderError('not_configured', 'Configura la API key de Anthropic para listar modelos', false);
    const client = new Anthropic({ apiKey: cred.apiKey, baseURL: cred.baseUrl || undefined, maxRetries: 1, timeout: 30_000 });
    try {
      const out: ModelInfo[] = [];
      for await (const m of client.models.list({ limit: 100 })) {
        out.push({ id: m.id, name: m.display_name, contextLength: (m as any).max_input_tokens ?? null });
        if (out.length >= 300) break;
      }
      return out;
    } catch (e) {
      throw mapError(e);
    }
  },
};
