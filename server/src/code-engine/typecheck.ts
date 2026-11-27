import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n';

/**
 * COMPROBACIÓN DE TIPOS ANTES DEL CI. Escribe el árbol del cambio en una carpeta temporal y ejecuta `tsc --noEmit`
 * (TypeScript 7, nativo) con las dos configuraciones del proyecto: así el agente ve sus errores en segundos, en
 * lugar de esperar minutos al CI. tsc solo ANALIZA el código, no lo ejecuta: el código generado sigue sin correr
 * fuera del build aislado del CI.
 *
 * Las herramientas (typescript y los tipos de las librerías) no están en la imagen de producción (se instala sin
 * dependencias de desarrollo): el worker las instala una vez en una carpeta de caché con
 * `npm ci --ignore-scripts --include=dev` a partir del package-lock.json (sin ejecutar scripts de los paquetes y
 * con un entorno mínimo, sin las variables ni los secretos de la aplicación).
 */

export interface TsDiagnostic {
  path: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export interface TypecheckResult {
  ok: boolean;
  errors: TsDiagnostic[];
  durationMs: number;
  /** Motivo si no se pudo comprobar (sin herramientas, plazo agotado…): entonces lo comprobará el CI. */
  skipped?: string;
}

const TS_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
/** Configuraciones que comprueba el CI (`npm run typecheck`). */
const PROJECTS = ['tsconfig.json', 'web/tsconfig.json'];

function minimalEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: path.join(home, '.npm-cache'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

function run(command: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // En Windows (desarrollo), npm es npm.cmd y necesita shell: un único comando fijo (nada viene del agente).
    const win = process.platform === 'win32' && command === 'npm';
    const child = spawn(win ? `npm.cmd ${args.join(' ')}` : command, win ? [] : args, { cwd: opts.cwd, env: opts.env, shell: win, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const onData = (d: Buffer) => {
      output = (output + d.toString('utf8')).slice(-400_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output, timedOut });
    });
  });
}

const installs = new Map<string, Promise<string>>();

/**
 * Carpeta con node_modules completo (incluidas las dependencias de desarrollo) para un package.json y su lockfile.
 * En desarrollo, si el directorio de trabajo ya tiene TypeScript y el mismo lockfile, se usa directamente.
 */
export async function ensureToolchain(packageJson: string, lockfile: string, opts: { signal?: AbortSignal; timeoutMs?: number; localRoot?: string } = {}): Promise<string> {
  const local = opts.localRoot ?? process.cwd();
  if (existsSync(path.join(local, 'node_modules', 'typescript', 'package.json')) && existsSync(path.join(local, 'package-lock.json'))) {
    if ((await readFile(path.join(local, 'package-lock.json'), 'utf8')) === lockfile) return local;
  }
  const key = createHash('sha256').update(packageJson).update('\u0000').update(lockfile).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `cortex-toolchain-${key}`);
  if (existsSync(path.join(dir, '.ok'))) return dir;
  const pending = installs.get(dir);
  if (pending) return pending;
  const job = (async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), packageJson);
    await writeFile(path.join(dir, 'package-lock.json'), lockfile);
    const r = await run('npm', ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, env: minimalEnv(dir), timeoutMs: opts.timeoutMs ?? 6 * 60_000, signal: opts.signal });
    if (r.code !== 0 || !existsSync(path.join(dir, 'node_modules', 'typescript', 'package.json'))) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      const output = r.output.trim().slice(-600);
      throw new Error(r.timedOut ? t('No se han podido instalar las herramientas de comprobación (plazo agotado): {output}', { output }) : t('No se han podido instalar las herramientas de comprobación: {output}', { output }));
    }
    await writeFile(path.join(dir, '.ok'), new Date().toISOString());
    return dir;
  })().finally(() => installs.delete(dir));
  installs.set(dir, job);
  return job;
}

/** Errores de tsc ("ruta(línea,col): error TSxxxx: mensaje"), con las rutas relativas al proyecto. */
export function parseTscOutput(output: string): TsDiagnostic[] {
  const out: TsDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const m = TS_ERROR.exec(raw.trim());
    if (!m) continue;
    const file = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    const key = `${file}:${m[2]}:${m[3]}:${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: file, line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5].trim() });
  }
  return out;
}

/** Comprueba los tipos de un árbol completo (base + cambio) con las herramientas de `toolchainDir`. */
export async function typecheckTree(files: ReadonlyMap<string, Buffer>, toolchainDir: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TypecheckResult> {
  const started = Date.now();
  const dir = await mkdtemp(path.join(os.tmpdir(), `cortex-tc-${randomUUID().slice(0, 8)}-`));
  try {
    for (const [p, content] of files) {
      const target = path.join(dir, ...p.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await symlink(path.join(toolchainDir, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const tsc = path.join(toolchainDir, 'node_modules', 'typescript', 'bin', 'tsc');
    const errors: TsDiagnostic[] = [];
    for (const project of PROJECTS) {
      if (!files.has(project)) continue;
      const left = (opts.timeoutMs ?? 180_000) - (Date.now() - started);
      if (left <= 0) return { ok: false, errors, durationMs: Date.now() - started, skipped: t('plazo agotado') };
      const r = await run(process.execPath, [tsc, '-p', project, '--noEmit', '--pretty', 'false'], { cwd: dir, env: minimalEnv(dir), timeoutMs: left, signal: opts.signal });
      if (r.timedOut) return { ok: false, errors, durationMs: Date.now() - started, skipped: t('plazo agotado') };
      const found = parseTscOutput(r.output);
      errors.push(...found);
      // Código distinto de 0 sin errores reconocibles: problema de la herramienta, no del código.
      if (r.code !== 0 && !found.length) return { ok: false, errors, durationMs: Date.now() - started, skipped: t('tsc terminó con código {code}: {output}', { code: String(r.code), output: r.output.trim().slice(-300) }) };
    }
    return { ok: errors.length === 0, errors, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Texto para el agente: los errores agrupados por archivo (como mucho `max`). */
export function formatTsErrors(errors: TsDiagnostic[], max = 60): string {
  const lines = errors.slice(0, max).map((e) => `${e.path}:${e.line}:${e.col} ${e.code}: ${e.message}`);
  return `${lines.join('\n')}${errors.length > max ? `\n… y ${errors.length - max} error(es) más` : ''}`;
}
