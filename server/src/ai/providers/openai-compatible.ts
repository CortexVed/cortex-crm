import { ProviderError, type ChatRequest, type ChatResponse, type Credentials, type ModelInfo, type ProviderAdapter, type ToolCall } from '../types';
import type { ProviderDefinition } from './registry';

/**
 * Adaptador genérico para APIs compatibles con OpenAI Chat Completions
 * (OpenAI, DeepSeek, OpenRouter, Gemini, Mistral, Groq...).
 */

const PDF_CAPABLE = new Set(['openai', 'openrouter']);

function toMessages(req: ChatRequest, def: ProviderDefinition): any[] {
  const out: any[] = [];
  if (req.system) out.push({ role: 'system', content: req.system + (req.json ? '\n\nResponde ÚNICAMENTE con un objeto JSON válido.' : '') });
  else if (req.json) out.push({ role: 'system', content: 'Responde ÚNICAMENTE con un objeto JSON válido.' });
  for (const m of req.messages) {
    if (m.role === 'user') {
      let content = m.content;
      const files: any[] = [];
      for (const a of m.attachments ?? []) {
        if (a.kind === 'pdf') {
          // OpenAI y OpenRouter aceptan PDF como parte "file" (data URL en base64) en Chat Completions.
          if (!PDF_CAPABLE.has(def.id)) throw new ProviderError('invalid_request', `${def.label} no admite PDF directamente: usa Claude, OpenAI u OpenRouter, o adjunta el texto`, false);
          files.push({ type: 'file', file: { filename: a.name, file_data: `data:application/pdf;base64,${a.data}` } });
        } else content = `[Documento: ${a.name}]\n${a.data}\n\n${content}`;
      }
      out.push({ role: 'user', content: files.length ? [{ type: 'text', text: content }, ...files] : content });
    } else if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) } }));
      }
      out.push(msg);
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
    }
  }
  return out;
}

function statusError(def: ProviderDefinition, status: number, detail: string): ProviderError {
  const d = detail.slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError('auth', `${def.label} rechazó la API key`, false, status);
  if (status === 402) return new ProviderError('limit_exceeded', `${def.label}: saldo o créditos insuficientes`, false, status);
  if (status === 429) return new ProviderError('rate_limit', `${def.label}: límite de peticiones alcanzado`, true, status);
  if (status === 400 || status === 404 || status === 422) return new ProviderError('invalid_request', `${def.label} rechazó la petición: ${d}`, false, status);
  return new ProviderError('unavailable', `${def.label} no disponible (${status}): ${d}`, true, status);
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([t, external]) : t;
}

export function createOpenAiCompatibleAdapter(def: ProviderDefinition, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  const headers = (cred: { apiKey?: string; appUrl?: string }) => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cred.apiKey) h.Authorization = `Bearer ${cred.apiKey}`;
    if (def.id === 'openrouter') {
      if (cred.appUrl) h['HTTP-Referer'] = cred.appUrl;
      h['X-Title'] = 'Cortex CRM';
    }
    return h;
  };

  return {
    async chat(req: ChatRequest, cred: Credentials): Promise<ChatResponse> {
      const body: Record<string, unknown> = { model: req.model, messages: toMessages(req, def) };
      const cap = def.maxOutputCap ?? 32_000;
      if (def.id === 'openai') body.max_completion_tokens = Math.min(req.maxTokens ?? 16_000, cap);
      else body.max_tokens = Math.min(req.maxTokens ?? 8_192, cap);
      if (req.json && def.supportsJsonMode && !req.tools?.length) body.response_format = { type: 'json_object' };
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
        body.tool_choice = 'auto';
      }
      if (def.id === 'openai' && req.effort && /^(o\d|gpt-5)/i.test(req.model)) body.reasoning_effort = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort;
      if (def.id === 'openrouter') body.usage = { include: true };

      let res: Response;
      try {
        res = await fetchImpl(`${cred.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: headers(cred),
          body: JSON.stringify(body),
          signal: combineSignals(300_000, req.signal),
        });
      } catch (e) {
        const name = (e as Error)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('timeout', `Tiempo de espera agotado con ${def.label}`, true);
        throw new ProviderError('unavailable', `No se pudo conectar con ${def.label}`, true);
      }
      if (!res.ok) {
        let detail = '';
        try {
          const j: any = await res.json();
          detail = j?.error?.message ?? JSON.stringify(j).slice(0, 300);
        } catch {
          detail = res.statusText;
        }
        throw statusError(def, res.status, detail);
      }
      const json: any = await res.json().catch(() => null);
      const choice = json?.choices?.[0];
      if (!choice?.message) {
        if (json?.error) throw new ProviderError('unavailable', `${def.label}: ${json.error.message ?? 'error'}`, true);
        throw new ProviderError('bad_response', `${def.label} devolvió una respuesta sin contenido`, true);
      }
      const content = choice.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : '';
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc: any) => {
        try {
          const input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          const ok = input && typeof input === 'object' && !Array.isArray(input);
          return { id: tc.id, name: tc.function?.name, input: ok ? input : null, parseError: ok ? undefined : 'Argumentos no son un objeto' };
        } catch {
          return { id: tc.id, name: tc.function?.name, input: null, parseError: 'Argumentos JSON inválidos' };
        }
      });
      const finish = choice.finish_reason;
      if (finish === 'content_filter') throw new ProviderError('refusal', `${def.label} bloqueó la respuesta por su filtro de contenido`, true);
      return {
        text,
        toolCalls,
        stopReason: toolCalls.length || finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end' : 'other',
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        reportedCostUsd: def.reportsCost && typeof json.usage?.cost === 'number' ? json.usage.cost : null,
        model: json.model ?? req.model,
      };
    },

    async listModels(cred): Promise<ModelInfo[]> {
      if (!def.publicModels && !cred.apiKey) throw new ProviderError('not_configured', `Configura la API key de ${def.label} para listar modelos`, false);
      let res: Response;
      try {
        res = await fetchImpl(`${cred.baseUrl.replace(/\/$/, '')}/models`, { headers: headers(cred), signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new ProviderError('unavailable', `No se pudo conectar con ${def.label}`, true);
      }
      if (!res.ok) throw statusError(def, res.status, res.statusText);
      const json: any = await res.json();
      const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      const toPerM = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : null;
      };
      return list
        .map((m) => {
          const id = String(m.id ?? m.name ?? '').replace(/^models\//, '');
          const pin = toPerM(m.pricing?.prompt);
          const pout = toPerM(m.pricing?.completion);
          return {
            id,
            name: m.name && m.name !== m.id ? String(m.name) : id,
            contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
            pricing: pin !== null && pout !== null ? { inputPerM: pin, outputPerM: pout } : null,
            description: typeof m.description === 'string' ? m.description.slice(0, 240) : undefined,
          } satisfies ModelInfo;
        })
        .filter((m) => m.id && (!def.modelFilter || def.modelFilter(m.id)))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 1000);
    },
  };
}
