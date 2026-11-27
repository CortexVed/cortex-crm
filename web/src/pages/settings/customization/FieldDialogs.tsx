import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2, Undo2 } from 'lucide-react';
import { FIELD_TYPES, FIELD_TYPE_LABELS, type Color, type FieldType } from '../../../../../shared/constants';
import { collectFieldRefs, FORMULA_FUNCTIONS, parseFormula } from '../../../../../shared/formula';
import { Alert, Badge, Button, ConfirmDialog, cx, Field, IconButton, Input, Modal, Select, Textarea, Toggle } from '../../../components/ui';
import { t, tk, tp } from '../../../lib/i18n';
import type { Automation, Field as BpField, Module } from '../../../lib/types';
import { FieldGroup } from '../ai/shared';
import {
  buildChangeSet,
  ColorDot,
  keyError,
  nextColor,
  optionErrors,
  OptionsEditor,
  ReasonInput,
  RiskNote,
  toKey,
  uniqueKey,
  useSubmitChangeSet,
  type FieldInput,
  type OperationInput,
  type OptionDraft,
  type RiskLevel,
} from './shared';

/** Tipos en los que tiene sentido exigir valores únicos. */
const UNIQUE_TYPES = new Set<FieldType>(['text', 'email', 'phone', 'url', 'number', 'currency', 'percent', 'date', 'datetime']);
const SYSTEM_REFS = new Set(['created_at', 'updated_at', 'last_activity_at']);
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'MXN', 'ARS', 'COP', 'CLP', 'PEN', 'BRL'];

function formulaError(expression: string, mod: Module, selfKey: string): string | null {
  if (!expression.trim()) return t('Escribe la expresión de la fórmula');
  if (expression.length > 1000) return t('Máximo 1000 caracteres');
  try {
    const ast = parseFormula(expression);
    for (const r of collectFieldRefs(ast)) {
      if (SYSTEM_REFS.has(r)) continue;
      if (r === selfKey) return t('La fórmula no puede referenciarse a sí misma');
      if (!mod.fields.some((f) => f.key === r && !f.archived)) return t('La fórmula usa un campo que no existe: {field}', { field: `{${r}}` });
    }
    return null;
  } catch (e) {
    return t('Fórmula inválida: {error}', { error: (e as Error).message });
  }
}

/** Detalle de tipo de un campo para listados ("→ Empresas", "EUR", "5 opciones"…). */
export function fieldTypeDetail(f: BpField, modules: Module[]): string | null {
  if (f.type === 'relation' && f.relation) return `→ ${modules.find((m) => m.key === f.relation!.module)?.labelPlural ?? f.relation.module}`;
  if (f.type === 'currency') return f.currency ?? null;
  if ((f.type === 'select' || f.type === 'multi_select') && f.options) return tp(f.options.length, '{count} opción', '{count} opciones');
  if (f.type === 'formula' && f.formula) return `= ${f.formula.expression}`;
  return null;
}

// ---------------------------------------------------------------- añadir campo

export function AddFieldModal({ open, onClose, mod, modules, defaultCurrency }: { open: boolean; onClose: () => void; mod: Module; modules: Module[]; defaultCurrency: string }) {
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<FieldType>('text');
  const [required, setRequired] = useState(false);
  const [unique, setUnique] = useState(false);
  const [helpText, setHelpText] = useState('');
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [relation, setRelation] = useState('');
  const [currency, setCurrency] = useState(/^[A-Z]{3}$/.test(defaultCurrency) ? defaultCurrency : 'EUR');
  const [expression, setExpression] = useState('');
  const [resultType, setResultType] = useState<'number' | 'text' | 'boolean'>('number');
  const [after, setAfter] = useState('');
  const [section, setSection] = useState(-1);
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const submit = useSubmitChangeSet(onClose);

  const taken = useMemo(() => new Map(mod.fields.map((f) => [f.key, { archived: f.archived }])), [mod]);
  const takenKeys = useMemo(() => new Set(mod.fields.map((f) => f.key)), [mod]);
  const activeFields = mod.fields.filter((f) => !f.archived);
  const isSelect = type === 'select' || type === 'multi_select';
  const canUnique = UNIQUE_TYPES.has(type);

  const errors = {
    label: !label.trim() ? t('La etiqueta es obligatoria') : label.trim().length > 80 ? t('Máximo 80 caracteres') : null,
    key: keyError(key, { taken, what: 'field' }),
    helpText: helpText.length > 300 ? t('Máximo 300 caracteres') : null,
    options: isSelect ? (options.length === 0 ? t('Añade al menos una opción') : optionErrors(options).some(Boolean) ? t('Revisa las opciones marcadas') : null) : null,
    relation: type === 'relation' && !relation ? t('Elige el módulo relacionado') : null,
    currency: type === 'currency' && !/^[A-Z]{3}$/.test(currency) ? t('Código ISO de 3 letras (p. ej. EUR)') : null,
    formula: type === 'formula' ? formulaError(expression, mod, key) : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  const changeType = (next: FieldType) => {
    setType(next);
    if ((next === 'select' || next === 'multi_select') && options.length === 0) setOptions([{ value: 'opcion_1', label: '', color: nextColor(0) }]);
    if (next === 'formula') {
      setRequired(false);
      setUnique(false);
    }
    if (!UNIQUE_TYPES.has(next)) setUnique(false);
  };

  const reasons: string[] = [];
  let risk: RiskLevel = 'low';
  if (required && type !== 'formula') {
    risk = 'medium';
    reasons.push(t('Campo obligatorio: los registros existentes no tendrán valor hasta que se editen.'));
  }
  if (section >= 0) {
    risk = risk === 'low' ? 'medium' : risk;
    reasons.push(t('Incluye una actualización del diseño de la ficha del módulo.'));
  }

  const send = () => {
    setShowErrors(true);
    if (invalid) return;
    const field: FieldInput = {
      key,
      label: label.trim(),
      type,
      required: type === 'formula' ? false : required,
      unique: canUnique ? unique : false,
      ...(helpText.trim() ? { helpText: helpText.trim() } : {}),
      ...(isSelect ? { options: options.map((o) => ({ value: o.value, label: o.label.trim(), color: o.color })) } : {}),
      ...(type === 'relation' ? { relation: { module: relation } } : {}),
      ...(type === 'currency' ? { currency } : {}),
      ...(type === 'formula' ? { formula: { expression: expression.trim(), resultType } } : {}),
    };
    const ops: OperationInput[] = [{ op: 'add_field', module: mod.key, field, ...(after ? { after } : {}) }];
    const sec = section >= 0 ? mod.layout?.[section] : undefined;
    if (sec && mod.layout) {
      // update_module recibe siempre icono, color y permisos actuales: el esquema rellenaría valores por defecto.
      ops.push({ op: 'update_module', module: mod.key, changes: { layout: mod.layout.map((s, i) => (i === section ? { ...s, fields: [...s.fields, key] } : s)), icon: mod.icon, color: mod.color, permissions: mod.permissions } });
    }
    const detail = [tk(FIELD_TYPE_LABELS[type]), type === 'currency' ? currency : '', type === 'relation' ? t('con {module}', { module: modules.find((m) => m.key === relation)?.labelPlural ?? relation }) : '', isSelect ? tp(options.length, '{count} opción', '{count} opciones') : ''].filter(Boolean).join(' · ');
    const summary = [
      t('Nuevo campo «{field}» (clave {key}, {detail}) en el módulo {module}.', { field: label.trim(), key, detail, module: mod.labelPlural }),
      required ? t('Es obligatorio.') : '',
      unique && canUnique ? t('No admite valores repetidos.') : '',
      sec ? t('Se muestra en la sección «{section}» de la ficha.', { section: sec.title }) : '',
    ];
    submit.mutate(
      buildChangeSet(
        t('Añadir el campo «{field}» a {module}', { field: label.trim(), module: mod.labelPlural }),
        summary.filter(Boolean).join(' '),
        ops,
        reason,
      ),
    );
  };

  const insertRef = (k: string) => setExpression((e) => `${e}${e && !e.endsWith(' ') ? ' ' : ''}{${k}}`);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('Nuevo campo en {module}', { module: mod.labelPlural })}
      description={t('Se crea un cambio que se valida y prueba en el sandbox antes de que alguien lo apruebe y publique.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancelar')}</Button>
          <Button variant="primary" loading={submit.isPending} disabled={showErrors && invalid} onClick={send}>
            {t('Enviar cambio')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Etiqueta')} required error={showErrors ? errors.label ?? undefined : undefined}>
            <Input
              value={label}
              maxLength={80}
              placeholder={t('Ej.: Fecha de cierre prevista')}
              invalid={showErrors && !!errors.label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (!keyTouched) setKey(uniqueKey(toKey(e.target.value), takenKeys));
              }}
            />
          </Field>
          <Field label={t('Clave interna')} required error={(showErrors || keyTouched) && errors.key ? errors.key : undefined} hint={t('Identificador inmutable en snake_case. Se genera desde la etiqueta.')}>
            <Input
              value={key}
              maxLength={40}
              className="font-mono text-[13px]"
              invalid={(showErrors || keyTouched) && !!errors.key}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toLowerCase());
              }}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Tipo de campo')}>
            <Select value={type} onChange={(e) => changeType(e.target.value as FieldType)}>
              {FIELD_TYPES.map((ft) => (
                <option key={ft} value={ft}>
                  {tk(FIELD_TYPE_LABELS[ft])}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('Posición')} hint={t('Orden en formularios y en «Otros campos» de la ficha.')}>
            <Select value={after} onChange={(e) => setAfter(e.target.value)}>
              <option value="">{t('Al final')}</option>
              {activeFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {t('Después de «{field}»', { field: f.label })}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {isSelect && (
          <FieldGroup label={type === 'select' ? t('Opciones') : t('Opciones (se pueden elegir varias)')} hint={showErrors && errors.options ? <span className="text-red-600 dark:text-red-400">{errors.options}</span> : t('El valor interno identifica la opción; la etiqueta y el color se pueden cambiar después.')}>
            <OptionsEditor options={options} onChange={setOptions} />
          </FieldGroup>
        )}

        {type === 'relation' && (
          <Field label={t('Módulo relacionado')} required error={showErrors ? errors.relation ?? undefined : undefined} hint={t('Cada registro podrá enlazarse con un registro de ese módulo.')}>
            <Select value={relation} invalid={showErrors && !!errors.relation} onChange={(e) => setRelation(e.target.value)}>
              <option value="">{t('Elige un módulo…')}</option>
              {modules.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.key === mod.key ? t('{module} (este mismo módulo)', { module: m.labelPlural }) : m.labelPlural}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {type === 'currency' && (
          <Field label={t('Moneda (ISO 4217)')} required error={errors.currency ?? undefined}>
            <div className="w-32">
              <Input value={currency} maxLength={3} list="evolve-currencies" className="font-mono uppercase" invalid={!!errors.currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </div>
            <datalist id="evolve-currencies">
              {CURRENCIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
        )}

        {type === 'formula' && (
          <div className="space-y-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:ring-zinc-800">
            <Field label={t('Expresión')} required error={expression ? errors.formula ?? undefined : showErrors ? errors.formula ?? undefined : undefined} hint={t('Referencia campos con {example}. Operadores + - * / %, comparaciones y funciones.', { example: `{${t('clave')}}` })}>
              <Textarea rows={3} value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="{amount} * {probability} / 100" /* i18n-ignore: fórmula con claves de campo */ className="font-mono text-[13px]" spellCheck={false} invalid={!!expression && !!errors.formula} />
            </Field>
            <FieldGroup label={t('Insertar campo')}>
              <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto scrollbar-thin">
                {[...activeFields.filter((f) => f.key !== key).map((f) => ({ key: f.key, label: f.label })), { key: 'created_at', label: t('Fecha de creación') }, { key: 'last_activity_at', label: t('Última actividad') }].map((f) => (
                  <button key={f.key} type="button" onClick={() => insertRef(f.key)} title={f.label} className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 ring-1 ring-inset ring-zinc-200 hover:bg-brand-50 hover:text-brand-700 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700 dark:hover:bg-brand-500/10">
                    {`{${f.key}}`}
                  </button>
                ))}
              </div>
            </FieldGroup>
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer font-medium text-zinc-600 dark:text-zinc-400">{t('Funciones disponibles')}</summary>
              <p className="mt-1.5 font-mono leading-relaxed">{Object.keys(FORMULA_FUNCTIONS).join(' · ')}</p>
              <p className="mt-1.5">{t('Ejemplos:')} <code className="font-mono">IF({'{'}tier{'}'} = "vip", 30, 0)</code> · <code className="font-mono">DAYS_SINCE({'{'}created_at{'}'})</code> · <code className="font-mono">COUNT_RELATED("deals", "company")</code></p>
            </details>
            <Field label={t('Tipo de resultado')}>
              <Select value={resultType} onChange={(e) => setResultType(e.target.value as 'number' | 'text' | 'boolean')} className="sm:w-56">
                <option value="number">{t('Número')}</option>
                <option value="text">{t('Texto')}</option>
                <option value="boolean">{t('Sí / No')}</option>
              </Select>
            </Field>
          </div>
        )}

        <Field label={t('Texto de ayuda')} error={errors.helpText ?? undefined} hint={t('Se muestra bajo el campo en los formularios.')}>
          <Input value={helpText} maxLength={300} onChange={(e) => setHelpText(e.target.value)} placeholder={t('Opcional')} />
        </Field>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <span title={type === 'formula' ? t('Un campo calculado no puede ser obligatorio') : undefined}>
            <Toggle checked={required && type !== 'formula'} onChange={setRequired} disabled={type === 'formula'} label={t('Obligatorio')} />
          </span>
          <span title={!canUnique ? t('No aplica a este tipo de campo') : undefined}>
            <Toggle checked={unique && canUnique} onChange={setUnique} disabled={!canUnique} label={t('Valores únicos (sin duplicados)')} />
          </span>
        </div>

        {mod.layout && mod.layout.length > 0 && (
          <Field label={t('Sección de la ficha')} hint={t('Sin sección, el campo aparece en «Otros campos» al final de la ficha.')}>
            <Select value={section} onChange={(e) => setSection(Number(e.target.value))}>
              <option value={-1}>{t('Otros campos (sin cambiar el diseño)')}</option>
              {mod.layout.map((s, i) => (
                <option key={`${s.title}-${i}`} value={i} disabled={s.fields.length >= 80}>
                  {s.title}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <ReasonInput value={reason} onChange={setReason} />
        <RiskNote level={risk} reasons={reasons} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- editar campo

export function EditFieldModal({ mod, field, onClose }: { mod: Module; field: BpField; onClose: () => void }) {
  const [label, setLabel] = useState(field.label);
  const [helpText, setHelpText] = useState(field.helpText ?? '');
  const [required, setRequired] = useState(field.required);
  const [reason, setReason] = useState('');
  const submit = useSubmitChangeSet(onClose);
  const isPrimary = mod.primaryField === field.key;
  const labelError = !label.trim() ? t('La etiqueta es obligatoria') : label.trim().length > 80 ? t('Máximo 80 caracteres') : null;
  const helpError = helpText.length > 300 ? t('Máximo 300 caracteres') : null;
  const dirty = label.trim() !== field.label || helpText.trim() !== (field.helpText ?? '') || required !== field.required;
  const changes: string[] = [];
  if (label.trim() !== field.label) changes.push(t('etiqueta «{from}» → «{to}»', { from: field.label, to: label.trim() }));
  if (helpText.trim() !== (field.helpText ?? '')) changes.push(helpText.trim() ? t('nuevo texto de ayuda') : t('se quita el texto de ayuda'));
  if (required !== field.required) changes.push(required ? t('pasa a ser obligatorio') : t('deja de ser obligatorio'));
  const risk: RiskLevel = required && !field.required ? 'medium' : 'low';

  const send = () => {
    if (labelError || helpError || !dirty) return;
    submit.mutate(
      buildChangeSet(
        t('Editar el campo «{field}» de {module}', { field: field.label, module: mod.labelPlural }),
        t('Cambios en el campo {key} del módulo {module}: {changes}.', { key: field.key, module: mod.labelPlural, changes: changes.join('; ') }),
        [
          {
            op: 'update_field',
            module: mod.key,
            field: field.key,
            // required/unique/hidden se envían siempre: el esquema de cambios rellenaría `false` por defecto.
            changes: { label: label.trim(), helpText: helpText.trim(), required: field.type === 'formula' ? false : required, unique: field.unique, hidden: field.hidden },
          },
        ],
        reason,
      ),
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('Editar «{field}»', { field: field.label })}
      description={
        <>
          <span className="font-mono">{field.key}</span> · {tk(FIELD_TYPE_LABELS[field.type])}. {t('La clave y el tipo no se cambian desde aquí.')}
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>{t('Cancelar')}</Button>
          <Button variant="primary" loading={submit.isPending} disabled={!dirty || !!labelError || !!helpError} onClick={send}>
            {t('Enviar cambio')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('Etiqueta')} required error={labelError ?? undefined}>
          <Input value={label} maxLength={80} invalid={!!labelError} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label={t('Texto de ayuda')} error={helpError ?? undefined}>
          <Input value={helpText} maxLength={300} onChange={(e) => setHelpText(e.target.value)} placeholder={t('Opcional')} />
        </Field>
        <div>
          <Toggle checked={required} onChange={setRequired} disabled={field.type === 'formula' || isPrimary} label={t('Obligatorio')} />
          {(field.type === 'formula' || isPrimary) && <p className="mt-1 text-xs text-zinc-500">{isPrimary ? t('El campo principal identifica cada registro y siempre se mantiene como está.') : t('Un campo calculado no puede ser obligatorio.')}</p>}
        </div>
        <ReasonInput value={reason} onChange={setReason} />
        {dirty && <RiskNote level={risk} reasons={risk === 'medium' ? [t('«{field}» pasa a ser obligatorio: los registros sin valor tendrán que completarlo al editarse.', { field: field.label })] : []} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- opciones / etapas

interface ExistingOption {
  value: string;
  label: string;
  color: Color;
  removed: boolean;
}

export function OptionsModal({ mod, field, automations = [], onClose }: { mod: Module; field: BpField; automations?: Automation[]; onClose: () => void }) {
  const original = useMemo(() => (field.options ?? []).map((o) => ({ value: o.value, label: o.label, color: o.color as Color, removed: false })), [field]);
  const [existing, setExisting] = useState<ExistingOption[]>(original);
  const [added, setAdded] = useState<OptionDraft[]>([]);
  const [reason, setReason] = useState('');
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const submit = useSubmitChangeSet(onClose);

  const kept = existing.filter((o) => !o.removed);
  const removed = existing.filter((o) => o.removed);
  const existingValues = existing.map((o) => o.value);
  const addedErrors = optionErrors(added, existingValues);
  const labelErrors = existing.map((o) => (!o.label.trim() ? t('La etiqueta es obligatoria') : o.label.trim().length > 80 ? t('Máximo 80 caracteres') : null));
  const origOf = (value: string) => original.find((x) => x.value === value);
  const renamed = existing.filter((o) => !o.removed && o.label.trim() !== origOf(o.value)?.label);
  const recolored = existing.filter((o) => !o.removed && o.color !== origOf(o.value)?.color);
  const reordered = existing.some((o, i) => o.value !== original[i]?.value);
  const modified = removed.length > 0 || renamed.length > 0 || recolored.length > 0 || reordered;
  // El sandbox rechaza un valor por defecto que ya no existe: se bloquea antes de enviar.
  const defaultRemoved = removed.find((o) => o.value === field.defaultValue);
  const isRemoved = (v: unknown) => removed.some((r) => r.value === v || (Array.isArray(v) && v.includes(r.value)));
  const affectedAutomations = removed.length
    ? automations.filter(
        (a) =>
          a.trigger.module === mod.key &&
          ((a.trigger.type === 'field_changed' && a.trigger.field === field.key && isRemoved(a.trigger.to)) ||
            a.conditions.some((c) => c.field === field.key && isRemoved(c.value)) ||
            a.actions.some((x) => x.type === 'update_field' && x.field === field.key && isRemoved(x.value))),
      )
    : [];
  const invalid = addedErrors.some(Boolean) || labelErrors.some(Boolean) || kept.length + added.length === 0 || kept.length + added.length > 100 || !!defaultRemoved;
  const dirty = modified || added.length > 0;
  const kanban = mod.views.filter((v) => v.type === 'kanban' && v.groupBy === field.key);

  const set = (i: number, patch: Partial<ExistingOption>) => setExisting(existing.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...existing];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setExisting(next);
  };

  const risk: RiskLevel = removed.length ? 'high' : 'low';
  const reasons = removed.length ? [t('Se eliminan opciones de «{field}»: {options}.', { field: field.label, options: removed.map((r) => r.label).join(', ') })] : [];

  const send = () => {
    if (invalid || !dirty) return;
    const newOptions = added.map((o) => ({ value: o.value, label: o.label.trim(), color: o.color }));
    let op: OperationInput;
    let summary: string;
    if (!modified && newOptions.length <= 50) {
      // add_select_options admite hasta 50 opciones por operación; si hay más se envía la lista completa.
      op = { op: 'add_select_options', module: mod.key, field: field.key, options: newOptions };
      summary = t('Nuevas opciones en «{field}» ({module}): {options}.', { field: field.label, module: mod.labelPlural, options: newOptions.map((o) => o.label).join(', ') });
    } else {
      const options = [...kept.map((o) => ({ value: o.value, label: o.label.trim(), color: o.color })), ...newOptions];
      // Lista completa de opciones; required/unique/hidden se envían para no perderlos.
      op = { op: 'update_field', module: mod.key, field: field.key, changes: { options, required: field.required, unique: field.unique, hidden: field.hidden } };
      const parts: string[] = [];
      if (renamed.length) parts.push(t('renombradas: {options}', { options: renamed.map((o) => `${origOf(o.value)?.label} → ${o.label.trim()}`).join(', ') }));
      if (recolored.length) parts.push(t('nuevo color: {options}', { options: recolored.map((o) => o.label.trim()).join(', ') }));
      if (reordered) parts.push(t('nuevo orden'));
      if (newOptions.length) parts.push(t('añadidas: {options}', { options: newOptions.map((o) => o.label).join(', ') }));
      if (removed.length) parts.push(t('ELIMINADAS: {options}', { options: removed.map((o) => o.label).join(', ') }));
      summary = t('Opciones de «{field}» ({module}) — {changes}.', { field: field.label, module: mod.labelPlural, changes: parts.join('; ') });
    }
    const title = kanban.length ? t('Etapas de «{field}» en {module}', { field: field.label, module: mod.labelPlural }) : t('Opciones de «{field}» en {module}', { field: field.label, module: mod.labelPlural });
    submit.mutate(buildChangeSet(title, summary, [op], reason));
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={kanban.length ? t('Etapas de «{field}»', { field: field.label }) : t('Opciones de «{field}»', { field: field.label })}
      description={kanban.length ? t('Este campo define las columnas de {views}: el orden de las opciones es el orden de las etapas.', { views: kanban.map((v) => `«${v.label}»`).join(', ') }) : t('Cambia etiquetas, colores u orden, o añade opciones nuevas.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancelar')}</Button>
          <Button variant={removed.length ? 'danger' : 'primary'} loading={submit.isPending && !confirmRemoval} disabled={!dirty || invalid} onClick={() => (removed.length ? setConfirmRemoval(true) : send())}>
            {t('Enviar cambio')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldGroup label={t('Opciones actuales')}>
          <ul className="space-y-2">
            {existing.map((o, i) => (
              <li key={o.value}>
                <div className={cx('flex items-center gap-2', o.removed && 'opacity-60')}>
                  <ColorDot value={o.color} onChange={(color) => set(i, { color })} />
                  <Input aria-label={t('Etiqueta de {value}', { value: o.value })} value={o.label} disabled={o.removed} invalid={!!labelErrors[i]} maxLength={80} onChange={(e) => set(i, { label: e.target.value })} className={cx('min-w-0 flex-1', o.removed && 'line-through')} />
                  <span className="hidden w-36 shrink-0 truncate font-mono text-[12px] text-zinc-500 sm:block" title={t('Valor interno (no se puede cambiar)')}>
                    {o.value}
                  </span>
                  <div className="flex shrink-0 items-center">
                    <IconButton label={t('Subir@@posición')} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton label={t('Bajar')} disabled={i === existing.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" />
                    </IconButton>
                    {o.removed ? (
                      <IconButton label={t('Mantener opción')} onClick={() => set(i, { removed: false })}>
                        <Undo2 className="size-4" />
                      </IconButton>
                    ) : (
                      <IconButton label={t('Eliminar opción')} onClick={() => set(i, { removed: true })} danger>
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                </div>
                {o.removed && (
                  <p className="mt-1 pl-11 text-xs text-red-600 dark:text-red-400">
                    {o.value === field.defaultValue ? t('Es el valor por defecto del campo: no se puede eliminar desde aquí (pide el cambio a EVOLVE AI ENGINE).') : t('Se eliminará al publicar el cambio.')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </FieldGroup>

        <FieldGroup label={t('Opciones nuevas')}>
          <OptionsEditor options={added} onChange={setAdded} existing={existingValues} max={Math.max(0, 100 - kept.length)} />
        </FieldGroup>

        {removed.length > 0 && (
          <Alert tone="danger" title={t('Eliminar opciones es un cambio de riesgo alto')}>
            {t('Requiere la aprobación de un propietario.')}{' '}
            {tp(
              removed.length,
              'Los registros que ya usan esa opción conservarán el valor guardado, pero tendrán que cambiarlo la próxima vez que se editen.',
              'Los registros que ya usan esas opciones conservarán el valor guardado, pero tendrán que cambiarlo la próxima vez que se editen.',
            )}{' '}
            {t('Si solo quieres dejar de usarla, considera renombrarla (p. ej. «Obsoleta»).')}
          </Alert>
        )}
        {affectedAutomations.length > 0 && (
          <Alert tone="warning" title={t('Automatizaciones que usan estas opciones')}>
            {t('{automations}. Revísalas: si dependen de una opción eliminada, el cambio puede no superar las pruebas del sandbox.', { automations: affectedAutomations.map((a) => `«${a.name}»`).join(', ') })}
          </Alert>
        )}
        <ReasonInput value={reason} onChange={setReason} />
        {dirty && <RiskNote level={risk} reasons={reasons} />}
      </div>
      <ConfirmDialog
        open={confirmRemoval}
        onClose={() => setConfirmRemoval(false)}
        onConfirm={send}
        loading={submit.isPending}
        danger
        title={tp(removed.length, '¿Eliminar una opción de «{field}»?', '¿Eliminar {count} opciones de «{field}»?', { field: field.label })}
        description={t('Se enviará como cambio de riesgo alto: un propietario tendrá que aprobarlo antes de publicarse.')}
        confirmLabel={t('Enviar cambio')}
      >
        <div className="flex flex-wrap gap-1.5">
          {removed.map((o) => (
            <Badge key={o.value} color={o.color} dot>
              <span className="line-through">{o.label}</span>
            </Badge>
          ))}
        </div>
      </ConfirmDialog>
    </Modal>
  );
}
