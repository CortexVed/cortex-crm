import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';

// API de ApiWass simulada (https://apiwass.com/api-docs): estado de la sesión y envío de textos.
const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
let statusReply: { status: number; body: unknown } = { status: 200, body: { status: 'READY' } };
let sendReply: { status: number; body: string; headers?: Record<string, string> } = { status: 200, body: '"OK"' };

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.startsWith('https://apiwass.com/api/sessions/') && url.endsWith('/status')) {
    return new Response(JSON.stringify(statusReply.body), { status: statusReply.status, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://apiwass.com/api/sessions/') && url.endsWith('/messages/text')) {
    return new Response(sendReply.body, { status: sendReply.status, headers: { 'content-type': 'application/json', ...(sendReply.headers ?? {}) } });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

let env: Awaited<ReturnType<typeof setup>>;
let owner: Client;
let connectorId = '';
let hookUrl = '';
let contactId = '';

beforeAll(async () => {
  env = await setup({ fetchImpl: fakeFetch });
  owner = new Client(env.app);
  await owner.register('Marta Ruiz', 'marta.apiwass@example.com', 'Clínica Ruiz SL');
  contactId = (await owner.req('POST', '/api/records/contacts', { values: { name: 'Lucía Pérez', phone: '+34 600 123 456' } })).body.record.id;
});
afterAll(async () => env.close());

const hook = (body: unknown) => new Client(env.app).req('POST', hookUrl, body);
const messages = async () => (await env.db.query(`SELECT direction, body, from_address, to_address, record_id, external_id, status FROM channel_messages WHERE channel = 'apiwass' ORDER BY created_at`)).rows;

describe('canal WhatsApp con ApiWass', () => {
  it('rechaza credenciales que ApiWass no acepta y alias de sesión no válidos', async () => {
    statusReply = { status: 401, body: { error: 'Missing or invalid API key.', errorType: 'Unauthorized' } };
    const bad = await owner.req('POST', '/api/comms/connectors', { type: 'apiwass', name: 'WhatsApp', credentials: { apiKey: 'sk_mala', sessionId: 'ventas' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('ApiWass: la API key no es válida.');
    statusReply = { status: 404, body: { error: 'Not found' } };
    const missing = await owner.req('POST', '/api/comms/connectors', { type: 'apiwass', name: 'WhatsApp', credentials: { apiKey: 'sk_buena', sessionId: 'nope' } });
    expect(missing.body.error.message).toContain('«nope»');
    const before = calls.length;
    const weird = await owner.req('POST', '/api/comms/connectors', { type: 'apiwass', name: 'WhatsApp', credentials: { apiKey: 'sk_buena', sessionId: '../otra' } });
    expect(weird.status).toBe(400);
    expect(calls.length).toBe(before); // ni siquiera se llama a ApiWass
  });

  it('conecta una sesión comprobando la API key y el estado, sin devolver nunca la clave', async () => {
    statusReply = { status: 200, body: { status: 'READY' } };
    const r = await owner.req('POST', '/api/comms/connectors', { type: 'apiwass', name: 'WhatsApp recepción', credentials: { apiKey: 'sk_test_123', sessionId: 'ventas' } });
    expect(r.status).toBe(200);
    expect(r.body.config).toMatchObject({ sessionId: 'ventas', sessionStatus: 'READY' });
    expect(r.body.webhookUrl).toContain('/api/hooks/apiwass/');
    const check = calls.at(-1)!;
    expect(check.url).toBe('https://apiwass.com/api/sessions/ventas/status');
    expect(check.headers['x-api-key']).toBe('sk_test_123');
    const list = await owner.req('GET', '/api/comms/connectors');
    const c = list.body.connectors.find((x: any) => x.type === 'apiwass');
    connectorId = c.id;
    hookUrl = new URL(c.webhookUrl).pathname;
    expect(list.body.types.some((t: any) => t.type === 'apiwass' && t.status === 'available')).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain('sk_test_123');
  });

  it('el webhook guarda los mensajes entrantes en la ficha del contacto por su teléfono, sin duplicarlos', async () => {
    const payload = {
      event: 'messages.received',
      sessionId: '1_ventas', // ApiWass puede anteponer el id de la cuenta
      from: '34600123456',
      pushName: 'Lucía',
      messageType: 'conversation',
      text: 'Hola, ¿tenéis cita mañana?',
      timestamp: 1700000000,
      raw: { key: { id: 'WAMSG-1', remoteJid: '34600123456@s.whatsapp.net', fromMe: false } },
    };
    expect((await hook(payload)).status).toBe(200);
    expect((await hook(payload)).status).toBe(200); // reintento de ApiWass
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'inbound', body: 'Hola, ¿tenéis cita mañana?', from_address: 'Lucía (+34600123456)', record_id: contactId, external_id: 'WAMSG-1' });
    // El responsable del contacto recibe el aviso.
    const contact = (await owner.req('GET', `/api/records/contacts/${contactId}`)).body;
    expect(contact.record?.lastActivityAt ?? contact.lastActivityAt).toBeTruthy();
  });

  it('ignora grupos, mensajes propios y eventos de otras sesiones; sin texto guarda un aviso legible', async () => {
    await hook({ event: 'messages.received', sessionId: 'ventas', from: '120363000000@g.us', text: 'Hola grupo', timestamp: 1 });
    await hook({ event: 'messages.received', sessionId: 'ventas', from: '34600123456', text: 'Eco', timestamp: 2, raw: { key: { id: 'X', remoteJid: '34600123456@s.whatsapp.net', fromMe: true } } });
    await hook({ event: 'messages.received', sessionId: 'otra-sesion', from: '34600123456', text: 'De otra sesión', timestamp: 3 });
    await hook({ event: 'message.sent', sessionId: 'ventas', to: '34600123456', text: 'Enviado desde el móvil', timestamp: 4 });
    await hook({ event: 'messages.received', sessionId: 'ventas', from: '34611222333', pushName: 'Desconocido', messageType: 'imageMessage', text: '', timestamp: 5 });
    const rows = await messages();
    expect(rows.map((r: any) => r.body)).toEqual(['Hola, ¿tenéis cita mañana?', '[Imagen]']);
    // Remitente sin contacto: queda sin vincular (y sin id de WhatsApp, con huella para no duplicarlo).
    expect(rows[1].record_id).toBeNull();
    expect(rows[1].external_id).toMatch(/^h:/);
    const unknown = await new Client(env.app).req('POST', '/api/hooks/apiwass/token-que-no-existe-0000000', { event: 'messages.received', from: '34600123456', text: 'x' });
    expect(unknown.status).toBe(404);
  });

  it('el estado de la sesión que avisa ApiWass se refleja en el canal', async () => {
    await hook({ event: 'session.status', sessionId: 'ventas', status: 'disconnected', reason: 'logout' });
    const c = (await owner.req('GET', '/api/comms/connectors')).body.connectors.find((x: any) => x.id === connectorId);
    expect(c.config.sessionStatus).toBe('DISCONNECTED');
  });

  it('se responde desde la ficha: ApiWass recibe el teléfono internacional y el texto', async () => {
    sendReply = { status: 200, body: '"OK"' };
    const r = await owner.req('POST', '/api/comms/send', { connectorId, recordId: contactId, text: 'Sí, mañana a las 10.' });
    expect(r.status).toBe(200);
    const sent = calls.at(-1)!;
    expect(sent).toMatchObject({ url: 'https://apiwass.com/api/sessions/ventas/messages/text', method: 'POST', body: { phone: '34600123456', message: 'Sí, mañana a las 10.' } });
    expect(sent.headers['x-api-key']).toBe('sk_test_123');
    const out = (await messages()).filter((m: any) => m.direction === 'outbound');
    expect(out).toEqual([expect.objectContaining({ body: 'Sí, mañana a las 10.', to_address: '34600123456', record_id: contactId, status: 'sent' })]);
  });

  it('si ApiWass limita los envíos, el CRM lo dice con el tiempo de espera y no guarda el mensaje', async () => {
    sendReply = { status: 429, body: JSON.stringify({ error: 'Too many requests', errorType: 'TooManyRequests' }), headers: { 'retry-after': '30' } };
    const r = await owner.req('POST', '/api/comms/send', { connectorId, recordId: contactId, text: 'Otro mensaje' });
    expect(r.status).toBe(429);
    expect(r.body.error.message).toContain('30');
    expect((await messages()).filter((m: any) => m.body === 'Otro mensaje')).toHaveLength(0);
  });
});
