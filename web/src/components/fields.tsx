import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileText, Loader2, Paperclip, Star, X } from 'lucide-react';
import type { Field, Module, Refs } from '../lib/types';
import { get, uploadFile, errorMessage } from '../lib/api';
import { formatBytes, formatCurrency, formatDate, formatNumber, formatPercent, toLocalInput } from '../lib/format';
import { useDebounced, useMembers } from '../lib/hooks';
import { Avatar, Badge, cx, Field as FieldWrap, Input, Select, Textarea, Toggle } from './ui';
import { useToast } from './toast';

const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
export const Dash = () => <span className="text-zinc-300 dark:text-zinc-600">—</span>;

export function FieldValue({ field, value, refs, compact }: { field: Field; value: unknown; refs?: Refs; compact?: boolean }) {
  if (empty(value)) return <Dash />;
  switch (field.type) {
    case 'number':
      return <span className="tabular-nums">{formatNumber(value as number)}</span>;
    case 'currency':
      return <span className="tabular-nums">{formatCurrency(value as number, field.currency ?? 'EUR')}</span>;
    case 'percent':
      return <span className="tabular-nums">{formatPercent(value as number)}</span>;
    case 'formula': {
      if (field.formula?.resultType === 'boolean') return <span>{value ? 'Sí' : 'No'}</span>;
      if (typeof value === 'number') return <span className="tabular-nums">{field.currency ? formatCurrency(value, field.currency) : formatNumber(value)}</span>;
      return <span>{String(value)}</span>;
    }
    case 'date':
      return <span>{formatDate(value as string)}</span>;
    case 'datetime':
      return <span>{formatDate(value as string, true)}</span>;
    case 'boolean':
      return <Badge color={value ? 'emerald' : 'slate'}>{value ? 'Sí' : 'No'}</Badge>;
    case 'email':
      return <a href={`mailto:${value}`} className="text-brand-600 hover:underline dark:text-brand-400" onClick={(e) => e.stopPropagation()}>{String(value)}</a>;
    case 'phone':
      return <a href={`tel:${String(value).replace(/\s/g, '')}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{String(value)}</a>;
    case 'url': {
      let host = String(value);
      try {
        host = new URL(String(value)).host;
      } catch {
        /* valor no URL */
      }
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400" onClick={(e) => e.stopPropagation()}>
          {host} <ExternalLink className="size-3" />
        </a>
      );
    }
    case 'select': {
      const opt = field.options?.find((o) => o.value === value);
      return <Badge color={opt?.color ?? 'slate'} dot>{opt?.label ?? String(value)}</Badge>;
    }
    case 'multi_select':
      return (
        <span className="flex flex-wrap gap-1">
          {(value as string[]).map((v) => {
            const opt = field.options?.find((o) => o.value === v);
            return <Badge key={v} color={opt?.color ?? 'slate'}>{opt?.label ?? v}</Badge>;
          })}
        </span>
      );
    case 'relation': {
      const ref = refs?.records[value as string];
      return (
        <Link to={`/m/${field.relation?.module}/${value}`} className="font-medium text-zinc-800 hover:text-brand-600 hover:underline dark:text-zinc-200 dark:hover:text-brand-400" onClick={(e) => e.stopPropagation()}>
          {ref?.title ?? 'Registro'}
        </Link>
      );
    }
    case 'user': {
      const name = refs?.users[value as string] ?? 'Usuario';
      return (
        <span className="inline-flex items-center gap-1.5">
          <Avatar name={name} size="sm" />
          {!compact && <span className="truncate">{name}</span>}
          {compact && <span className="truncate">{name.split(' ')[0]}</span>}
        </span>
      );
    }
    case 'rating':
      return (
        <span className="inline-flex text-amber-400">
          {[1, 2, 3, 4, 5].map((i) => (
            <Star key={i} className={cx('size-3.5', i <= (value as number) ? 'fill-current' : 'text-zinc-300 dark:text-zinc-700')} />
          ))}
        </span>
      );
    case 'file':
      return (
        <span className="flex flex-wrap gap-1.5">
          {(value as string[]).map((id) => (
            <a key={id} href={`/api/files/${id}`} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700" onClick={(e) => e.stopPropagation()}>
              <Paperclip className="size-3" /> {refs?.files[id]?.name ?? 'Archivo'}
            </a>
          ))}
        </span>
      );
    case 'long_text':
      return compact ? <span className="line-clamp-1">{String(value)}</span> : <span className="whitespace-pre-wrap">{String(value)}</span>;
    default:
      return <span className={compact ? 'truncate' : ''}>{String(value)}</span>;
  }
}

function RelationPicker({ module, value, onChange, initialTitle, invalid }: { module: string; value: string | null; onChange: (v: string | null) => void; initialTitle?: string; invalid?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [title, setTitle] = useState(initialTitle ?? '');
  const ref = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(q, 200);
  const results = useQuery({ queryKey: ['lookup', module, debounced], queryFn: () => get<{ id: string; title: string }[]>(`/lookup/${module}?q=${encodeURIComponent(debounced)}`), enabled: open });
  const current = useQuery({ queryKey: ['lookup-id', module, value], queryFn: () => get<{ id: string; title: string }[]>(`/lookup/${module}?ids=${value}`), enabled: !!value && !initialTitle && !title });
  useEffect(() => {
    if (current.data?.[0]) setTitle(current.data[0].title);
  }, [current.data]);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      {value && !open ? (
        <div className={cx('flex h-9 items-center justify-between rounded-lg bg-white px-3 text-sm ring-1 ring-inset dark:bg-zinc-900', invalid ? 'ring-red-400' : 'ring-zinc-200 dark:ring-zinc-700')}>
          <button type="button" className="min-w-0 flex-1 truncate text-left font-medium" onClick={() => setOpen(true)}>{title || 'Registro seleccionado'}</button>
          <button type="button" aria-label="Quitar" className="text-zinc-400 hover:text-zinc-700" onClick={() => { onChange(null); setTitle(''); }}>
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <Input autoFocus={open} placeholder="Buscar…" value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} invalid={invalid} />
      )}
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg bg-white p-1 shadow-xl ring-1 ring-zinc-200 scrollbar-thin dark:bg-zinc-900 dark:ring-zinc-800">
          {results.isLoading ? (
            <div className="flex justify-center p-3"><Loader2 className="size-4 animate-spin text-zinc-400" /></div>
          ) : !results.data?.length ? (
            <p className="p-3 text-center text-xs text-zinc-500">Sin resultados</p>
          ) : (
            results.data.map((r) => (
              <button type="button" key={r.id} className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => { onChange(r.id); setTitle(r.title); setOpen(false); setQ(''); }}>
                {r.title}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FileInput({ value, onChange, refs, recordId, fieldKey, max }: { value: string[]; onChange: (v: string[] | null) => void; refs?: Refs; recordId?: string; fieldKey: string; max: number }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const ids = [...value];
      for (const f of Array.from(files).slice(0, max - ids.length)) {
        const r = await uploadFile(f, { recordId, fieldKey });
        ids.push(r.id);
        setNames((n) => ({ ...n, [r.id]: r.name }));
      }
      onChange(ids);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {value.map((id) => (
        <div key={id} className="flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-sm ring-1 ring-zinc-200 dark:bg-zinc-800/60 dark:ring-zinc-700">
          <FileText className="size-4 text-zinc-400" />
          <a href={`/api/files/${id}`} className="min-w-0 flex-1 truncate hover:underline">{names[id] ?? refs?.files[id]?.name ?? 'Archivo'}</a>
          {refs?.files[id] && <span className="text-xs text-zinc-400">{formatBytes(refs.files[id].size)}</span>}
          <button type="button" aria-label="Quitar" className="text-zinc-400 hover:text-red-600" onClick={() => onChange(value.filter((x) => x !== id).length ? value.filter((x) => x !== id) : null)}>
            <X className="size-4" />
          </button>
        </div>
      ))}
      {value.length < max && (
        <label className={cx('flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2.5 text-sm text-zinc-500 hover:border-brand-400 hover:text-brand-600 dark:border-zinc-700', busy && 'pointer-events-none opacity-60')}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          {busy ? 'Subiendo…' : 'Adjuntar archivos'}
          <input type="file" multiple className="sr-only" onChange={(e) => upload(e.target.files)} />
        </label>
      )}
    </div>
  );
}

export function FieldInput({ field, value, onChange, refs, invalid, recordId }: { field: Field; value: unknown; onChange: (v: unknown) => void; refs?: Refs; invalid?: boolean; recordId?: string }) {
  const members = useMembers();
  const str = value === null || value === undefined ? '' : String(value);
  switch (field.type) {
    case 'long_text':
      return <Textarea value={str} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} rows={4} />;
    case 'number':
    case 'currency':
    case 'percent':
      return (
        <div className="relative">
          <Input type="number" inputMode="decimal" step="any" min={field.min} max={field.max} value={str} invalid={invalid} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className={field.type !== 'number' ? 'pr-12' : ''} />
          {field.type !== 'number' && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400">{field.type === 'percent' ? '%' : field.currency ?? 'EUR'}</span>}
        </div>
      );
    case 'date':
      return <Input type="date" value={str.slice(0, 10)} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />;
    case 'datetime':
      return <Input type="datetime-local" value={toLocalInput(str)} invalid={invalid} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case 'boolean':
      return <Toggle checked={value === true} onChange={(v) => onChange(v)} />;
    case 'email':
      return <Input type="email" value={str} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />;
    case 'phone':
      return <Input type="tel" value={str} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />;
    case 'url':
      return <Input type="url" placeholder="https://" value={str} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />;
    case 'select':
      return (
        <Select value={str} invalid={invalid} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Sin seleccionar —</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      );
    case 'multi_select': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options?.map((o) => {
            const on = arr.includes(o.value);
            return (
              <button type="button" key={o.value} onClick={() => onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])} className={cx('rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset transition', on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700')}>
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case 'relation':
      return <RelationPicker module={field.relation!.module} value={(value as string) ?? null} onChange={onChange} initialTitle={value ? refs?.records[value as string]?.title : undefined} invalid={invalid} />;
    case 'user':
      return (
        <Select value={str} invalid={invalid} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Sin asignar —</option>
          {members.data?.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </Select>
      );
    case 'rating':
      return (
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <button type="button" key={i} aria-label={`${i} estrellas`} onClick={() => onChange(value === i ? null : i)} className="text-amber-400">
              <Star className={cx('size-5', i <= ((value as number) ?? 0) ? 'fill-current' : 'text-zinc-300 dark:text-zinc-700')} />
            </button>
          ))}
        </div>
      );
    case 'file':
      return <FileInput value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} refs={refs} recordId={recordId} fieldKey={field.key} max={field.maxFiles ?? 10} />;
    case 'formula':
      return <div className="flex h-9 items-center rounded-lg bg-zinc-50 px-3 text-sm text-zinc-500 dark:bg-zinc-800/60">{empty(value) ? 'Se calcula automáticamente' : <FieldValue field={field} value={value} />}</div>;
    default:
      return <Input value={str} invalid={invalid} onChange={(e) => onChange(e.target.value || null)} />;
  }
}

/** Secciones de la ficha según el diseño (layout) del módulo; si no hay, todos los campos visibles. */
export function moduleSections(mod: Module) {
  const visible = mod.fields.filter((f) => !f.archived && !f.hidden);
  if (mod.layout?.length) {
    const used = new Set<string>();
    const sections = mod.layout.map((s) => {
      const fields = s.fields.map((k) => visible.find((f) => f.key === k)).filter((f): f is Field => !!f);
      fields.forEach((f) => used.add(f.key));
      return { title: s.title, columns: s.columns ?? 2, fields };
    });
    const rest = visible.filter((f) => !used.has(f.key));
    if (rest.length) sections.push({ title: 'Otros campos', columns: 2, fields: rest });
    return sections.filter((s) => s.fields.length);
  }
  return [{ title: 'Datos', columns: 2, fields: visible }];
}

export function RecordForm({ mod, values, onChange, errors, refs, recordId, mode }: { mod: Module; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; errors: Record<string, string>; refs?: Refs; recordId?: string; mode: 'create' | 'edit' }) {
  const sections = moduleSections(mod);
  return (
    <div className="space-y-6">
      {sections.map((s) => (
        <fieldset key={s.title}>
          <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">{s.title}</legend>
          <div className={cx('grid gap-4', s.columns === 2 && 'sm:grid-cols-2')}>
            {s.fields
              .filter((f) => !(mode === 'create' && f.type === 'formula'))
              .map((f) => (
                <FieldWrap key={f.key} label={f.label} required={f.required} hint={f.helpText} error={errors[f.key]} className={f.type === 'long_text' || f.type === 'file' || f.type === 'multi_select' ? 'sm:col-span-2' : ''}>
                  <FieldInput field={f} value={values[f.key]} onChange={(v) => onChange({ ...values, [f.key]: v })} refs={refs} invalid={!!errors[f.key]} recordId={recordId} />
                </FieldWrap>
              ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
