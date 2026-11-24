import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import { isPrivateIp, safePost } from '../src/lib/ssrf';
import { SecretBox } from '../src/lib/crypto';
import { redact } from '../src/lib/errors';

describe('asistente contextual EVOLVE AI', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let c: Client;
  let companyId: string;
  beforeAll(async () => {
    env = await setup();
    c = new Client(env.app);
    await c.register('Pablo', 'pablo@example.com', 'Contexto SL');
    companyId = (await c.req('POST', '/api/records/companies', { values: { name: 'Umbrella Corp' } })).body.record.id;
    await c.req('POST', '/api/records/deals', { values: { title: 'Renovación Umbrella', amount: 12000, company: companyId } });
  });
  afterAll(async () => env.close());

  it('entiende "este cliente" por el contexto de pantalla y consulta datos reales con herramientas', async () => {
    let step = 0;
    let system = '';
    let userTurn = '';
    env.setMock((req) => {
      step++;
      system = req.system ?? '';
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      userTurn = lastUser && lastUser.role === 'user' ? lastUser.content : '';
      if (step === 1) return { toolCalls: [{ id: 'c1', name: 'list_related', input: { module: 'companies', id: companyId, related_module: 'deals' } }] };
      const toolMsg = req.messages.find((m) => m.role === 'tool') as any;
      return { text: `Tenéis 1 oportunidad: ${JSON.parse(toolMsg.results[0].content).results[0].items[0].title}` };
    });
    const r = await c.req('POST', '/api/assistant/chat', { message: '¿Qué oportunidades tenemos con este cliente?', context: { module: 'companies', recordId: companyId } });
    expect(r.status).toBe(200);
    // El contexto de pantalla (que puede contener texto de terceros) viaja como DATOS en el turno del usuario, no en el system prompt
    expect(userTurn).toContain('[CONTEXTO]');
    expect(userTurn).toContain('ficha de Empresa «Umbrella Corp»');
    expect(userTurn.endsWith('¿Qué oportunidades tenemos con este cliente?')).toBe(true);
    expect(system).not.toContain('Umbrella Corp');
    expect(r.body.message.content).toBe('Tenéis 1 oportunidad: Renovación Umbrella');
    expect(r.body.message.toolCalls[0].name).toBe('list_related');
    const conv = await c.req('GET', `/api/assistant/conversations/${r.body.conversationId}`);
    expect(conv.body.messages).toHaveLength(2);
  });

  it('las escrituras solo se proponen (requieren confirmación del usuario)', async () => {
    let step = 0;
    env.setMock(() => {
      step++;
      if (step === 1) return { toolCalls: [{ id: 'c2', name: 'propose_record_change', input: { action: 'create', module: 'tasks', values: { title: 'Llamar a Umbrella' }, summary: 'Crear tarea de seguimiento' } }] };
      return { text: 'He preparado la tarea; confírmala para crearla.' };
    });
    const before = (await c.req('GET', '/api/records/tasks')).body.total;
    const r = await c.req('POST', '/api/assistant/chat', { message: 'Crea una tarea para llamar a Umbrella' });
    expect(r.body.message.actions[0]).toMatchObject({ type: 'record_change', payload: { action: 'create', module: 'tasks' } });
    expect((await c.req('GET', '/api/records/tasks')).body.total).toBe(before);
  });

  it('sin proveedores configurados en producción no inventa respuestas', async () => {
    const prod = await setup({ env: { LLM_ENABLE_MOCK: 'false' } });
    const u = new Client(prod.app);
    await u.register('Sin IA', 'sinia@example.com', 'Sin IA SL');
    const r = await u.req('POST', '/api/assistant/chat', { message: 'hola' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ai_not_configured');
    await prod.close();
  });
});

describe('controles de seguridad', () => {
  it('SSRF: bloquea IPs privadas, locales y de metadatos', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd12::1', '::ffff:127.0.0.1', '100.64.0.1']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
    await expect(safePost('http://example.com/hook', '{}', {})).rejects.toThrow(/HTTPS/);
    await expect(safePost('https://127.0.0.1/hook', '{}', {})).rejects.toThrow(/privado/);
    await expect(safePost('https://user:pass@example.com/', '{}', {})).rejects.toThrow(/credenciales/);
  });

  it('cifrado ligado a la organización (AAD): un secreto no se puede mover a otra', () => {
    const box = new SecretBox(Buffer.alloc(32, 1));
    const t = box.encrypt('sk-secreto', 'ai:org-a:openai');
    expect(box.decrypt(t, 'ai:org-a:openai')).toBe('sk-secreto');
    expect(() => box.decrypt(t, 'ai:org-b:openai')).toThrow();
    const tampered = t.slice(0, -4) + (t.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => box.decrypt(tampered, 'ai:org-a:openai')).toThrow();
  });

  it('redacta secretos antes de registrarlos', () => {
    expect(redact({ apiKey: 'x', nested: { password: 'y', ok: 1 }, list: [{ token: 'z' }] })).toEqual({ apiKey: '[redactado]', nested: { password: '[redactado]', ok: 1 }, list: [{ token: '[redactado]' }] });
  });
});
