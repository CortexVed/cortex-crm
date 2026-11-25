import zlib from 'node:zlib';

/**
 * Escritor (y lector, para verificarlo) mínimo de archivos tar en formato ustar, sin dependencias: es lo que
 * espera el endpoint de subida de Railway (`railway up`), comprimido con gzip. Solo archivos normales (0644)
 * y sus carpetas (0755); nunca enlaces, dispositivos ni permisos especiales. Las rutas largas se reparten
 * entre los campos `prefix` (155 bytes) y `name` (100 bytes).
 */

const BLOCK = 512;

export interface TarEntry {
  path: string;
  type: 'file' | 'dir';
  mode: number;
  mtime: number;
  content: Buffer;
}

function writeText(h: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`Campo tar demasiado largo: ${value.slice(0, 60)}`);
  bytes.copy(h, offset);
}

function writeOctal(h: Buffer, offset: number, length: number, value: number) {
  const digits = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  if (digits.length > length - 1) throw new Error('Valor numérico demasiado grande para tar');
  h.write(digits, offset, length - 1, 'ascii');
  h[offset + length - 1] = 0;
}

/** Reparte una ruta entre `prefix` y `name`; error si no cabe (más de 255 bytes o un segmento final > 100). */
export function splitTarPath(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name && Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { prefix, name };
  }
  throw new Error(`Ruta demasiado larga para un archivo tar: ${path.slice(0, 80)}…`);
}

function checksum(h: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum;
}

function header(entry: { path: string; type: 'file' | 'dir'; size: number; mtime: number }): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  const { prefix, name } = splitTarPath(entry.path);
  const isDir = entry.type === 'dir';
  writeText(h, 0, 100, isDir && Buffer.byteLength(name) < 100 ? `${name}/` : name);
  writeOctal(h, 100, 8, isDir ? 0o755 : 0o644);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, isDir ? 0 : entry.size);
  writeOctal(h, 136, 12, entry.mtime);
  h.write(isDir ? '5' : '0', 156, 1, 'ascii');
  h.write('ustar\u0000', 257, 6, 'latin1');
  h.write('00', 263, 2, 'ascii');
  writeText(h, 265, 32, 'root');
  writeText(h, 297, 32, 'root');
  writeOctal(h, 329, 8, 0);
  writeOctal(h, 337, 8, 0);
  writeText(h, 345, 155, prefix);
  const sum = checksum(h).toString(8).padStart(6, '0');
  h.write(sum, 148, 6, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/** Crea un tar con los archivos indicados (ordenados por ruta) y las carpetas que los contienen. */
export function createTar(files: Iterable<readonly [string, Buffer]>, opts: { mtime?: number } = {}): Buffer {
  const mtime = Math.max(0, Math.floor(opts.mtime ?? 0));
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dirs = new Set<string>();
  for (const [p] of sorted) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const chunks: Buffer[] = [];
  for (const d of [...dirs].sort()) chunks.push(header({ path: d, type: 'dir', size: 0, mtime }));
  for (const [p, content] of sorted) {
    chunks.push(header({ path: p, type: 'file', size: content.length, mtime }), content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

/** tar + gzip, el formato que acepta la subida de Railway. */
export function createTarGz(files: Iterable<readonly [string, Buffer]>, opts: { mtime?: number } = {}): Buffer {
  return zlib.gzipSync(createTar(files, opts), { level: 9 });
}

const cstr = (h: Buffer, offset: number, length: number) => {
  const slice = h.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString('utf8');
};

/** Lee un tar (sin comprimir) y comprueba la suma de cada cabecera. */
export function parseTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(cstr(h, 148, 8).trim() || '0', 8);
    if (stored !== checksum(h)) throw new Error(`Suma de control tar incorrecta en el desplazamiento ${off}`);
    if (cstr(h, 257, 6) !== 'ustar') throw new Error('Cabecera tar sin la marca ustar');
    const name = cstr(h, 0, 100);
    const prefix = cstr(h, 345, 155);
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]) === '5' ? 'dir' : 'file';
    off += BLOCK;
    out.push({
      path: (prefix ? `${prefix}/${name}` : name).replace(/\/$/, ''),
      type,
      mode: parseInt(cstr(h, 100, 8).trim() || '0', 8),
      mtime: parseInt(cstr(h, 136, 12).trim() || '0', 8),
      content: Buffer.from(buf.subarray(off, off + size)),
    });
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
