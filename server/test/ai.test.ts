import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import { extractJson } from '../src/ai/json';
import { createOpenAiCompatibleAdapter } from '../src/ai/providers/openai-compatible';
import { PROVIDERS } from '../src/ai/providers/registry';
import { computeCost, resolvePrice } from '../src/ai/pricing';
import { supportsEffort, supportsServerFallback } from '../src/ai/providers/anthropic';

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; json: unknown }): typeof fetch {
  return (async (input: any, init: any) => {
    const r = handler(String(input), init ?? {});
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

describe('adaptador compatible con OpenAI (OpenAI, DeepSeek, OpenRouter...)', () => {
  it('mapea mensajes, herramientas, uso y coste informado por OpenRouter', async () => {
    let body: any;
    let headers: any;
    const adapter = createOpenAiCompatibleAdapter(
      PROVIDERS.openrouter,
      fakeFetch((url, init) => {
        body = JSON.parse(String(init.body));
        headers = init.headers;
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        return {
          json: {
            model: 'anthropic/claude-x',
            choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search_records', arguments: '{"module":"contacts"}' } }] } }],
            usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042 },
          },
        };
      }),
    );
    const res = await adapter.chat(
      {
        model: 'anthropic/claude-x',
        system: 'sys',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'get_record', input: { id: '1' } }] },
          { role: 'tool', results: [{ toolCallId: 't0', name: 'get_record', content: '{}' }] },
        ],
        tools: [{ name: 'search_records', description: 'd', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      },
      { apiKey: 'sk-or-test', baseUrl: PROVIDERS.openrouter.baseUrl, appUrl: 'https://crm.example' },
    );
    expect(headers.Authorization).toBe('Bearer sk-or-test');
    expect(headers['X-Title']).toBe('Cortex CRM');
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(body.tools[0].function.name).toBe('search_records');
    expect(body.usage).toEqual({ include: true });
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls[0]).toMatchObject({ name: 'search_records', input: { module: 'contacts' } });
    expect(res.reportedCostUsd).toBe(0.00042);
  });

  it('descubre modelos de OpenRouter con precios por millón sin lista fija', async () => {
    const adapter = createOpenAiCompatibleAdapter(
      PROVIDERS.openrouter,
      fakeFetch(() => ({ json: { data: [{ id: 'z/model-b', name: 'B', context_length: 8000, pricing: { prompt: '0.000003', completion: '0.000015' } }, { id: 'a/model-a', pricing: { prompt: '-1', completion: '-1' } }] } })),
    );
    const models = await adapter.listModels({ baseUrl: PROVIDERS.openrouter.baseUrl });
    expect(models.map((m) => m.id)).toEqual(['a/model-a', 'z/model-b']);
    expect(models[1].pricing).toEqual({ inputPerM: 3, outputPerM: 15 });
    expect(models[0].pricing).toBeNull();
  });

  it('traduce errores HTTP a errores tipados (auth no reintentable, 429 reintentable)', async () => {
    const a401 = createOpenAiCompatibleAdapter(PROVIDERS.deepseek, fakeFetch(() => ({ status: 401, json: { error: { message: 'bad key' } } })));
    await expect(a401.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { apiKey: 'k', baseUrl: 'https://api.deepseek.com' })).rejects.toMatchObject({ code: 'auth', retryable: false });
    const a429 = createOpenAiCompatibleAdapter(PROVIDERS.openai, fakeFetch(() => ({ status: 429, json: {} })));
    await expect(a429.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { apiKey: 'k', baseUrl: 'https://api.openai.com/v1' })).rejects.toMatchObject({ code: 'rate_limit', retryable: true });
  });
});

describe('precios, JSON y capacidades', () => {
  it('extrae JSON aunque venga con texto o bloques de código', () => {
    expect(extractJson('Aquí va: ```json\n{"a": {"b": "}"}}\n``` fin')).toEqual({ a: { b: '}' } });
    expect(() => extractJson('{"a": 1')).toThrow(/incompleto/);
  });
  it('calcula costes con precios conocidos y caché de Anthropic', () => {
    const { price } = resolvePrice('anthropic', 'claude-opus-5-5');
    expect(price).toEqual({ inputPerM: 4, outputPerM: 20 });
    expect(computeCost('anthropic', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 }, price)).toBeCloseTo(0.4);
    expect(resolvePrice('openai', 'desconocido').price).toBeNull();
  });
  it('detecta qué modelos Claude admiten effort y fallback de rechazos', () => {
    expect(supportsEffort('claude-opus-5-5')).toBe(true);
    expect(supportsEffort('claude-haiku-4-5')).toBe(false);
    expect(supportsServerFallback('claude-opus-5-5')).toBe(true);
    expect(supportsServerFallback('claude-haiku-5-5')).toBe(false);
  });
});

describe('AI PROVIDER MANAGER', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let c: Client;
  let ws: string;
  beforeAll(async () => {
    env = await setup({
      fetchImpl: fakeFetch((url) => {
        if (url.includes('api.deepseek.com')) return { status: 503, json: { error: { message: 'caído' } } };
        return { json: { model: 'gpt-x', choices: [{ finish_reason: 'stop', message: { content: 'respuesta openai' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
      }),
    });
    c = new Client(env.app);
    ws = (await c.register('Iris', 'iris@example.com', 'IA SL')).workspace.id;
  });
  afterAll(async () => env.close());

  it('guarda API keys cifradas y solo devuelve una versión enmascarada', async () => {
    const r = await c.req('PUT', '/api/ai/providers/openai', { apiKey: 'sk-test-SUPERSECRETO-1234', defaultModel: 'gpt-x' });
    expect(r.status).toBe(200);
    expect(r.body.keyHint_masked).toBe('••••1234');
    expect(JSON.stringify(r.body)).not.toContain('SUPERSECRETO');
    const list = await c.req('GET', '/api/ai/providers');
    expect(JSON.stringify(list.body)).not.toContain('SUPERSECRETO');
    const raw = await env.db.query(`SELECT api_key_ciphertext FROM ai_providers WHERE workspace_id = $1 AND provider = 'openai'`, [ws]);
    expect(raw.rows[0].api_key_ciphertext).toMatch(/^v1\./);
    expect(raw.rows[0].api_key_ciphertext).not.toContain('SUPERSECRETO');
    const audit = await c.req('GET', '/api/workspace/audit?action=ai.');
    expect(JSON.stringify(audit.body)).not.toContain('SUPERSECRETO');
  });

  it('enruta por tarea y usa la alternativa cuando un proveedor falla', async () => {
    await c.req('PUT', '/api/ai/providers/deepseek', { apiKey: 'sk-deepseek-1234567', defaultModel: 'deepseek-x' });
    await c.req('PUT', '/api/ai/settings', { routing: { chat: [{ provider: 'deepseek', model: 'deepseek-x' }, { provider: 'openai', model: 'gpt-x' }] } });
    const res = await env.deps.ai.run(ws, { task: 'chat', messages: [{ role: 'user', content: 'hola' }] });
    expect(res.provider).toBe('openai');
    expect(res.text).toBe('respuesta openai');
    expect(res.attempts.map((a) => [a.provider, a.ok])).toEqual([['deepseek', false], ['openai', true]]);
    const usage = await c.req('GET', '/api/ai/usage?days=1');
    expect(usage.body.totals.requests).toBeGreaterThanOrEqual(2);
    expect(usage.body.recentErrors[0]).toMatchObject({ provider: 'deepseek', error_code: 'unavailable' });
  });

  it('aplica límites de uso configurados', async () => {
    await c.req('PUT', '/api/ai/settings', { limits: { maxRequestsPerHour: 1 } });
    await expect(env.deps.ai.run(ws, { task: 'chat', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'limit_exceeded' });
    await c.req('PUT', '/api/ai/settings', { limits: { maxRequestsPerHour: 500, disabledTasks: ['security'] } });
    await expect(env.deps.ai.run(ws, { task: 'security', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('compara modelos lado a lado y revoca claves', async () => {
    const cmp = await c.req('POST', '/api/ai/compare', { prompt: 'Resume', targets: [{ provider: 'openai', model: 'gpt-x' }, { provider: 'deepseek', model: 'deepseek-x' }] });
    expect(cmp.status).toBe(200);
    expect(cmp.body.results.map((r: any) => r.ok)).toEqual([true, false]);
    expect((await c.req('DELETE', '/api/ai/providers/openai/key')).status).toBe(200);
    const st = (await c.req('GET', '/api/ai/providers')).body.find((p: any) => p.id === 'openai');
    expect(st.configured).toBe(false);
  });

  it('solo administradores gestionan proveedores', async () => {
    const inv = await c.req('POST', '/api/workspace/invites', { email: 'm@example.com', role: 'member' });
    const m = new Client(env.app);
    const acc = await m.req('POST', '/api/auth/invite/accept', { token: env.inviteToken('m@example.com'), name: 'Miembro', password: 'Contraseña-Segura-123' });
    m.csrf = acc.body.csrfToken;
    expect((await m.req('GET', '/api/ai/providers')).status).toBe(403);
    expect((await m.req('PUT', '/api/ai/providers/openai', { apiKey: 'sk-robada-12345678' })).status).toBe(403);
  });
});
