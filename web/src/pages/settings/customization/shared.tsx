import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ArrowDown, ArrowUp, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { COLORS, ICONS, SYSTEM_FIELD_KEYS, type Color, type IconName } from '../../../../../shared/constants';
import type { FieldSchema, ModuleSchema, SelectOptionSchema } from '../../../../../shared/blueprint';
import type { ChangeSetSchema, OperationSchema } from '../../../../../shared/changeset';
import { cx, IconButton, Input } from '../../../components/ui';
import { useToast } from '../../../components/toast';
import { post } from '../../../lib/api';
import { DOT, MODULE_ACCENT } from '../../../lib/colors';
import { ModuleIcon } from '../../../lib/icons';
import type { Module } from '../../../lib/types';
import { describeError } from '../ai/shared';

// Tipos de ENTRADA de los esquemas (los valores por defecto son opcionales).
export type ChangeSetInput = z.input<typeof ChangeSetSchema>;
export type OperationInput = z.input<typeof OperationSchema>;
export type FieldInput = z.input<typeof FieldSchema>;
export type ModuleInput = z.input<typeof ModuleSchema>;
export type OptionInput = z.input<typeof SelectOptionSchema>;

// Mismas reglas que shared/blueprint.ts (se replican para no empaquetar zod en el cliente).
export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const OPTION_VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/;

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** "Fecha de cierre" → "fecha_de_cierre" (a-z0-9_, empieza por letra, máx. 40). */
export function toKey(label: string, max = 40): string {
  return stripAccents(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, max)
    .replace(/_+$/, '');
}

/** Valor de opción a partir de su etiqueta ("En negociación" → "en_negociacion"). */
export function toOptionValue(label: string): string {
  return stripAccents(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 50)
    .replace(/_+$/, '');
}

/** Devuelve `base` o `base_2`, `base_3`… si ya está en uso. */
export function uniqueKey(base: string, taken: Set<string>, max = 40): string {
  if (!base) return '';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const k = `${base.slice(0, max - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!taken.has(k)) return k;
  }
  return base;
}

export function keyError(key: string, opts: { taken?: Map<string, { archived: boolean }> | Set<string>; what?: string } = {}): string | null {
  if (!key) return 'La clave es obligatoria';
  if (!KEY_RE.test(key)) return 'Usa a-z, 0-9 y _, empezando por una letra (máximo 40)';
  if ((SYSTEM_FIELD_KEYS as readonly string[]).includes(key)) return `"${key}" está reservada por el sistema`;
  const t = opts.taken;
  if (t instanceof Map) {
    const hit = t.get(key);
    if (hit) return hit.archived ? `Ya existe un ${opts.what ?? 'campo'} archivado con esta clave: restáuralo en lugar de crearlo` : `Ya existe un ${opts.what ?? 'campo'} con esta clave`;
  } else if (t?.has(key)) return `Ya existe un ${opts.what ?? 'elemento'} con esta clave`;
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Construye un change set manual con título y resumen legibles para los revisores. */
export function buildChangeSet(title: string, summary: string, operations: OperationInput[], reason?: string): ChangeSetInput {
  const t = clip(title.trim(), 140);
  const parts = [summary.trim(), reason?.trim() ? `Motivo: ${reason.trim()}` : '', 'Cambio creado con el editor manual de Personalización (sin IA).'].filter(Boolean);
  return { title: t.length >= 3 ? t : `Cambio manual: ${t}`, summary: clip(parts.join('\n\n'), 3000), operations };
}

/**
 * Envía el change set al MISMO circuito gobernado que usa la IA (validación → sandbox →
 * aprobación → publicación) y abre la petición. Nunca se modifica el blueprint directamente.
 */
export function useSubmitChangeSet(onSent?: () => void) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changeSet: ChangeSetInput) => post<{ id: string }>('/evolve/requests/manual', { changeSet }),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['evolve'] });
      toast('Cambio enviado: se valida y prueba en el sandbox antes de publicarse');
      onSent?.();
      navigate('/evolve/requests/' + id);
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
}

// ---------------------------------------------------------------- textos

export const COLOR_LABELS: Record<Color, string> = {
  slate: 'Gris',
  red: 'Rojo',
  orange: 'Naranja',
  amber: 'Ámbar',
  yellow: 'Amarillo',
  lime: 'Lima',
  green: 'Verde',
  emerald: 'Esmeralda',
  teal: 'Verde azulado',
  cyan: 'Cian',
  sky: 'Celeste',
  blue: 'Azul',
  indigo: 'Índigo',
  violet: 'Violeta',
  purple: 'Morado',
  fuchsia: 'Fucsia',
  pink: 'Rosa',
  rose: 'Rosa intenso',
};

export const PERMISSION_LABELS: Record<keyof Module['permissions'], string> = {
  read: 'Ver registros',
  create: 'Crear',
  update: 'Editar',
  delete: 'Eliminar',
};

// ---------------------------------------------------------------- UI

export function ModuleBadgeIcon({ mod, size = 'md' }: { mod: Pick<Module, 'icon' | 'color'>; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cx('flex shrink-0 items-center justify-center rounded-lg', MODULE_ACCENT[mod.color as Color] ?? MODULE_ACCENT.slate, size === 'sm' ? 'size-6' : size === 'lg' ? 'size-10 rounded-xl' : 'size-8')}>
      <ModuleIcon name={mod.icon} className={size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-5' : 'size-4'} />
    </span>
  );
}

export function IconPicker({ value, onChange, color }: { value: string; onChange: (v: IconName) => void; color: string }) {
  return (
    <div role="radiogroup" aria-label="Icono" className="grid grid-cols-8 gap-1 sm:grid-cols-11">
      {ICONS.map((ic) => (
        <button
          key={ic}
          type="button"
          role="radio"
          aria-checked={value === ic}
          aria-label={ic}
          title={ic}
          onClick={() => onChange(ic)}
          className={cx(
            'flex aspect-square items-center justify-center rounded-lg transition',
            value === ic ? cx(MODULE_ACCENT[color as Color] ?? MODULE_ACCENT.slate, 'ring-2 ring-brand-500') : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
          )}
        >
          <ModuleIcon name={ic} className="size-4" />
        </button>
      ))}
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: Color) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_LABELS[c]}
          title={COLOR_LABELS[c]}
          onClick={() => onChange(c)}
          className={cx('flex size-7 items-center justify-center rounded-full transition', value === c ? 'ring-2 ring-brand-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900' : 'hover:scale-110')}
        >
          <span className={cx('size-5 rounded-full', DOT[c])} />
        </button>
      ))}
    </div>
  );
}

/** Selector de color compacto (punto + paleta desplegable) para opciones de selección. */
export function ColorDot({ value, onChange }: { value: string; onChange: (v: Color) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`Color: ${COLOR_LABELS[value as Color] ?? value}`} title={COLOR_LABELS[value as Color] ?? value} className="flex size-9 items-center justify-center rounded-lg ring-1 ring-inset ring-zinc-200 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800">
        <span className={cx('size-4 rounded-full', DOT[value as Color] ?? DOT.slate)} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 grid w-[13.5rem] grid-cols-6 gap-1 rounded-xl bg-white p-2 shadow-xl ring-1 ring-zinc-200 animate-pop dark:bg-zinc-900 dark:ring-zinc-800">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={COLOR_LABELS[c]}
              aria-label={COLOR_LABELS[c]}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              className={cx('flex size-8 items-center justify-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800', value === c && 'bg-zinc-100 ring-1 ring-brand-500 dark:bg-zinc-800')}
            >
              <span className={cx('size-4 rounded-full', DOT[c])} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface OptionDraft {
  value: string;
  label: string;
  color: Color;
  /** true si el valor se escribió a mano (deja de autogenerarse desde la etiqueta). */
  touched?: boolean;
}

export function optionErrors(options: OptionDraft[], existing: string[] = []): (string | null)[] {
  return options.map((o, i) => {
    if (!o.label.trim()) return 'La etiqueta es obligatoria';
    if (o.label.trim().length > 80) return 'Máximo 80 caracteres';
    if (!OPTION_VALUE_RE.test(o.value)) return 'Valor inválido: minúsculas, números, _ o - (máx. 50)';
    if (existing.includes(o.value) || options.findIndex((x) => x.value === o.value) !== i) return `El valor "${o.value}" está repetido`;
    return null;
  });
}

const NEXT_COLORS: Color[] = ['sky', 'indigo', 'violet', 'amber', 'emerald', 'rose', 'teal', 'orange', 'fuchsia', 'slate'];
export const nextColor = (n: number): Color => NEXT_COLORS[n % NEXT_COLORS.length];

/** Editor de opciones nuevas (valor/etiqueta/color), con valor autogenerado desde la etiqueta. */
export function OptionsEditor({ options, onChange, existing = [], max = 100 }: { options: OptionDraft[]; onChange: (o: OptionDraft[]) => void; existing?: string[]; max?: number }) {
  const errors = optionErrors(options, existing);
  const taken = new Set([...existing, ...options.map((o) => o.value)]);
  const set = (i: number, patch: Partial<OptionDraft>) => onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...options];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {options.map((o, i) => (
        <div key={i}>
          <div className="flex items-center gap-2">
            <ColorDot value={o.color} onChange={(color) => set(i, { color })} />
            <Input
              aria-label="Etiqueta de la opción"
              placeholder="Etiqueta"
              value={o.label}
              invalid={!!errors[i] && !o.label.trim()}
              onChange={(e) => {
                const label = e.target.value;
                if (o.touched) set(i, { label });
                else {
                  const others = new Set([...existing, ...options.filter((_, j) => j !== i).map((x) => x.value)]);
                  set(i, { label, value: uniqueKey(toOptionValue(label), others, 50) });
                }
              }}
              className="min-w-0 flex-1"
            />
            <Input aria-label="Valor interno" placeholder="valor" value={o.value} invalid={!!errors[i] && !!o.label.trim()} onChange={(e) => set(i, { value: e.target.value.toLowerCase(), touched: true })} className="w-32 shrink-0 font-mono text-[12.5px] sm:w-40" />
            <div className="flex shrink-0 items-center">
              <IconButton label="Subir" disabled={i === 0} onClick={() => move(i, -1)} className="hidden disabled:opacity-30 sm:inline-flex">
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton label="Bajar" disabled={i === options.length - 1} onClick={() => move(i, 1)} className="hidden disabled:opacity-30 sm:inline-flex">
                <ArrowDown className="size-4" />
              </IconButton>
              <IconButton label="Quitar opción" onClick={() => onChange(options.filter((_, j) => j !== i))} className="hover:text-red-600">
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          </div>
          {errors[i] && (o.label || o.value) && <p className="mt-1 pl-11 text-xs text-red-600 dark:text-red-400">{errors[i]}</p>}
        </div>
      ))}
      {options.length < max && (
        <button
          type="button"
          onClick={() => onChange([...options, { value: uniqueKey(`opcion_${options.length + 1}`, taken, 50), label: '', color: nextColor(existing.length + options.length) }])}
          className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          + Añadir opción
        </button>
      )}
    </div>
  );
}

export type RiskLevel = 'low' | 'medium' | 'high';

/** Riesgo previsto según las reglas deterministas del servidor (server/src/evolve/risk.ts). */
export function RiskNote({ level, reasons }: { level: RiskLevel; reasons: string[] }) {
  const meta = {
    low: { label: 'Riesgo bajo', who: 'Lo puede aprobar un administrador.', cls: 'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/20', icon: <ShieldCheck className="mt-0.5 size-4 shrink-0" /> },
    medium: { label: 'Riesgo medio', who: 'Lo puede aprobar un administrador.', cls: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20', icon: <ShieldAlert className="mt-0.5 size-4 shrink-0" /> },
    high: { label: 'Riesgo alto', who: 'Requiere la aprobación de un propietario y confirmación explícita.', cls: 'bg-red-50 text-red-900 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20', icon: <ShieldAlert className="mt-0.5 size-4 shrink-0" /> },
  }[level];
  return (
    <div className={cx('flex gap-2.5 rounded-lg px-3 py-2.5 text-xs ring-1 ring-inset', meta.cls)}>
      {meta.icon}
      <div>
        <span className="font-semibold">{meta.label}.</span> {meta.who}
        {reasons.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 opacity-90">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Motivo opcional que se añade al resumen del change set (lo leen quienes aprueban). */
export function ReasonInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
        Motivo del cambio <span className="font-normal text-zinc-400">(opcional, lo verá quien lo apruebe)</span>
      </span>
      <Input value={value} maxLength={500} onChange={(e) => onChange(e.target.value)} placeholder="Ej.: Lo pide el equipo comercial para segmentar campañas" />
    </label>
  );
}
