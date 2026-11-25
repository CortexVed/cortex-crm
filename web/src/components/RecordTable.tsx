import { ArrowDown, ArrowUp } from 'lucide-react';
import { relativeTime } from '../lib/format';
import type { Module, RecordItem, RecordList } from '../lib/types';
import { recordTitle } from '../../../shared/records';
import { FieldValue } from './fields';
import { cx } from './ui';

export const SYSTEM_COLS: Record<string, string> = { created_at: 'Creado', updated_at: 'Actualizado', last_activity_at: 'Última actividad' };

export type TableSort = { field: string; dir: 'asc' | 'desc' };

function Cell({ mod, col, rec, refs }: { mod: Module; col: string; rec: RecordItem; refs: RecordList['refs'] }) {
  if (SYSTEM_COLS[col]) return <span className="text-zinc-500">{relativeTime((rec as any)[col === 'created_at' ? 'createdAt' : col === 'updated_at' ? 'updatedAt' : 'lastActivityAt'])}</span>;
  const f = mod.fields.find((x) => x.key === col);
  if (!f) return null;
  return <FieldValue field={f} value={rec.data[col]} refs={refs} compact />;
}

/** Columnas de una tabla: las indicadas (vista o bloque) o el campo principal y los cinco siguientes visibles. */
export function tableColumns(mod: Module, columns?: string[]): string[] {
  return (columns?.length ? columns : [mod.primaryField, ...mod.fields.filter((f) => !f.archived && !f.hidden && f.key !== mod.primaryField).slice(0, 5).map((f) => f.key)]).filter((c) => SYSTEM_COLS[c] || mod.fields.some((f) => f.key === c && !f.archived));
}

/**
 * Tabla de registros de un módulo (vista tabla de ModulePage y bloques "records" de las páginas). `bare` quita
 * el marco (para usarla dentro de una tarjeta) y `fit` la ajusta al ancho disponible en lugar de 720 px mínimos.
 */
export function RecordTable({ mod, columns, data, sort, setSort, onOpen, bare, fit }: { mod: Module; columns?: string[]; data: RecordList; sort: TableSort | null; setSort?: (s: TableSort) => void; onOpen: (r: RecordItem) => void; bare?: boolean; fit?: boolean }) {
  const cols = tableColumns(mod, columns);
  const label = (c: string) => SYSTEM_COLS[c] ?? mod.fields.find((f) => f.key === c)?.label ?? c;
  return (
    <div className={cx('overflow-x-auto', !bare && 'rounded-xl bg-white ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800')}>
      <table className={cx('w-full text-sm', fit ? 'min-w-full' : 'min-w-[720px]')}>
        <thead>
          <tr className="border-b border-zinc-100 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800">
            {cols.map((c) => {
              const active = sort?.field === c;
              return (
                <th key={c} className={cx('sticky top-0 bg-zinc-50/80 px-4 py-2.5 font-medium backdrop-blur dark:bg-zinc-900/80', !bare && 'first:rounded-tl-xl last:rounded-tr-xl')}>
                  {setSort ? (
                    <button className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => setSort({ field: c, dir: active && sort?.dir === 'asc' ? 'desc' : 'asc' })}>
                      {label(c)}
                      {active && (sort?.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : (
                    label(c)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.items.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpen(r)}
              // Con teclado: Tab llega a cada fila y Enter (o Espacio) la abre.
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onOpen(r);
                }
              }}
              className="cursor-pointer border-b border-zinc-50 transition last:border-0 hover:bg-zinc-50/80 focus-visible:bg-zinc-50/80 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40 dark:focus-visible:bg-zinc-800/40"
            >
              {cols.map((c) => (
                <td key={c} className={cx('max-w-[280px] truncate px-4 py-2.5', c === mod.primaryField && 'font-medium text-zinc-900 dark:text-zinc-100')}>
                  {c === mod.primaryField ? recordTitle(mod, r.data) : <Cell mod={mod} col={c} rec={r} refs={data.refs} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
