/**
 * Rutas del paquete de código fuente y reglas deterministas sobre qué puede tocar el motor de código.
 * Todo lo que escribe el agente pasa por aquí (y, al final, otra vez por guards.ts).
 */

/** Carpetas del paquete de código fuente (lo que el Dockerfile copia en /app/source). */
export const BUNDLE_DIRS = ['server', 'web', 'shared', 'docs'] as const;

/** Archivos de la raíz que forman parte del paquete. */
export const BUNDLE_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'railway.json',
  'Dockerfile',
  'Dockerfile.ci',
  '.dockerignore',
  'README.md',
  '.env.example',
  'source-version.json',
] as const;

/** Carpetas que nunca forman parte del paquete aunque estén dentro de las anteriores. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', '.data', 'coverage', '.git', '.vite', '.turbo', '.cache']);
/** Archivos que nunca se leen ni se suben (basura del sistema y variables de entorno). */
export const SKIP_FILE = /^(?:\.DS_Store|Thumbs\.db|.*\.log|\.env(?:\..*)?)$/;

/** Raíces en las que el agente puede escribir. */
export const WRITABLE_ROOTS = ['server/src/', 'server/test/', 'web/', 'shared/', 'docs/'] as const;
/** Archivos de la raíz que el agente puede escribir (package.json: version, description y dependencias). */
export const WRITABLE_ROOT_FILES = new Set(['README.md', 'package.json', '.env.example']);
/**
 * Tipos de archivo que el agente puede crear o modificar (siempre texto). Los de código (.ts, .tsx, .js, .jsx,
 * .mjs, .cjs, .html) pasan por las mismas reglas de patrones prohibidos.
 */
export const WRITABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.md', '.json', '.html', '.txt', '.svg', '.csv', '.xml', '.yml', '.yaml', '.webmanifest']);

export const MAX_PATH_LENGTH = 240;

/** Ruta o escritura no permitida: el mensaje se devuelve tal cual al agente o a la interfaz. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const SEGMENT = /^[A-Za-z0-9_@()+.-]+$/;

/**
 * Normaliza una ruta relativa a la raíz del proyecto. Solo admite rutas ya normalizadas: nada de
 * absolutas, unidades de Windows, barras invertidas, segmentos vacíos, "." o "..", ni caracteres fuera de
 * un conjunto seguro (así no hay forma de escribir fuera del árbol ni de colar nombres ambiguos).
 */
export function normalizePath(input: unknown): string {
  if (typeof input !== 'string') throw new PathError('La ruta debe ser un texto');
  if (!input.length) throw new PathError('Ruta vacía');
  if (input.length > MAX_PATH_LENGTH) throw new PathError(`La ruta supera ${MAX_PATH_LENGTH} caracteres`);
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathError('La ruta contiene caracteres de control');
  if (input.includes('\\')) throw new PathError('Usa "/" como separador (sin barras invertidas)');
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input) || input.startsWith('~')) throw new PathError('Solo se admiten rutas relativas a la raíz del proyecto (p. ej. server/src/app.ts)');
  const segments = input.split('/');
  for (const s of segments) {
    if (!s) throw new PathError('La ruta contiene segmentos vacíos o termina en "/"');
    if (s === '.' || s === '..') throw new PathError('La ruta no puede contener "." ni ".."');
    if (!SEGMENT.test(s)) throw new PathError(`Carácter no permitido en "${s.slice(0, 60)}" (solo letras, números y . _ - @ ( ) +)`);
  }
  return input;
}

export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** ¿Forma parte del paquete de código fuente? */
export function isBundlePath(path: string): boolean {
  if ((BUNDLE_ROOT_FILES as readonly string[]).includes(path)) return true;
  const segments = path.split('/');
  if (segments.length < 2 || !(BUNDLE_DIRS as readonly string[]).includes(segments[0])) return false;
  return !segments.some((s) => SKIP_DIRS.has(s)) && !SKIP_FILE.test(segments[segments.length - 1]);
}

export const isTestPath = (path: string) => path.startsWith('server/test/');

/**
 * Núcleo protegido: el agente no puede crear, modificar ni borrar estas rutas. Los patrones se comparan en
 * minúsculas (`**` = cualquier cosa, `*` = cualquier cosa salvo "/").
 */
export const PROTECTED_RULES: readonly { pattern: string; reason: string }[] = [
  { pattern: 'server/src/auth/**', reason: 'autenticación, sesiones y CSRF' },
  { pattern: 'server/src/lib/crypto.ts', reason: 'cifrado, contraseñas y secretos' },
  { pattern: 'server/src/lib/ssrf.ts', reason: 'protección SSRF de las llamadas salientes' },
  { pattern: 'server/src/lib/client-ip.ts', reason: 'IP real del cliente (límites y auditoría)' },
  { pattern: 'server/src/lib/request-limit.ts', reason: 'límite general de peticiones' },
  { pattern: 'server/src/db/db.ts', reason: 'acceso a datos y Row Level Security' },
  { pattern: 'server/src/crm/scripts.ts', reason: 'sandbox de los scripts de las organizaciones' },
  { pattern: 'server/src/crm/visibility.ts', reason: 'visibilidad de la configuración por rol' },
  { pattern: 'server/src/config.ts', reason: 'configuración y secretos' },
  { pattern: 'server/src/lib/audit.ts', reason: 'registro de auditoría' },
  { pattern: 'server/src/evolve/risk.ts', reason: 'clasificación de riesgo de los cambios de las organizaciones' },
  { pattern: 'server/src/evolve/routes.ts', reason: 'política de aprobación, roles y rollback de EVOLVE' },
  { pattern: 'shared/appearance.ts', reason: 'saneado del CSS personalizado de las organizaciones' },
  { pattern: 'server/test/appearance.test.ts', reason: 'pruebas de seguridad de la capa visual (CSS y permisos de páginas)' },
  { pattern: 'server/test/extensibility.test.ts', reason: 'pruebas de seguridad de las capacidades nuevas (riesgo y visibilidad por defecto)' },
  { pattern: 'server/src/code-engine/**', reason: 'el propio motor de código fuente' },
  { pattern: 'web/src/pages/platform/**', reason: 'la pantalla del motor de código fuente' },
  { pattern: 'server/test/tenant-isolation.test.ts', reason: 'pruebas de seguridad (aislamiento entre organizaciones)' },
  { pattern: 'server/test/security-regressions.test.ts', reason: 'pruebas de seguridad' },
  { pattern: 'server/test/audit-hardening*', reason: 'pruebas de seguridad (auditoría)' },
  { pattern: 'server/test/scripts-sandbox.test.ts', reason: 'pruebas de seguridad del sandbox de scripts' },
  { pattern: 'server/test/template.test.ts', reason: 'pruebas de la plantilla de Railway' },
  { pattern: 'server/test/code-engine*', reason: 'pruebas del motor de código fuente' },
  { pattern: 'server/test/auth.test.ts', reason: 'pruebas de seguridad (autenticación, CSRF, cabeceras)' },
  { pattern: 'server/test/helpers.ts', reason: 'utilidades de todas las pruebas, también las de seguridad' },
  { pattern: 'dockerfile*', reason: 'imagen de producción y del CI' },
  { pattern: 'railway.json', reason: 'configuración de despliegue' },
  { pattern: '.dockerignore', reason: 'contenido de la imagen' },
  { pattern: '.github/**', reason: 'flujos de CI externos' },
  { pattern: 'package-lock.json', reason: 'lo genera el motor con npm a partir de package.json (no se edita a mano)' },
  { pattern: 'tsconfig.json', reason: 'comprobación de tipos que ejecuta el CI' },
  { pattern: 'web/tsconfig.json', reason: 'comprobación de tipos que ejecuta el CI' },
  { pattern: 'vitest.config.ts', reason: 'configuración de las pruebas que ejecuta el CI' },
  { pattern: 'source-version.json', reason: 'lo genera el motor de código en cada versión' },
];

const globToRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*')}$`,
  );

const PROTECTED = PROTECTED_RULES.map((r) => ({ ...r, re: globToRegExp(r.pattern) }));
/** Módulos protegidos (sin comodines): tampoco se pueden «sombrear» con x.tsx, x.d.ts, x.js ni una carpeta x/. */
const PROTECTED_MODULES = PROTECTED_RULES.filter((r) => !r.pattern.includes('*') && r.pattern.endsWith('.ts')).map((r) => ({ stem: r.pattern.slice(0, -3), reason: r.reason }));

/** Motivo por el que una ruta pertenece al núcleo protegido, o null. */
export function protectedReason(path: string): string | null {
  const p = path.toLowerCase();
  for (const r of PROTECTED) if (r.re.test(p)) return `Ruta protegida (${r.reason}): ${path}`;
  for (const m of PROTECTED_MODULES) {
    if (p === `${m.stem}.tsx` || p === `${m.stem}.d.ts` || p === `${m.stem}.js` || p === `${m.stem}.mjs` || p === `${m.stem}.cjs` || p.startsWith(`${m.stem}/`)) {
      return `Ruta protegida (${m.reason}): ${path} haría sombra a ${m.stem}.ts`;
    }
  }
  return null;
}

/** Motivo por el que el agente no puede escribir (crear, modificar o borrar) esta ruta, o null. */
export function writeBlockedReason(path: string): string | null {
  const prot = protectedReason(path);
  if (prot) return prot;
  const segments = path.split('/');
  if (segments.length === 1) {
    return WRITABLE_ROOT_FILES.has(path) ? null : `Solo se puede escribir en ${WRITABLE_ROOTS.join(', ')} y en README.md, package.json o .env.example`;
  }
  // Los archivos de código no pueden ser JavaScript compilado mezclado con el código fuente del servidor: el build
  // usa TypeScript; JavaScript se admite en la web (p. ej. web/public) y en documentación.
  if (path.startsWith('server/src/') && ['.js', '.mjs', '.cjs', '.jsx'].includes(extname(path))) return 'En server/src/ el código es TypeScript (.ts)';
  if (!WRITABLE_ROOTS.some((r) => path.startsWith(r))) return `Solo se puede escribir en ${WRITABLE_ROOTS.join(', ')} y en README.md, package.json o .env.example`;
  if (segments.some((s) => s.startsWith('.'))) return 'No se pueden crear archivos ni carpetas ocultos';
  if (segments.some((s) => SKIP_DIRS.has(s))) return `Carpeta no permitida: ${path}`;
  if (!WRITABLE_EXTENSIONS.has(extname(path))) return `Tipo de archivo no permitido (${extname(path) || 'sin extensión'}): solo ${[...WRITABLE_EXTENSIONS].join(', ')}`;
  return null;
}
