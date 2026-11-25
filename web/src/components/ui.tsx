import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Inbox, Loader2, RefreshCw, X } from 'lucide-react';
import { BADGE, DOT } from '../lib/colors';
import { initials } from '../lib/format';
import type { Color } from '../../../shared/constants';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'dangerGhost' | 'danger' | 'ai';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm shadow-brand-600/20 disabled:bg-brand-600/60',
  secondary: 'bg-white text-zinc-800 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
  // Acción destructiva discreta (Eliminar, Rechazar…): `cx` no resuelve conflictos de clases de Tailwind, así que el
  // color va en su propia variante en lugar de sobrescribir el de `ghost` con className.
  dangerGhost: 'text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10 dark:hover:text-red-300',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-600/60',
  ai: 'evolve-gradient text-white shadow-sm shadow-fuchsia-500/25 hover:brightness-110 disabled:opacity-60',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100',
          size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
          VARIANTS[variant],
          className,
        )}
        disabled={disabled || loading}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
        {children}
      </button>
    );
  },
);

/**
 * Botón de icono. `danger` para quitar o archivar (el color de hover no se puede cambiar con className: `cx` no
 * resuelve conflictos de Tailwind). Desactivado se atenúa y no reacciona al hover; su `title` sigue explicando por qué.
 */
export function IconButton({ label, className, children, danger, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-8 items-center justify-center rounded-lg text-zinc-500 transition dark:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-30',
        danger
          ? 'enabled:hover:bg-red-50 enabled:hover:text-red-600 dark:enabled:hover:bg-red-500/10 dark:enabled:hover:text-red-400'
          : 'enabled:hover:bg-zinc-100 enabled:hover:text-zinc-900 dark:enabled:hover:bg-zinc-800 dark:enabled:hover:text-zinc-100',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const inputBase =
  'w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs ring-1 ring-inset ring-zinc-200 placeholder:text-zinc-400 focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-500 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:placeholder:text-zinc-500 dark:disabled:bg-zinc-800';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={cx(inputBase, 'h-9', invalid && 'ring-red-400 focus:ring-red-500 dark:ring-red-500/60', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputBase, 'min-h-20 resize-y', invalid && 'ring-red-400', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ className, invalid, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(inputBase, 'h-9 pr-8', invalid && 'ring-red-400', className)} {...rest}>
      {children}
    </select>
  );
});

/**
 * Campo de formulario. Por defecto es un <label> (clicar el texto enfoca el control). Para controles compuestos
 * (varios botones, estrellas, archivos, buscadores) usa `as="div"`: un <label> reenviaría el clic a su primer
 * botón y, p. ej., alternaría la primera opción o quitaría el primer adjunto.
 */
export function Field({ label, hint, error, required, children, className, as = 'label' }: { label?: string; hint?: string; error?: string; required?: boolean; children: ReactNode; className?: string; as?: 'label' | 'div' }) {
  const labelId = useId();
  const body = (
    <>
      {label && (
        <span id={labelId} className="mb-1.5 block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </span>
      )}
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{error}</span> : hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
    </>
  );
  if (as === 'div') {
    return (
      <div role="group" aria-labelledby={label ? labelId : undefined} className={cx('block', className)}>
        {body}
      </div>
    );
  }
  return <label className={cx('block', className)}>{body}</label>;
}

export function Badge({ color = 'slate', children, dot, className }: { color?: Color | string; children: ReactNode; dot?: boolean; className?: string }) {
  const c = (BADGE as Record<string, string>)[color] ?? BADGE.slate;
  return (
    <span className={cx('inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', c, className)}>
      {dot && <span className={cx('size-1.5 shrink-0 rounded-full', (DOT as Record<string, string>)[color] ?? DOT.slate)} />}
      {children}
    </span>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-xl bg-white ring-1 ring-zinc-200/80 shadow-xs dark:bg-zinc-900 dark:ring-zinc-800', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            {title && <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-zinc-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-zinc-400', className)} aria-label="Cargando" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800', className)} />;
}

export function PageLoader() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{icon ?? <Inbox className="size-5" />}</div>
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-zinc-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = (error as Error)?.message ?? 'Error inesperado';
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
        <AlertTriangle className="size-5" />
      </div>
      <h3 className="text-sm font-semibold">No se ha podido cargar</h3>
      <p className="mt-1 max-w-md text-sm text-zinc-500">{msg}</p>
      {onRetry && (
        <Button className="mt-4" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}

/** `onDark`: sobre una superficie siempre oscura (p. ej. la cabecera de EVOLVE), con colores claros en cualquier tema. */
export function Alert({ tone = 'info', title, children, className, onDark }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; className?: string; onDark?: boolean }) {
  const tones = {
    info: 'bg-sky-50 text-sky-900 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-500/20',
    warning: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20',
    danger: 'bg-red-50 text-red-900 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20',
    success: 'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/20',
  };
  const darkSurface = {
    info: 'bg-sky-500/10 text-sky-100 ring-sky-500/30',
    warning: 'bg-amber-500/10 text-amber-100 ring-amber-500/30',
    danger: 'bg-red-500/10 text-red-100 ring-red-500/30',
    success: 'bg-emerald-500/10 text-emerald-100 ring-emerald-500/30',
  };
  return (
    <div className={cx('rounded-lg px-3.5 py-3 text-sm ring-1 ring-inset', onDark ? darkSurface[tone] : tones[tone], className)} role={tone === 'danger' ? 'alert' : undefined}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={cx(!!title && 'mt-0.5', 'opacity-90')}>{children}</div>}
    </div>
  );
}

/**
 * Pila de capas para Escape: modales, cajones, la paleta, los menús y los desplegables se apilan y solo responde la
 * de arriba (antes cada una escuchaba en window y un Escape las cerraba todas, perdiendo lo no guardado).
 */
const escapeStack: { close: () => void }[] = [];
let escapeListening = false;
function onEscapeKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
}

export function useEscapeLayer(open: boolean, onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = { close: () => latest.current() };
    escapeStack.push(entry);
    if (!escapeListening) {
      window.addEventListener('keydown', onEscapeKey, true);
      escapeListening = true;
    }
    return () => {
      const i = escapeStack.lastIndexOf(entry);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [open]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Foco de una capa: al abrir va dentro (el primer campo o [data-autofocus]); al cerrar vuelve a donde estaba. */
function useLayerFocus(open: boolean, ref: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select') ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }, 30);
    return () => {
      clearTimeout(t);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}

/** Tab y Mayús+Tab no salen de la capa (foco atrapado mientras está abierta). */
function trapTab(e: { key: string; shiftKey: boolean; preventDefault: () => void }, container: HTMLElement | null) {
  if (e.key !== 'Tab' || !container) return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Clic en el fondo (no en la barra de scroll del propio fondo, que es parte del mismo elemento). */
function isBackdropClick(e: { target: EventTarget; currentTarget: HTMLElement; clientX: number }) {
  if (e.target !== e.currentTarget) return false;
  const el = e.currentTarget;
  return e.clientX < el.getBoundingClientRect().left + el.clientWidth;
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEscapeLayer(open, onClose);
  const ref = useRef<HTMLDivElement>(null);
  useLayerFocus(open, ref);
  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/40 p-4 pt-[8vh] backdrop-blur-[2px] animate-fade-in" onMouseDown={(e) => isBackdropClick(e) && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" onKeyDown={(e) => trapTab(e, ref.current)} className={cx('w-full rounded-2xl bg-white shadow-2xl ring-1 ring-zinc-200 animate-pop dark:bg-zinc-900 dark:ring-zinc-800', widths[size])}>
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
          </div>
          <IconButton label="Cerrar" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 rounded-b-2xl border-t border-zinc-100 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, width = 'max-w-xl' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string }) {
  useEscapeLayer(open, onClose);
  const ref = useRef<HTMLDivElement>(null);
  useLayerFocus(open, ref);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-zinc-950/30 animate-fade-in" onMouseDown={(e) => isBackdropClick(e) && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" onKeyDown={(e) => trapTab(e, ref.current)} className={cx('flex h-full w-full flex-col bg-white shadow-2xl animate-slide-in dark:bg-zinc-900', width)}>
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton label="Cerrar" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { key: T; label: ReactNode; count?: number }[]; value: T; onChange: (k: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx('flex gap-1 overflow-x-auto border-b border-zinc-200 scrollbar-thin dark:border-zinc-800', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition',
            value === t.key ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-zinc-100 px-1.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-sans text-[11px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">{children}</kbd>;
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const palette = ['bg-brand-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-fuchsia-500'];
  const color = palette[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length];
  return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', color, size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs')}>{initials(name) || '?'}</span>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative inline-flex h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50', checked ? 'bg-brand-600' : 'bg-zinc-300 dark:bg-zinc-700')}
      >
        {/* transform (no left): no recalcula el diseño en cada fotograma y escala con la densidad (rem). */}
        <span className={cx('absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
      {label && (
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
      )}
    </span>
  );
}

export function PageHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Diálogo de confirmación; con `typed` exige escribir una palabra (operaciones de riesgo). */
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger, typed, loading, children }: { open: boolean; onClose: () => void; onConfirm: (typedValue: string) => void; title: string; description?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; typed?: string; loading?: boolean; children?: ReactNode }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue('');
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          {/* En una acción destructiva el foco va a Cancelar: un Enter repetido no borra nada por accidente. */}
          <Button onClick={onClose} data-autofocus={danger && !typed ? true : undefined}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} disabled={!!typed && value !== typed} onClick={() => onConfirm(value)} data-autofocus={!danger ? true : undefined}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {typed && (
        <Field label={`Escribe ${typed} para confirmar`} className="mt-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        </Field>
      )}
    </Modal>
  );
}

export function StatTile({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200/80 shadow-xs dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-center justify-between text-xs font-medium text-zinc-500">
        {label}
        {icon}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}
