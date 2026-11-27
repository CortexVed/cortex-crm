import { Link } from 'react-router';
import { formatValue } from '../lib/format';
import { t } from '../lib/i18n';
import type { Widget, WidgetData } from '../lib/types';
import { Skeleton } from './ui';
import { BarChart, DonutChart, LineChart } from './charts';

/** Representación de un widget calculado por el servidor (paneles y consultas en lenguaje natural). */
export function WidgetBody({ w, data }: { w: Widget; data: WidgetData | undefined }) {
  void w;
  if (!data) return <Skeleton className="h-24" />;
  if (data.type === 'error') return <p className="text-sm text-red-600 dark:text-red-400">{data.message}</p>;
  if (data.type === 'metric') return <div className="text-3xl font-semibold tracking-tight tabular-nums">{formatValue(data.value, data.format, data.currency)}</div>;
  if (data.type !== 'list') {
    if (data.type === 'bar') return <BarChart points={data.points} format={data.format} currency={data.currency} />;
    if (data.type === 'donut') return <DonutChart points={data.points} format={data.format} currency={data.currency} />;
    return <LineChart points={data.points} format={data.format} currency={data.currency} />;
  }
  if (!data.items.length) return <p className="py-6 text-center text-sm text-zinc-500">{t('Nada por aquí')}</p>;
  return (
    <ul className="-mx-1 divide-y divide-zinc-100 dark:divide-zinc-800">
      {data.items.map((it) => (
        <li key={it.id}>
          <Link to={`/m/${data.module}/${it.id}`} className="flex items-center gap-2 rounded-md px-1 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
            <span className="min-w-0 flex-1 truncate">{it.title}</span>
            {it.subtitle && <span className="text-xs text-zinc-500">{it.subtitle}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
