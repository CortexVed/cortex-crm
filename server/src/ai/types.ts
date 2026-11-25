export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema del input (objeto, additionalProperties: false). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown> | null;
  parseError?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface Attachment {
  kind: 'pdf' | 'text';
  name: string;
  /** base64 para PDF, texto plano para 'text'. */
  data: string;
}

export type ChatMessage =
  | { role: 'user'; content: string; attachments?: Attachment[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; native?: unknown }
  | { role: 'tool'; results: ToolResult[] };

/** Esfuerzo de razonamiento. xhigh y max solo los admiten los modelos más recientes (los adaptadores los rebajan a high). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  tools?: ToolSpec[];
  effort?: Effort;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: Usage;
  /** Coste informado por el propio proveedor (p. ej. OpenRouter), en USD. */
  reportedCostUsd?: number | null;
  /** Mensaje nativo del proveedor para reenviarlo sin cambios en bucles de herramientas. */
  native?: unknown;
  model: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number | null;
  pricing?: { inputPerM: number; outputPerM: number } | null;
  description?: string;
}

export interface Credentials {
  apiKey: string;
  baseUrl: string;
  appUrl?: string;
}

export interface ProviderAdapter {
  chat(req: ChatRequest, cred: Credentials): Promise<ChatResponse>;
  listModels(cred: { apiKey?: string; baseUrl: string }): Promise<ModelInfo[]>;
}

export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'invalid_request'
  | 'unavailable'
  | 'timeout'
  | 'refusal'
  | 'not_configured'
  | 'limit_exceeded'
  | 'bad_response';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
