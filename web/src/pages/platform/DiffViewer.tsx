import { useMemo, useState } from 'react';
import { FileMinus2, FilePen, FilePlus2 } from 'lucide-react';
import { Badge, Card, cx } from '../../components/ui';
import { msg, t, tk, tp } from '../../lib/i18n';
import type { FileEntry } from './codeTypes';
import { collapse, countChanges, lineDiff } from './diff';

const ACTION = {
  add: { label: msg('nuevo'), color: 'emerald', icon: FilePlus2 },
  modify: { label: msg('modificado'), color: 'amber', icon: FilePen },
  delete: { label: msg('borrado'), color: 'red', icon: FileMinus2 },
} as const;

function FileDiff({ file }: { file: FileEntry }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const { lines, approximate } = useMemo(() => lineDiff(file.before, file.after), [file.before, file.after]);
  const rows = useMemo(() => collapse(lines, 3, expanded), [lines, expanded]);
  if (!lines.length) return <p className="p-4 text-sm text-zinc-500">{t('Archivo vacío.')}</p>;
  return (
    <div className="overflow-x-auto scrollbar-thin">
      {approximate && <p className="border-b border-zinc-100 px-3 py-1.5 text-xs text-amber-700 dark:border-zinc-800 dark:text-amber-300">{t('Cambio muy grande: se muestra el contenido anterior completo y después el nuevo.')}</p>}
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.45]">
        <tbody>
          {rows.map((r, i) =>
            r.type === 'gap' ? (
              <tr key={`g${r.from}`}>
                <td colSpan={3} className="bg-zinc-50 px-3 py-1 text-center dark:bg-zinc-800/40">
                  <button type="button" className="text-xs text-brand-600 hover:underline dark:text-brand-400" onClick={() => setExpanded((s) => new Set(s).add(r.from))}>
                    ··· {tp(r.count, '{count} línea sin cambios', '{count} líneas sin cambios')} ···
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={i} className={cx(r.type === 'add' && 'bg-emerald-50 dark:bg-emerald-500/10', r.type === 'del' && 'bg-red-50 dark:bg-red-500/10')}>
                <td className="w-10 select-none border-r border-zinc-100 px-2 text-right align-top text-zinc-400 dark:border-zinc-800">{r.a ?? ''}</td>
                <td className="w-10 select-none border-r border-zinc-100 px-2 text-right align-top text-zinc-400 dark:border-zinc-800">{r.b ?? ''}</td>
                <td className={cx('whitespace-pre px-2 align-top', r.type === 'add' ? 'text-emerald-900 dark:text-emerald-200' : r.type === 'del' ? 'text-red-900 dark:text-red-200' : 'text-zinc-700 dark:text-zinc-300')}>
                  <span className="mr-1 select-none text-zinc-400">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
                  {r.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Lista de archivos del cambio y diff línea a línea del seleccionado (antes → después). */
export function DiffViewer({ files }: { files: FileEntry[] }) {
  const [selected, setSelected] = useState(0);
  const counts = useMemo(() => files.map((f) => countChanges(lineDiff(f.before, f.after).lines)), [files]);
  const current = files[Math.min(selected, files.length - 1)];
  if (!files.length) return null;
  const total = counts.reduce((acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }), { added: 0, removed: 0 });
  return (
    <Card
      title={t('Cambios en el código')}
      description={t('{files} · +{added} −{removed} líneas. Revisa el diff completo antes de aprobar: es exactamente lo que se desplegará.', { files: tp(files.length, '{count} archivo', '{count} archivos'), added: total.added, removed: total.removed })}
      padded={false}
    >
      {/* Consultas de contenedor: la lista de archivos solo va al lado del diff si la tarjeta es ancha
          (con el panel de IA abierto, la ventana puede ser ancha y la tarjeta estrecha). */}
      <div className="@container">
      <div className="grid @3xl:grid-cols-[260px_minmax(0,1fr)]">
        <ul className="max-h-[16rem] overflow-y-auto border-b border-zinc-100 scrollbar-thin dark:border-zinc-800 @3xl:max-h-[28rem] @3xl:border-b-0 @3xl:border-r">
          {files.map((f, i) => {
            const a = ACTION[f.action];
            return (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  className={cx('flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40', i === selected && 'bg-brand-50/70 dark:bg-brand-500/10')}
                >
                  <a.icon className={cx('mt-0.5 size-3.5 shrink-0', f.action === 'add' ? 'text-emerald-500' : f.action === 'delete' ? 'text-red-500' : 'text-amber-500')} />
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-mono">{f.path}</span>
                    <span className="text-zinc-400">
                      <span className="text-emerald-600 dark:text-emerald-400">+{counts[i].added}</span> <span className="text-red-600 dark:text-red-400">−{counts[i].removed}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <code className="break-all text-xs font-medium">{current.path}</code>
            <Badge color={ACTION[current.action].color}>{tk(ACTION[current.action].label)}</Badge>
          </div>
          <div className="max-h-[36rem] overflow-y-auto scrollbar-thin">
            <FileDiff key={current.path} file={current} />
          </div>
        </div>
      </div>
      </div>
    </Card>
  );
}
