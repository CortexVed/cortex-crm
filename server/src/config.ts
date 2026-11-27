import crypto from 'node:crypto';
import { z } from 'zod';
import type { ObjectStorageConfig } from './lib/object-storage';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const EnvSchema = z.object({
  // Sin valor: 'production' en Railway (RAILWAY_ENVIRONMENT_ID) y 'development' fuera de él. Así un despliegue
  // nunca arranca en modo desarrollo por una variable vacía (las plantillas generadas vacían los literales).
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  // 'ci' = servicio de CI del motor de código fuente: solo un health check, sin base de datos ni secretos.
  PROCESS_ROLE: z.enum(['web', 'worker', 'all', 'ci']).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(15),
  APP_URL: z.string().url().optional(),
  // Railway la define en los servicios con dominio público: sirve de APP_URL si no se indica otra.
  RAILWAY_PUBLIC_DOMAIN: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/).optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  // Token de instalación: permite que la primera persona que lo conozca (quien tiene acceso a las variables
  // del despliegue) se convierta en administradora de la plataforma desde la web, solo mientras no haya ninguna.
  PLATFORM_ADMIN_SETUP_TOKEN: z.string().min(32, 'PLATFORM_ADMIN_SETUP_TOKEN debe tener al menos 32 caracteres').max(256).optional(),
  ALLOW_SIGNUP: bool(true),
  // Correo transaccional (recuperación de contraseña, verificación, invitaciones)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // Claves LLM de plataforma (opcionales; cada organización puede usar las suyas)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  ALLOW_PLATFORM_LLM_KEYS: bool(false),
  // Límites
  AI_MAX_REQUESTS_PER_HOUR: z.coerce.number().int().positive().default(60),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),
  // Cabecera con la IP real del cliente que fija el proxy de entrada. Railway la SOBRESCRIBE en cada
  // petición pública (X-Real-IP), por eso es la que se usa por defecto al correr en Railway; 'none' la
  // desactiva y entonces solo se confía en el salto inmediato.
  CLIENT_IP_HEADER: z.string().regex(/^[A-Za-z0-9-]{1,60}$/).optional(),
  // Railway la define automáticamente en todos los servicios (detecta la plataforma y, en el motor de código
  // fuente, el entorno al que se despliega).
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),
  // Motor de código fuente (docs/CODE_ENGINE.md). Railway define RAILWAY_PROJECT_ID y RAILWAY_SERVICE_ID en
  // cada servicio; la plantilla pasa al worker, por referencia, el id del servicio web (CORTEX_SERVICE_ID =
  // ${{Cortex.RAILWAY_SERVICE_ID}}) y el del servicio de CI (CI_SERVICE_ID = ${{CI.RAILWAY_SERVICE_ID}}).
  // Se validan al usarlos (no aquí): un valor raro nunca impide arrancar la aplicación.
  RAILWAY_PROJECT_ID: z.string().max(100).optional(),
  RAILWAY_SERVICE_ID: z.string().max(100).optional(),
  CORTEX_SERVICE_ID: z.string().max(100).optional(),
  CI_SERVICE_ID: z.string().max(100).optional(),
  // Archivos adjuntos en un bucket compatible con S3 (el bucket de la plantilla de Railway las rellena por
  // referencia: ${{Bucket.ENDPOINT}}, ${{Bucket.BUCKET}}…). Sin ellas, los archivos se guardan en PostgreSQL.
  S3_ENDPOINT: z.string().max(500).optional(),
  S3_BUCKET: z.string().max(255).optional(),
  S3_ACCESS_KEY_ID: z.string().max(512).optional(),
  S3_SECRET_ACCESS_KEY: z.string().max(512).optional(),
  S3_REGION: z.string().max(64).optional(),
  S3_FORCE_PATH_STYLE: bool(false),
  // Los mismos datos con los nombres estándar de AWS (los que imprime `railway bucket credentials`). Solo se usan
  // si está el nombre del bucket: unas credenciales de AWS para otra cosa no activan ni rompen nada.
  AWS_ENDPOINT_URL: z.string().max(500).optional(),
  AWS_S3_BUCKET_NAME: z.string().max(255).optional(),
  AWS_ACCESS_KEY_ID: z.string().max(512).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().max(512).optional(),
  AWS_DEFAULT_REGION: z.string().max(64).optional(),
  // Solo tests / desarrollo
  LLM_ENABLE_MOCK: bool(false),
});

export type AppConfig = ReturnType<typeof loadConfig>;

/**
 * Clave maestra de cifrado (32 bytes). Admite dos formatos:
 *   - 32 bytes en base64 (el formato de siempre: `node -e "…randomBytes(32).toString('base64')"`);
 *   - cualquier secreto aleatorio de 32 caracteres o más (p. ej. el `${{secret(64)}}` de una plantilla de
 *     Railway), del que se deriva la clave con SHA-256 y separación de dominio.
 * Una clave que ya funcionaba sigue dando exactamente los mismos bytes.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  // Mismo criterio que antes para las claves en base64 (estándar o URL): si decodifica a 32 bytes, se usa tal cual.
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  }
  if (value.length < 32) throw new Error('APP_ENCRYPTION_KEY debe ser 32 bytes en base64 o un secreto aleatorio de al menos 32 caracteres');
  if (new Set(value).size < 10) throw new Error('APP_ENCRYPTION_KEY no parece aleatoria: genera una nueva');
  return crypto.createHash('sha256').update(`cortex-crm:app-encryption-key:v1:${value}`, 'utf8').digest();
}

/**
 * Bucket de archivos: todo o nada. Con alguna variable S3_* (o el nombre del bucket con los nombres de AWS) tienen
 * que estar las cuatro (endpoint, bucket, clave y secreto); si falta alguna, la aplicación no arranca y lo dice,
 * en lugar de guardar en silencio los archivos en otro sitio.
 */
function objectStorageConfig(e: z.infer<typeof EnvSchema>, isProd: boolean): ObjectStorageConfig | null {
  const s3 = [e.S3_ENDPOINT, e.S3_BUCKET, e.S3_ACCESS_KEY_ID, e.S3_SECRET_ACCESS_KEY];
  const group = s3.some(Boolean)
    ? { names: 'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY', endpoint: e.S3_ENDPOINT, bucket: e.S3_BUCKET, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, region: e.S3_REGION }
    : e.AWS_S3_BUCKET_NAME
      ? { names: 'AWS_ENDPOINT_URL, AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY', endpoint: e.AWS_ENDPOINT_URL, bucket: e.AWS_S3_BUCKET_NAME, accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY, region: e.AWS_DEFAULT_REGION }
      : null;
  if (!group) return null;
  if (!group.endpoint || !group.bucket || !group.accessKeyId || !group.secretAccessKey) {
    throw new Error(`Configuración inválida: el almacenamiento de archivos en un bucket necesita ${group.names} (o ninguna, para guardarlos en PostgreSQL)`);
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(group.endpoint) ? group.endpoint : `https://${group.endpoint}`);
  } catch {
    throw new Error('Configuración inválida: el endpoint del bucket no es una URL válida');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !isProd)) throw new Error('Configuración inválida: el endpoint del bucket debe usar https');
  if (url.username || url.password || url.search || url.hash) throw new Error('Configuración inválida: el endpoint del bucket no puede llevar credenciales, consulta ni fragmento');
  const bucket = group.bucket.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Configuración inválida: nombre de bucket no válido (3-63 caracteres: minúsculas, números, puntos y guiones)');
  return {
    endpoint: `${url.protocol}//${url.host}`,
    bucket,
    accessKeyId: group.accessKeyId.trim(),
    secretAccessKey: group.secretAccessKey.trim(),
    region: (group.region ?? '').trim() || 'auto',
    pathStyle: e.S3_FORCE_PATH_STYLE,
  };
}

function roleFromArgv(argv: readonly string[]): 'web' | 'worker' | 'all' | 'ci' | undefined {
  const arg = argv.find((a) => a.startsWith('--role='));
  if (!arg) return undefined;
  const role = arg.slice('--role='.length);
  if (role === 'web' || role === 'worker' || role === 'all' || role === 'ci') return role;
  throw new Error(`Configuración inválida: --role=${role.slice(0, 20)} (usa web, worker, all o ci)`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Record<string, string> = {}, argv: readonly string[] = process.argv) {
  // Variables vacías (p. ej. "RESEND_API_KEY=" copiado de .env.example) cuentan como no definidas.
  const raw = Object.fromEntries(Object.entries({ ...env, ...overrides }).map(([k, v]) => [k, v === '' ? undefined : v]));
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${issues}`);
  }
  const e = parsed.data;
  const nodeEnv = e.NODE_ENV ?? (e.RAILWAY_ENVIRONMENT_ID ? 'production' : 'development');
  const isProd = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  // URL pública: APP_URL o, en Railway, el dominio público del propio servicio.
  const appUrl = (e.APP_URL ?? (e.RAILWAY_PUBLIC_DOMAIN ? `https://${e.RAILWAY_PUBLIC_DOMAIN}` : undefined))?.replace(/\/$/, '');
  // PROCESS_ROLE o el argumento --role= del comando de arranque (la plantilla de Railway arranca el worker
  // con `… dist/server/index.js --role=worker`: es un ajuste del servicio, no una variable).
  const role = e.PROCESS_ROLE ?? roleFromArgv(argv) ?? (isProd ? 'web' : 'all');

  // El rol 'ci' (servicio de CI del motor de código) no tiene variables ni secretos a propósito: no abre la
  // base de datos ni descifra nada, así que no se le exigen.
  if (isProd && role !== 'ci') {
    const missing: string[] = [];
    if (!e.DATABASE_URL) missing.push('DATABASE_URL');
    if (!e.APP_ENCRYPTION_KEY) missing.push('APP_ENCRYPTION_KEY');
    // Los enlaces de correo nunca se construyen con cabeceras de la petición en producción.
    if (!appUrl) missing.push('APP_URL');
    if (missing.length) throw new Error(`Faltan variables obligatorias en producción: ${missing.join(', ')}`);
    if (e.LLM_ENABLE_MOCK) throw new Error('LLM_ENABLE_MOCK no está permitido en producción');
  }

  // En desarrollo/test sin clave se usa una clave efímera determinista (nunca en producción).
  const encryptionKey = e.APP_ENCRYPTION_KEY ? parseEncryptionKey(e.APP_ENCRYPTION_KEY) : Buffer.alloc(32, 7);

  const ipHeader = e.CLIENT_IP_HEADER?.toLowerCase();
  const objectStorage = objectStorageConfig(e, isProd);

  return {
    env: nodeEnv,
    isProd,
    isTest,
    role,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    dbPoolMax: e.DB_POOL_MAX,
    appUrl,
    encryptionKey,
    allowSignup: e.ALLOW_SIGNUP,
    email: e.RESEND_API_KEY && e.EMAIL_FROM ? { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM } : null,
    platformLlmKeys: {
      anthropic: e.ANTHROPIC_API_KEY,
      openai: e.OPENAI_API_KEY,
      deepseek: e.DEEPSEEK_API_KEY,
      openrouter: e.OPENROUTER_API_KEY,
      gemini: e.GEMINI_API_KEY,
      mistral: e.MISTRAL_API_KEY,
      groq: e.GROQ_API_KEY,
    } as Record<string, string | undefined>,
    allowPlatformLlmKeys: e.ALLOW_PLATFORM_LLM_KEYS,
    aiMaxRequestsPerHour: e.AI_MAX_REQUESTS_PER_HOUR,
    maxUploadBytes: Math.round(e.MAX_UPLOAD_MB * 1024 * 1024),
    /** Bucket compatible con S3 para los archivos adjuntos (null = se guardan en PostgreSQL). */
    objectStorage,
    llmEnableMock: e.LLM_ENABLE_MOCK && !isProd,
    platformAdminSetupToken: e.PLATFORM_ADMIN_SETUP_TOKEN?.trim() || null,
    /** Cabecera de la IP real del cliente (null = solo el salto inmediato). */
    clientIpHeader: ipHeader === 'none' ? null : (ipHeader ?? (e.RAILWAY_ENVIRONMENT_ID ? 'x-real-ip' : null)),
    /**
     * Identificadores de Railway que usa el motor de código fuente. `serviceId` es el del propio proceso;
     * en el worker, `webServiceId` y `ciServiceId` llegan por referencia desde la plantilla.
     */
    railway: {
      projectId: e.RAILWAY_PROJECT_ID ?? null,
      environmentId: e.RAILWAY_ENVIRONMENT_ID ?? null,
      serviceId: e.RAILWAY_SERVICE_ID ?? null,
      webServiceId: e.CORTEX_SERVICE_ID ?? null,
      ciServiceId: e.CI_SERVICE_ID ?? null,
    },
  };
}
