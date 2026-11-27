import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  effectiveLocale,
  intlTagFor,
  interpolate,
  localeFromRegion,
  LOCALES,
  matchLocale,
  negotiateLocale,
  pluralKey,
  translate,
  translatePlural,
  type Catalog,
} from '../../shared/i18n';
import { currentLocale, t, withLocale } from '../src/i18n';
import { enqueue } from '../src/lib/jobs';
import { planningTask } from '../src/evolve/pipeline';
import { Client, setup } from './helpers';

const LOCALES_DIR = path.resolve(__dirname, '../../shared/i18n/locales');
const catalog = (l: string): Catalog => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${l}.json`), 'utf8'));
/** Traducción esperada de una clave (el español si aún no está traducida). */
const expected = (l: string, key: string) => {
  const v = catalog(l)[key];
  return typeof v === 'string' && v ? v : key;
};

describe('idiomas: negociación', () => {
  it('elige el primer idioma soportado de Accept-Language respetando q=', () => {
    expect(negotiateLocale('de-CH,de;q=0.9,en;q=0.8')).toBe('de');
    expect(negotiateLocale('nl-NL,nl;q=0.9,fr;q=0.5')).toBe('fr');
    expect(negotiateLocale('en;q=0.2,ja;q=0.9')).toBe('ja');
    expect(negotiateLocale('pt-PT')).toBe('pt-BR');
    expect(negotiateLocale('pt')).toBe('pt-BR');
    expect(negotiateLocale('ca-ES')).toBe('es');
    expect(negotiateLocale('nl-NL,sv')).toBeNull();
    expect(negotiateLocale('*')).toBeNull();
    expect(negotiateLocale('')).toBeNull();
    expect(negotiateLocale(['it-IT', 'en'])).toBe('it');
  });

  it('el idioma de la organización sale de su «Idioma y región» y la preferencia personal manda', () => {
    expect(localeFromRegion('es-MX')).toBe('es');
    expect(localeFromRegion('fr-CA')).toBe('fr');
    expect(localeFromRegion('nl-NL')).toBe('en');
    expect(localeFromRegion(null)).toBe('es');
    expect(effectiveLocale(null, 'de-AT')).toBe('de');
    expect(effectiveLocale('ja', 'de-AT')).toBe('ja');
    expect(effectiveLocale('xx', 'it-IT')).toBe('it');
    expect(matchLocale('EN-gb')).toBe('en');
  });

  it('fechas y números: la región de la organización si es de la misma lengua', () => {
    expect(intlTagFor('es', 'es-MX')).toBe('es-MX');
    expect(intlTagFor('en', 'es-MX')).toBe('en-US');
    expect(intlTagFor('en', 'en-GB')).toBe('en-GB');
    expect(intlTagFor('es', 'ca-ES')).toBe('es-ES');
    expect(intlTagFor('de', 'no-válido')).toBe('de-DE');
  });
});

describe('idiomas: traducción', () => {
  it('sustituye variables y formatea los números del idioma', () => {
    expect(interpolate('Hola, {name}', { name: 'Ana' }, 'es-ES')).toBe('Hola, Ana');
    expect(interpolate('{n} filas', { n: 12345.5 }, 'es-ES')).toBe('12.345,5 filas');
    expect(interpolate('{n} rows', { n: 12345.5 }, 'en-US')).toBe('12,345.5 rows');
    expect(interpolate('Año {y}', { y: 2026 }, 'es-ES')).toBe('Año 2026');
    expect(interpolate('Falta {x}', {}, 'es-ES')).toBe('Falta {x}');
    expect(interpolate('Vacío: {x}', { x: null }, 'es-ES')).toBe('Vacío: ');
  });

  it('sin traducción devuelve el español (también en plurales)', () => {
    expect(translate('de', 'Texto que nadie ha traducido {x}', { x: 1 }, 'de-DE')).toBe('Texto que nadie ha traducido 1');
    expect(translatePlural('fr', 1, '{count} registro sin traducir', '{count} registros sin traducir', undefined, 'fr-FR')).toBe('1 registro sin traducir');
    expect(translatePlural('fr', 3, '{count} registro sin traducir', '{count} registros sin traducir', undefined, 'fr-FR')).toBe('3 registros sin traducir');
    expect(pluralKey('a', 'b')).toBe('a|b');
  });

  it('el idioma va con la petición o el trabajo (AsyncLocalStorage)', async () => {
    expect(currentLocale()).toBe('es');
    const inside = await withLocale('ja', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentLocale();
    });
    expect(inside).toBe('ja');
    expect(currentLocale()).toBe('es');
    expect(withLocale('en', () => t('Datos no válidos'))).toBe(expected('en', 'Datos no válidos'));
  });

  it('los catálogos son JSON válidos, de los idiomas previstos y conservan variables y etiquetas', () => {
    const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
    expect(files.map((f) => f.replace('.json', '')).sort()).toEqual(LOCALES.filter((l) => l !== 'es').slice().sort());
    const toks = (s: string) => [...s.matchAll(/\{(\w+)\}|<\/?(\w+)>/g)].map((m) => m[0]).sort();
    for (const f of files) {
      const cat = catalog(f.replace('.json', ''));
      for (const [key, value] of Object.entries(cat)) {
        if (typeof value === 'string') {
          if (value) expect(toks(value), `${f}: «${key}»`).toEqual(toks(key));
        } else {
          const allowed = new Set([...toks(key.replace('|', ' ')), '{count}']);
          for (const form of Object.values(value ?? {})) for (const tk of toks(form ?? '')) expect(allowed.has(tk), `${f}: «${key}» usa ${tk}`).toBe(true);
        }
      }
    }
  });
});

describe('idiomas: EVOLVE entiende las peticiones de automatización en los siete idiomas', () => {
  it('elige la tarea de automatizaciones o de funcionalidades según la petición', () => {
    for (const p of [
      'Cuando se gane una oportunidad, avisa al comercial',
      'Notify the owner when a deal is won',
      'Remind me every monday to call inactive clients',
      'Quando um negócio for ganho, avise o responsável',
      'Envoie un rappel chaque lundi aux clients inactifs',
      'Benachrichtige den Verantwortlichen, wenn ein Deal gewonnen wird',
      'Ricordami ogni lunedì di chiamare i clienti inattivi',
      '商談が成立したら担当者に通知して',
    ]) expect(planningTask(p), p).toBe('automations');
    for (const p of ['Añade un campo NIF a las empresas', 'Add a VAT number field to companies', 'Ajoute un champ SIRET aux entreprises', '自動車ディーラー向けの在庫モジュールを作って']) expect(planningTask(p), p).toBe('feature_creation');
  });
});

describe('idiomas: servidor', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  it('los errores salen en el idioma que pide la petición; sin cabecera, en español', async () => {
    const body = { email: 'nadie@example.com', password: 'x' };
    const es = await new Client(env.app).req('POST', '/api/auth/login', body);
    expect(es.status).toBe(401);
    expect(es.body.error.message).toBe('Email o contraseña incorrectos');
    for (const l of ['en', 'de', 'ja'] as const) {
      const r = await new Client(env.app).req('POST', '/api/auth/login', body, { 'accept-language': l });
      expect(r.body.error.message).toBe(expected(l, 'Email o contraseña incorrectos'));
    }
    // Un idioma que Cortex no tiene: inglés.
    const nl = await new Client(env.app).req('POST', '/api/auth/login', body, { 'accept-language': 'nl-NL' });
    expect(nl.body.error.message).toBe(expected('en', 'Email o contraseña incorrectos'));
    // Validación: el mensaje general y los propios (msg()) también se traducen.
    const weak = await new Client(env.app).req('POST', '/api/auth/register', { name: 'Ana', email: 'ana.i18n@example.com', password: 'corta', workspaceName: 'Acme' }, { 'accept-language': 'fr' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toBe(expected('fr', 'Datos no válidos'));
    expect(weak.body.error.details.find((d: any) => d.path === 'password').message).toBe(expected('fr', 'La contraseña debe tener al menos 10 caracteres'));
  });

  it('registro con idioma: la organización toma su región y la sesión lo indica; cada persona puede elegir otro', async () => {
    const c = new Client(env.app);
    const r = await c.req('POST', '/api/auth/register', { name: 'Hans', email: 'hans@example.com', password: 'Contraseña-Segura-123', workspaceName: 'Hans GmbH', locale: 'de' });
    expect(r.status).toBe(200);
    c.csrf = r.body.csrfToken;
    expect(r.body.workspace.locale).toBe('de-DE');
    expect(r.body.user.locale).toBeNull();
    const ws = await c.req('GET', '/api/workspace');
    expect(ws.body.settings.locale).toBe('de-DE');
    // Sin Accept-Language, los errores salen en el idioma de su organización.
    const denied = await c.req('POST', '/api/auth/platform-admin/claim', { token: 'x' });
    expect(denied.body.error.message).toBe(expected('de', 'Esta instalación no tiene token de instalación'));
    const pref = await c.req('PUT', '/api/auth/me/locale', { locale: 'ja' });
    expect(pref.status).toBe(200);
    expect(pref.body.user.locale).toBe('ja');
    const again = await c.req('POST', '/api/auth/platform-admin/claim', { token: 'x' });
    expect(again.body.error.message).toBe(expected('ja', 'Esta instalación no tiene token de instalación'));
    expect((await c.req('PUT', '/api/auth/me/locale', { locale: 'xx' })).status).toBe(400);
    expect((await c.req('PUT', '/api/auth/me/locale', { locale: null })).body.user.locale).toBeNull();
  });

  it('una organización nueva toma la zona horaria del navegador, la moneda de su región y el país por defecto en su idioma', async () => {
    const c = new Client(env.app);
    const bad = await c.req('POST', '/api/auth/register', { name: 'Rui', email: 'rui@example.com', password: 'Contraseña-Segura-123', workspaceName: 'Rui Ltda', locale: 'pt-BR', timezone: 'Marte/Olimpo' });
    expect(bad.status).toBe(400);
    const r = await c.req('POST', '/api/auth/register', { name: 'Rui', email: 'rui@example.com', password: 'Contraseña-Segura-123', workspaceName: 'Rui Ltda', locale: 'pt-BR', timezone: 'America/Sao_Paulo' });
    expect(r.status).toBe(200);
    c.csrf = r.body.csrfToken;
    const ws = await c.req('GET', '/api/workspace');
    expect(ws.body.settings).toMatchObject({ locale: 'pt-BR', currency: 'BRL', timezone: 'America/Sao_Paulo' });
    const bp = (await c.req('GET', '/api/blueprint')).body.blueprint;
    const deals = bp.modules.find((m: any) => m.key === 'deals');
    expect(deals.fields.find((f: any) => f.key === 'amount').currency).toBe('BRL');
    const companies = bp.modules.find((m: any) => m.key === 'companies');
    expect(companies.fields.find((f: any) => f.key === 'country').defaultValue).toBe('Brasil');
    // Sin idioma ni zona: como siempre (español, Europe/Madrid, euros, España).
    const es = new Client(env.app);
    await es.register('Eva', 'eva.i18n@example.com', 'Eva SL');
    const wsEs = await es.req('GET', '/api/workspace');
    expect(wsEs.body.settings).toMatchObject({ locale: 'es-ES', currency: 'EUR', timezone: 'Europe/Madrid' });
    const bpEs = (await es.req('GET', '/api/blueprint')).body.blueprint;
    expect(bpEs.modules.find((m: any) => m.key === 'companies').fields.find((f: any) => f.key === 'country').defaultValue).toBe('España');
  });

  it('los trabajos guardan el idioma de quien los encola', async () => {
    const id = await withLocale('it', () => enqueue(env.db, { type: 'noop.i18n', workspaceId: null }));
    const row = (await env.db.query(`SELECT locale FROM jobs WHERE id = $1`, [id])).rows[0];
    expect(row.locale).toBe('it');
    const sys = await enqueue(env.db, { type: 'noop.i18n', workspaceId: null });
    expect((await env.db.query(`SELECT locale FROM jobs WHERE id = $1`, [sys])).rows[0].locale).toBeNull();
    await env.db.query(`DELETE FROM jobs WHERE type = 'noop.i18n'`);
  });

  it('una región no válida se rechaza', async () => {
    const c = new Client(env.app);
    await c.register('Lia', 'lia.i18n@example.com', 'Lia SRL');
    const bad = await c.req('PATCH', '/api/workspace', { settings: { locale: 'no válido!' } });
    expect(bad.status).toBe(400);
    const ok = await c.req('PATCH', '/api/workspace', { settings: { locale: 'it-IT' } });
    expect(ok.status).toBe(200);
  });
});
