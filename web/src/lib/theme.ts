import type { CSSProperties } from 'react';
import type { Appearance } from '../../../shared/blueprint';
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_DENSITIES,
  APPEARANCE_FONTS,
  APPEARANCE_RADII,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_BRAND_COLOR,
  HEX_COLOR_RE,
  SIDEBAR_STYLES,
  THEME_MODES,
  sanitizeCustomCss,
  type AppearanceDensity,
  type AppearanceFont,
  type AppearanceRadius,
  type SidebarStyle,
} from '../../../shared/appearance';

/**
 * Tema de cada organización (blueprint.appearance) sobre los tokens de Tailwind v4: la paleta `--color-brand-*`
 * (calculada en OKLCH a partir del color principal), `--color-accent`, el degradado de EVOLVE, la tipografía
 * (`--font-sans`), los radios (`--radius-*`) y la densidad (`--spacing`, la base de todos los espaciados).
 * Se aplican en `document.documentElement` (estilo en línea: manda sobre `:root`) o, para las vistas previas,
 * en un contenedor (las variables CSS se heredan).
 */

export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type Shade = (typeof SHADES)[number];

/** Paleta original de Cortex CRM (web/src/index.css): se usa tal cual con el color principal por defecto. */
export const DEFAULT_PALETTE: Record<Shade, string> = {
  50: '#f4f3ff',
  100: '#ebe9fe',
  200: '#d9d6fe',
  300: '#bdb4fe',
  400: '#9b8afb',
  500: '#7a5af8',
  600: '#6938ef',
  700: '#5925dc',
  800: '#4a1fb8',
  900: '#3e1c96',
  950: '#27115f',
};

export const DEFAULT_GRADIENT = 'linear-gradient(120deg, #7a5af8 0%, #c026d3 55%, #f97316 100%)';

export const FONT_STACKS: Record<AppearanceFont, string> = {
  inter: "'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', 'Arial Rounded MT Bold', Calibri, sans-serif",
};

/** Radios de Tailwind v4 (rem) y factor de cada opción. `rounded-full` no cambia. */
const RADIUS_BASE: Record<string, number> = { xs: 0.125, sm: 0.25, md: 0.375, lg: 0.5, xl: 0.75, '2xl': 1, '3xl': 1.5, '4xl': 2 };
const RADIUS_FACTOR: Record<AppearanceRadius, number> = { none: 0, sm: 0.5, md: 1, lg: 1.5, xl: 2 };
/** `--spacing` (por defecto 0.25rem): escala paddings, márgenes, huecos y alturas de controles. */
const SPACING: Record<AppearanceDensity, string> = { compact: '0.225rem', comfortable: '0.25rem', spacious: '0.275rem' };

// ---------------------------------------------------------------- color (OKLCH, Björn Ottosson)

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToOklch(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = toLinear(((n >> 16) & 255) / 255);
  const g = toLinear(((n >> 8) & 255) / 255);
  const b = toLinear((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

function oklchToLinearRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (rgb: number[]) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** OKLCH → #rrggbb, reduciendo el croma hasta que el color quepa en sRGB (conserva luminosidad y tono). */
export function oklchToHex(L: number, C: number, H: number): string {
  let rgb = oklchToLinearRgb(L, C, H);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearRgb(L, mid, H))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinearRgb(L, lo, H);
  }
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, c))))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

// Luminosidad de referencia de cada tono (como las paletas de Tailwind) y croma relativo al del tono 600.
const REF_L: Record<Shade, number> = { 50: 0.971, 100: 0.936, 200: 0.885, 300: 0.808, 400: 0.704, 500: 0.637, 600: 0.577, 700: 0.505, 800: 0.444, 900: 0.396, 950: 0.258 };
const REF_C: Record<Shade, number> = { 50: 0.06, 100: 0.14, 200: 0.27, 300: 0.48, 400: 0.78, 500: 0.95, 600: 1, 700: 0.9, 800: 0.76, 900: 0.62, 950: 0.45 };
const L_LIGHTEST = 0.975;
const L_DARKEST = 0.2;

/**
 * Paleta 50…950 a partir del color principal: el tono 600 (botones, enlaces, selección) es EXACTAMENTE ese
 * color; los demás se interpolan en OKLCH hacia el casi blanco y el casi negro con el mismo tono, como las
 * paletas de Tailwind (menos croma en los extremos).
 */
export function brandPalette(hex: string): Record<Shade, string> {
  const color = hex.toLowerCase();
  if (color === DEFAULT_BRAND_COLOR || !HEX_COLOR_RE.test(color)) return { ...DEFAULT_PALETTE };
  const [L0, C0, H] = hexToOklch(color);
  const out = {} as Record<Shade, string>;
  for (const s of SHADES) {
    if (s === 600) {
      out[s] = color;
      continue;
    }
    let L: number;
    if (REF_L[s] > REF_L[600]) {
      const t = (REF_L[s] - REF_L[600]) / (REF_L[50] - REF_L[600]);
      L = L0 + t * (Math.max(L_LIGHTEST, L0) - L0);
    } else {
      const t = (REF_L[600] - REF_L[s]) / (REF_L[600] - REF_L[950]);
      L = L0 - t * (L0 - Math.min(L_DARKEST, L0));
    }
    out[s] = oklchToHex(L, C0 * REF_C[s], H);
  }
  return out;
}

// ---------------------------------------------------------------- tokens

/** Apariencia efectiva (con valores por defecto) a partir de la del blueprint, de un borrador o de la caché. */
export function resolveAppearance(a: Partial<Appearance> | null | undefined): Appearance {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const hex = (v: unknown) => (typeof v === 'string' && HEX_COLOR_RE.test(v) ? v.toLowerCase() : undefined);
  const out: Appearance = {
    brandColor: hex(a?.brandColor) ?? APPEARANCE_DEFAULTS.brandColor,
    font: pick(a?.font, APPEARANCE_FONTS, APPEARANCE_DEFAULTS.font),
    radius: pick(a?.radius, APPEARANCE_RADII, APPEARANCE_DEFAULTS.radius),
    density: pick(a?.density, APPEARANCE_DENSITIES, APPEARANCE_DEFAULTS.density),
    sidebar: pick(a?.sidebar, SIDEBAR_STYLES, APPEARANCE_DEFAULTS.sidebar),
    defaultTheme: pick(a?.defaultTheme, THEME_MODES, APPEARANCE_DEFAULTS.defaultTheme),
  };
  const accent = hex(a?.accentColor);
  if (accent) out.accentColor = accent;
  if (typeof a?.appName === 'string' && a.appName.trim()) out.appName = a.appName.trim().slice(0, 40);
  if (typeof a?.customCss === 'string') out.customCss = a.customCss;
  return out;
}

/** Variables CSS de una apariencia (completas: también los valores por defecto, para las vistas previas). */
export function appearanceVars(input: Partial<Appearance> | null | undefined): Record<string, string> {
  const a = resolveAppearance(input);
  const palette = brandPalette(a.brandColor);
  const vars: Record<string, string> = {};
  for (const s of SHADES) vars[`--color-brand-${s}`] = palette[s];
  vars['--color-accent'] = a.accentColor ?? DEFAULT_ACCENT_COLOR;
  vars['--evolve-gradient'] = a.accentColor ? `linear-gradient(120deg, ${palette[500]} 0%, ${a.accentColor} 100%)` : DEFAULT_GRADIENT;
  vars['--font-sans'] = FONT_STACKS[a.font];
  for (const [k, rem] of Object.entries(RADIUS_BASE)) vars[`--radius-${k}`] = `${+(rem * RADIUS_FACTOR[a.radius]).toFixed(4)}rem`;
  vars['--spacing'] = SPACING[a.density];
  return vars;
}

/** Para `style={…}` de un contenedor de vista previa. */
export function appearanceStyle(a: Partial<Appearance> | null | undefined): CSSProperties {
  return appearanceVars(a) as CSSProperties;
}

const MANAGED_VARS = Object.keys(appearanceVars(null));
const DEFAULT_TITLE = 'Cortex CRM';

/** Aplica la apariencia de la organización a toda la interfaz (sin el CSS personalizado: ver setCustomCss). */
export function applyAppearance(a: Partial<Appearance> | null | undefined): void {
  const root = document.documentElement;
  if (!a) {
    for (const k of MANAGED_VARS) root.style.removeProperty(k);
    document.title = DEFAULT_TITLE;
    return;
  }
  const resolved = resolveAppearance(a);
  for (const [k, v] of Object.entries(appearanceVars(resolved))) root.style.setProperty(k, v);
  document.title = resolved.appName ?? DEFAULT_TITLE;
}

/** Vuelve al aspecto de Cortex CRM (al cambiar de organización o cerrar sesión). */
export function resetAppearance(): void {
  applyAppearance(null);
  setCustomCss(null);
}

const STYLE_ID = 'org-custom-css';

/**
 * Inyecta el CSS personalizado en <style id="org-custom-css"> (permitido por la CSP: style-src 'unsafe-inline').
 * Se vuelve a comprobar aquí con las mismas reglas que el servidor: si no las cumple, no se inyecta nada.
 */
export function setCustomCss(css: string | null | undefined): void {
  const current = document.getElementById(STYLE_ID);
  const existing = current instanceof HTMLStyleElement ? current : null;
  if (current && !existing) current.remove();
  if (!css?.trim()) {
    existing?.remove();
    return;
  }
  const checked = sanitizeCustomCss(css);
  if (!checked.ok || !checked.css) {
    existing?.remove();
    console.warn('CSS personalizado descartado:', checked.errors.join('; '));
    return;
  }
  const el = existing ?? document.createElement('style');
  el.id = STYLE_ID;
  if (el.textContent !== checked.css) el.textContent = checked.css;
  if (!el.isConnected) document.head.appendChild(el);
}

// ---------------------------------------------------------------- caché local (evita el destello de la paleta por defecto al recargar)

const CACHE_KEY = 'cortex-appearance';

/**
 * Guarda los tokens (nunca el CSS personalizado) de la última apariencia aplicada en esta organización, también ya
 * convertidos en variables CSS (`vars`): los aplica public/theme-init.js antes del primer pintado.
 */
export function cacheAppearance(workspaceId: string, a: Appearance | undefined): void {
  try {
    if (!a) localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, JSON.stringify({ ws: workspaceId, a: { ...a, customCss: undefined }, vars: appearanceVars(a) }));
  } catch {
    /* sin almacenamiento */
  }
}

/**
 * Última apariencia guardada en este navegador para esa organización. Con `workspaceId` undefined, la última de
 * cualquier organización: se usa al arrancar, mientras aún no se sabe quién ha iniciado sesión, para que la primera
 * pantalla (el cargador) no salga con la paleta por defecto y cambie de color medio segundo después.
 */
export function cachedAppearance(workspaceId: string | undefined, anyWorkspace = false): Appearance | undefined {
  if (!workspaceId && !anyWorkspace) return undefined;
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { ws?: unknown; a?: unknown } | null;
    if (!raw || (workspaceId && raw.ws !== workspaceId) || !raw.a || typeof raw.a !== 'object') return undefined;
    // Se normaliza campo a campo: solo valores permitidos (colores #rrggbb y opciones conocidas).
    const { customCss: _ignored, ...rest } = resolveAppearance(raw.a as Partial<Appearance>);
    void _ignored;
    return rest;
  } catch {
    return undefined;
  }
}

/** Clases del menú lateral: claro (el de siempre), oscuro o del color de marca (con la variante dark de Tailwind). */
export function sidebarClass(style: SidebarStyle | undefined, opaque = false): string {
  if (style === 'dark') return 'dark border-zinc-800 bg-zinc-950 text-zinc-100';
  if (style === 'brand') return 'dark border-brand-950 bg-brand-900 text-zinc-100';
  return opaque ? 'border-zinc-200/70 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950' : 'border-zinc-200/70 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-950';
}
