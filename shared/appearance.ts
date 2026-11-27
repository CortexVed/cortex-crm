/**
 * CAPA VISUAL de cada organización (apariencia, menú y páginas): constantes y utilidades SIN dependencias
 * (no importa zod), compartidas por el servidor (validación de los change sets) y por el cliente (aplicación
 * del tema y del CSS personalizado). El CSS personalizado se comprueba aquí con las MISMAS reglas en los dos
 * lados: el servidor no deja publicar nada que no las cumpla y el navegador lo vuelve a comprobar antes de
 * inyectarlo.
 */
import { msg, t, tk } from './i18n';

export const APPEARANCE_FONTS = ['inter', 'system', 'serif', 'mono', 'rounded'] as const;
export type AppearanceFont = (typeof APPEARANCE_FONTS)[number];
export const APPEARANCE_RADII = ['none', 'sm', 'md', 'lg', 'xl'] as const;
export type AppearanceRadius = (typeof APPEARANCE_RADII)[number];
export const APPEARANCE_DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type AppearanceDensity = (typeof APPEARANCE_DENSITIES)[number];
export const SIDEBAR_STYLES = ['light', 'dark', 'brand'] as const;
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number];
export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export const BLOCK_WIDTHS = ['full', 'half', 'third', 'two_thirds'] as const;
export type BlockWidth = (typeof BLOCK_WIDTHS)[number];
export const BUTTON_TARGETS = ['module', 'page', 'dashboard', 'new_record'] as const;
export const BUTTON_STYLES = ['primary', 'secondary', 'ghost'] as const;

/** Color principal por defecto: el tono 600 de la paleta original de Cortex CRM (botones, enlaces, selección). */
export const DEFAULT_BRAND_COLOR = '#6938ef';
/** Color de acento por defecto (avisos y degradados): fuchsia-500. */
export const DEFAULT_ACCENT_COLOR = '#d946ef';
export const MAX_CUSTOM_CSS = 20_000;
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Valores por defecto de la apariencia (los mismos que aplica el esquema). */
export const APPEARANCE_DEFAULTS = {
  brandColor: DEFAULT_BRAND_COLOR,
  font: 'inter',
  radius: 'md',
  density: 'comfortable',
  sidebar: 'light',
  defaultTheme: 'system',
} as const satisfies { brandColor: string; font: AppearanceFont; radius: AppearanceRadius; density: AppearanceDensity; sidebar: SidebarStyle; defaultTheme: ThemeMode };

export const FONT_LABELS: Record<AppearanceFont, string> = { inter: 'Inter', system: msg('Del sistema'), serif: 'Serif', mono: msg('Monoespaciada'), rounded: msg('Redondeada') };
export const RADIUS_LABELS: Record<AppearanceRadius, string> = { none: msg('Sin redondeo'), sm: msg('Pequeño'), md: msg('Medio'), lg: msg('Grande'), xl: msg('Muy grande') };
export const DENSITY_LABELS: Record<AppearanceDensity, string> = { compact: msg('Compacta'), comfortable: msg('Normal'), spacious: msg('Amplia') };
export const SIDEBAR_LABELS: Record<SidebarStyle, string> = { light: msg('Claro'), dark: msg('Oscuro'), brand: msg('Color de marca') };
export const THEME_LABELS: Record<ThemeMode, string> = { system: msg('Según el sistema'), light: msg('Claro'), dark: msg('Oscuro') };
export const BLOCK_WIDTH_LABELS: Record<BlockWidth, string> = { full: msg('Ancho completo'), half: msg('Mitad'), third: msg('Un tercio'), two_thirds: msg('Dos tercios') };

// ---------------------------------------------------------------- contraste (WCAG 2.x)

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa de un color #rrggbb (0 = negro, 1 = blanco). */
export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * linear((n >> 16) & 255) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
}

/** Relación de contraste entre dos colores #rrggbb (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------- enlaces del menú

/**
 * Tipo de destino de un enlace del menú: `internal` (una ruta de la aplicación: empieza por una única «/», sin
 * barras invertidas, espacios ni caracteres de control, y no apunta a la API) o `external` (solo https, sin
 * credenciales). Cualquier otra cosa (javascript:, data:, //host, http:…) es `null` y no se acepta.
 */
export function navHrefKind(href: string): 'internal' | 'external' | null {
  if (typeof href !== 'string' || !href || href.length > 500) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\u0000-\u001f\u007f]/.test(href)) return null;
  if (href.startsWith('/')) {
    if (href.startsWith('//')) return null;
    if (/^\/api(?:[/?#]|$)/i.test(href)) return null;
    return 'internal';
  }
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
    return 'external';
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- CSS personalizado

/** Reglas @ permitidas: solo las que estructuran estilos (ninguna carga recursos ni define fuentes). */
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'layer', 'container']);
const MAX_CSS_DEPTH = 5;

/**
 * Construcciones prohibidas (se comprueban sobre el CSS sin comentarios, incluidas las cadenas de texto). Con la
 * CSP estricta (`img-src 'self' data: blob:`, `font-src 'self' data:`, `connect-src 'self'`) el navegador ya
 * bloquearía los destinos externos, pero el CSS de una organización no debe poder cargar NADA, ni siquiera del
 * propio origen: no hay url() ni ninguna otra forma de pedir recursos.
 */
const FORBIDDEN: [RegExp, string][] = [
  [/@import/i, msg('@import no está permitido: el CSS personalizado no puede cargar otras hojas de estilo')],
  [/@charset/i, msg('@charset no está permitido')],
  [/url\s*\(/i, msg('url() no está permitido: el CSS personalizado no puede cargar imágenes, fuentes ni otros recursos')],
  [/(?:image-set|image|cross-fade|element|paint)\s*\(/i, msg('Las funciones de imagen (image-set, image, cross-fade, element, paint) no están permitidas')],
  [/expression\s*\(/i, msg('expression() no está permitido')],
  [/javascript\s*:/i, msg('javascript: no está permitido')],
  [/vbscript\s*:/i, msg('vbscript: no está permitido')],
  [/behavior/i, msg('behavior no está permitido')],
  [/-moz-binding/i, msg('-moz-binding no está permitido')],
  [/<\s*\/?\s*style/i, msg('No se pueden abrir ni cerrar etiquetas <style>')],
  // HTML (etiquetas, cierres y comentarios). Se admite «<» en las consultas de rango: @media (width < 640px).
  [/<\s*[a-z!/?]/i, msg('El CSS personalizado no puede contener HTML')],
  [/\\/, msg('No se admiten secuencias de escape (\\) en el CSS personalizado')],
  // eslint-disable-next-line no-control-regex
  [/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, msg('El CSS contiene caracteres de control no permitidos')],
];

export interface CssCheck {
  ok: boolean;
  /** CSS normalizado (sin comentarios): es lo que se inyecta en la página. Vacío si `ok` es false. */
  css: string;
  errors: string[];
}

/**
 * Comprueba que el CSS personalizado de una organización es CSS plano y seguro: sin comentarios sin cerrar,
 * cadenas mal formadas, llaves desequilibradas, reglas @ fuera de la lista permitida ni construcciones que
 * carguen recursos o ejecuten código (ver FORBIDDEN). Es deliberadamente estricto: ante la duda, rechaza.
 */
export function sanitizeCustomCss(input: string): CssCheck {
  const errors = new Set<string>();
  const src = typeof input === 'string' ? input : '';
  // El límite va como texto («20000»): como número saldría con separador de miles («20.000»).
  if (src.length > MAX_CUSTOM_CSS) errors.add(t('El CSS personalizado no puede superar {max} caracteres', { max: String(MAX_CUSTOM_CSS) }));
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) {
        errors.add(t('Hay un comentario /* sin cerrar'));
        break;
      }
      out += ' ';
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n' && src[j] !== '\r') j++;
      if (src[j] !== c) {
        errors.add(t('Hay una cadena de texto sin cerrar'));
        break;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '{') {
      depth++;
      if (depth > MAX_CSS_DEPTH) errors.add(t('Demasiados niveles de anidamiento (máximo {max})', { max: MAX_CSS_DEPTH }));
    } else if (c === '}') {
      depth--;
      if (depth < 0) {
        errors.add(t('Hay una llave «}» sin abrir'));
        break;
      }
    } else if (c === '@') {
      const m = /^@(-?[a-z][a-z0-9-]*)/i.exec(src.slice(i, i + 64));
      if (!m) errors.add(t('Hay una «@» que no inicia ninguna regla válida'));
      else if (!ALLOWED_AT_RULES.has(m[1].toLowerCase())) errors.add(t('La regla @{rule} no está permitida (solo @media, @supports, @keyframes, @layer y @container)', { rule: m[1] }));
    }
    out += c;
    i++;
  }
  if (depth > 0 && !errors.size) errors.add(t('Hay llaves «{» sin cerrar'));
  for (const [re, message] of FORBIDDEN) if (re.test(out)) errors.add(tk(message));
  const list = [...errors];
  return list.length ? { ok: false, css: '', errors: list } : { ok: true, css: out.trim(), errors: [] };
}
