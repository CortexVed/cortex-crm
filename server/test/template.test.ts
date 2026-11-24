import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import { loadConfig, parseEncryptionKey } from '../src/config';
import { waitForDatabase } from '../src/lib/wait-db';

/**
 * Despliegue desde la plantilla de Railway: la aplicación tiene que arrancar solo con las variables que
 * define la plantilla (secretos generados por Railway, referencias entre servicios y variables de Railway).
 */

// Lo que generan las funciones de plantilla de Railway: `${{secret(64)}}` y el ejemplo base64 de su documentación.
const RAILWAY_SECRET_64 = Array.from(crypto.randomBytes(64), (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
const RAILWAY_BASE64_43 = `${crypto.randomBytes(32).toString('base64').slice(0, 43)}=`;

/** Variables de cada servicio tal como quedan tras resolver las referencias de la plantilla. */
function templateEnv(role: 'web' | 'worker'): Record<string, string> {
  const railway = { RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PROJECT_ID: 'proj-123', PORT: '8080' };
  const common = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://postgres:pw@postgres.railway.internal:5432/railway', APP_ENCRYPTION_KEY: RAILWAY_SECRET_64, ...railway };
  return role === 'web'
    ? { ...common, PROCESS_ROLE: 'web', RAILWAY_PUBLIC_DOMAIN: 'cortex-production-1a2b.up.railway.app', PLATFORM_ADMIN_SETUP_TOKEN: RAILWAY_SECRET_64.slice(0, 48) }
    : { ...common, PROCESS_ROLE: 'worker', APP_URL: 'https://cortex-production-1a2b.up.railway.app' };
}

describe('configuración desde la plantilla', () => {
  it('una clave de 32 bytes en base64 (formato de siempre) da exactamente los mismos bytes', () => {
    const raw = crypto.randomBytes(32);
    expect(parseEncryptionKey(raw.toString('base64')).equals(raw)).toBe(true);
    expect(parseEncryptionKey(raw.toString('base64url')).equals(raw)).toBe(true);
    expect(parseEncryptionKey(` ${raw.toString('base64')}\n`).equals(raw)).toBe(true);
  });

  it('acepta los secretos que genera Railway y deriva siempre la misma clave', () => {
    const a = parseEncryptionKey(RAILWAY_SECRET_64);
    expect(a).toHaveLength(32);
    expect(parseEncryptionKey(RAILWAY_SECRET_64).equals(a)).toBe(true);
    expect(parseEncryptionKey(`${RAILWAY_SECRET_64.slice(0, 63)}x`).equals(a)).toBe(false);
    expect(parseEncryptionKey(RAILWAY_BASE64_43)).toHaveLength(32);
    expect(parseEncryptionKey(RAILWAY_SECRET_64.slice(0, 32))).toHaveLength(32);
  });

  it('rechaza claves cortas o que no parecen aleatorias', () => {
    expect(() => parseEncryptionKey('demasiado-corta')).toThrow(/al menos 32/);
    expect(() => parseEncryptionKey('a'.repeat(40))).toThrow(/aleatoria/);
  });

  it('sin APP_URL usa el dominio público de Railway; si se indica APP_URL, manda APP_URL', () => {
    const web = loadConfig(templateEnv('web'));
    expect(web.appUrl).toBe('https://cortex-production-1a2b.up.railway.app');
    expect(loadConfig({ ...templateEnv('web'), APP_URL: 'https://crm.example.com/' }).appUrl).toBe('https://crm.example.com');
    const { RAILWAY_PUBLIC_DOMAIN: _omit, ...withoutDomain } = templateEnv('web');
    expect(() => loadConfig(withoutDomain)).toThrow(/APP_URL/);
  });

  it('web y worker arrancan solo con las variables de la plantilla y comparten la misma clave', () => {
    const web = loadConfig(templateEnv('web'));
    const worker = loadConfig(templateEnv('worker'));
    expect([web.role, worker.role]).toEqual(['web', 'worker']);
    expect(web.isProd && worker.isProd).toBe(true);
    expect(web.encryptionKey.equals(worker.encryptionKey)).toBe(true);
    expect(worker.appUrl).toBe(web.appUrl);
    expect(web.clientIpHeader).toBe('x-real-ip');
    expect(web.platformAdminSetupToken).toHaveLength(48);
    expect(worker.platformAdminSetupToken).toBeNull();
  });
});

describe('arranque con la base de datos todavía iniciándose', () => {
  it('espera a que Postgres acepte conexiones en lugar de fallar al primer intento', async () => {
    let calls = 0;
    const waits: number[] = [];
    const db = { query: async () => { if (++calls < 4) throw new Error('connect ECONNREFUSED postgres.railway.internal:5432'); return {}; } };
    const attempts = await waitForDatabase(db, { sleep: async (ms) => void waits.push(ms) });
    expect(attempts).toBe(4);
    expect(waits).toEqual([500, 1000, 1500]);
  });

  it('se rinde al superar el plazo y propaga el error', async () => {
    const db = { query: async () => { throw new Error('connect ECONNREFUSED'); } };
    await expect(waitForDatabase(db, { maxMs: 0, sleep: async () => {} })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('token de instalación para la administración de la plataforma', () => {
  const TOKEN = RAILWAY_SECRET_64.slice(0, 48);

  it('sin token configurado no existe la vía web', async () => {
    const env = await setup({ config: { isProd: true } });
    try {
      const c = new Client(env.app);
      const me = await c.register('Uno', 'uno@example.com', 'Uno SL');
      expect(me.features.platformSetupAvailable).toBe(false);
      expect((await c.req('POST', '/api/auth/platform-admin/claim', { token: TOKEN })).status).toBe(404);
    } finally {
      await env.close();
    }
  });

  it('la primera persona con el token se convierte en administradora; después la vía se cierra', async () => {
    const env = await setup({ config: { isProd: true, platformAdminSetupToken: TOKEN } });
    try {
      const owner = new Client(env.app);
      const me = await owner.register('Dueña', 'duena@example.com', 'Instalación SL');
      expect(me.user.isPlatformAdmin).toBe(false);
      expect(me.features.platformSetupAvailable).toBe(true);
      expect((await owner.req('GET', '/api/admin/overview')).status).toBe(403);

      const wrong = await owner.req('POST', '/api/auth/platform-admin/claim', { token: `${TOKEN.slice(0, 47)}#` });
      expect(wrong.status).toBe(403);
      expect((await env.db.query(`SELECT 1 FROM audit_log WHERE action = 'platform.admin_claim_failed'`)).rows).toHaveLength(1);

      // Sin sesión de usuario (p. ej. con una API key) no se puede reclamar
      expect((await new Client(env.app).req('POST', '/api/auth/platform-admin/claim', { token: TOKEN })).status).toBe(401);

      expect((await owner.req('POST', '/api/auth/platform-admin/claim', { token: TOKEN })).status).toBe(200);
      const after = (await owner.req('GET', '/api/auth/me')).body;
      expect(after.user.isPlatformAdmin).toBe(true);
      expect(after.features.platformSetupAvailable).toBe(false);
      expect((await owner.req('GET', '/api/admin/overview')).status).toBe(200);
      expect((await env.db.query(`SELECT 1 FROM audit_log WHERE action = 'platform.admin_granted_by_setup_token'`)).rows).toHaveLength(1);

      // Una segunda persona con el mismo token ya no puede
      const other = new Client(env.app);
      const otherMe = await other.register('Otra', 'otra@example.com', 'Otra SL');
      expect(otherMe.features.platformSetupAvailable).toBe(false);
      expect((await other.req('POST', '/api/auth/platform-admin/claim', { token: TOKEN })).status).toBe(409);
      expect((await other.req('GET', '/api/auth/me')).body.user.isPlatformAdmin).toBe(false);
    } finally {
      await env.close();
    }
  });
});
