import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** Expande una IPv6 a sus 8 grupos de 16 bits (admite notación "::" y sufijo IPv4). */
function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[2]);
    addr = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - h.length - t.length;
  if (tail === null && h.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...h, ...Array(tail === null ? 0 : missing).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** true si la IP es privada, local, reservada o de metadatos (no se permite como destino). */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(clean)) {
    const n = ipv4ToInt(clean);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(clean)) {
    const g = expandIPv6(clean);
    if (!g) return true;
    const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
    if (zeroPrefix && g[5] === 0xffff) return isPrivateIp(embeddedV4()); // ::ffff:a.b.c.d (también en hex)
    if (zeroPrefix && g[5] === 0) return g[6] === 0 && g[7] <= 1 ? true : isPrivateIp(embeddedV4()); // ::, ::1, ::a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA, incluye la red privada de Railway)
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local y site-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentación
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // descarte 100::/64
    return false;
  }
  return true;
}

/** true si el nombre de host es un literal de IP privada o un nombre interno conocido. */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return isPrivateIp(h);
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.railway.internal');
}

export class SsrfError extends Error {}

/**
 * Fallo de transporte de safePost: plazo total agotado, respuesta demasiado grande, conexión cortada
 * antes de completar la respuesta o cancelación externa. A diferencia de SsrfError es transitorio
 * (el trabajo de webhook se reintenta con backoff).
 */
export class SafePostError extends Error {
  constructor(
    readonly code: 'timeout' | 'too_large' | 'incomplete' | 'aborted',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SafePostError';
  }
}

export interface SafePostOptions {
  /** Permite http: además de https: (solo fuera de producción). */
  allowHttp?: boolean;
  /** Plazo TOTAL de la petición: DNS + conexión + TLS + envío + respuesta completa. Por defecto 10 s. */
  timeoutMs?: number;
  /**
   * Tamaño máximo del cuerpo de la respuesta (por defecto 64 KB). Al superarlo se corta la conexión y la
   * respuesta se da por recibida con el cuerpo truncado (`truncated: true`): el destino ya contestó con
   * su código de estado, y rechazarla haría reintentar —y duplicar— una entrega que ya aceptó.
   */
  maxBytes?: number;
  /** Cancelación externa (p. ej. el watchdog del JobRunner): destruye la petición en curso. */
  signal?: AbortSignal;
}

export interface SafePostResult {
  status: number;
  body: string;
  /** El cuerpo superaba maxBytes: se cortó la conexión y solo se conserva el principio. */
  truncated?: boolean;
}

interface TransportOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  lookup?: net.LookupFunction;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 65_536;

/** lookup DNS que valida TODAS las direcciones resueltas en el momento de conectar (evita DNS rebinding). */
const guardedLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return (cb as any)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad || !list.length) return (cb as any)(new SsrfError('Destino privado no permitido'));
    if ((options as dns.LookupOptions).all) return (cb as any)(null, list);
    (cb as any)(null, list[0].address, list[0].family);
  });
};

/**
 * POST saliente protegido contra SSRF: solo HTTPS (HTTP solo en desarrollo), sin credenciales en
 * la URL, sin redirecciones y validando la IP resuelta EN EL MOMENTO DE CONECTAR (evita DNS rebinding).
 * Además impone un plazo total y un tamaño máximo de respuesta: un receptor malicioso no puede
 * dejar la promesa colgada (goteo de bytes, cuerpo parcial y cierre, cuerpo infinito).
 */
export async function safePost(rawUrl: string, body: string, headers: Record<string, string>, opts: SafePostOptions = {}): Promise<SafePostResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('URL inválida');
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) throw new SsrfError('Solo se permiten destinos HTTPS');
  if (url.username || url.password) throw new SsrfError('La URL no puede incluir credenciales');
  if (isPrivateHostname(url.hostname)) throw new SsrfError('Destino privado no permitido');
  return postWithDeadline(url, body, headers, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, signal: opts.signal, lookup: guardedLookup });
}

/**
 * Transporte HTTP(S) con plazo TOTAL. NO valida el destino: eso lo hace safePost, que es su único
 * llamador en producción. Garantiza que la promesa siempre se resuelve o rechaza:
 * - un temporizador (o la señal externa) destruye petición y respuesta al vencer el plazo;
 * - si la respuesta emite 'aborted', 'error' o 'close' sin 'end', se rechaza;
 * - en cuanto el cuerpo supera maxBytes (o lo anuncia Content-Length) se corta la conexión y se resuelve
 *   con el código de estado y el cuerpo truncado (el destino ya respondió; así no se duplica la entrega).
 */
function postWithDeadline(url: URL, body: string, headers: Record<string, string>, opts: TransportOptions): Promise<SafePostResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (signal?.aborted) return reject(new SafePostError('aborted', 'Envío cancelado'));
    let settled = false;
    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    const settle = (err: Error | null, value?: SafePostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        // Se destruyen ambos extremos: el socket no queda abierto aunque el destino siga enviando.
        // Los listeners de 'error' siguen registrados, así que los errores posteriores no tumban el proceso.
        res?.destroy();
        req?.destroy();
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const onAbort = () => settle(new SafePostError('aborted', 'Envío cancelado'));
    const incomplete = (cause?: unknown) => new SafePostError('incomplete', 'El destino cerró la conexión antes de completar la respuesta', { cause });
    // Respuesta demasiado grande: se conserva el código de estado y el principio del cuerpo, y se cortan
    // ambos extremos para no seguir recibiendo datos.
    const truncate = (response: http.IncomingMessage, chunks: Buffer[]) => {
      settle(null, { status: response.statusCode ?? 0, body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), truncated: true });
      response.destroy();
      req?.destroy();
    };
    const timer = setTimeout(() => settle(new SafePostError('timeout', `Tiempo de espera agotado (${timeoutMs} ms)`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      req = client.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString(), 'User-Agent': 'EVOLVE-CRM-Webhooks/1.0', ...headers },
          lookup: opts.lookup,
        },
        (response) => {
          res = response;
          response.on('aborted', () => settle(incomplete()));
          // Cualquier error del flujo de respuesta (p. ej. ECONNRESET a mitad de cuerpo) es una respuesta incompleta.
          response.on('error', (e) => settle(incomplete(e)));
          // 'close' llega siempre después de 'end' si la respuesta está completa (y entonces no hace nada).
          response.on('close', () => settle(incomplete()));
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) return truncate(response, []);
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => {
            if (settled) return;
            size += c.length;
            chunks.push(c);
            if (size > maxBytes) truncate(response, chunks);
          });
          response.on('end', () => settle(null, { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
    } catch (e) {
      return settle(e as Error);
    }
    req.on('error', (e) => settle(e));
    req.on('close', () => {
      if (!res) settle(new SafePostError('incomplete', 'La conexión se cerró sin recibir respuesta'));
    });
    req.end(body);
  });
}

/**
 * SOLO PARA TESTS: el transporte de safePost SIN la validación de destino, para probar el plazo total
 * y los límites contra un servidor local (127.0.0.1). No lo usa ninguna ruta ni manejador y no
 * funciona en producción.
 */
export const __test = {
  postWithDeadline(rawUrl: string, body: string, headers: Record<string, string> = {}, opts: TransportOptions = {}): Promise<SafePostResult> {
    if (process.env.NODE_ENV === 'production') throw new Error('__test.postWithDeadline no está disponible en producción');
    return postWithDeadline(new URL(rawUrl), body, headers, opts);
  },
  guardedLookup,
};
