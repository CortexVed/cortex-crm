import { GENERATED_PATHS } from './lockfile';
import { normalizePath, PathError, writeBlockedReason } from './paths';
import { isBinary, type SourceTree } from './source';
import { t } from '../i18n';

/**
 * Límites de un cambio (los vuelve a comprobar guards.ts sobre el resultado final). Son límites de abuso, no de
 * alcance: un cambio puede ser una funcionalidad completa (servidor, interfaz, pruebas y documentación).
 */
export const LIMITS = {
  maxFiles: 1000,
  maxPatchBytes: 12 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  /** package-lock.json (lo genera el motor) puede ser mayor que un archivo normal. */
  maxGeneratedBytes: 8 * 1024 * 1024,
} as const;

export interface FileChange {
  path: string;
  action: 'add' | 'modify' | 'delete';
  /** Contenido en la versión base (null si el archivo es nuevo). */
  before: string | null;
  /** Contenido nuevo (null si se borra). */
  after: string | null;
}

/**
 * Espacio de trabajo virtual: el código base (de solo lectura) más una capa con los cambios del agente.
 * Nada se escribe en disco ni se ejecuta: el agente solo manipula texto, y el resultado se empaqueta para el
 * CI aislado de Railway.
 */
export class VirtualWorkspace {
  private readonly overlay = new Map<string, string | null>();
  private revision = 0;

  constructor(
    readonly base: SourceTree,
    initial: Iterable<Pick<FileChange, 'path' | 'after'>> = [],
  ) {
    for (const c of initial) {
      const p = normalizePath(c.path);
      const baseText = this.baseText(p);
      if (c.after === null) {
        if (this.base.files.has(p)) this.overlay.set(p, null);
      } else if (baseText !== c.after) {
        this.overlay.set(p, c.after);
      }
    }
  }

  /** Cambia con cada escritura (para guardar borradores solo cuando hay algo nuevo). */
  get version(): number {
    return this.revision;
  }

  private baseText(p: string): string | null {
    const buf = this.base.files.get(p);
    if (!buf || isBinary(buf)) return null;
    return buf.toString('utf8');
  }

  exists(path: string): boolean {
    const p = normalizePath(path);
    if (this.overlay.has(p)) return this.overlay.get(p) !== null;
    return this.base.files.has(p);
  }

  /** Texto actual del archivo (null si no existe). Los binarios no se pueden leer como texto. */
  read(path: string): string | null {
    const p = normalizePath(path);
    if (this.overlay.has(p)) return this.overlay.get(p) ?? null;
    const buf = this.base.files.get(p);
    if (!buf) return null;
    if (isBinary(buf)) throw new PathError(t('{path} es un archivo binario', { path: p }));
    return buf.toString('utf8');
  }

  /** Rutas actuales (base + nuevas − borradas), ordenadas, opcionalmente bajo un prefijo. */
  list(prefix = ''): string[] {
    const out = new Set<string>();
    for (const p of this.base.files.keys()) if (this.overlay.get(p) !== null) out.add(p);
    for (const [p, v] of this.overlay) if (v !== null) out.add(p);
    return [...out].filter((p) => p.startsWith(prefix)).sort();
  }

  write(path: string, content: string): void {
    const p = normalizePath(path);
    const blocked = writeBlockedReason(p);
    if (blocked) throw new PathError(blocked);
    if (typeof content !== 'string') throw new PathError(t('El contenido debe ser texto'));
    if (content.includes('\u0000')) throw new PathError(t('El contenido no puede incluir bytes nulos'));
    if (Buffer.byteLength(content, 'utf8') > LIMITS.maxFileBytes) throw new PathError(t('El archivo supera {size} KB', { size: LIMITS.maxFileBytes / 1024 }));
    const baseBuf = this.base.files.get(p);
    if (baseBuf && isBinary(baseBuf)) throw new PathError(t('{path} es un archivo binario: no se puede modificar', { path: p }));
    const previous = this.overlay.has(p) ? { value: this.overlay.get(p) } : null;
    if (this.baseText(p) === content) this.overlay.delete(p);
    else this.overlay.set(p, content);
    try {
      this.checkLimits();
    } catch (e) {
      if (previous) this.overlay.set(p, previous.value ?? null);
      else this.overlay.delete(p);
      throw e;
    }
    this.revision++;
  }

  remove(path: string): void {
    const p = normalizePath(path);
    const blocked = writeBlockedReason(p);
    if (blocked) throw new PathError(blocked);
    if (!this.exists(p)) throw new PathError(t('{path} no existe', { path: p }));
    if (this.base.files.has(p)) this.overlay.set(p, null);
    else this.overlay.delete(p);
    this.revision++;
  }

  /**
   * Archivo que calcula el propio motor, nunca el agente: hoy solo package-lock.json, generado con npm a partir del
   * package.json del cambio (ver lockfile.ts). Se salta las rutas protegidas a propósito; guards.ts lo verifica.
   */
  setGenerated(path: string, content: string): void {
    const p = normalizePath(path);
    if (!GENERATED_PATHS.has(p)) throw new PathError(t('{path} no lo genera el motor', { path: p }));
    if (Buffer.byteLength(content, 'utf8') > LIMITS.maxGeneratedBytes) throw new PathError(t('{path} supera {size} MB', { path: p, size: LIMITS.maxGeneratedBytes / 1024 / 1024 }));
    if (this.baseText(p) === content) this.overlay.delete(p);
    else this.overlay.set(p, content);
    this.revision++;
  }

  /** Vuelve a la versión base de los archivos generados (se recalculan después de cada ronda del agente). */
  dropGenerated(): void {
    for (const p of GENERATED_PATHS) {
      if (this.overlay.delete(p)) this.revision++;
    }
  }

  private checkLimits() {
    const changes = this.overlay.size;
    if (changes > LIMITS.maxFiles) throw new PathError(t('Un cambio puede tocar como mucho {max} archivos', { max: LIMITS.maxFiles }));
    let bytes = 0;
    for (const v of this.overlay.values()) bytes += v ? Buffer.byteLength(v, 'utf8') : 0;
    if (bytes > LIMITS.maxPatchBytes) throw new PathError(t('El cambio supera {size} MB', { size: LIMITS.maxPatchBytes / 1024 / 1024 }));
  }

  /** Cambios frente a la base, ordenados por ruta. */
  changes(): FileChange[] {
    const out: FileChange[] = [];
    for (const [p, after] of this.overlay) {
      const exists = this.base.files.has(p);
      const before = this.baseText(p);
      if (after === null) {
        if (exists) out.push({ path: p, action: 'delete', before, after: null });
      } else {
        out.push({ path: p, action: exists ? 'modify' : 'add', before: exists ? before : null, after });
      }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Árbol completo (base + cambios) más los archivos que añade el propio motor (railway.json, source-version.json). */
  tree(extra: Record<string, string> = {}): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    for (const [p, buf] of this.base.files) if (this.overlay.get(p) !== null) out.set(p, buf);
    for (const [p, v] of this.overlay) if (v !== null) out.set(p, Buffer.from(v, 'utf8'));
    for (const [p, v] of Object.entries(extra)) out.set(normalizePath(p), Buffer.from(v, 'utf8'));
    return out;
  }
}
