import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_DIRS, BUNDLE_ROOT_FILES, normalizePath, SKIP_DIRS, SKIP_FILE } from './paths';

/**
 * Paquete de código fuente de la instalación: el código exacto con el que se construyó la imagen que se está
 * ejecutando (el Dockerfile lo copia en /app/source). En desarrollo, sin /app/source, es la raíz del repo.
 */

export interface SourceVersion {
  id: string;
  base: string | null;
  createdAt: string | null;
}

export interface SourceTree {
  root: string;
  files: ReadonlyMap<string, Buffer>;
  /** Huella del árbol completo (rutas + sha256 de cada archivo). */
  hash: string;
  /** source-version.json de la versión (null en una imagen construida desde el repositorio). */
  version: SourceVersion | null;
  /** Etiqueta legible: id de la versión o «inicial-<huella>» para la imagen de partida. */
  label: string;
}

/** Ningún archivo del paquete debería acercarse a esto; los mayores se ignoran. */
const MAX_BASE_FILE_BYTES = 5 * 1024 * 1024;

/** /app/source (imagen de Docker) o, si no existe, el directorio de trabajo (desarrollo). */
export function resolveSourceRoot(cwd = process.cwd()): string {
  const bundled = path.join(cwd, 'source');
  return fs.existsSync(path.join(bundled, 'package.json')) ? bundled : cwd;
}

export const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Huella determinista de un árbol (orden por ruta). `exclude`: rutas que no cuentan (p. ej. railway.json). */
export function treeHash(files: ReadonlyMap<string, Buffer>, exclude: ReadonlySet<string> = new Set()): string {
  const h = crypto.createHash('sha256');
  for (const p of [...files.keys()].sort()) {
    if (exclude.has(p)) continue;
    h.update(p);
    h.update('\0');
    h.update(sha256Hex(files.get(p)!));
    h.update('\n');
  }
  return h.digest('hex');
}

export function parseSourceVersion(buf: Buffer | string | undefined | null): SourceVersion | null {
  if (!buf) return null;
  try {
    const raw = JSON.parse(buf.toString()) as Record<string, unknown> | null;
    if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
    return { id: raw.id.slice(0, 100), base: typeof raw.base === 'string' ? raw.base.slice(0, 100) : null, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : null };
  } catch {
    return null;
  }
}

/** Lee el paquete de un directorio: solo archivos normales (nunca enlaces simbólicos) con rutas seguras. */
export function readSourceTree(root: string): SourceTree {
  const files = new Map<string, Buffer>();
  const add = (rel: string) => {
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > MAX_BASE_FILE_BYTES) return;
    files.set(rel, fs.readFileSync(abs));
  };
  for (const f of BUNDLE_ROOT_FILES) add(f);
  const walk = (relDir: string, depth: number) => {
    if (depth > 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel, depth + 1);
        continue;
      }
      if (!e.isFile() || SKIP_FILE.test(e.name)) continue;
      try {
        normalizePath(rel);
      } catch {
        continue; // nombres fuera del conjunto seguro: no forman parte del paquete
      }
      add(rel);
    }
  };
  for (const d of BUNDLE_DIRS) walk(d, 0);
  const hash = treeHash(files);
  const version = parseSourceVersion(files.get('source-version.json'));
  return { root, files, hash, version, label: version?.id ?? `inicial-${hash.slice(0, 12)}` };
}

const cache = new Map<string, SourceTree>();

/**
 * Árbol de la versión en ejecución. /app/source es inmutable dentro de la imagen y se lee una sola vez; en
 * desarrollo (la raíz del repositorio) se vuelve a leer cada vez, porque cambia mientras se trabaja.
 */
export function loadSourceTree(root: string): SourceTree {
  const immutable = path.basename(root) === 'source' && root === path.join(process.cwd(), 'source');
  if (immutable) {
    const hit = cache.get(root);
    if (hit) return hit;
  }
  const tree = readSourceTree(root);
  if (immutable) cache.set(root, tree);
  return tree;
}
