import { diffStats } from './diff';
import { extname, isTestPath, normalizePath, PathError, writeBlockedReason } from './paths';
import { isBinary, type SourceTree } from './source';
import { checkMigrationsChange, MIGRATIONS_PATH } from './sql-guard';
import { LIMITS, type FileChange } from './workspace';

/**
 * Comprobaciones deterministas que se aplican a TODO resultado del agente antes de subirlo al CI (y otra vez
 * antes de desplegarlo). No dependen de lo que diga ningún modelo: un cambio que incumple una regla no llega
 * ni al CI. Son una defensa en profundidad: la barrera principal frente a cambios de lógica maliciosos o
 * erróneos es la revisión humana del diff (con la revisión de IA como ayuda).
 */

export interface Violation {
  rule: string;
  path?: string;
  line?: number;
  message: string;
}

export interface Flag {
  key: string;
  level: 'info' | 'warning';
  message: string;
  paths?: string[];
}

export interface GuardStats {
  files: number;
  added: number;
  modified: number;
  deleted: number;
  linesAdded: number;
  linesRemoved: number;
  bytes: number;
}

export interface GuardResult {
  ok: boolean;
  violations: Violation[];
  flags: Flag[];
  stats: GuardStats;
  migrations: string[];
}

type Scope = 'code' | 'server' | 'test';

interface PatternRule {
  id: string;
  re: RegExp;
  scope: Scope;
  message: string;
  /** Rutas a las que no se aplica. */
  except?: (path: string) => boolean;
}

const isCode = (p: string) => ['.ts', '.tsx', '.html'].includes(extname(p));

/**
 * Patrones prohibidos. Se cuentan en la versión base y en la nueva de cada archivo: solo es infracción si el
 * cambio AÑADE apariciones (así el código que ya existía, como el `process.env` de buildVersion o el
 * `DROP POLICY IF EXISTS` de la migración 002, no bloquea los cambios en esos archivos).
 */
export const FORBIDDEN_PATTERNS: readonly PatternRule[] = [
  { id: 'child_process', re: /\bchild_process\b/g, scope: 'code', message: 'No se pueden lanzar procesos (child_process)' },
  {
    id: 'node_internals',
    re: /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](?:node:)?(?:vm|worker_threads|cluster|inspector|module|repl|v8|wasi|trace_events)['"]/g,
    scope: 'code',
    message: 'Módulo de Node no permitido (vm, worker_threads, cluster, inspector, module…)',
  },
  { id: 'eval', re: /\beval\s*\(/g, scope: 'code', message: 'eval() no está permitido' },
  { id: 'function_constructor', re: /\bnew\s+Function\b|(?<![\w$.])Function\s*\(/g, scope: 'code', message: 'new Function() no está permitido' },
  { id: 'string_timer', re: /\bset(?:Timeout|Interval|Immediate)\s*\(\s*['"`]/g, scope: 'code', message: 'Los temporizadores no pueden recibir código como texto' },
  {
    id: 'process_env',
    re: /\bprocess\s*(?:\.\s*env\b|\[)|\bglobalThis\s*(?:\.\s*|\[\s*['"`])process\b|\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b/g,
    scope: 'code',
    message: 'process.env solo se lee en server/src/config.ts: usa deps.config',
  },
  {
    id: 'sql_role',
    re: /\b(?:SET|RESET)\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b|\bBYPASSRLS\b|\bDROP\s+POLICY\b|\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b|\bNO\s+FORCE\s+ROW\s+LEVEL\b|\bSESSION\s+AUTHORIZATION\b|\brow_security\b/gi,
    scope: 'code',
    message: 'No se puede cambiar de rol ni tocar Row Level Security (SET ROLE, RESET ROLE, BYPASSRLS, DROP POLICY…)',
  },
  {
    id: 'xss',
    re: /dangerouslySetInnerHTML|\.\s*(?:inner|outer)HTML\s*\+?=(?!=)|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write(?:ln)?\b|\bsrcdoc\b|['"`]\s*javascript:/gi,
    scope: 'code',
    message: 'HTML sin escapar no permitido (dangerouslySetInnerHTML, innerHTML =, document.write, javascript:)',
  },
  {
    id: 'raw_network',
    re: /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]|\bundici\b|\bXMLHttpRequest\b/g,
    scope: 'code',
    message: 'HTTP y sockets directos no permitidos (node:http, https, net…): las llamadas salientes usan safePost (lib/ssrf.ts)',
  },
  { id: 'dynamic_import', re: /\bimport\s*\(\s*(?!['"])/g, scope: 'code', message: 'import() solo con una ruta literal' },
  { id: 'require', re: /(?<![\w$.])require\s*\(/g, scope: 'code', message: 'El proyecto es ESM: usa import (require no está permitido)' },
  {
    id: 'ddl',
    re: /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|POLICY|ROLE|USER|FUNCTION|PROCEDURE|TRIGGER|VIEW|SCHEMA|EXTENSION|RULE|SEQUENCE|DATABASE)\b/gi,
    scope: 'server',
    except: (p) => p === MIGRATIONS_PATH,
    message: 'El esquema solo se cambia con migraciones nuevas en server/src/db/migrations.ts',
  },
  { id: 'sql_privileges', re: /\b(?:GRANT|REVOKE)\s+[A-Z]|\bTRUNCATE\b/g, scope: 'server', except: (p) => p === MIGRATIONS_PATH, message: 'GRANT, REVOKE y TRUNCATE no se pueden usar desde el código' },
  {
    id: 'engine_internals',
    re: /\b(?:source_changes|platform_settings|schema_migrations)\b|platform:railway-token|project-access-token|backboard\.railway/gi,
    scope: 'code',
    message: 'Solo el motor de código fuente puede tocar sus tablas, las migraciones aplicadas y su credencial de Railway',
  },
  { id: 'platform_admin', re: /\bis_platform_admin\s*=\s*(?:true|\$\d)|\bisPlatformAdmin\s*:\s*true\b/gi, scope: 'code', message: 'El código no puede conceder el rol de administrador de la plataforma' },
  {
    id: 'test_skip',
    re: /\b(?:it|test|describe|suite|bench)\s*\.\s*(?:skip|only|todo|skipIf|runIf|fails)\b|\bx(?:it|describe|test)\s*\(/g,
    scope: 'test',
    message: 'Las pruebas no se pueden saltar ni aislar (.skip, .only, .todo, skipIf…)',
  },
];

/** Avisos (no bloquean, se muestran a quien aprueba). También por apariciones nuevas. */
const WARNING_PATTERNS: readonly { key: string; re: RegExp; scope: Scope; message: string }[] = [
  { key: 'outbound_http', re: /(?<![\w$])(?:fetch|fetchImpl)\s*\(/g, scope: 'server', message: 'Llamadas HTTP salientes nuevas (fetch): comprueba que van a hosts fijos o que usan safePost' },
  { key: 'secrets', re: /\.decrypt\s*\(|\bencryptionKey\b|\bplatformLlmKeys\b|\bresendApiKey\b|\bdatabaseUrl\b|\bbox\s*\.\s*derive\s*\(/g, scope: 'server', message: 'Accede a secretos o credenciales' },
  { key: 'privileged_db', re: /\bdeps\s*\.\s*db\s*\.\s*(?:query|tx|exec)\s*\(|\bdb\s*\.\s*tx\s*\(/g, scope: 'server', message: 'Consultas con la conexión privilegiada (sin Row Level Security): comprueba el filtro por organización' },
];

const ROUTE_RE = /\b(?:app|r|router|fastify|instance|server)\s*\.\s*(?:get|post|put|patch|delete|route|all)\s*\(/g;
const AUTHZ_RE = /\brequire(?:Workspace|UserSession|PlatformAdmin|Auth)\s*\(/g;

/**
 * Anclas del núcleo: líneas que deben seguir existiendo en estos archivos (solo se exigen las que ya están en
 * la base). Protegen controles de seguridad que viven en archivos que el agente sí puede editar (p. ej. para
 * registrar rutas nuevas en app.ts) y la propia fontanería del motor de código.
 */
export const KERNEL_ANCHORS: readonly { path: string; reason: string; anchors: string[] }[] = [
  {
    path: 'server/src/app.ts',
    reason: 'controles de seguridad de la aplicación y rutas del motor de código',
    anchors: [
      'registerAuth(app, deps);',
      'general.hit(ipBucket(req.ip), max)',
      'bodyLimit: 2 * 1024 * 1024',
      'trustProxy: (_address: string, hop: number) => hop === 0',
      'normalizeClientIp(req, config.clientIpHeader!)',
      `defaultSrc: ["'self'"]`,
      `scriptSrc: ["'self'"]`,
      `connectSrc: ["'self'"]`,
      `objectSrc: ["'none'"]`,
      `frameAncestors: ["'none'"]`,
      `baseUri: ["'self'"]`,
      `formAction: ["'self'"]`,
      "frameguard: { action: 'deny' }",
      "'Error interno. Se ha registrado para su revisión.'",
      'await codeEngineRoutes(r, deps);',
      "'source-version.json'",
    ],
  },
  { path: 'server/src/worker.ts', reason: 'el worker debe seguir ejecutando el motor de código', anchors: ["'code.plan': (job, ctx) => runCodePlanJob(deps, job, ctx)", "'code.deploy': (job, ctx) => runCodeDeployJob(deps, job, ctx)"] },
  { path: 'server/src/index.ts', reason: 'el servicio de CI arranca con el rol ci', anchors: ["if (config.role === 'ci') return startCiRole(config);"] },
  { path: 'server/src/lib/jobs.ts', reason: 'plazo de los trabajos del motor de código', anchors: ["type.startsWith('code.')"] },
  { path: 'web/src/main.tsx', reason: 'la pantalla del motor de código debe seguir accesible', anchors: ['path="/platform/code"'] },
];

const KERNEL_FILES = ['server/src/app.ts', 'server/src/worker.ts', 'server/src/index.ts', 'server/src/lib/jobs.ts', 'server/src/lib/errors.ts', 'server/src/lib/audit.ts', 'server/src/ai/manager.ts', MIGRATIONS_PATH];

const count = (re: RegExp, text: string | null) => (text ? [...text.matchAll(re)].length : 0);

function lineOf(re: RegExp, text: string, nth: number): number | undefined {
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (i++ === nth) return text.slice(0, m.index).split('\n').length;
  }
  return undefined;
}

function inScope(scope: Scope, path: string): boolean {
  if (!isCode(path)) return false;
  if (scope === 'server') return path.startsWith('server/src/');
  if (scope === 'test') return isTestPath(path);
  return true;
}

/** package.json: solo pueden cambiar version y description (dependencias y scripts están protegidos). */
function checkPackageJson(before: string | null, after: string | null): string | null {
  if (before === null || after === null) return 'package.json no se puede crear ni borrar';
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return 'package.json no es JSON válido';
  }
  const sortDeep = (o: unknown): unknown =>
    Array.isArray(o)
      ? o.map(sortDeep)
      : o && typeof o === 'object'
        ? Object.fromEntries(Object.entries(o as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => [k, sortDeep(v)]))
        : o;
  const canonical = (o: Record<string, unknown>) => {
    const { version: _v, description: _d, ...rest } = o;
    return JSON.stringify(sortDeep(rest));
  };
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object' || canonical(a) !== canonical(b)) {
    return 'package.json: solo se pueden cambiar version y description (dependencias, scripts y el resto están protegidos)';
  }
  return null;
}

export function formatViolation(v: Violation): string {
  return `${v.path ? `${v.path}${v.line ? `:${v.line}` : ''}: ` : ''}${v.message}`;
}

/** Aplica todas las reglas a los cambios (frente al árbol base). */
export function checkChanges(base: SourceTree, changes: FileChange[]): GuardResult {
  const violations: Violation[] = [];
  const flags: Flag[] = [];
  const stats: GuardStats = { files: changes.length, added: 0, modified: 0, deleted: 0, linesAdded: 0, linesRemoved: 0, bytes: 0 };
  const migrations: string[] = [];
  const warnPaths = new Map<string, Set<string>>();
  const warn = (key: string, path: string) => (warnPaths.get(key) ?? warnPaths.set(key, new Set()).get(key)!).add(path);

  if (changes.length > LIMITS.maxFiles) violations.push({ rule: 'limits', message: `El cambio toca ${changes.length} archivos (máximo ${LIMITS.maxFiles})` });
  const seen = new Set<string>();

  for (const c of changes) {
    // Ruta: normalizada, única, en una raíz permitida y fuera del núcleo protegido.
    let path: string;
    try {
      path = normalizePath(c.path);
    } catch (e) {
      violations.push({ rule: 'path', path: String(c.path).slice(0, 120), message: (e as PathError).message });
      continue;
    }
    if (seen.has(path)) {
      violations.push({ rule: 'path', path, message: 'Ruta repetida en el cambio' });
      continue;
    }
    seen.add(path);
    const blocked = writeBlockedReason(path);
    if (blocked) {
      violations.push({ rule: blocked.startsWith('Ruta protegida') ? 'protected' : 'path', path, message: blocked });
      continue;
    }
    const baseBuf = base.files.get(path);
    if (baseBuf && isBinary(baseBuf)) {
      violations.push({ rule: 'path', path, message: 'Los archivos binarios no se pueden modificar' });
      continue;
    }
    const before = baseBuf ? baseBuf.toString('utf8') : null;
    const after = c.action === 'delete' ? null : c.after;
    if (c.action !== 'delete' && typeof after !== 'string') {
      violations.push({ rule: 'path', path, message: 'Contenido no válido' });
      continue;
    }
    if (c.action === 'add' && baseBuf) violations.push({ rule: 'path', path, message: 'El archivo ya existe en la base (debería ser una modificación)' });
    if (c.action !== 'add' && !baseBuf) violations.push({ rule: 'path', path, message: 'El archivo no existe en la base' });

    // Tamaño
    const bytes = after ? Buffer.byteLength(after, 'utf8') : 0;
    stats.bytes += bytes;
    if (bytes > LIMITS.maxFileBytes) violations.push({ rule: 'limits', path, message: `El archivo supera ${LIMITS.maxFileBytes / 1024} KB` });
    if (after?.includes('\u0000')) violations.push({ rule: 'path', path, message: 'El contenido incluye bytes nulos' });
    if (c.action === 'add') stats.added++;
    else if (c.action === 'modify') stats.modified++;
    else stats.deleted++;
    const d = diffStats(before, after);
    stats.linesAdded += d.added;
    stats.linesRemoved += d.removed;

    // Borrados que debilitarían la red de seguridad o romperían el motor
    if (c.action === 'delete' && isTestPath(path)) violations.push({ rule: 'tests', path, message: 'No se pueden borrar pruebas existentes' });
    if (c.action === 'delete' && (KERNEL_FILES.includes(path) || KERNEL_ANCHORS.some((a) => a.path === path))) violations.push({ rule: 'kernel', path, message: 'Este archivo del núcleo no se puede borrar' });

    // Reglas especiales
    if (path === 'package.json') {
      const problem = checkPackageJson(before, after);
      if (problem) violations.push({ rule: 'dependencies', path, message: problem });
    }
    if (path === MIGRATIONS_PATH && before !== null && after !== null) {
      const report = checkMigrationsChange(before, after);
      for (const v of report.violations) violations.push({ rule: 'migrations', path, message: v.message });
      for (const w of report.warnings) flags.push({ key: 'migration_warning', level: 'warning', message: w.message, paths: [path] });
      migrations.push(...report.added.map((a) => a.id));
    }

    // Patrones prohibidos (solo apariciones nuevas)
    for (const rule of FORBIDDEN_PATTERNS) {
      if (!inScope(rule.scope, path) || rule.except?.(path)) continue;
      const n0 = count(rule.re, before);
      const n1 = count(rule.re, after);
      if (n1 > n0) violations.push({ rule: rule.id, path, line: lineOf(rule.re, after!, n0), message: rule.message });
    }
    for (const w of WARNING_PATTERNS) {
      if (inScope(w.scope, path) && count(w.re, after) > count(w.re, before)) warn(w.key, path);
    }

    // Anclas del núcleo
    const anchors = KERNEL_ANCHORS.find((a) => a.path === path);
    if (anchors && before !== null) {
      for (const anchor of anchors.anchors) {
        if (before.includes(anchor) && !(after ?? '').includes(anchor)) {
          violations.push({ rule: 'kernel', path, message: `Falta «${anchor}»: no se puede quitar ni cambiar (${anchors.reason})` });
        }
      }
    }

    // Rutas HTTP nuevas
    if (path.startsWith('server/src/') && isCode(path)) {
      const newRoutes = count(ROUTE_RE, after) - count(ROUTE_RE, before);
      if (newRoutes > 0) {
        warn('routes', path);
        if (count(AUTHZ_RE, after) - count(AUTHZ_RE, before) < newRoutes) warn('routes_without_auth', path);
      }
    }
    if (path.startsWith('web/')) warn('web', path);
    if (path.startsWith('shared/')) warn('shared', path);
    if (path.startsWith('docs/') || path === 'README.md') warn('docs', path);
    if (isTestPath(path)) warn(c.action === 'add' ? 'tests_added' : 'tests_modified', path);
    if (c.action === 'delete') warn('deletes', path);
    if (KERNEL_FILES.includes(path)) warn('kernel_files', path);
  }

  if (stats.bytes > LIMITS.maxPatchBytes) violations.push({ rule: 'limits', message: `El cambio supera ${LIMITS.maxPatchBytes / 1024 / 1024} MB` });

  // Avisos para quien aprueba (el riesgo de un cambio de código es siempre alto)
  const paths = (key: string) => [...(warnPaths.get(key) ?? [])];
  if (migrations.length) flags.push({ key: 'migrations', level: 'warning', message: `Migraciones nuevas: ${migrations.join(', ')} (se aplican al arrancar el worker y no se deshacen al revertir)`, paths: [MIGRATIONS_PATH] });
  const MESSAGES: Record<string, { level: Flag['level']; message: string }> = {
    routes: { level: 'warning', message: 'Rutas HTTP nuevas' },
    routes_without_auth: { level: 'warning', message: 'Rutas nuevas sin una comprobación de autorización visible (requireWorkspace / requireUserSession / requirePlatformAdmin)' },
    web: { level: 'info', message: 'Cambios en la interfaz web' },
    shared: { level: 'info', message: 'Cambios en la lógica compartida (servidor e interfaz)' },
    docs: { level: 'info', message: 'Cambios en la documentación' },
    tests_added: { level: 'info', message: 'Pruebas nuevas' },
    tests_modified: { level: 'warning', message: 'Modifica pruebas existentes' },
    deletes: { level: 'warning', message: 'Borra archivos' },
    kernel_files: { level: 'warning', message: 'Toca archivos centrales de la plataforma' },
    ...Object.fromEntries(WARNING_PATTERNS.map((w) => [w.key, { level: 'warning' as const, message: w.message }])),
  };
  for (const [key, def] of Object.entries(MESSAGES)) {
    const list = paths(key);
    if (list.length) flags.push({ key, level: def.level, message: def.message, paths: list });
  }
  const codeTouched = changes.some((c) => (c.path.startsWith('server/src/') || c.path.startsWith('shared/')) && isCode(c.path));
  if (codeTouched && !changes.some((c) => isTestPath(c.path))) flags.push({ key: 'no_tests', level: 'warning', message: 'Cambia código del servidor sin añadir ni modificar pruebas' });
  if (stats.files > 40 || stats.linesAdded > 3000) flags.push({ key: 'large_change', level: 'warning', message: `Cambio grande (${stats.files} archivos, +${stats.linesAdded} líneas): revísalo con calma` });

  return { ok: violations.length === 0, violations, flags, stats, migrations };
}
