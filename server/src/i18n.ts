import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  effectiveLocale,
  FALLBACK_LOCALE,
  intlTagFor,
  LOCALE_INFO,
  localeFromRegion,
  negotiateLocale,
  setI18nBackend,
  SOURCE_LOCALE,
  type Catalog,
  type Locale,
} from '../../shared/i18n';
import de from '../../shared/i18n/locales/de.json';
import en from '../../shared/i18n/locales/en.json';
import fr from '../../shared/i18n/locales/fr.json';
import it from '../../shared/i18n/locales/it.json';
import ja from '../../shared/i18n/locales/ja.json';
import ptBR from '../../shared/i18n/locales/pt-BR.json';

export { activeIntlTag, inSentence, listFormat, msg, t, tk, tp } from '../../shared/i18n';

/**
 * Idioma de cada petición y de cada trabajo en segundo plano. Se guarda en AsyncLocalStorage para que t()
 * funcione en cualquier capa sin pasar el idioma de función en función.
 *
 * Petición: el idioma que pide la cabecera Accept-Language (la web envía siempre el que está usando) o, si no
 * pide ninguno de los de Cortex, el de la persona identificada (su preferencia o el de su organización).
 * Sin cabecera ni identidad: español, como hasta ahora. Trabajo: el de la petición que lo encoló o, si lo
 * encoló el propio sistema, el de su organización.
 */
interface LocaleStore {
  locale: Locale;
  /** La petición pidió un idioma de Cortex: la identidad no lo cambia. */
  explicit: boolean;
  /** «Idioma y región» de la organización, para fechas y números. */
  orgTag: string | null;
}

const catalogs: Readonly<Record<Locale, Catalog | undefined>> = { es: undefined, en, 'pt-BR': ptBR, fr, de, it, ja };
const storage = new AsyncLocalStorage<LocaleStore>();

setI18nBackend({
  locale: () => storage.getStore()?.locale ?? SOURCE_LOCALE,
  intlTag: () => {
    const s = storage.getStore();
    return s ? intlTagFor(s.locale, s.orgTag) : LOCALE_INFO[SOURCE_LOCALE].tag;
  },
  catalog: (l) => catalogs[l],
});

// Los mensajes por defecto de zod (los que no son textos propios) también en el idioma de la petición.
const zodLocales: Readonly<Record<Locale, { localeError: z.core.$ZodErrorMap }>> = {
  es: z.locales.es(),
  en: z.locales.en(),
  'pt-BR': z.locales.ptBR(),
  fr: z.locales.fr(),
  de: z.locales.de(),
  it: z.locales.it(),
  ja: z.locales.ja(),
};
z.config({ localeError: (issue) => zodLocales[currentLocale()].localeError(issue) });

declare module 'fastify' {
  interface FastifyRequest {
    i18n: LocaleStore | null;
  }
}

export function currentLocale(): Locale {
  return storage.getStore()?.locale ?? SOURCE_LOCALE;
}

/** Idioma de la petición o trabajo en curso; null fuera de ellos (arranque, tareas del sistema). */
export function contextLocale(): Locale | null {
  return storage.getStore()?.locale ?? null;
}

/** Ejecuta fn con un idioma (trabajos, correos a otra persona, el CRM inicial de una organización nueva). */
export function withLocale<T>(locale: Locale, fn: () => T, orgTag: string | null = null): T {
  return storage.run({ locale, explicit: true, orgTag }, fn);
}

/** Nombre del idioma para los prompts de la IA («Responde en {promptLanguage()}»). */
export function promptLanguage(locale: Locale = currentLocale()): string {
  return LOCALE_INFO[locale].promptName;
}

/**
 * Idioma de la organización de la petición o trabajo en curso (su «Idioma y región»): el de los datos que se crean
 * para toda la organización, como las etiquetas de módulos y campos que propone la IA. Sin organización conocida,
 * el idioma de la petición.
 */
export function orgLocale(): Locale {
  const s = storage.getStore();
  return s?.orgTag ? localeFromRegion(s.orgTag) : currentLocale();
}

function storeFromHeader(header: string | string[] | undefined): LocaleStore {
  const raw = Array.isArray(header) ? header.join(',') : header;
  const negotiated = negotiateLocale(raw);
  return { locale: negotiated ?? (raw?.trim() ? FALLBACK_LOCALE : SOURCE_LOCALE), explicit: !!negotiated, orgTag: null };
}

/** Debe registrarse antes que cualquier otro hook onRequest: todo lo que viene después corre con este idioma. */
export function registerI18n(app: FastifyInstance): void {
  app.decorateRequest('i18n', null);
  app.addHook('onRequest', (req, _reply, done) => {
    const store = storeFromHeader(req.headers['accept-language']);
    req.i18n = store;
    storage.run(store, done);
  });
}

/** La autenticación ya sabe quién es: su preferencia y la región de su organización completan el idioma. */
export function applyIdentityLocale(req: FastifyRequest, preference: string | null | undefined, orgTag: string | null | undefined): void {
  const s = req.i18n;
  if (!s) return;
  s.orgTag = orgTag ?? null;
  if (!s.explicit) s.locale = effectiveLocale(preference, orgTag);
}

/** Ejecuta fn con el idioma de la petición (para el manejador de errores, por si se llama fuera de contexto). */
export function inRequestLocale<T>(req: FastifyRequest, fn: () => T): T {
  const s = req.i18n;
  return s && storage.getStore() !== s ? storage.run(s, fn) : fn();
}
