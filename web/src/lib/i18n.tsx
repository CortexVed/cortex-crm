import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import {
  FALLBACK_LOCALE,
  intlTagFor,
  isLocale,
  LOCALE_INFO,
  negotiateLocale,
  setI18nBackend,
  SOURCE_LOCALE,
  translate,
  type Catalog,
  type Locale,
} from '../../../shared/i18n';

export { inSentence, listFormat, msg, t, tk, tp, LOCALES, LOCALE_INFO, effectiveLocale, type Locale } from '../../../shared/i18n';

/**
 * Idioma de la interfaz. Los catálogos se cargan bajo demanda (uno por idioma; el español no tiene, es el texto
 * del código). Cambiar de idioma vuelve a montar la aplicación (I18nBoundary) para que todo se pinte de nuevo.
 */

const STORAGE_KEY = 'cortex.locale';
const loaders = import.meta.glob<{ default: Catalog }>('../../../shared/i18n/locales/*.json');
const catalogs: Partial<Record<Locale, Catalog>> = {};

let locale: Locale = SOURCE_LOCALE;
let tag = LOCALE_INFO[SOURCE_LOCALE].tag;
let ticket = 0;
const listeners = new Set<() => void>();

setI18nBackend({ locale: () => locale, intlTag: () => tag, catalog: (l) => catalogs[l] });

async function loadCatalog(l: Locale): Promise<boolean> {
  if (l === SOURCE_LOCALE || catalogs[l]) return true;
  const load = loaders[`../../../shared/i18n/locales/${l}.json`];
  if (!load) return false;
  try {
    catalogs[l] = (await load()).default;
    return true;
  } catch {
    return false; // sin conexión: se mantiene el idioma actual
  }
}

export function getLocale(): Locale {
  return locale;
}

/** Etiqueta Intl activa para fechas y números (la región de la organización si es de la misma lengua). */
export function getIntlTag(): string {
  return tag;
}

export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

export function browserLocale(): Locale {
  const langs = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return negotiateLocale(langs) ?? FALLBACK_LOCALE;
}

/** Zona horaria IANA del navegador (para una organización nueva); undefined si el navegador no la da. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cambia el idioma de la interfaz. `orgTag` es la región de la organización (fechas y números) y `persist`
 * recuerda el idioma en este navegador para las pantallas de acceso.
 */
export async function setLocale(next: Locale, opts: { orgTag?: string | null; persist?: boolean } = {}): Promise<void> {
  const mine = ++ticket;
  const ok = await loadCatalog(next);
  if (mine !== ticket || !ok) return; // llegó otro cambio después, o no se pudo cargar el catálogo
  if (opts.persist !== false) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* almacenamiento bloqueado: solo esta sesión */
    }
  }
  const nextTag = intlTagFor(next, opts.orgTag);
  document.documentElement.lang = LOCALE_INFO[next].tag;
  if (next === locale && nextTag === tag) return;
  locale = next;
  tag = nextTag;
  for (const f of listeners) f();
}

/** Idioma inicial, antes de saber quién es: el último usado en este navegador o el del navegador. */
export function initI18n(): Promise<void> {
  return setLocale(storedLocale() ?? browserLocale(), { persist: false });
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Avisa cada vez que cambia el idioma (p. ej. para volver a pedir al servidor los textos que traduce él). */
export function onLocaleChange(f: () => void): () => void {
  return subscribe(f);
}
const snapshot = () => `${locale}|${tag}`;

export function useLocale(): Locale {
  useSyncExternalStore(subscribe, snapshot);
  return locale;
}

/** Vuelve a montar su contenido al cambiar de idioma (los textos se calculan al pintar). */
export function I18nBoundary({ children }: { children: ReactNode }) {
  const key = useSyncExternalStore(subscribe, snapshot);
  return <Fragment key={key}>{children}</Fragment>;
}

type RichValue = ReactNode | ((chunks: ReactNode) => ReactNode);

const RICH_RE = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;

function renderRich(text: string, values: Readonly<Record<string, RichValue>>, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(RICH_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${keyPrefix}${i++}`;
    if (m[1] !== undefined) {
      const wrap = values[m[1]];
      const inner = renderRich(m[2] ?? '', values, `${k}.`);
      out.push(<Fragment key={k}>{typeof wrap === 'function' ? wrap(inner) : inner}</Fragment>);
    } else {
      const name = m[3] ?? '';
      const v = Object.hasOwn(values, name) ? values[name] : undefined;
      if (v === undefined || typeof v === 'function') out.push(m[0]);
      else out.push(<Fragment key={k}>{typeof v === 'number' ? new Intl.NumberFormat(tag, { maximumFractionDigits: 2, useGrouping: 'min2' }).format(v) : v}</Fragment>);
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Texto con elementos dentro: tx('Escribe <b>{name}</b> para confirmar', { name, b: (c) => <strong>{c}</strong> }).
 * Las etiquetas <x>…</x> envuelven texto traducible; las {variables} pueden ser texto o elementos.
 */
export function tx(key: string, values: Readonly<Record<string, RichValue>> = {}): ReactNode {
  return renderRich(translate(locale, key), values, 'tx');
}
