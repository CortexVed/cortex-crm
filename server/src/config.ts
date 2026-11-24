import crypto from 'node:crypto';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const EnvSchema = z.object({
  // Sin valor: 'production' en Railway (RAILWAY_ENVIRONMENT_ID) y 'development' fuera de él. Así un despliegue
  // nunca arranca en modo desarrollo por una variable vacía (las plantillas generadas vacían los literales).
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PROCESS_ROLE: z.enum(['web', 'worker', 'all']).optional(),
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
  // Railway la define automáticamente en todos los servicios (se usa solo para detectar la plataforma).
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),
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

function roleFromArgv(argv: readonly string[]): 'web' | 'worker' | 'all' | undefined {
  const arg = argv.find((a) => a.startsWith('--role='));
  if (!arg) return undefined;
  const role = arg.slice('--role='.length);
  if (role === 'web' || role === 'worker' || role === 'all') return role;
  throw new Error(`Configuración inválida: --role=${role.slice(0, 20)} (usa web, worker o all)`);
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

  if (isProd) {
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

  return {
    env: nodeEnv,
    isProd,
    isTest,
    // PROCESS_ROLE o el argumento --role= del comando de arranque (la plantilla de Railway arranca el worker
    // con `… dist/server/index.js --role=worker`: es un ajuste del servicio, no una variable).
    role: e.PROCESS_ROLE ?? roleFromArgv(argv) ?? (isProd ? 'web' : 'all'),
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
    llmEnableMock: e.LLM_ENABLE_MOCK && !isProd,
    platformAdminSetupToken: e.PLATFORM_ADMIN_SETUP_TOKEN?.trim() || null,
    /** Cabecera de la IP real del cliente (null = solo el salto inmediato). */
    clientIpHeader: ipHeader === 'none' ? null : (ipHeader ?? (e.RAILWAY_ENVIRONMENT_ID ? 'x-real-ip' : null)),
  };
}
