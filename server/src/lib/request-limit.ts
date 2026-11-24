import { isIPv4, isIPv6 } from 'node:net';

/**
 * Clave de límite para una IP: las IPv4 tal cual y las IPv6 agrupadas por su prefijo /64 (un mismo
 * cliente suele disponer de un /64 entero y podría rotar direcciones para obtener claves infinitas).
 */
export function ipBucket(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (v.startsWith('::ffff:') && isIPv4(v.slice(7))) return v.slice(7);
  if (!isIPv6(v)) return v;
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * Contador de ventana fija en memoria (por instancia). Es independiente de @fastify/rate-limit a
 * propósito: ese plugin marca la petición como "ya limitada" tras su primer limitador y se saltaría los
 * límites estrictos de cada ruta si también aplicara el general.
 */
export class WindowCounter {
  private start = Date.now();
  private counts = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 200_000,
  ) {}

  /** Suma una petición y devuelve si está dentro del máximo y los segundos hasta que se reinicia la ventana. */
  hit(key: string, max: number, now = Date.now()): { allowed: boolean; retryAfter: number } {
    if (now - this.start >= this.windowMs) {
      this.start = now;
      this.counts = new Map();
    }
    // Defensa ante una avalancha de claves distintas: se reinicia en lugar de crecer sin límite.
    if (!this.counts.has(key) && this.counts.size >= this.maxKeys) this.counts = new Map();
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { allowed: n <= max, retryAfter: Math.max(1, Math.ceil((this.start + this.windowMs - now) / 1000)) };
  }
}
