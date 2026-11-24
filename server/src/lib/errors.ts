export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Necesitas iniciar sesión') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'No tienes permisos para esta acción') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'No encontrado') => new AppError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, 'validation_failed', message, details);
export const tooMany = (message = 'Demasiadas peticiones, inténtalo más tarde') => new AppError(429, 'rate_limited', message);
export const unavailable = (message: string, details?: unknown) => new AppError(503, 'unavailable', message, details);

const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|ciphertext|credential/i;

/** Elimina valores sensibles de objetos antes de registrarlos (logs, auditoría, errores). */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redactado]' : redact(v, depth + 1);
  }
  return out as T;
}
