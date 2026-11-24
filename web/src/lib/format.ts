const nf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });

export function formatNumber(n: number | null | undefined, opts: Intl.NumberFormatOptions = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Object.keys(opts).length ? new Intl.NumberFormat('es-ES', opts).format(n) : nf.format(n);
}

export function formatCurrency(n: number | null | undefined, currency = 'EUR', compact = false): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: compact || Math.abs(n) >= 1000 ? 0 : 2, notation: compact && Math.abs(n) >= 100_000 ? 'compact' : 'standard' }).format(n);
}

export function formatPercent(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${nf.format(n)} %`;
}

export function formatValue(n: number, format: 'currency' | 'number' | 'percent', currency?: string, compact = false) {
  if (format === 'currency') return formatCurrency(n, currency ?? 'EUR', compact);
  if (format === 'percent') return formatPercent(n);
  return formatNumber(n, compact && Math.abs(n) >= 10_000 ? { notation: 'compact' } : {});
}

export function formatDate(v: string | null | undefined, withTime = false): string {
  if (!v) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString('es-ES', withTime ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' });
}

export function relativeTime(v: string | null | undefined): string {
  if (!v) return '—';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return 'ahora mismo';
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(-Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(-Math.round(diff / (86400 * 365)), 'year');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Convierte un datetime ISO a valor de <input type="datetime-local"> en hora local. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
