import type { AppConfig } from './config';
import type { Db } from './db/db';
import type { SecretBox } from './lib/crypto';
import type { Mailer } from './lib/mailer';
import type { AiManager } from './ai/manager';
import type { ObjectStorage } from './lib/object-storage';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  box: SecretBox;
  ai: AiManager;
  mailer: Mailer;
  fetchImpl: typeof fetch;
  now: () => Date;
  /** Bucket compatible con S3 para los archivos adjuntos (null = se guardan en PostgreSQL). */
  storage: ObjectStorage | null;
}

export function appBaseUrl(deps: AppDeps, req: { protocol: string; headers: Record<string, unknown> }): string {
  if (deps.config.appUrl) return deps.config.appUrl;
  // Solo fuera de producción (en producción APP_URL es obligatoria): evita envenenar enlaces con X-Forwarded-Host.
  const host = (req.headers.host as string) ?? 'localhost';
  return `${req.protocol}://${host}`;
}
