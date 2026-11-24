import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, PenLine, RefreshCw, Search, Undo2 } from 'lucide-react';
import { cx, Spinner } from '../../../components/ui';
import { relativeTime } from '../../../lib/format';
import { catalogAvailable, describeError, formatPerM, formatTokens, useModels, useRefreshModels } from './shared';
import type { ModelInfo, ProviderState } from './types';

const MAX_ROWS = 150;

type Entry = { kind: 'null' } | { kind: 'custom'; id: string } | { kind: 'model'; model: ModelInfo };

interface Position {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

function priceLabel(m: ModelInfo): string {
  if (!m.pricing) return '—';
  const { inputPerM, outputPerM } = m.pricing;
  if (inputPerM === 0 && outputPerM === 0) return 'Gratis';
  return `${formatPerM(inputPerM)} / ${formatPerM(outputPerM)}`;
}

const validCustomId = (s: string) => s.length > 0 && s.length <= 200 && !/\s/.test(s);

/**
 * Selector de modelo con búsqueda sobre el catálogo EN VIVO del proveedor (nunca listas fijas).
 * Muestra contexto y precio por millón de tokens cuando la API los ofrece y admite IDs escritos a mano.
 */
export function ModelPicker({
  provider,
  value,
  onChange,
  nullLabel,
  disabled,
  invalid,
  loading,
  placeholder = 'Elige un modelo',
  className,
  ariaLabel,
}: {
  provider: ProviderState | undefined;
  value: string | null;
  onChange: (model: string | null) => void;
  /** Si se indica, ofrece una opción para dejar el modelo sin fijar (valor null). */
  nullLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  loading?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardNav = useRef(false);
  const listId = useId();
  const models = useModels(provider, open);
  const refresh = useRefreshModels();
  const all = useMemo(() => models.data?.models ?? [], [models.data]);
  const selected = value ? all.find((m) => m.id === value) : undefined;

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return all;
    return all.filter((m) => {
      const hay = `${m.id} ${m.name ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [all, trimmed]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (nullLabel && !trimmed) out.push({ kind: 'null' });
    if (trimmed && validCustomId(trimmed) && !all.some((m) => m.id === trimmed)) out.push({ kind: 'custom', id: trimmed });
    for (const m of filtered.slice(0, MAX_ROWS)) out.push({ kind: 'model', model: m });
    return out;
  }, [all, filtered, nullLabel, trimmed]);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 460), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    if (below < 300 && above > below) setPos({ left, width, bottom: vh - r.top + 4, maxHeight: Math.min(440, above) });
    else setPos({ left, width, top: r.bottom + 4, maxHeight: Math.max(220, Math.min(440, below)) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Se recoloca al desplazar la página o un contenedor, pero no al desplazar la propia lista.
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  // Al abrir (o al llegar el catálogo) se resalta y muestra el modelo seleccionado.
  useEffect(() => {
    if (!open || trimmed) return;
    const idx = entries.findIndex((e) => (e.kind === 'model' ? e.model.id === value : e.kind === 'null' && value === null));
    const next = idx >= 0 ? idx : 0;
    setActive(next);
    const t = setTimeout(() => listRef.current?.querySelector(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' }), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, models.data]);

  // Solo se desplaza la lista al navegar con el teclado (con el ratón provocaría saltos).
  useEffect(() => {
    if (!keyboardNav.current) return;
    keyboardNav.current = false;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const close = (focusTrigger = true) => {
    setOpen(false);
    setQuery('');
    if (focusTrigger) triggerRef.current?.focus();
  };

  const pick = (e: Entry | undefined) => {
    if (!e) return;
    onChange(e.kind === 'null' ? null : e.kind === 'custom' ? e.id : e.model.id);
    close();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      keyboardNav.current = true;
      setActive((a) => Math.min(a + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      keyboardNav.current = true;
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(entries[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const canCatalog = catalogAvailable(provider);
  let status: string;
  if (!provider) status = 'Elige primero un proveedor.';
  else if (!canCatalog) status = `Añade la API key de ${provider.label} para ver su catálogo. Puedes escribir un ID de modelo.`;
  else if (models.isLoading) status = 'Cargando catálogo en vivo…';
  else if (models.error) status = `No se pudo cargar el catálogo: ${describeError(models.error)}`;
  else status = `${all.length} modelos${models.data?.cachedAt ? ` · actualizado ${relativeTime(models.data.cachedAt)}` : ''}`;

  const showModels = entries.some((e) => e.kind === 'model');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ?? undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={cx(
          'flex h-9 w-full min-w-0 items-center gap-2 rounded-lg bg-white px-3 text-left text-sm text-zinc-900 shadow-xs ring-1 ring-inset transition focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 dark:bg-zinc-900 dark:text-zinc-100 dark:disabled:bg-zinc-800',
          invalid ? 'ring-red-400 dark:ring-red-500/60' : open ? 'ring-2 ring-brand-500' : 'ring-zinc-200 dark:ring-zinc-700',
          className,
        )}
      >
        {value ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate font-mono text-[12.5px]">{value}</span>
            {selected?.name && selected.name !== value && <span className="hidden truncate text-xs text-zinc-500 sm:inline">{selected.name}</span>}
          </span>
        ) : (
          <span className={cx('min-w-0 flex-1 truncate', nullLabel ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400')}>{nullLabel ?? placeholder}</span>
        )}
        {loading ? <Spinner className="size-4 shrink-0" /> : <ChevronsUpDown className="size-4 shrink-0 text-zinc-400" />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            className="z-[55] flex flex-col overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-zinc-200 animate-pop dark:bg-zinc-900 dark:ring-zinc-800"
          >
            <div className="flex items-center gap-2 border-b border-zinc-100 px-3 dark:border-zinc-800">
              <Search className="size-4 shrink-0 text-zinc-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-autocomplete="list"
                spellCheck={false}
                autoComplete="off"
                placeholder={all.length ? `Buscar entre ${all.length} modelos o escribir un ID…` : 'Escribe el ID del modelo…'}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
              />
              {models.isFetching && <Spinner className="size-4" />}
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800">
              <span className="min-w-0 truncate" title={status}>
                {status}
              </span>
              {provider && canCatalog && (
                <button
                  type="button"
                  onClick={() => refresh.mutate(provider.id)}
                  disabled={refresh.isPending}
                  className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-600 hover:underline disabled:opacity-60 dark:text-brand-400"
                >
                  <RefreshCw className={cx('size-3', refresh.isPending && 'animate-spin')} />
                  Actualizar catálogo
                </button>
              )}
            </div>
            <div ref={listRef} id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1 scrollbar-thin">
              {showModels && (
                <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/95 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 backdrop-blur dark:bg-zinc-900/95">
                  <span className="flex-1">Modelo</span>
                  <span className="hidden w-14 text-right sm:block">Contexto</span>
                  <span className="w-32 text-right sm:w-40">Entrada / salida · 1M</span>
                  <span className="size-4" />
                </div>
              )}
              {entries.map((e, i) => {
                const isActive = i === active;
                const base = cx('flex w-full scroll-mt-7 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors', isActive && 'bg-zinc-100 dark:bg-zinc-800');
                if (e.kind === 'null') {
                  return (
                    <button key="__null" type="button" role="option" aria-selected={value === null} data-idx={i} onMouseEnter={() => setActive(i)} onClick={() => pick(e)} className={base}>
                      <Undo2 className="size-4 shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300">{nullLabel}</span>
                      <Check className={cx('size-4 shrink-0 text-brand-600 dark:text-brand-400', value === null ? 'opacity-100' : 'opacity-0')} />
                    </button>
                  );
                }
                if (e.kind === 'custom') {
                  return (
                    <button key="__custom" type="button" role="option" aria-selected={false} data-idx={i} onMouseEnter={() => setActive(i)} onClick={() => pick(e)} className={base}>
                      <PenLine className="size-4 shrink-0 text-brand-500" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        Usar <span className="font-mono text-[12.5px] font-medium">{e.id}</span> como ID de modelo
                      </span>
                    </button>
                  );
                }
                const m = e.model;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={m.id === value}
                    data-idx={i}
                    title={m.description ?? undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(e)}
                    className={base}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{m.name ?? m.id}</span>
                      {m.name && m.name !== m.id && <span className="block truncate font-mono text-[11px] text-zinc-500">{m.id}</span>}
                    </span>
                    <span className="hidden w-14 shrink-0 text-right text-xs tabular-nums text-zinc-500 sm:block">{m.contextLength ? formatTokens(m.contextLength) : '—'}</span>
                    <span className="w-32 shrink-0 text-right text-xs tabular-nums text-zinc-600 sm:w-40 dark:text-zinc-400">{priceLabel(m)}</span>
                    <Check className={cx('size-4 shrink-0 text-brand-600 dark:text-brand-400', m.id === value ? 'opacity-100' : 'opacity-0')} />
                  </button>
                );
              })}
              {!entries.length && (
                <p className="px-3 py-6 text-center text-sm text-zinc-500">
                  {models.isLoading ? 'Cargando…' : trimmed ? 'Ningún modelo coincide. Revisa el ID: no puede contener espacios.' : canCatalog ? 'El proveedor no ha devuelto modelos.' : 'Escribe el ID exacto del modelo que quieres usar.'}
                </p>
              )}
            </div>
            {filtered.length > MAX_ROWS && (
              <div className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800">
                Mostrando {MAX_ROWS} de {filtered.length} modelos. Escribe para afinar la búsqueda.
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
