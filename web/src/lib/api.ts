export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** Errores de validación por campo devueltos por el servidor. */
  get fieldErrors(): Record<string, string> {
    // Dos formatos: errores de registro { fields: [{field, message}] } y de esquema [{path, message}].
    if (Array.isArray(this.details)) {
      return Object.fromEntries((this.details as { path?: string; message: string }[]).map((d) => [String(d.path ?? '').replace(/^values\./, ''), d.message]));
    }
    const d = this.details as { fields?: { field: string; message: string }[] } | undefined;
    return Object.fromEntries((d?.fields ?? []).map((f) => [f.field, f.message]));
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T = any>(path: string, opts: { method?: Method; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const isBinary = opts.body instanceof Blob || opts.body instanceof ArrayBuffer;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !isBinary) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: opts.body === undefined ? undefined : isBinary ? (opts.body as BodyInit) : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'network', 'No se pudo conectar con el servidor. Revisa tu conexión.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Error ${res.status}`, data?.error?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const patch = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: body ?? {} });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export async function uploadFile(file: File, opts: { recordId?: string; fieldKey?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) };
  if (opts.recordId) headers['X-Record-Id'] = opts.recordId;
  if (opts.fieldKey) headers['X-Field-Key'] = opts.fieldKey;
  return api<{ id: string; name: string; mime: string; size: number }>('/files', { method: 'POST', body: file, headers });
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return (e as Error)?.message ?? 'Error inesperado';
}

// Registro de errores del cliente (limitado en el servidor).
let reported = 0;
export function reportClientError(message: string, stack?: string) {
  if (reported++ > 5) return;
  void fetch('/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: message.slice(0, 2000), stack: stack?.slice(0, 8000), url: location.pathname }) }).catch(() => {});
}
