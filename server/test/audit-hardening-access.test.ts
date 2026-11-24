import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import type { Role } from '../../shared/constants';

/**
 * Regresiones de la auditoría de noviembre de 2026 (segunda parte): cuentas, invitaciones, visibilidad
 * de la configuración, exportación, bandeja de mensajes y entradas sin autenticar.
 */

type Env = Awaited<ReturnType<typeof setup>>;
const PASSWORD = 'Contraseña-Segura-123';

function harness() {
  const ctx = {} as { env: Env; owner: Client };
  beforeAll(async () => {
    ctx.env = await setup();
    ctx.owner = new Client(ctx.env.app);
    await ctx.owner.register('Olga', `olga-${randomUUID().slice(0, 8)}@example.com`, 'Accesos SL');
  });
  afterAll(async () => ctx.env.close());

  const join = async (email: string, role: Role, name: string) => {
    expect((await ctx.owner.req('POST', '/api/workspace/invites', { email, role })).status).toBe(200);
    const client = new Client(ctx.env.app);
    const acc = await client.req('POST', '/api/auth/invite/accept', { token: ctx.env.inviteToken(email), name, password: PASSWORD });
    expect(acc.status).toBe(200);
    client.csrf = acc.body.csrfToken;
    return { client, id: acc.body.user.id as string };
  };

  const manual = async (title: string, operations: unknown[]) => {
    const r = await ctx.owner.req('POST', '/api/evolve/requests/manual', { changeSet: { title, summary: title, operations } });
    expect(r.status).toBe(200);
    await ctx.env.drain();
    const req = (await ctx.owner.req('GET', `/api/evolve/requests/${r.body.id}`)).body;
    expect(req.status).toBe('ready_for_review');
    return req as { id: string; risk: string };
  };

  const publish = async (req: { id: string; risk: string }) => {
    expect((await ctx.owner.req('POST', `/api/evolve/requests/${req.id}/approve`, req.risk === 'high' ? { confirmation: 'APLICAR' } : {})).status).toBe(200);
    expect((await ctx.owner.req('POST', `/api/evolve/requests/${req.id}/deploy`)).status).toBe(200);
  };

  return { ctx, join, manual, publish };
}

const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

describe('cuentas: enlaces de restablecimiento e invitaciones', () => {
  const { ctx, join } = harness();

  it('un enlace nuevo invalida el anterior y el que genera un propietario caduca en 30 minutos', async () => {
    const m = await join('reset1@example.com', 'member', 'Reset Uno');
    const first = await ctx.owner.req('POST', `/api/workspace/members/${m.id}/reset-link`);
    expect(first.status).toBe(200);
    expect(first.body.expiresInMinutes).toBe(30);
    const second = await ctx.owner.req('POST', `/api/workspace/members/${m.id}/reset-link`);
    const reset = (link: string, password: string) => new Client(ctx.env.app).req('POST', '/api/auth/password/reset', { token: tokenOf(link), password });
    expect((await reset(first.body.link, 'Nueva-Contraseña-111')).status).toBe(400);
    expect((await reset(second.body.link, 'Nueva-Contraseña-222')).status).toBe(200);
    const exp = await ctx.env.db.query<{ minutes: number }>(
      `SELECT round(extract(epoch FROM (expires_at - created_at)) / 60)::int AS minutes FROM auth_tokens WHERE kind = 'password_reset' AND user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [m.id],
    );
    expect(exp.rows[0].minutes).toBe(30);
  });

  it('restablecer la contraseña revoca las API keys creadas por la cuenta y avisa por correo', async () => {
    const adm = await join('reset2@example.com', 'admin', 'Admin Reset');
    const key = await adm.client.req('POST', '/api/workspace/api-keys', { name: 'ERP', role: 'member' });
    expect(key.status).toBe(200);
    const bearer = { authorization: `Bearer ${key.body.key}` };
    expect((await new Client(ctx.env.app).req('GET', '/api/records/contacts', undefined, bearer)).status).toBe(200);
    const link = (await ctx.owner.req('POST', `/api/workspace/members/${adm.id}/reset-link`)).body.link;
    const r = await new Client(ctx.env.app).req('POST', '/api/auth/password/reset', { token: tokenOf(link), password: 'Nueva-Contraseña-333' });
    expect(r.status).toBe(200);
    expect(r.body.apiKeysRevoked).toBe(1);
    expect((await new Client(ctx.env.app).req('GET', '/api/records/contacts', undefined, bearer)).status).toBe(401);
    expect(ctx.env.sent.some((m) => m.to === 'reset2@example.com' && m.subject.startsWith('Tu contraseña ha cambiado'))).toBe(true);
  });

  it('el enlace de un propietario se rechaza (y se audita) si la cuenta pasa a tener otra organización', async () => {
    const m = await join('reset3@example.com', 'member', 'Reset Tres');
    const link = (await ctx.owner.req('POST', `/api/workspace/members/${m.id}/reset-link`)).body.link;
    expect((await m.client.req('POST', '/api/auth/workspaces', { name: 'Mi Otra SL' })).status).toBe(200);
    const r = await new Client(ctx.env.app).req('POST', '/api/auth/password/reset', { token: tokenOf(link), password: 'Nueva-Contraseña-444' });
    expect(r.status).toBe(400);
    expect((await ctx.env.db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.owner_reset_link_refused' AND target_id = $1`, [m.id])).rows).toHaveLength(1);
    // La contraseña no ha cambiado
    expect((await new Client(ctx.env.app).login('reset3@example.com', PASSWORD)).status).toBe(200);
  });

  it('una invitación de administrador deja de valer si quien la creó deja de ser propietario', async () => {
    const co = await join('co@example.com', 'member', 'Copropietaria');
    expect((await ctx.owner.req('PATCH', `/api/workspace/members/${co.id}`, { role: 'owner' })).status).toBe(200);
    expect((await co.client.req('POST', '/api/workspace/invites', { email: 'nuevo-admin@example.com', role: 'admin' })).status).toBe(200);
    const token = ctx.env.inviteToken('nuevo-admin@example.com');
    expect((await ctx.owner.req('PATCH', `/api/workspace/members/${co.id}`, { role: 'member' })).status).toBe(200);
    const acc = await new Client(ctx.env.app).req('POST', '/api/auth/invite/accept', { token, name: 'Nuevo Admin', password: PASSWORD });
    expect(acc.status).toBeGreaterThanOrEqual(400);
    expect(acc.status).toBeLessThan(500);
    expect((await ctx.env.db.query(`SELECT 1 FROM users WHERE email = 'nuevo-admin@example.com'`)).rows).toHaveLength(0);
  });

  it('el correo de invitación no reproduce enlaces ni dominios escritos en nombres', async () => {
    const evil = new Client(ctx.env.app);
    await evil.register('Soporte www.banco-falso.example', 'evil@example.com', 'Verifica tu cuenta en http://phish.example/login');
    expect((await evil.req('POST', '/api/workspace/invites', { email: 'victima@example.com', role: 'member' })).status).toBe(200);
    const mail = ctx.env.sent.filter((m) => m.to === 'victima@example.com').at(-1)!;
    expect(mail.subject).toBe('Te han invitado a una organización en Cortex CRM');
    for (const part of [mail.text, mail.html]) {
      expect(part).not.toContain('banco-falso');
      expect(part).not.toContain('phish.example');
    }
  });
});

describe('visibilidad de la configuración, exportación y bandeja', () => {
  const { ctx, join, manual, publish } = harness();
  let admin: Awaited<ReturnType<typeof join>>;
  let builder: Awaited<ReturnType<typeof join>>;
  let member: Awaited<ReturnType<typeof join>>;

  it('las URL de las integraciones solo las ve completas administración; miembros y lectores no ven la configuración', async () => {
    admin = await join('a@example.com', 'admin', 'Admin');
    builder = await join('b@example.com', 'builder', 'Constructora');
    member = await join('m@example.com', 'member', 'Miembro');
    await publish(await manual('Webhook ERP', [{ op: 'upsert_integration', integration: { key: 'erp', name: 'ERP', url: 'https://erp.example.com/hooks/secreto-123' } }]));
    const bp = async (c: Client) => (await c.req('GET', '/api/blueprint')).body.blueprint;
    expect((await bp(builder.client)).integrations[0].url).toBe('https://erp.example.com/…');
    expect((await bp(admin.client)).integrations[0].url).toBe('https://erp.example.com/hooks/secreto-123');
    const forMember = await bp(member.client);
    expect(forMember.integrations).toEqual([]);
    expect(forMember.automations).toEqual([]);
    expect(forMember.scripts).toEqual([]);
  });

  it('la exportación solo incluye los módulos, registros y paneles que el rol puede leer', async () => {
    await publish(await manual('Oportunidades solo para propietarios', [{ op: 'update_module', module: 'deals', changes: { permissions: { read: 'owner' } } }]));
    await ctx.owner.req('POST', '/api/records/deals', { values: { title: 'Operación secreta' } });
    const exp = await admin.client.req('GET', '/api/workspace/export');
    expect(exp.status).toBe(200);
    expect(exp.body.blueprint.modules.some((m: any) => m.key === 'deals')).toBe(false);
    expect(exp.body.records.some((r: any) => r.module_key === 'deals')).toBe(false);
    expect(exp.body.blueprint.dashboards.every((d: any) => d.widgets.every((w: any) => w.module !== 'deals'))).toBe(true);
    expect(JSON.stringify(exp.body)).not.toContain('Operación secreta');
    const own = await ctx.owner.req('GET', '/api/workspace/export');
    expect(own.body.records.some((r: any) => r.module_key === 'deals')).toBe(true);
  });

  it('la bandeja solo muestra mensajes de fichas legibles; los no vinculados, solo administración', async () => {
    const wsId = (await ctx.owner.req('GET', '/api/workspace')).body.id;
    const contact = (await ctx.owner.req('POST', '/api/records/contacts', { values: { name: 'Cliente Uno' } })).body.record;
    const deal = (await ctx.owner.req('POST', '/api/records/deals', { values: { title: 'Trato privado' } })).body.record;
    const insert = (body: string, recordId: string | null) =>
      ctx.env.db.query(`INSERT INTO channel_messages (id, workspace_id, channel, direction, from_address, body, record_id) VALUES ($1,$2,'whatsapp','inbound','34600000000',$3,$4)`, [randomUUID(), wsId, body, recordId]);
    await insert('Hola desde el contacto', contact.id);
    await insert('Mensaje del trato privado', deal.id);
    await insert('Mensaje sin vincular', null);
    const bodies = async (c: Client) => ((await c.req('GET', '/api/comms/inbox')).body as any[]).map((m) => m.body).sort();
    expect(await bodies(member.client)).toEqual(['Hola desde el contacto']);
    expect(await bodies(admin.client)).toEqual(['Hola desde el contacto', 'Mensaje sin vincular']);
    expect(await bodies(ctx.owner)).toEqual(['Hola desde el contacto', 'Mensaje del trato privado', 'Mensaje sin vincular']);
    // Un miembro no puede "adoptar" un mensaje sin vincular en una ficha suya
    const loose = (await ctx.env.db.query<{ id: string }>(`SELECT id FROM channel_messages WHERE body = 'Mensaje sin vincular'`)).rows[0].id;
    expect((await member.client.req('POST', `/api/comms/messages/${loose}/link`, { recordId: contact.id })).status).toBe(404);
  });

  it('los nombres de archivo pierden los caracteres que invierten el texto', async () => {
    await publish(await manual('Adjuntos en contactos', [{ op: 'add_field', module: 'contacts', field: { key: 'docs', label: 'Documentos', type: 'file' } }]));
    const up = await member.client.req('POST', '/api/files', Buffer.from('hola'), { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('factura‮txt.exe.txt') });
    expect(up.status).toBe(200);
    const fileId = up.body.id ?? up.body.file?.id;
    const got = await member.client.req('GET', `/api/files/${fileId}`);
    expect(got.status).toBe(200);
    expect(String(got.headers['content-disposition'])).not.toContain('%E2%80%AE');
  });
});

describe('entradas sin autenticar', () => {
  const { ctx } = harness();

  it('los errores del navegador: sin duplicados masivos y sin trazas ni tokens si no hay sesión', async () => {
    for (let i = 0; i < 25; i++) {
      const r = await new Client(ctx.env.app).req('POST', '/api/client-errors', { message: 'TypeError: x is undefined', stack: 'at https://app/invite/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', url: 'https://app/invite/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?x=1' });
      expect(r.status).toBe(200);
    }
    const rows = (await ctx.env.db.query<{ stack: string | null; context: any }>(`SELECT stack, context FROM error_events WHERE source = 'web' AND message = 'TypeError: x is undefined'`)).rows;
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.stack === null)).toBe(true);
    expect(JSON.stringify(rows[0].context)).not.toContain('AAAAAAAAAAAAAAAAAAAA');
  });

  it('una ruta inexistente responde 404 sin autenticar ni consultar organizaciones', async () => {
    const r = await new Client(ctx.env.app).req('GET', '/api/no-existe', undefined, { authorization: 'Bearer evk_falsa_123' });
    expect(r.status).toBe(404);
  });
});
