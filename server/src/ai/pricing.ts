import type { ModelInfo, Usage } from './types';

export interface Price {
  inputPerM: number;
  outputPerM: number;
}

/**
 * Precios públicos conocidos (USD por millón de tokens) de los modelos de Anthropic.
 * Para OpenRouter se usan los precios en vivo de su API de modelos y para el resto los que
 * configure el administrador. Si no hay precio, el coste se muestra como "no configurado".
 */
const KNOWN_PRICES: Record<string, Price> = {
  'anthropic:claude-fable-5-2': { inputPerM: 8, outputPerM: 40 },
  'anthropic:claude-fable-5-1': { inputPerM: 10, outputPerM: 50 },
  'anthropic:claude-fable-5': { inputPerM: 10, outputPerM: 50 },
  'anthropic:claude-opus-5-5': { inputPerM: 4, outputPerM: 20 },
  'anthropic:claude-opus-5': { inputPerM: 5, outputPerM: 25 },
  'anthropic:claude-opus-4-8': { inputPerM: 5, outputPerM: 25 },
  'anthropic:claude-opus-4-7': { inputPerM: 5, outputPerM: 25 },
  'anthropic:claude-opus-4-6': { inputPerM: 5, outputPerM: 25 },
  'anthropic:claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10 },
  'anthropic:claude-sonnet-5': { inputPerM: 2, outputPerM: 10 },
  'anthropic:claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'anthropic:claude-haiku-5-5': { inputPerM: 0.1, outputPerM: 0.5 },
  'anthropic:claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
};

export function resolvePrice(
  provider: string,
  model: string,
  overrides: Record<string, Price> = {},
  modelsCache: ModelInfo[] | null = null,
): { price: Price | null; source: 'override' | 'provider_api' | 'known' | null } {
  const key = `${provider}:${model}`;
  if (overrides[key]) return { price: overrides[key], source: 'override' };
  const cached = modelsCache?.find((m) => m.id === model)?.pricing;
  if (cached) return { price: cached, source: 'provider_api' };
  if (KNOWN_PRICES[key]) return { price: KNOWN_PRICES[key], source: 'known' };
  return { price: null, source: null };
}

export function computeCost(provider: string, usage: Usage, price: Price | null): number | null {
  if (!price) return null;
  if (provider === 'anthropic') {
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const plainInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
    return round6((plainInput * price.inputPerM + cacheWrite * price.inputPerM * 1.25 + cacheRead * price.inputPerM * 0.1 + usage.outputTokens * price.outputPerM) / 1e6);
  }
  return round6((usage.inputTokens * price.inputPerM + usage.outputTokens * price.outputPerM) / 1e6);
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
