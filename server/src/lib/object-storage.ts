import crypto from 'node:crypto';

/**
 * Almacenamiento de objetos compatible con S3 para los archivos adjuntos: los buckets de Railway (y Tigris, R2,
 * MinIO, AWS S3…). Sin dependencias: firma AWS Signature Version 4 con node:crypto y envía con fetch.
 *
 * El bucket es privado: los archivos se descargan siempre a través de la aplicación, que comprueba los permisos;
 * nunca se generan URL públicas ni firmadas. Las claves de objeto las genera el servidor (`files/<org>/<archivo>`),
 * sin ninguna parte escrita por el usuario.
 */

export interface ObjectStorageConfig {
  /** Origen del servicio, p. ej. https://t3.storageapi.dev (sin el nombre del bucket). */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Región de la firma. Los buckets de Railway usan «auto». */
  region: string;
  /** true = https://endpoint/bucket/clave; false = https://bucket.endpoint/clave (el estilo de Railway). */
  pathStyle: boolean;
}

export interface ObjectStorage {
  readonly bucket: string;
  /** `sha256Hex` del contenido (ya se calcula para la tabla files): firma el cuerpo sin volver a leerlo. */
  put(key: string, body: Buffer, contentType: string, sha256Hex: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Borrar un objeto que ya no existe no es un error. */
  delete(key: string): Promise<void>;
}

export class ObjectStorageError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TIMEOUT_MS = 60_000;

const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** Codificación de SigV4 (RFC 3986): todo salvo A-Z a-z 0-9 - _ . ~ y, en las rutas, «/». */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export interface SignV4Input {
  method: string;
  url: URL;
  /** Cabeceras adicionales a firmar (además de host, x-amz-date y x-amz-content-sha256). */
  headers?: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  date: Date;
}

/**
 * AWS Signature Version 4 con cabecera Authorization. Devuelve todas las cabeceras firmadas (con `host` en
 * minúsculas, que fetch envía por su cuenta a partir de la URL: quien llama la quita antes de enviar).
 */
export function signV4(input: SignV4Input): Record<string, string> {
  const service = input.service ?? 's3';
  const amzDate = input.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = input.url.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = input.payloadHash;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // La ruta ya va codificada (la construye objectUrl con uriEncode); se usa tal cual, sin codificar dos veces.
  const canonicalRequest = [input.method, input.url.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/** URL del objeto según el estilo del servicio. */
export function objectUrl(cfg: Pick<ObjectStorageConfig, 'endpoint' | 'bucket' | 'pathStyle'>, key: string): URL {
  const base = new URL(cfg.endpoint);
  const path = uriEncode(key, true);
  if (cfg.pathStyle) return new URL(`${base.protocol}//${base.host}/${uriEncode(cfg.bucket, false)}/${path}`);
  return new URL(`${base.protocol}//${cfg.bucket}.${base.host}/${path}`);
}

/** Código y mensaje de un error XML de S3 (<Code>…</Code><Message>…</Message>), sin exponer nada más. */
function s3Error(status: number, text: string): ObjectStorageError {
  const code = /<Code>([^<]{1,100})<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]{1,300})<\/Message>/.exec(text)?.[1];
  return new ObjectStorageError(`El almacenamiento de archivos respondió ${status}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`, status, code);
}

export function createObjectStorage(cfg: ObjectStorageConfig, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): ObjectStorage {
  async function send(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, extra: Record<string, string> = {}, payloadHash = EMPTY_SHA256): Promise<Response> {
    const url = objectUrl(cfg, key);
    const signed = signV4({ method, url, headers: extra, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, date: now() });
    delete signed.host;
    try {
      return await fetchImpl(url, { method, headers: signed, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    } catch (e) {
      const reason = e instanceof Error && e.name === 'TimeoutError' ? 'no respondió a tiempo' : 'no está accesible';
      throw new ObjectStorageError(`El almacenamiento de archivos ${reason}`);
    }
  }

  return {
    bucket: cfg.bucket,
    async put(key, body, contentType, digest) {
      // content-length lo calcula y lo envía fetch (cabecera prohibida para quien llama): no se firma.
      const res = await send('PUT', key, body, { 'content-type': contentType }, digest);
      if (!res.ok) throw s3Error(res.status, await res.text().catch(() => ''));
      await res.arrayBuffer().catch(() => undefined);
    },
    async get(key) {
      const res = await send('GET', key);
      if (!res.ok) throw s3Error(res.status, await res.text().catch(() => ''));
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await send('DELETE', key);
      if (!res.ok && res.status !== 404) throw s3Error(res.status, await res.text().catch(() => ''));
      await res.arrayBuffer().catch(() => undefined);
    },
  };
}

/** Clave del objeto de un archivo: generada por el servidor, sin datos del usuario. */
export const fileObjectKey = (workspaceId: string, fileId: string) => `files/${workspaceId}/${fileId}`;
