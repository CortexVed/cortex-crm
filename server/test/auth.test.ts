import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => env.close());

describe('autenticación y sesiones', () => {
  it('registra, crea la organización con el CRM base y marca al primer usuario como admin de plataforma', async () => {
    const c = new Client(env.app);
    const me = await c.register('Ana López', 'ana@example.com', 'Acme SL');
    expect(me.workspace.role).toBe('owner');
    expect(me.user.isPlatformAdmin).toBe(true);
    expect(me.csrfToken).toBeTruthy();
    const bp = await c.req('GET', '/api/blueprint');
    expect(bp.status).toBe(200);
    expect(bp.body.blueprint.modules.map((m: any) => m.key)).toContain('deals');
    // Correo de verificación enviado
    expect(env.sent.some((m) => m.to === 'ana@example.com' && /verify-email/.test(m.text))).toBe(true);
  });

  it('el segundo usuario no es admin de plataforma y no puede reutilizar un email', async () => {
    const c = new Client(env.app);
    const me = await c.register('Beto', 'beto@example.com', 'Beta SA');
    expect(me.user.isPlatformAdmin).toBe(false);
    const dup = await new Client(env.app).req('POST', '/api/auth/register', { name: 'Xavi', email: 'BETO@example.com', password: 'Contraseña-Segura-123', workspaceName: 'Xavi SL' });
    expect(dup.status).toBe(409);
  });

  it('limita la frecuencia de intentos de login por IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await new Client(env.app).req('POST', '/api/auth/login', { email: 'nadie@example.com', password: 'x' }, { 'x-test-rate-limit': 'on' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('rechaza contraseñas débiles', async () => {
    const r = await new Client(env.app).req('POST', '/api/auth/register', { name: 'Débil', email: 'weak@example.com', password: '1234567', workspaceName: 'W' });
    expect(r.status).toBe(400);
  });

  it('exige token CSRF en peticiones con sesión y rechaza orígenes ajenos', async () => {
    const c = new Client(env.app);
    await c.register('Carla', 'carla@example.com', 'Carla Corp');
    const token = c.csrf;
    c.csrf = null;
    const noCsrf = await c.req('POST', '/api/records/contacts', { values: { name: 'Sin CSRF' } });
    expect(noCsrf.status).toBe(403);
    c.csrf = token;
    const badOrigin = await c.req('POST', '/api/records/contacts', { values: { name: 'Origen' } }, { origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    const ok = await c.req('POST', '/api/records/contacts', { values: { name: 'Con CSRF' } });
    expect(ok.status).toBe(200);
  });

  it('login, logout y credenciales incorrectas', async () => {
    const c = new Client(env.app);
    expect((await c.login('ana@example.com', 'incorrecta')).status).toBe(401);
    expect((await c.login('noexiste@example.com', 'loquesea')).status).toBe(401);
    const ok = await c.login('ana@example.com');
    expect(ok.status).toBe(200);
    expect(ok.body.workspace.name).toBe('Acme SL');
    await c.req('POST', '/api/auth/logout');
    expect((await c.req('GET', '/api/auth/me')).status).toBe(401);
  });

  it('bloquea la cuenta tras 10 intentos fallidos', async () => {
    const c = new Client(env.app);
    await c.register('Lock', 'lock@example.com', 'Lock Org');
    const d = new Client(env.app);
    for (let i = 0; i < 10; i++) await d.login('lock@example.com', `mala-${i}`);
    const r = await d.login('lock@example.com');
    expect(r.status).toBe(429);
  });

  it('recuperación de contraseña sin enumerar usuarios e invalidación de sesiones', async () => {
    const c = new Client(env.app);
    await c.register('Dani', 'dani@example.com', 'Dani Org');
    const unknown = await new Client(env.app).req('POST', '/api/auth/password/forgot', { email: 'nadie@example.com' });
    expect(unknown.status).toBe(200);
    const known = await new Client(env.app).req('POST', '/api/auth/password/forgot', { email: 'dani@example.com' });
    expect(known.status).toBe(200);
    const mail = env.sent.filter((m) => m.to === 'dani@example.com' && /reset-password/.test(m.text)).pop()!;
    const token = decodeURIComponent(mail.text.match(/token=([^\s]+)/)![1]);
    const reset = await new Client(env.app).req('POST', '/api/auth/password/reset', { token, password: 'Nueva-Contraseña-456' });
    expect(reset.status).toBe(200);
    expect((await c.req('GET', '/api/auth/me')).status).toBe(401); // sesión anterior invalidada
    expect((await new Client(env.app).login('dani@example.com', 'Nueva-Contraseña-456')).status).toBe(200);
    const reuse = await new Client(env.app).req('POST', '/api/auth/password/reset', { token, password: 'Otra-Contraseña-789' });
    expect(reuse.status).toBe(400); // un solo uso
  });

  it('lista y revoca sesiones', async () => {
    const a = new Client(env.app);
    await a.login('ana@example.com');
    const b = new Client(env.app);
    await b.login('ana@example.com');
    const list = await a.req('GET', '/api/auth/sessions');
    const other = list.body.find((s: any) => !s.current);
    expect(other).toBeTruthy();
    expect((await a.req('DELETE', `/api/auth/sessions/${other.id}`)).status).toBe(200);
  });

  it('invitaciones: el invitado crea su cuenta y entra con el rol asignado', async () => {
    const owner = new Client(env.app);
    await owner.login('ana@example.com');
    const inv = await owner.req('POST', '/api/workspace/invites', { email: 'nuevo@example.com', role: 'viewer' });
    expect(inv.status).toBe(200);
    // Con el correo activo, el enlace solo viaja en el email (prueba de posesión del buzón)
    expect(inv.body).toEqual({ link: null, emailSent: true });
    const token = env.inviteToken('nuevo@example.com');
    const guest = new Client(env.app);
    const info = await guest.req('GET', `/api/auth/invite/${token}`);
    expect(info.body).toMatchObject({ email: 'nuevo@example.com', role: 'viewer', workspaceName: 'Acme SL', userExists: false });
    const acc = await guest.req('POST', '/api/auth/invite/accept', { token, name: 'Nuevo', password: 'Contraseña-Segura-123' });
    expect(acc.status).toBe(200);
    expect(acc.body.workspace.role).toBe('viewer');
    guest.csrf = acc.body.csrfToken;
    // Un lector no puede crear registros
    expect((await guest.req('POST', '/api/records/contacts', { values: { name: 'X' } })).status).toBe(403);
  });

  it('cabeceras de seguridad (CSP, nosniff, frame-ancestors)', async () => {
    const r = await new Client(env.app).req('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
