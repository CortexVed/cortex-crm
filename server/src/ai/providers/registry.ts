import { msg } from '../../i18n';

/**
 * Registro de proveedores del AI PROVIDER MANAGER.
 * Añadir un proveedor compatible con la API de OpenAI (Mistral, Groq, Together, etc.) es
 * solo añadir una entrada aquí: no hace falta tocar el resto de la aplicación.
 * Los modelos NUNCA se codifican como lista fija: se descubren con la API de cada proveedor.
 */
export interface ProviderDefinition {
  id: string;
  label: string;
  adapter: 'anthropic' | 'openai_compatible';
  baseUrl: string;
  /** Modelo sugerido hasta que el administrador elija otro de la lista descubierta. */
  defaultModel: string | null;
  docsUrl: string;
  keyHint: string;
  tier: 'core' | 'experimental';
  description: string;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  supportsPdf: boolean;
  /** El listado de modelos no requiere API key. */
  publicModels?: boolean;
  /** El proveedor devuelve el coste real de cada llamada. */
  reportsCost?: boolean;
  /** Filtra modelos que no son de chat (embeddings, audio, imagen...). */
  modelFilter?: (id: string) => boolean;
  /** Máximo de tokens de salida que acepta la API del proveedor. */
  maxOutputCap?: number;
}

const NON_CHAT = /(embed|embedding|whisper|tts|transcribe|audio|realtime|image|dall-e|moderation|search|similarity|edit|instruct|babbage|davinci|computer-use|sora)/i;

export const PROVIDERS: Record<string, ProviderDefinition> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
    tier: 'core',
    description: msg('Modelos Claude vía SDK oficial de Anthropic. Recomendado para planificar cambios y revisar código.'),
    supportsTools: true,
    supportsJsonMode: false,
    supportsPdf: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: null,
    docsUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    tier: 'core',
    description: msg('Modelos GPT y de razonamiento de OpenAI.'),
    supportsTools: true,
    supportsJsonMode: true,
    supportsPdf: false,
    modelFilter: (id) => /^(gpt|o\d|chatgpt)/i.test(id) && !NON_CHAT.test(id),
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: null,
    docsUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-…',
    tier: 'core',
    description: msg('Modelos DeepSeek (API compatible con OpenAI).'),
    supportsTools: true,
    supportsJsonMode: true,
    supportsPdf: false,
    maxOutputCap: 8192,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    adapter: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: null,
    docsUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    tier: 'core',
    description: msg('Acceso a cientos de modelos de distintos proveedores con una sola clave. Catálogo y precios en vivo desde su API.'),
    supportsTools: true,
    supportsJsonMode: true,
    supportsPdf: false,
    publicModels: true,
    reportsCost: true,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    adapter: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: null,
    docsUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza…',
    tier: 'experimental',
    description: msg('Experimental: endpoint compatible con OpenAI de Gemini. No verificado en producción.'),
    supportsTools: true,
    supportsJsonMode: true,
    supportsPdf: false,
    modelFilter: (id) => /gemini/i.test(id) && !NON_CHAT.test(id),
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral AI',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: null,
    docsUrl: 'https://console.mistral.ai/api-keys',
    keyHint: '…',
    tier: 'experimental',
    description: msg('Experimental: API compatible con OpenAI. No verificado en producción.'),
    supportsTools: true,
    supportsJsonMode: true,
    supportsPdf: false,
    modelFilter: (id) => !NON_CHAT.test(id),
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: null,
    docsUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    tier: 'experimental',
    description: msg('Experimental: inferencia de baja latencia, API compatible con OpenAI. No verificado en producción.'),
    supportsTools: true,
    supportsJsonMode: true,
    supportsPdf: false,
    modelFilter: (id) => !NON_CHAT.test(id),
  },
};

export const MOCK_PROVIDER: ProviderDefinition = {
  id: 'mock',
  label: msg('Simulado (solo tests)'),
  adapter: 'openai_compatible',
  baseUrl: 'mock://',
  defaultModel: 'mock-model',
  docsUrl: '',
  keyHint: '',
  tier: 'experimental',
  description: msg('Proveedor determinista para pruebas automáticas. Deshabilitado en producción.'),
  supportsTools: true,
  supportsJsonMode: true,
  supportsPdf: true,
};
