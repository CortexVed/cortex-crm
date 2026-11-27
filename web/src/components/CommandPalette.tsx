import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BarChart3, CornerDownLeft, History, LayoutDashboard, Plus, Search, Settings, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { get } from '../lib/api';
import { useBlueprint, useDebounced } from '../lib/hooks';
import { t } from '../lib/i18n';
import { ModuleIcon } from '../lib/icons';
import { useSession } from '../lib/session';
import { cx, Spinner, useEscapeLayer } from './ui';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({ open, onClose, onAskAi }: { open: boolean; onClose: () => void; onAskAi: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { data } = useBlueprint();
  const { can } = useSession();
  const debounced = useDebounced(q.trim(), 200);
  // keepPreviousData: los resultados no desaparecen (ni la lista salta) mientras llega la búsqueda nueva.
  const search = useQuery({ queryKey: ['search', debounced], queryFn: () => get<{ groups: any[] }>(`/search?q=${encodeURIComponent(debounced)}`), enabled: open && debounced.length >= 2, placeholderData: keepPreviousData });
  useEscapeLayer(open, onClose);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    const modules = (data?.blueprint.modules ?? []).filter((m) => !m.archived);
    const navGroup = t('Navegación');
    const nav: Item[] = [
      { id: 'nav-home', group: navGroup, label: t('Panel'), icon: <LayoutDashboard className="size-4" />, run: go('/') },
      ...modules.map((m) => ({ id: `nav-${m.key}`, group: navGroup, label: m.labelPlural, icon: <ModuleIcon name={m.icon} className="size-4" />, run: go(`/m/${m.key}`) })),
      ...(data?.blueprint.pages ?? []).map((p) => ({ id: `page-${p.key}`, group: navGroup, label: p.label, hint: t('Página'), icon: <ModuleIcon name={p.icon} className="size-4" />, run: go(`/p/${p.key}`) })),
      { id: 'nav-reports', group: navGroup, label: t('Informes'), icon: <BarChart3 className="size-4" />, run: go('/reports') },
      { id: 'nav-evolve', group: navGroup, label: 'EVOLVE AI ENGINE', icon: <Sparkles className="size-4" />, run: go('/evolve') },
      { id: 'nav-releases', group: navGroup, label: t('Historial de versiones'), icon: <History className="size-4" />, run: go('/evolve/releases') },
      ...(can('admin') ? [{ id: 'nav-security', group: navGroup, label: t('Seguridad'), icon: <ShieldCheck className="size-4" />, run: go('/evolve/security') }] : []),
      { id: 'nav-settings', group: navGroup, label: t('Ajustes'), icon: <Settings className="size-4" />, run: go('/settings/general') },
    ];
    const create: Item[] = can('member')
      ? modules.filter((m) => can(m.permissions.create)).map((m) => ({ id: `new-${m.key}`, group: t('Crear'), label: t('Nuevo: {name}', { name: m.label }), icon: <Plus className="size-4" />, run: go(`/m/${m.key}?new=1`) }))
      : [];
    const term = q.trim().toLowerCase();
    const filtered = [...nav, ...create].filter((i) => !term || i.label.toLowerCase().includes(term));
    const ai: Item[] = term
      ? [
          {
            id: 'ai-ask',
            group: t('Inteligencia artificial'),
            label: t('Preguntar a EVOLVE AI: «{question}»', { question: q.trim() }),
            icon: <Sparkles className="size-4 text-fuchsia-500" />,
            run: () => {
              sessionStorage.setItem('evolve-ai-prefill', q.trim());
              onAskAi();
              // El panel puede estar ya abierto: el evento hace que lea la pregunta ahora (y con el contexto actual).
              window.dispatchEvent(new CustomEvent('evolve:open-ai'));
              onClose();
            },
          },
          ...(can('builder')
            ? [
                {
                  id: 'ai-evolve',
                  group: t('Inteligencia artificial'),
                  label: t('Pedir este cambio al CRM: «{request}»', { request: q.trim() }),
                  icon: <Wand2 className="size-4 text-brand-500" />,
                  run: () => {
                    sessionStorage.setItem('evolve-prefill', q.trim());
                    navigate('/evolve');
                    // Si ya estaba en /evolve, la página no se vuelve a montar: el evento le pasa el texto.
                    window.dispatchEvent(new CustomEvent('evolve:prefill'));
                    onClose();
                  },
                },
              ]
            : []),
        ]
      : [];
    // Sin texto (p. ej. al reabrir), nada de los resultados de la búsqueda anterior.
    const records: Item[] = (term.length >= 2 ? (search.data?.groups ?? []) : []).flatMap((g) =>
      g.items.map((r: any) => ({ id: `rec-${r.id}`, group: g.label, label: r.title, hint: r.subtitle ?? undefined, icon: <ModuleIcon name={g.icon} className="size-4" />, run: go(`/m/${g.module}/${r.id}`) })),
    );
    return [...records, ...filtered, ...ai];
  }, [data, q, search.data, can, navigate, onClose, onAskAi]);

  useEffect(() => setActive(0), [q, search.data]);
  // Con las flechas, el elemento activo siempre a la vista.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (!open) return null;

  const groups = items.reduce<Record<string, Item[]>>((acc, it) => ((acc[it.group] ??= []).push(it), acc), {});
  let idx = -1;
  return createPortal(
    // En un portal y por encima de los modales (z-60): con ⌘K dentro de un modal, la paleta no queda debajo.
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-zinc-950/40 p-4 pt-[12vh] backdrop-blur-[2px] animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-zinc-200 animate-pop dark:bg-zinc-900 dark:ring-zinc-800" role="dialog" aria-label={t('Paleta de comandos')}>
        <div className="flex items-center gap-2 border-b border-zinc-100 px-4 dark:border-zinc-800">
          <Search className="size-4 text-zinc-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                items[active]?.run();
              }
            }}
            placeholder={t('Busca registros, módulos o escribe una pregunta…')}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
          {search.isFetching && <Spinner className="size-4" />}
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2 scrollbar-thin">
          {!items.length && <p className="px-3 py-8 text-center text-sm text-zinc-500">{t('Sin resultados')}</p>}
          {Object.entries(groups).map(([group, list]) => (
            <div key={group} className="mb-1">
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{group}</div>
              {list.map((it) => {
                idx++;
                const i = idx;
                return (
                  <button key={it.id} data-idx={i} onMouseEnter={() => setActive(i)} onClick={it.run} className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm', active === i ? 'bg-zinc-100 dark:bg-zinc-800' : '')}>
                    <span className="text-zinc-500">{it.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.hint && <span className="max-w-40 truncate text-xs text-zinc-400">{it.hint}</span>}
                    {active === i && <CornerDownLeft className="size-3.5 text-zinc-400" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
