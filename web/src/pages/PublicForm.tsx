import { useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, FileX, Lock, Send, Star } from 'lucide-react';
import { Alert, Button, ErrorState, Field, Input, Select, Skeleton, Textarea, cx } from '../components/ui';
import { ApiError, errorMessage, get, post } from '../lib/api';
import { useTheme } from '../lib/hooks';
import type { FieldType } from '../../../shared/constants';

interface PublicField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string; color?: string }[];
  helpText?: string;
}

interface PublicFormDef {
  organization: string;
  name: string;
  submitLabel: string;
  fields: PublicField[];
}

type Value = string | boolean | string[] | number | null;
type Values = Record<string, Value>;
type Notice = { tone: 'danger' | 'warning'; title: string; text?: string };

// Tipos que se pueden rellenar desde un formulario público (relaciones, usuarios, archivos y fórmulas no).
const SUPPORTED = new Set<FieldType>(['text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'email', 'phone', 'url', 'select', 'multi_select', 'rating']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const INPUTS: Partial<Record<FieldType, { type: string; inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode']; autoComplete?: string; placeholder?: string; step?: string; suffix?: string }>> = {
  text: { type: 'text' },
  email: { type: 'email', inputMode: 'email', autoComplete: 'email', placeholder: 'nombre@empresa.com' },
  phone: { type: 'tel', inputMode: 'tel', autoComplete: 'tel', placeholder: '+34 600 000 000' },
  url: { type: 'url', inputMode: 'url', autoComplete: 'url', placeholder: 'https://' },
  number: { type: 'number', inputMode: 'decimal', step: 'any' },
  currency: { type: 'number', inputMode: 'decimal', step: 'any' },
  percent: { type: 'number', inputMode: 'decimal', step: 'any', suffix: '%' },
  date: { type: 'date' },
  datetime: { type: 'datetime-local' },
};

// Autocompletado del navegador para los campos de texto habituales (sobre todo en móvil).
function textAutoComplete(key: string): string | undefined {
  if (/^(first_?name|nombre)$/.test(key)) return 'given-name';
  if (/^(last_?name|apellidos?)$/.test(key)) return 'family-name';
  if (/^(full_?name|name)$/.test(key)) return 'name';
  if (/^(company|company_name|empresa|organization)$/.test(key)) return 'organization';
  if (/^(job_?title|position|cargo|puesto)$/.test(key)) return 'organization-title';
  return undefined;
}

const fieldId = (key: string) => `pf-${key}`;

function initialValue(f: PublicField): Value {
  if (f.type === 'boolean') return false;
  if (f.type === 'multi_select') return [];
  if (f.type === 'rating') return null;
  return '';
}

function validate(fields: PublicField[], values: Values): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'boolean') {
      if (f.required && v !== true) errs[f.key] = 'Debes marcar esta casilla para continuar';
      continue;
    }
    const empty = v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) errs[f.key] = 'Este campo es obligatorio';
      continue;
    }
    if (f.type === 'email' && typeof v === 'string' && !EMAIL_RE.test(v.trim())) errs[f.key] = 'Introduce un email válido';
  }
  return errs;
}

/** Convierte los valores del formulario al formato que espera la API (vacíos fuera, números como número, fecha y hora en ISO). */
function serialize(fields: PublicField[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    switch (f.type) {
      case 'boolean':
        out[f.key] = v === true;
        break;
      case 'multi_select':
        if (Array.isArray(v) && v.length) out[f.key] = v;
        break;
      case 'rating':
        if (typeof v === 'number') out[f.key] = v;
        break;
      case 'number':
      case 'currency':
      case 'percent': {
        const s = typeof v === 'string' ? v.trim().replace(',', '.') : '';
        if (s) out[f.key] = Number.isFinite(Number(s)) ? Number(s) : s;
        break;
      }
      case 'datetime': {
        // datetime-local no lleva zona: se interpreta en la hora local del visitante.
        const s = typeof v === 'string' ? v : '';
        if (s) {
          const d = new Date(s);
          out[f.key] = Number.isNaN(d.getTime()) ? s : d.toISOString();
        }
        break;
      }
      case 'long_text':
        if (typeof v === 'string' && v.trim()) out[f.key] = v;
        break;
      default:
        if (typeof v === 'string' && v.trim()) out[f.key] = v.trim();
    }
  }
  return out;
}

export default function PublicForm() {
  useTheme();
  const { slug = '', form = '' } = useParams();
  const url = `/public/forms/${encodeURIComponent(slug)}/${encodeURIComponent(form)}`;
  const q = useQuery({ queryKey: ['public-form', slug, form], queryFn: () => get<PublicFormDef>(url), staleTime: 5 * 60_000 });

  useEffect(() => {
    if (!q.data) return;
    const prev = document.title;
    document.title = `${q.data.name} · ${q.data.organization}`;
    return () => {
      document.title = prev;
    };
  }, [q.data]);

  let content: ReactNode = null;
  if (q.isLoading) content = <FormSkeleton />;
  else if (q.error instanceof ApiError && q.error.status === 404) content = <Unavailable />;
  else if (q.isError) content = <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-8" />;
  else if (q.data) content = <FormBody def={q.data} url={url} />;

  return <Shell>{content}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-zinc-50 px-4 py-8 sm:justify-center sm:py-14 dark:bg-zinc-950">
      <main className="w-full max-w-xl animate-pop">
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800">
          <div aria-hidden className="h-1 evolve-gradient" />
          <div className="p-6 sm:p-8">{children}</div>
        </div>
        <footer className="mt-6 flex items-center justify-center gap-1.5 text-xs text-zinc-400 dark:text-zinc-500">
          <img src="/favicon.svg" alt="" className="size-4" />
          <span>
            Con la tecnología de <span className="font-semibold text-zinc-500 dark:text-zinc-400">Cortex CRM</span>
          </span>
        </footer>
      </main>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Cargando formulario">
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-7 w-64 max-w-full" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

function Unavailable() {
  return (
    <div className="py-6 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        <FileX className="size-7" />
      </div>
      <h1 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-white">Formulario no disponible</h1>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-zinc-500">Puede que el enlace no sea correcto o que el formulario ya no acepte respuestas. Si crees que es un error, contacta con quien te lo envió.</p>
    </div>
  );
}

function Success({ message, onAgain }: { message: string; onAgain: () => void }) {
  return (
    <div className="py-6 text-center animate-pop" role="status">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">
        <CircleCheck className="size-7" />
      </div>
      <h1 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-white">Formulario enviado</h1>
      <p className="mx-auto mt-1.5 max-w-sm whitespace-pre-line text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
      <Button className="mt-6" onClick={onAgain}>
        Enviar otra respuesta
      </Button>
    </div>
  );
}

function FormBody({ def, url }: { def: PublicFormDef; url: string }) {
  const fields = def.fields.filter((f) => SUPPORTED.has(f.type));
  const blank = (): Values => Object.fromEntries(fields.map((f) => [f.key, initialValue(f)]));
  const [values, setValues] = useState<Values>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [website, setWebsite] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const focusFirst = (keys: string[]) => {
    const first = fields.find((f) => keys.includes(f.key));
    if (first) setFocusKey(first.key);
  };

  const m = useMutation({
    mutationFn: (payload: { values: Record<string, unknown>; website: string }) => post<{ ok: boolean; message: string }>(url, payload),
    onSuccess: (res) => setDone(res.message || '¡Gracias! Hemos recibido tus datos.'),
    onError: (e) => {
      if (e instanceof ApiError && e.status === 429) {
        setNotice({ tone: 'warning', title: 'Demasiados envíos seguidos', text: 'Por seguridad limitamos los envíos por minuto. Espera un momento y vuelve a intentarlo: tus respuestas se mantienen.' });
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        setNotice({ tone: 'danger', title: 'Formulario no disponible', text: 'Este formulario ya no acepta respuestas.' });
        return;
      }
      const fieldErrors = e instanceof ApiError ? e.fieldErrors : {};
      const keys = Object.keys(fieldErrors);
      if (keys.length) {
        const shown = Object.fromEntries(Object.entries(fieldErrors).filter(([k]) => fields.some((f) => f.key === k)));
        // Errores de campos que no se muestran en el formulario: se indican con su etiqueta.
        const other = keys.filter((k) => !(k in shown)).map((k) => `${def.fields.find((f) => f.key === k)?.label ?? k}: ${fieldErrors[k]}`);
        setErrors(shown);
        setNotice({ tone: 'danger', title: 'Revisa los campos marcados', text: other.length ? other.join(' · ') : undefined });
        focusFirst(Object.keys(shown));
        return;
      }
      setNotice({ tone: 'danger', title: 'No se ha podido enviar el formulario', text: errorMessage(e) });
    },
  });

  // El foco se mueve cuando los controles vuelven a estar habilitados (durante el envío están deshabilitados).
  useEffect(() => {
    if (!focusKey || m.isPending) return;
    document.getElementById(fieldId(focusKey))?.focus();
    setFocusKey(null);
  }, [focusKey, m.isPending]);

  const setValue = (key: string, v: Value) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (m.isPending) return;
    setNotice(null);
    const errs = validate(fields, values);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setNotice({ tone: 'danger', title: 'Revisa los campos marcados' });
      focusFirst(Object.keys(errs));
      return;
    }
    m.mutate({ values: serialize(fields, values), website });
  };

  const again = () => {
    setValues(blank());
    setErrors({});
    setNotice(null);
    setDone(null);
    m.reset();
  };

  if (done) return <Success message={done} onAgain={again} />;

  return (
    <form noValidate onSubmit={submit} className="relative space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400">{def.organization}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">{def.name}</h1>
        {fields.some((f) => f.required) && (
          <p className="mt-1.5 text-xs text-zinc-500">
            Los campos marcados con <span className="text-red-500">*</span> son obligatorios.
          </p>
        )}
      </header>

      {fields.map((f) => (
        <FormField key={f.key} field={f} value={values[f.key] ?? initialValue(f)} error={errors[f.key]} disabled={m.isPending} onChange={(v) => setValue(f.key, v)} />
      ))}

      {/* Honeypot anti-bots: invisible para personas y lectores de pantalla; si llega relleno, el servidor descarta el envío. */}
      <div aria-hidden="true" className="pointer-events-none absolute left-[-10000px] top-auto size-px overflow-hidden opacity-0">
        <label htmlFor="pf-website">Sitio web</label>
        <input id="pf-website" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text}
        </Alert>
      )}

      <Button type="submit" variant="primary" className="w-full" loading={m.isPending} icon={<Send className="size-4" />}>
        {def.submitLabel || 'Enviar'}
      </Button>
      <p className="flex items-start justify-center gap-1.5 text-center text-xs text-zinc-500">
        <Lock className="mt-0.5 size-3 shrink-0" /> Tus datos se enviarán de forma segura a {def.organization}.
      </p>
    </form>
  );
}

function Help({ error, hint, className }: { error?: string; hint?: string; className?: string }) {
  if (error) return <p className={cx('mt-1 text-xs text-red-600 dark:text-red-400', className)}>{error}</p>;
  if (hint) return <p className={cx('mt-1 text-xs text-zinc-500', className)}>{hint}</p>;
  return null;
}

/** Grupo de controles (casillas, valoración): fieldset en lugar de <label> para no asociar varios controles a una etiqueta. */
function Group({ label, required, error, hint, children }: { label: string; required?: boolean; error?: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </legend>
      {children}
      <Help error={error} hint={hint} />
    </fieldset>
  );
}

function FormField({ field: f, value, error, disabled, onChange }: { field: PublicField; value: Value; error?: string; disabled?: boolean; onChange: (v: Value) => void }) {
  const id = fieldId(f.key);
  const invalid = !!error;
  const str = typeof value === 'string' ? value : '';

  switch (f.type) {
    case 'boolean':
      return (
        <div>
          <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-800 dark:text-zinc-200">
            <input id={id} type="checkbox" disabled={disabled} aria-invalid={invalid || undefined} checked={value === true} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 cursor-pointer accent-brand-600" />
            <span>
              {f.label}
              {f.required && <span className="ml-0.5 text-red-500">*</span>}
            </span>
          </label>
          <Help error={error} hint={f.helpText} className="pl-[26px]" />
        </div>
      );

    case 'multi_select': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <Group label={f.label} required={f.required} error={error} hint={f.helpText}>
          <div className="grid gap-2 sm:grid-cols-2">
            {(f.options ?? []).map((o, i) => {
              const checked = selected.includes(o.value);
              return (
                <label
                  key={o.value}
                  className={cx(
                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm ring-1 ring-inset transition',
                    checked ? 'bg-brand-50 text-brand-900 ring-brand-300 dark:bg-brand-500/10 dark:text-brand-100 dark:ring-brand-500/40' : 'text-zinc-800 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800/60',
                    invalid && !checked && 'ring-red-300 dark:ring-red-500/50',
                  )}
                >
                  <input
                    id={i === 0 ? id : undefined}
                    type="checkbox"
                    disabled={disabled}
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))}
                    className="size-4 shrink-0 cursor-pointer accent-brand-600"
                  />
                  <span className="min-w-0 break-words">{o.label}</span>
                </label>
              );
            })}
          </div>
        </Group>
      );
    }

    case 'rating': {
      const current = typeof value === 'number' ? value : 0;
      return (
        <Group label={f.label} required={f.required} error={error} hint={f.helpText}>
          <div className="flex items-center gap-1" role="radiogroup" aria-label={f.label}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                id={n === 1 ? id : undefined}
                type="button"
                role="radio"
                aria-checked={current === n}
                aria-label={`${n} de 5`}
                disabled={disabled}
                onClick={() => onChange(current === n ? null : n)}
                className="rounded-md p-1 text-zinc-300 transition hover:text-amber-400 dark:text-zinc-600 dark:hover:text-amber-400"
              >
                <Star className={cx('size-6', n <= current && 'fill-amber-400 text-amber-400')} />
              </button>
            ))}
          </div>
        </Group>
      );
    }

    case 'select':
      return (
        <Field label={f.label} required={f.required} error={error} hint={f.helpText}>
          <Select id={id} disabled={disabled} invalid={invalid} aria-invalid={invalid || undefined} value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">Selecciona una opción…</option>
            {(f.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );

    case 'long_text':
      return (
        <Field label={f.label} required={f.required} error={error} hint={f.helpText}>
          <Textarea id={id} rows={4} disabled={disabled} invalid={invalid} aria-invalid={invalid || undefined} value={str} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );

    default: {
      const cfg = INPUTS[f.type] ?? { type: 'text' };
      return (
        <Field label={f.label} required={f.required} error={error} hint={f.helpText}>
          <div className="relative">
            <Input
              id={id}
              type={cfg.type}
              inputMode={cfg.inputMode}
              autoComplete={cfg.autoComplete ?? (f.type === 'text' ? textAutoComplete(f.key) : undefined)}
              placeholder={cfg.placeholder}
              step={cfg.step}
              disabled={disabled}
              invalid={invalid}
              aria-invalid={invalid || undefined}
              value={str}
              onChange={(e) => onChange(e.target.value)}
              className={cfg.suffix ? 'pr-9' : undefined}
            />
            {cfg.suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-zinc-400">{cfg.suffix}</span>}
          </div>
        </Field>
      );
    }
  }
}
