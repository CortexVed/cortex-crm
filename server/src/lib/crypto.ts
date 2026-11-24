import crypto from 'node:crypto';
import { AppError } from './errors';

type ScryptOpts = { N: number; r: number; p: number; maxmem: number };

// Concurrencia acotada: scrypt usa ~32 MB y un hilo del pool de libuv por operación; sin límite,
// una ráfaga de logins podría agotar memoria y bloquear el servidor.
const MAX_CONCURRENT = 4;
const MAX_QUEUE = 200;
let active = 0;
const queue: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUE) throw new AppError(503, 'busy', 'Servidor ocupado, inténtalo en unos segundos');
    // El hueco se hereda directamente de quien termina (nunca se supera MAX_CONCURRENT).
    await new Promise<void>((resolve) => queue.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOpts): Promise<Buffer> {
  return withSlot(
    () =>
      new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
      }),
  );
}

// Coste reducido solo en tests para que la suite sea rápida.
const SCRYPT_N = process.env.NODE_ENV === 'test' ? 2 ** 12 : 2 ** 15;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const opts = { N: SCRYPT_N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
  const key = await scryptAsync(password.normalize('NFKC'), salt, 64, opts);
  return ['scrypt', opts.N, opts.r, opts.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const derived = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// Hash ficticio para igualar tiempos cuando el usuario no existe (evita enumeración por tiempo).
let dummyHash: string | null = null;
export async function burnPasswordCheck(password: string) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function hmacHex(key: Buffer | string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

export function maskSecret(secret: string): string {
  const tail = secret.slice(-4);
  return `••••${tail}`;
}

/**
 * Cifrado autenticado AES-256-GCM para secretos en reposo (API keys de proveedores IA,
 * credenciales de conectores). El AAD vincula el texto cifrado a su contexto
 * (organización + tipo), así un valor cifrado no puede trasladarse a otra organización.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes');
  }

  encrypt(plain: string, aad: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
  }

  decrypt(token: string, aad: string): string {
    const [v, ivB64, tagB64, ctB64] = token.split('.');
    if (v !== 'v1' || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Formato de secreto inválido');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Secreto derivado (p. ej. firma HMAC de webhooks salientes) sin necesidad de almacenarlo. */
  derive(purpose: string): string {
    return crypto.createHmac('sha256', this.key).update(purpose).digest('base64url');
  }
}

export function newId(): string {
  return crypto.randomUUID();
}
