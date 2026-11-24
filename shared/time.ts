// Utilidades de fecha con zona horaria (sin dependencias).

export const DEFAULT_TZ = 'Europe/Madrid';

/** Fecha local 'YYYY-MM-DD' en la zona horaria indicada. */
export function localDate(d: Date, tz: string = DEFAULT_TZ): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
}

export function isIsoDateTime(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

/** Días completos entre dos fechas 'YYYY-MM-DD' (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10) + 'T00:00:00Z') - Date.parse(a.slice(0, 10) + 'T00:00:00Z')) / 86_400_000);
}

export function startOfMonth(d: Date, tz: string = DEFAULT_TZ): string {
  return localDate(d, tz).slice(0, 8) + '01';
}

export function startOfWeek(d: Date, tz: string = DEFAULT_TZ): string {
  const iso = localDate(d, tz);
  const day = new Date(iso + 'T00:00:00Z').getUTCDay(); // 0 domingo
  const diff = day === 0 ? 6 : day - 1;
  return localDate(addDays(new Date(iso + 'T12:00:00Z'), -diff), 'UTC');
}

export function startOfYear(d: Date, tz: string = DEFAULT_TZ): string {
  return localDate(d, tz).slice(0, 4) + '-01-01';
}
