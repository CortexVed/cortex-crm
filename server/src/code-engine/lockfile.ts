import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * DEPENDENCIAS NUEVAS DEL MOTOR DE CÓDIGO. El agente puede añadir o actualizar paquetes en package.json
 * (`dependencies` y `devDependencies`), pero nunca escribe package-lock.json: lo calcula el propio motor con
 * `npm install --package-lock-only --ignore-scripts` (solo descarga metadatos del registro, no instala ni ejecuta
 * nada de los paquetes) y después se verifica de forma determinista: cada paquete sale del registro oficial de
 * npm con su hash de integridad y la raíz coincide exactamente con package.json. Así no se puede colar un
 * paquete servido desde otra URL, un repositorio git o un archivo local.
 */

/** Rutas que genera el motor (no el agente). */
export const GENERATED_PATHS: ReadonlySet<string> = new Set(['package-lock.json']);

/** Nombre de paquete de npm (con ámbito opcional). */
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Versión del registro: exacta, ^ o ~ (nada de git, URL, file:, link:, npm: ni workspace:). */
export const NPM_VERSION = /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const;
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];
const REGISTRY = 'https://registry.npmjs.org/';

export interface DependencyChange {
  field: DependencyField;
  name: string;
  from: string | null;
  to: string | null;
}

export class LockfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockfileError';
  }
}

type Json = Record<string, unknown>;
const isPlainObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const asDeps = (v: unknown): Record<string, unknown> => (isPlainObject(v) ? v : {});

/** Diferencias de dependencias entre dos package.json (los dos ya parseados). */
export function dependencyChanges(before: Json, after: Json): DependencyChange[] {
  const out: DependencyChange[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const a = asDeps(before[field]);
    const b = asDeps(after[field]);
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const from = typeof a[name] === 'string' ? (a[name] as string) : null;
      const to = typeof b[name] === 'string' ? (b[name] as string) : null;
      if (from !== to) out.push({ field, name, from, to });
    }
  }
  return out;
}

/** Problemas de las dependencias que se añaden o cambian (nombres y versiones). */
export function dependencyProblems(after: Json, changes: DependencyChange[]): string[] {
  const problems: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const v = after[field];
    if (v !== undefined && (!isPlainObject(v) || Object.values(v).some((x) => typeof x !== 'string'))) problems.push(`package.json: "${field}" debe ser un objeto { "paquete": "versión" }`);
  }
  for (const c of changes) {
    if (c.to === null) continue;
    if (c.name.length > 214 || !NPM_NAME.test(c.name)) problems.push(`package.json: nombre de paquete no válido «${c.name.slice(0, 80)}»`);
    if (!NPM_VERSION.test(c.to)) problems.push(`package.json: ${c.name}@${c.to.slice(0, 60)}: solo versiones del registro de npm (1.2.3, ^1.2.3 o ~1.2.3); nada de git, URL, file:, link:, npm: ni workspace:`);
  }
  return problems;
}

const sameDeps = (a: unknown, b: unknown) => {
  const norm = (o: unknown) => JSON.stringify(Object.entries(asDeps(o)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return norm(a) === norm(b);
};

/**
 * Verifica un package-lock.json frente a su package.json: formato 2 o 3, la raíz declara exactamente las mismas
 * dependencias y cada paquete se descarga del registro oficial con un hash sha512 (salvo los que vienen dentro de
 * otro paquete, `inBundle`). Devuelve la lista de problemas (vacía si es válido).
 */
export function verifyLockfile(packageJson: string, lockJson: string): string[] {
  let pkg: Json;
  let lock: Json;
  try {
    pkg = JSON.parse(packageJson);
    lock = JSON.parse(lockJson);
  } catch {
    return ['package-lock.json o package.json no son JSON válido'];
  }
  if (!isPlainObject(pkg) || !isPlainObject(lock)) return ['package-lock.json no es válido'];
  const problems: string[] = [];
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) problems.push('package-lock.json debe tener lockfileVersion 2 o 3');
  const packages = isPlainObject(lock.packages) ? lock.packages : null;
  if (!packages) return [...problems, 'package-lock.json no tiene la sección "packages"'];
  const root = isPlainObject(packages['']) ? packages[''] : {};
  for (const field of DEPENDENCY_FIELDS) {
    if (!sameDeps(root[field], pkg[field])) problems.push(`package-lock.json no corresponde a package.json (${field})`);
  }
  for (const [key, raw] of Object.entries(packages)) {
    if (!key) continue;
    if (!isPlainObject(raw)) {
      problems.push(`package-lock.json: entrada no válida (${key.slice(0, 80)})`);
      continue;
    }
    if (raw.link) problems.push(`package-lock.json: ${key.slice(0, 80)} es un enlace local (no permitido)`);
    else if (raw.inBundle) continue;
    else {
      if (typeof raw.resolved !== 'string' || !raw.resolved.startsWith(REGISTRY)) problems.push(`package-lock.json: ${key.slice(0, 80)} no viene del registro oficial de npm`);
      if (typeof raw.integrity !== 'string' || !raw.integrity.startsWith('sha512-')) problems.push(`package-lock.json: ${key.slice(0, 80)} no tiene hash de integridad sha512`);
    }
    if (problems.length > 20) break;
  }
  return problems.slice(0, 20);
}

const clip = (s: string, n = 3000) => s.replace(/\s+\n/g, '\n').trim().slice(-n);

/**
 * Calcula package-lock.json para un package.json con npm, en una carpeta temporal y sin ejecutar nada de los
 * paquetes (`--package-lock-only --ignore-scripts`). El proceso recibe un entorno mínimo: ni las variables de la
 * aplicación ni secretos (solo PATH y una carpeta propia como HOME y caché).
 */
export async function resolveLockfileWithNpm(packageJson: string, baseLock: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cortex-lock-'));
  try {
    await writeFile(path.join(dir, 'package.json'), packageJson);
    await writeFile(path.join(dir, 'package-lock.json'), baseLock);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      USERPROFILE: dir,
      npm_config_cache: path.join(dir, '.npm-cache'),
      npm_config_registry: REGISTRY,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const args = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];
    await new Promise<void>((resolve, reject) => {
      // En Windows (desarrollo), npm es npm.cmd y necesita shell: se pasa como un único comando fijo (nada viene del
      // agente). En Linux (Railway) se ejecuta npm directamente, sin shell.
      const win = process.platform === 'win32';
      const child = spawn(win ? `npm.cmd ${args.join(' ')}` : 'npm', win ? [] : args, { cwd: dir, env, shell: win, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const onData = (d: Buffer) => {
        output = (output + d.toString('utf8')).slice(-20_000);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 180_000);
      const onAbort = () => child.kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(new LockfileError(`No se ha podido ejecutar npm: ${e.message}`));
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new LockfileError(`npm no ha podido resolver las dependencias${sig ? ` (${sig})` : ''}:\n${clip(output) || `código ${code}`}`));
      });
    });
    return await readFile(path.join(dir, 'package-lock.json'), 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
