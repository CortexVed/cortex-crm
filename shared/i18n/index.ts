/**
 * Idiomas de Cortex CRM. Sin dependencias: lo usan la web, el servidor y el código compartido.
 *
 * El texto en español ES la clave: `t('Guardar')` busca «Guardar» en el catálogo del idioma activo
 * (shared/i18n/locales/<idioma>.json) y, si no hay traducción, devuelve el español. Así el código se sigue
 * leyendo igual y una traducción que falte nunca rompe la interfaz.
 *
 * - `t(texto, variables?)`: traduce en el momento. Variables entre llaves: t('Hola, {name}', { name }).
 * - `tp(n, singular, plural, variables?)`: plurales; `{count}` es n con el formato del idioma.
 * - `msg(texto)`: marca un texto fijo (constantes de módulo, datos compartidos, mensajes de validación) para
 *   que entre en el catálogo, sin traducirlo; se traduce donde se muestra con `tk(valor)`.
 * - `tk(valor, variables?)`: traduce un texto que llega en una variable (marcado antes con msg()).
 * - `listFormat(['a', 'b', 'c'])`: «a, b y c» en el idioma activo.
 * - Contexto: `t('Media@@agregado')` se ve «Media» en español pero se traduce aparte de `t('Media')` (para palabras
 *   que en otros idiomas cambian según dónde se usan).
 *
 * El primer argumento de t/tp/msg (y de tx en la web) debe ser un literal: scripts/i18n.mjs los extrae para
 * los catálogos. El idioma activo lo decide cada entorno con setI18nBackend: la web (lo que eligió la
 * persona) y el servidor (el de cada petición o trabajo).
 */

export const LOCALES = ['es', 'en', 'pt-BR', 'fr', 'de', 'it', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];

/** Idioma en el que está escrito el código: no tiene catálogo. */
export const SOURCE_LOCALE: Locale = 'es';
/** Idioma para quien pide uno que Cortex no tiene (p. ej. un navegador en neerlandés). */
export const FALLBACK_LOCALE: Locale = 'en';

export interface LocaleInfo {
  /** Nombre en el propio idioma, para los selectores. */
  native: string;
  /** Etiqueta BCP 47 por defecto para fechas y números. */
  tag: string;
  /** Nombre del idioma dentro de los prompts de la IA (escritos en español). */
  promptName: string;
}

export const LOCALE_INFO: Readonly<Record<Locale, LocaleInfo>> = {
  es: { native: 'Español', tag: 'es-ES', promptName: 'español' },
  en: { native: 'English', tag: 'en-US', promptName: 'inglés' },
  'pt-BR': { native: 'Português (Brasil)', tag: 'pt-BR', promptName: 'portugués de Brasil' },
  fr: { native: 'Français', tag: 'fr-FR', promptName: 'francés' },
  de: { native: 'Deutsch', tag: 'de-DE', promptName: 'alemán' },
  it: { native: 'Italiano', tag: 'it-IT', promptName: 'italiano' },
  ja: { native: '日本語', tag: 'ja-JP', promptName: 'japonés' },
};

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type CatalogEntry = string | PluralForms;
export type Catalog = Readonly<Record<string, CatalogEntry>>;
export type Vars = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface I18nBackend {
  locale(): Locale;
  /** Etiqueta Intl activa (puede ser la región de la organización, p. ej. 'es-MX'). */
  intlTag(): string;
  catalog(locale: Locale): Catalog | undefined;
}

let backend: I18nBackend = { locale: () => SOURCE_LOCALE, intlTag: () => LOCALE_INFO.es.tag, catalog: () => undefined };

/** Cada entorno (web, servidor) indica de dónde salen el idioma activo y los catálogos. */
export function setI18nBackend(b: I18nBackend): void {
  backend = b;
}

export function activeLocale(): Locale {
  return backend.locale();
}

export function activeIntlTag(): string {
  return backend.intlTag();
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Lenguas sin catálogo propio cuyos hablantes entienden mejor otro de los idiomas de Cortex. */
const RELATED: Readonly<Record<string, Locale>> = { ca: 'es', gl: 'es', eu: 'es' };

const primary = (tag: string) => tag.toLowerCase().split('-')[0] ?? '';

/** Idioma de Cortex para una etiqueta BCP 47 ('pt-PT' → 'pt-BR', 'en-GB' → 'en', 'ca' → 'es'); null si no hay. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const clean = tag.trim().replace(/_/g, '-').toLowerCase();
  if (!clean || clean === '*' || clean.length > 35) return null;
  for (const l of LOCALES) if (l.toLowerCase() === clean) return l;
  const lang = primary(clean);
  for (const l of LOCALES) if (primary(l) === lang) return l;
  return RELATED[lang] ?? null;
}

/** Primer idioma de Cortex de una cabecera Accept-Language (respetando q=) o de navigator.languages. */
export function negotiateLocale(input: string | readonly string[] | null | undefined): Locale | null {
  if (!input) return null;
  const tags =
    typeof input === 'string'
      ? input
          .slice(0, 512)
          .split(',')
          .map((part, i) => {
            const [tag = '', ...params] = part.trim().split(';');
            const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
            return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, i };
          })
          .filter((x) => x.tag && Number.isFinite(x.q) && x.q > 0)
          .sort((a, b) => b.q - a.q || a.i - b.i)
          .map((x) => x.tag)
      : input;
  for (const tag of tags.slice(0, 20)) {
    const l = matchLocale(tag);
    if (l) return l;
  }
  return null;
}

/** Idioma de una organización a partir de su «Idioma y región» (settings.locale, p. ej. 'es-MX'). */
export function localeFromRegion(tag: string | null | undefined): Locale {
  return matchLocale(tag) ?? (tag ? FALLBACK_LOCALE : SOURCE_LOCALE);
}

/** Idioma de la interfaz de una persona: el que eligió o, si no eligió ninguno, el de su organización. */
export function effectiveLocale(preference: string | null | undefined, orgTag: string | null | undefined): Locale {
  return isLocale(preference) ? preference : localeFromRegion(orgTag);
}

function validTag(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

/**
 * Etiqueta Intl para fechas y números: la región de la organización si es de la misma lengua que la interfaz
 * ('es-MX' con la interfaz en español), si no la del idioma ('en-US' para la interfaz en inglés).
 */
export function intlTagFor(locale: Locale, orgTag?: string | null): string {
  const own = LOCALE_INFO[locale].tag;
  if (orgTag && primary(orgTag) === primary(own) && validTag(orgTag)) return orgTag;
  return own;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(tag: string): Intl.NumberFormat {
  let f = numberFormats.get(tag);
  if (!f) {
    // min2: los números de 4 cifras (años, puertos) no llevan separador de miles.
    f = new Intl.NumberFormat(tag, { maximumFractionDigits: 2, useGrouping: 'min2' });
    numberFormats.set(tag, f);
  }
  return f;
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralRule(tag: string): Intl.PluralRules {
  let r = pluralRules.get(tag);
  if (!r) {
    r = new Intl.PluralRules(tag);
    pluralRules.set(tag, r);
  }
  return r;
}

/** Nombres de variable válidos: {name}, {count}, {n2}… (letras, cifras y _). */
export const PLACEHOLDER_RE = /\{(\w+)\}/g;

/** Sustituye {variables}; los números salen con el formato del idioma. Las variables que no se pasan se dejan tal cual. */
export function interpolate(text: string, vars: Vars | undefined, tag: string = backend.intlTag()): string {
  if (!vars || !text.includes('{')) return text;
  return text.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!Object.hasOwn(vars, name)) return whole;
    const v = vars[name];
    if (v === null || v === undefined) return '';
    return typeof v === 'number' ? numberFormat(tag).format(v) : String(v);
  });
}

/** Entrada del catálogo para una clave; las vacías cuentan como pendientes de traducir. */
export function lookup(locale: Locale, key: string): CatalogEntry | undefined {
  if (locale === SOURCE_LOCALE) return undefined;
  const c = backend.catalog(locale);
  if (!c || !Object.hasOwn(c, key)) return undefined;
  const v = c[key];
  return v === '' ? undefined : v;
}

/** Clave de catálogo de un plural: las dos formas en español separadas por «|». */
export function pluralKey(one: string, other: string): string {
  return `${one}|${other}`;
}

/**
 * Contexto de una clave: «Media@@agregado» se muestra «Media» en español, pero se traduce aparte de «Media» (nivel),
 * para las palabras que en otro idioma necesitan traducciones distintas según dónde se usan.
 */
export const CONTEXT_SEP = '@@';

/** El texto en español de una clave, sin su contexto. */
export function sourceText(key: string): string {
  const i = key.indexOf(CONTEXT_SEP);
  return i >= 0 ? key.slice(0, i) : key;
}

export function translate(locale: Locale, key: string, vars?: Vars, tag: string = backend.intlTag()): string {
  const v = lookup(locale, key);
  return interpolate(typeof v === 'string' ? v : sourceText(key), vars, tag);
}

export function translatePlural(locale: Locale, count: number, one: string, other: string, vars?: Vars, tag: string = backend.intlTag()): string {
  const entry = lookup(locale, pluralKey(one, other));
  let text: string;
  if (entry && typeof entry === 'object') text = entry[pluralRule(LOCALE_INFO[locale].tag).select(count)] ?? entry.other ?? other;
  else if (typeof entry === 'string') text = entry;
  else text = pluralRule(LOCALE_INFO.es.tag).select(count) === 'one' ? one : other;
  return interpolate(text, { ...vars, count }, tag);
}

/** Traduce un texto literal en el idioma activo. */
export function t(key: string, vars?: Vars): string {
  return translate(backend.locale(), key, vars);
}

/** Plural: tp(n, '{count} registro', '{count} registros'). */
export function tp(count: number, one: string, other: string, vars?: Vars): string {
  return translatePlural(backend.locale(), count, one, other, vars);
}

/** Traduce un texto que llega en una variable (marcado con msg() donde se definió). */
export function tk(key: string, vars?: Vars): string {
  return translate(backend.locale(), key, vars);
}

/** Marca un texto para el catálogo sin traducirlo todavía (se traduce al mostrarlo, con tk). */
export function msg<const T extends string>(key: T): T {
  return key;
}

/**
 * Una etiqueta dentro de una frase («menú lateral oscuro», «densidad compacta»): en minúsculas, salvo en alemán,
 * donde los sustantivos van con mayúscula.
 */
export function inSentence(label: string): string {
  return backend.locale() === 'de' ? label : label.toLocaleLowerCase(backend.intlTag());
}

const listFormats = new Map<string, Intl.ListFormat>();
/** Lista en el idioma activo: listFormat(['A', 'B', 'C']) → «A, B y C» / «A, B, and C». */
export function listFormat(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  const tag = backend.intlTag();
  const k = `${tag}|${type}`;
  let f = listFormats.get(k);
  if (!f) {
    try {
      f = new Intl.ListFormat(tag, { style: 'long', type });
    } catch {
      return items.join(', ');
    }
    listFormats.set(k, f);
  }
  return f.format(items);
}
