import { useState } from 'react';
import { CHART_SEQUENCE, HEX } from '../lib/colors';
import { formatValue } from '../lib/format';
import type { SeriesPoint } from '../lib/types';
import type { Color } from '../../../shared/constants';
import { cx } from './ui';

type Fmt = 'currency' | 'number' | 'percent';
/** Color de la serie principal: el de la marca de la organización (variable CSS, ver lib/theme.ts). */
const BRAND = 'var(--color-brand-500)';
const colorOf = (p: SeriesPoint, i: number) => (p.color ? HEX[p.color as Color] ?? CHART_SEQUENCE[i % CHART_SEQUENCE.length] : CHART_SEQUENCE[i % CHART_SEQUENCE.length]);

function Tooltip({ point, format, currency }: { point: SeriesPoint | null; format: Fmt; currency?: string }) {
  if (!point) return <div className="h-5" />;
  return (
    <div className="h-5 truncate text-xs text-zinc-500">
      <span className="font-medium text-zinc-800 dark:text-zinc-200">{point.label}</span> · {formatValue(point.value, format, currency)}
    </div>
  );
}

export function BarChart({ points, format = 'number', currency, height = 180 }: { points: SeriesPoint[]; format?: Fmt; currency?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <div className="flex h-40 items-center justify-center text-sm text-zinc-400">Sin datos todavía</div>;
  const max = Math.max(...points.map((p) => p.value), 1);
  const allZero = points.every((p) => p.value === 0);
  return (
    <div>
      <Tooltip point={hover !== null ? points[hover] : null} format={format} currency={currency} />
      <div className="relative flex items-end gap-1.5" style={{ height }} onMouseLeave={() => setHover(null)}>
        {allZero && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-400">Sin valores en este periodo</div>}
        {points.map((p, i) => (
          <div key={p.key + i} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end" onMouseEnter={() => setHover(i)}>
            {/* Los valores cero se dibujan como una marca neutra (no con el color de la serie). */}
            <div
              className={cx('w-full max-w-12 rounded-t-md transition-all duration-500', p.value === 0 && 'bg-zinc-200 dark:bg-zinc-700')}
              style={{ height: `${Math.max(2, (p.value / max) * 100)}%`, background: p.value === 0 ? undefined : colorOf(p, i), opacity: hover === null || hover === i ? 1 : 0.45 }}
              title={`${p.label}: ${formatValue(p.value, format, currency)}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {points.map((p, i) => (
          <div key={p.key + i} className="min-w-0 flex-1 truncate text-center text-[10px] text-zinc-500">
            {p.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function LineChart({ points, format = 'number', currency, height = 170 }: { points: SeriesPoint[]; format?: Fmt; currency?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <div className="flex h-40 items-center justify-center text-sm text-zinc-400">Sin datos todavía</div>;
  const W = 600;
  const H = 200;
  const pad = 8;
  const max = Math.max(...points.map((p) => p.value), 1);
  const x = (i: number) => pad + (i * (W - pad * 2)) / Math.max(points.length - 1, 1);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${H - pad} L${x(0)},${H - pad} Z`;
  return (
    <div>
      <Tooltip point={hover !== null ? points[hover] : null} format={format} currency={currency} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="evolve-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: BRAND, stopOpacity: 0.28 }} />
            <stop offset="1" style={{ stopColor: BRAND, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#evolve-area)" />
        <path d={line} fill="none" style={{ stroke: BRAND }} strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={p.key + i}>
            <rect x={x(i) - (W / points.length) / 2} y={0} width={W / points.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
            {hover === i && <circle cx={x(i)} cy={y(p.value)} r="5" style={{ fill: BRAND }} stroke="white" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          </g>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
        <span>{points[0]?.label}</span>
        <span>{points[Math.floor(points.length / 2)]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

export function DonutChart({ points, format = 'number', currency }: { points: SeriesPoint[]; format?: Fmt; currency?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = points.reduce((a, b) => a + b.value, 0);
  if (!total) return <div className="flex h-40 items-center justify-center text-sm text-zinc-400">Sin datos todavía</div>;
  const R = 42;
  const C = 2 * Math.PI * R;
  let acc = 0;
  // La leyenda va al lado solo si el propio contenedor es ancho (consulta de contenedor): en tarjetas estrechas
  // (p. ej. un bloque de un tercio en una página) va debajo y no se corta.
  return (
    <div className="@container">
      <div className="flex flex-col items-center gap-4 @xs:flex-row">
        <svg viewBox="0 0 120 120" className="size-36 shrink-0 -rotate-90" onMouseLeave={() => setHover(null)}>
          <circle cx="60" cy="60" r={R} fill="none" strokeWidth="16" className="stroke-zinc-100 dark:stroke-zinc-800" />
          {points.map((p, i) => {
            const len = (p.value / total) * C;
            const el = (
              <circle key={p.key + i} cx="60" cy="60" r={R} fill="none" style={{ stroke: colorOf(p, i) }} strokeWidth={hover === i ? 19 : 16} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} onMouseEnter={() => setHover(i)} className="transition-all">
                <title>{`${p.label}: ${formatValue(p.value, format, currency)}`}</title>
              </circle>
            );
            acc += len;
            return el;
          })}
        </svg>
        <ul className="w-full min-w-0 space-y-1.5 text-sm">
          {points.map((p, i) => (
            <li key={p.key + i} className="flex items-center gap-2" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(p, i) }} />
              <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">{p.label}</span>
              <span className="font-medium tabular-nums">{formatValue(p.value, format, currency, true)}</span>
              <span className="w-10 text-right text-xs text-zinc-400 tabular-nums">{Math.round((p.value / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function FunnelChart({ points, format = 'number', currency }: { points: SeriesPoint[]; format?: Fmt; currency?: string }) {
  const max = Math.max(...points.map((p) => p.value), 1);
  if (!points.length) return <div className="flex h-40 items-center justify-center text-sm text-zinc-400">Sin datos todavía</div>;
  return (
    <div className="space-y-2">
      {points.map((p, i) => (
        <div key={p.key + i} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 truncate text-zinc-600 dark:text-zinc-400">{p.label}</span>
          <div className="h-6 flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded-md transition-all duration-700" style={{ width: `${Math.max(1.5, (p.value / max) * 100)}%`, background: colorOf(p, i) }} />
          </div>
          <span className="w-16 shrink-0 text-right font-medium tabular-nums">{formatValue(p.value, format, currency, true)}</span>
        </div>
      ))}
    </div>
  );
}
