import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Columns3, Filter, Plus, Search, Sparkles, Table2, X } from 'lucide-react';
import { ApiError, errorMessage, get, patch, post } from '../lib/api';
import { useBlueprint, useDebounced, useHotkeys } from '../lib/hooks';
import { useSession } from '../lib/session';
import { ModuleIcon } from '../lib/icons';
import { MODULE_ACCENT, DOT } from '../lib/colors';
import { formatCurrency } from '../lib/format';
import { getIntlTag, inSentence, msg, t, tk, tp } from '../lib/i18n';
import type { Condition, Field, Module, RecordItem, RecordList, View } from '../lib/types';
import { recordTitle } from '../../../shared/records';
import type { Color } from '../../../shared/constants';
import { Alert, Badge, Button, cx, Drawer, EmptyState, ErrorState, Input, PageLoader, Select, Skeleton } from '../components/ui';
import { FieldValue, RecordForm } from '../components/fields';
import { RecordTable } from '../components/RecordTable';
import { useToast } from '../components/toast';
import NotFound from './NotFound';

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
// Etiquetas marcadas con msg(): se traducen al mostrarlas (tk).
const OPERATORS: { value: Condition['operator']; label: string }[] = [
  { value: 'eq', label: msg('es') },
  { value: 'neq', label: msg('no es') },
  { value: 'contains', label: msg('contiene') },
  { value: 'gt', label: msg('mayor que') },
  { value: 'lt', label: msg('menor que') },
  { value: 'is_empty', label: msg('está vacío') },
  { value: 'is_not_empty', label: msg('no está vacío') },
];

function CreateDrawer({ mod, open, onClose, prefill }: { mod: Module; open: boolean; onClose: () => void; prefill: Record<string, unknown> }) {
  const [values, setValues] = useState<Record<string, unknown>>(prefill);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  useEffect(() => {
    if (open) {
      setValues(prefill);
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useMutation({
    mutationFn: () => post<{ record: RecordItem }>(`/records/${mod.key}`, { values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== '')) }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['records', mod.key] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast(t('Registro creado'));
      onClose();
      navigate(`/m/${mod.key}/${r.record.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast(errorMessage(e), 'error');
    },
  });
  return (
    <Drawer open={open} onClose={onClose} title={t('Nuevo: {name}', { name: mod.label })}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="flex min-h-full flex-col">
        <div className="flex-1 p-5">
          <RecordForm mod={mod} values={values} onChange={setValues} errors={errors} mode="create" />
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-zinc-100 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button type="button" onClick={onClose}>{t('Cancelar')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>{t('Crear {name}', { name: inSentence(mod.label) })}</Button>
        </div>
      </form>
    </Drawer>
  );
}

function KanbanView({ mod, view, data, onOpen, onCreate }: { mod: Module; view: View; data: RecordList; onOpen: (r: RecordItem) => void; onCreate: (prefill: Record<string, unknown>) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const group = mod.fields.find((f) => f.key === view.groupBy);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const moneyField = mod.fields.find((f) => f.type === 'currency' && !f.archived);
  const move = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string | null }) => patch(`/records/${mod.key}/${id}`, { values: { [group!.key]: value } }),
    onMutate: async ({ id, value }) => {
      const key = ['records', mod.key];
      await qc.cancelQueries({ queryKey: key });
      const snapshots = qc.getQueriesData<RecordList>({ queryKey: key });
      qc.setQueriesData<RecordList>({ queryKey: key }, (old) => old && { ...old, items: old.items.map((it) => (it.id === id ? { ...it, data: { ...it.data, [group!.key]: value } } : it)) });
      return { snapshots };
    },
    onError: (e, _v, ctx) => {
      ctx?.snapshots.forEach(([k, d]) => qc.setQueryData(k, d));
      toast(errorMessage(e), 'error');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['records', mod.key] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  if (!group?.options) return <ErrorState error={new Error(t('La vista kanban necesita un campo de selección'))} />;
  const columns = [...group.options.map((o) => ({ value: o.value as string | null, label: o.label, color: o.color })), { value: null, label: t('Sin valor'), color: 'slate' as Color }];
  const cardFields = (view.cardFields ?? []).map((k) => mod.fields.find((f) => f.key === k)).filter((f): f is Field => !!f && !f.archived);
  return (
    <div className="flex gap-3 overflow-x-auto pb-4 scrollbar-thin">
      {columns.map((col) => {
        const items = data.items.filter((r) => (r.data[group.key] ?? null) === col.value);
        if (col.value === null && !items.length) return null;
        const total = moneyField ? items.reduce((a, r) => a + (typeof r.data[moneyField.key] === 'number' ? (r.data[moneyField.key] as number) : 0), 0) : null;
        return (
          <div
            key={col.value ?? '__none'}
            onDragOver={(e) => { e.preventDefault(); setOver(col.value ?? '__none'); }}
            // Al pasar por encima de las tarjetas (hijas) también salta dragleave: solo se apaga al salir de la columna.
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/plain');
              const rec = data.items.find((r) => r.id === id);
              if (rec && (rec.data[group.key] ?? null) !== col.value) move.mutate({ id, value: col.value });
            }}
            className={cx('flex w-72 shrink-0 flex-col rounded-xl bg-zinc-100/70 p-2 transition dark:bg-zinc-900/60', over === (col.value ?? '__none') && 'ring-2 ring-brand-400')}
          >
            <div className="flex items-center gap-2 px-1.5 pb-2 pt-1">
              <span className={cx('size-2 rounded-full', DOT[col.color as Color])} />
              <span className="text-sm font-semibold">{col.label}</span>
              <span className="text-xs text-zinc-400">{items.length}</span>
              {total !== null && total > 0 && <span className="ml-auto text-xs font-medium text-zinc-500 tabular-nums">{formatCurrency(total, moneyField?.currency ?? 'EUR', true)}</span>}
            </div>
            <div className="flex min-h-16 flex-1 flex-col gap-2">
              {items.map((r) => (
                <div
                  key={r.id}
                  draggable={can(mod.permissions.update)}
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', r.id); setDragging(r.id); }}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => onOpen(r)}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(r);
                    }
                  }}
                  className={cx('cursor-pointer rounded-lg bg-white p-3 shadow-xs ring-1 ring-zinc-200/80 transition hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:bg-zinc-800 dark:ring-zinc-700', dragging === r.id && 'opacity-50')}
                >
                  <div className="text-sm font-medium leading-snug">{recordTitle(mod, r.data)}</div>
                  {cardFields.some((f) => !isEmpty(r.data[f.key])) && (
                    <div className="mt-2 space-y-1 text-xs text-zinc-500">
                      {cardFields
                        .filter((f) => !isEmpty(r.data[f.key]))
                        .map((f) => (
                          <div key={f.key} className="flex items-center gap-1.5 truncate">
                            <FieldValue field={f} value={r.data[f.key]} refs={data.refs} compact />
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ))}
              {can(mod.permissions.create) && col.value !== null && (
                <button onClick={() => onCreate({ [group.key]: col.value })} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-white hover:text-zinc-800 dark:hover:bg-zinc-800">
                  <Plus className="size-3.5" /> {t('Añadir')}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const thisMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Primer día (lunes) de la cuadrícula de 6 semanas del mes. */
function gridStart(month: Date) {
  const start = new Date(month);
  start.setDate(1 - ((start.getDay() + 6) % 7));
  return start;
}
/**
 * Filtro de fechas de la cuadrícula visible: el calendario pide los registros de esas semanas (antes pedía 500
 * registros cualquiera y, con más, faltaban días). Un día de margen por cada lado: la hora de un campo fecha-hora
 * se compara en UTC y la cuadrícula se pinta en la hora local.
 */
function calendarRange(field: string, month: Date): Condition[] {
  const start = gridStart(month);
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  const to = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42);
  return [
    { field, operator: 'gte', value: dayKey(from) },
    { field, operator: 'lte', value: dayKey(to) },
  ];
}

function CalendarView({ mod, view, data, month, setMonth, onOpen, onCreate }: { mod: Module; view: View; data: RecordList; month: Date; setMonth: (m: Date) => void; onOpen: (r: RecordItem) => void; onCreate: (prefill: Record<string, unknown>) => void }) {
  const { can } = useSession();
  const df = view.dateField!;
  const dateField = mod.fields.find((f) => f.key === df);
  const colorField = mod.fields.find((f) => f.key === view.colorBy);
  const start = gridStart(month);
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const keyOf = dayKey;
  const byDay = new Map<string, RecordItem[]>();
  for (const r of data.items) {
    const v = df === 'created_at' ? r.createdAt : df === 'updated_at' ? r.updatedAt : (r.data[df] as string | undefined);
    if (!v) continue;
    const k = v.length > 10 ? keyOf(new Date(v)) : v.slice(0, 10);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  const today = keyOf(new Date());
  return (
    <div className="rounded-xl bg-white ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <div className="text-sm font-semibold capitalize">{month.toLocaleDateString(getIntlTag(), { month: 'long', year: 'numeric' })}</div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t('Mes anterior')}><ChevronLeft className="size-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setMonth(thisMonth())}>{t('Hoy')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t('Mes siguiente')}><ChevronRight className="size-4" /></Button>
        </div>
      </div>
      <div className="grid grid-cols-7 border-b border-zinc-100 text-center text-[11px] font-medium uppercase text-zinc-400 dark:border-zinc-800">
        {/* La cuadrícula empieza en lunes: los nombres de los días salen de su primera semana, en el idioma activo. */}
        {days.slice(0, 7).map((d) => <div key={d.getDay()} className="py-2">{d.toLocaleDateString(getIntlTag(), { weekday: 'short' })}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const k = keyOf(d);
          const items = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div key={k} className={cx('group min-h-24 border-b border-r border-zinc-100 p-1.5 dark:border-zinc-800', !inMonth && 'bg-zinc-50/60 dark:bg-zinc-950/40')}>
              <div className="flex items-center justify-between">
                <span className={cx('flex size-6 items-center justify-center rounded-full text-xs', k === today ? 'bg-brand-600 font-semibold text-white' : inMonth ? 'text-zinc-700 dark:text-zinc-300' : 'text-zinc-400')}>{d.getDate()}</span>
                {can(mod.permissions.create) && dateField && (
                  <button aria-label={t('Crear este día')} className="hidden size-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 group-hover:flex dark:hover:bg-zinc-800" onClick={() => onCreate({ [df]: dateField.type === 'date' ? k : new Date(`${k}T09:00:00`).toISOString() })}>
                    <Plus className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-1 space-y-1">
                {items.slice(0, 3).map((r) => {
                  const opt = colorField?.options?.find((o) => o.value === r.data[colorField.key]);
                  return (
                    <button key={r.id} onClick={() => onOpen(r)} className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      <span className={cx('size-1.5 shrink-0 rounded-full', DOT[(opt?.color ?? 'violet') as Color])} />
                      <span className="truncate">{recordTitle(mod, r.data)}</span>
                    </button>
                  );
                })}
                {items.length > 3 && <div className="px-1 text-[10px] text-zinc-400">{t('+{count} más', { count: items.length - 3 })}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Una instancia por módulo: al cambiar de módulo no se arrastran búsqueda, filtros, orden ni el formulario de alta
// del anterior (antes se pedía un instante la lista del módulo nuevo con los filtros del viejo).
export default function ModulePageRoute() {
  const { module = '' } = useParams();
  return <ModulePage key={module} module={module} />;
}

function ModulePage({ module }: { module: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const bp = useBlueprint();
  const { can } = useSession();
  const mod = bp.data?.blueprint.modules.find((m) => m.key === module && !m.archived);
  const viewKey = params.get('view') ?? mod?.views[0]?.key;
  const view = mod?.views.find((v) => v.key === viewKey) ?? mod?.views[0];
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);
  const [filters, setFilters] = useState<Condition[]>([]);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<Record<string, unknown>>({});
  const [filterDraft, setFilterDraft] = useState<{ field: string; operator: Condition['operator']; value: string } | null>(null);
  const [calMonth, setCalMonth] = useState(thisMonth);
  useEffect(() => {
    setSearch('');
    setFilters([]);
    setSort(null);
    setPage(1);
  }, [module, viewKey]);
  useEffect(() => {
    if (params.get('new') === '1' && mod) {
      let initial: Record<string, unknown> = {};
      try {
        const raw = sessionStorage.getItem(`evolve-new-prefill:${mod.key}`);
        if (raw) initial = JSON.parse(raw);
        sessionStorage.removeItem(`evolve-new-prefill:${mod.key}`);
      } catch {
        /* sin prellenado */
      }
      setPrefill(initial);
      setCreateOpen(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, mod, setParams]);
  useHotkeys({ c: () => mod && can(mod.permissions.create) && (setPrefill({}), setCreateOpen(true)) }, [mod]);

  const all = view?.type === 'kanban' || view?.type === 'calendar';
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (view) p.set('view', view.key);
    if (debounced) p.set('search', debounced);
    const conds = view?.type === 'calendar' && view.dateField ? [...filters, ...calendarRange(view.dateField, calMonth)] : filters;
    if (conds.length) p.set('filters', JSON.stringify(conds));
    if (sort) {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    }
    p.set('page', String(all ? 1 : page));
    p.set('pageSize', all ? '500' : '50');
    return p.toString();
  }, [view, debounced, filters, sort, page, all, calMonth]);
  const list = useQuery({ queryKey: ['records', module, qs], queryFn: () => get<RecordList>(`/records/${module}?${qs}`), enabled: !!mod, placeholderData: keepPreviousData });

  if (bp.isLoading) return <PageLoader />;
  // Un fallo al cargar la estructura no es «página no encontrada»: se muestra el error y se puede reintentar.
  if (bp.error && !bp.data) return <ErrorState error={bp.error} onRetry={() => bp.refetch()} className="py-24" />;
  if (!mod || !view) return <NotFound />;
  const open = (r: RecordItem) => navigate(`/m/${mod.key}/${r.id}`);
  const openCreate = (p: Record<string, unknown>) => {
    setPrefill(p);
    setCreateOpen(true);
  };
  const filterable = mod.fields.filter((f) => !f.archived && f.type !== 'file');
  const ViewIcon = (v: View) => (v.type === 'kanban' ? Columns3 : v.type === 'calendar' ? CalendarDays : Table2);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className={cx('flex size-9 items-center justify-center rounded-xl', MODULE_ACCENT[mod.color as Color])}>
            <ModuleIcon name={mod.icon} className="size-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{mod.labelPlural}</h1>
            <p className="text-sm text-zinc-500">{list.data ? tp(list.data.total, '{count} registro', '{count} registros') : mod.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {can('builder') && (
            <Button variant="ghost" size="sm" icon={<Sparkles className="size-3.5 text-fuchsia-500" />} onClick={() => { sessionStorage.setItem('evolve-prefill', `${t('En el módulo {module}:', { module: mod.labelPlural })} `); navigate('/evolve'); }}>
              {t('Evolucionar módulo')}
            </Button>
          )}
          {can(mod.permissions.create) && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openCreate({})}>
              {t('Nuevo')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex gap-1 overflow-x-auto rounded-lg bg-zinc-100/80 p-0.5 dark:bg-zinc-900">
          {mod.views.map((v) => {
            const Icon = ViewIcon(v);
            return (
              <button key={v.key} onClick={() => setParams({ view: v.key })} className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition', v.key === view.key ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-800 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
                <Icon className="size-3.5" /> {v.label}
              </button>
            );
          })}
        </div>
        <div className="relative lg:ml-auto lg:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('Buscar en {module}…', { module: inSentence(mod.labelPlural) })} className="pl-8" />
        </div>
        <Button size="md" icon={<Filter className="size-4" />} onClick={() => setFilterDraft({ field: filterable[0]?.key ?? '', operator: 'eq', value: '' })}>
          {t('Filtro')}
        </Button>
      </div>

      {(filters.length > 0 || filterDraft) && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((f, i) => {
            const fd = mod.fields.find((x) => x.key === f.field);
            const opt = fd?.options?.find((o) => o.value === f.value);
            return (
              <Badge key={i} color="violet" className="gap-1.5 py-1">
                {fd?.label} {tk(OPERATORS.find((o) => o.value === f.operator)?.label ?? '')} {f.value !== undefined ? <strong>{opt?.label ?? String(f.value)}</strong> : null}
                <button aria-label={t('Quitar filtro')} onClick={() => { setFilters(filters.filter((_, j) => j !== i)); setPage(1); }}><X className="size-3" /></button>
              </Badge>
            );
          })}
          {filterDraft && (
            <form
              className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-1.5 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700"
              onSubmit={(e) => {
                e.preventDefault();
                const needsValue = !['is_empty', 'is_not_empty'].includes(filterDraft.operator);
                const fd = mod.fields.find((x) => x.key === filterDraft.field);
                const numeric = fd && ['number', 'currency', 'percent', 'rating'].includes(fd.type);
                setFilters([...filters, { field: filterDraft.field, operator: filterDraft.operator, ...(needsValue ? { value: numeric ? Number(filterDraft.value) : filterDraft.value } : {}) }]);
                setFilterDraft(null);
                setPage(1);
              }}
            >
              {/* El ancho va en un envoltorio: las clases base (w-full, h-9) no se pueden anular con className. */}
              <div className="w-40">
                <Select aria-label={t('Campo')} value={filterDraft.field} onChange={(e) => setFilterDraft({ ...filterDraft, field: e.target.value, value: '' })}>
                  {filterable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </Select>
              </div>
              <div className="w-36">
                <Select aria-label={t('Condición')} value={filterDraft.operator} onChange={(e) => setFilterDraft({ ...filterDraft, operator: e.target.value as Condition['operator'] })}>
                  {OPERATORS.map((o) => <option key={o.value} value={o.value}>{tk(o.label)}</option>)}
                </Select>
              </div>
              {!['is_empty', 'is_not_empty'].includes(filterDraft.operator) &&
                (() => {
                  const fd = mod.fields.find((x) => x.key === filterDraft.field);
                  return (
                    <div className="w-40">
                      {fd?.options ? (
                        <Select aria-label={t('Valor')} value={filterDraft.value} onChange={(e) => setFilterDraft({ ...filterDraft, value: e.target.value })}>
                          <option value="">{t('Elige…')}</option>
                          {fd.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </Select>
                      ) : (
                        <Input aria-label={t('Valor')} type={fd && ['date', 'datetime'].includes(fd.type) ? 'date' : fd && ['number', 'currency', 'percent', 'rating'].includes(fd.type) ? 'number' : 'text'} value={filterDraft.value} onChange={(e) => setFilterDraft({ ...filterDraft, value: e.target.value })} />
                      )}
                    </div>
                  );
                })()}
              <Button size="sm" type="submit" variant="primary">{t('Aplicar')}</Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setFilterDraft(null)}>{t('Cancelar')}</Button>
            </form>
          )}
        </div>
      )}

      {list.isLoading ? (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11" />)}</div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data!.items.length && view.type === 'table' ? (
        <div className="rounded-xl bg-white ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
          <EmptyState
            icon={<ModuleIcon name={mod.icon} className="size-5" />}
            title={debounced || filters.length ? t('Sin resultados') : t('Todavía no hay {module}', { module: inSentence(mod.labelPlural) })}
            description={debounced || filters.length ? t('Prueba con otra búsqueda o quita filtros.') : t('Crea el primero para empezar.')}
            action={!debounced && !filters.length && can(mod.permissions.create) ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openCreate({})}>{t('Nuevo {name}', { name: inSentence(mod.label) })}</Button> : undefined}
          />
        </div>
      ) : view.type === 'kanban' || view.type === 'calendar' ? (
        <>
          {list.data!.total > list.data!.items.length && (
            <Alert tone="info">{t('Se muestran {shown} de {total} {module}. Usa la búsqueda o un filtro para ver el resto.', { shown: list.data!.items.length, total: list.data!.total, module: inSentence(mod.labelPlural) })}</Alert>
          )}
          {view.type === 'kanban' ? <KanbanView mod={mod} view={view} data={list.data!} onOpen={open} onCreate={openCreate} /> : <CalendarView mod={mod} view={view} data={list.data!} month={calMonth} setMonth={setCalMonth} onOpen={open} onCreate={openCreate} />}
        </>
      ) : (
        <>
          <RecordTable mod={mod} columns={view.columns} data={list.data!} sort={sort ?? (view.sort ? { field: view.sort.field, dir: view.sort.direction } : null)} setSort={(s) => { setSort(s); setPage(1); }} onOpen={open} />
          {list.data!.total > 50 && (
            <div className="flex items-center justify-between text-sm text-zinc-500">
              <span>{t('{from}–{to} de {total}', { from: (page - 1) * 50 + 1, to: Math.min(page * 50, list.data!.total), total: list.data!.total })}</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>{t('Anterior')}</Button>
                <Button size="sm" disabled={page * 50 >= list.data!.total} onClick={() => setPage(page + 1)}>{t('Siguiente')}</Button>
              </div>
            </div>
          )}
        </>
      )}
      <CreateDrawer mod={mod} open={createOpen} onClose={() => setCreateOpen(false)} prefill={prefill} />
    </div>
  );
}
