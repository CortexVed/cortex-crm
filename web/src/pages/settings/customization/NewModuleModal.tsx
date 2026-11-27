import { useMemo, useState } from 'react';
import type { Color, IconName } from '../../../../../shared/constants';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import { effectiveLocale, msg, t, tk, type Locale } from '../../../lib/i18n';
import { useSession } from '../../../lib/session';
import type { Module } from '../../../lib/types';
import { FieldGroup } from '../ai/shared';
import { buildChangeSet, ColorPicker, IconPicker, keyError, ModuleBadgeIcon, ReasonInput, RiskNote, toKey, uniqueKey, useSubmitChangeSet, type ModuleInput } from './shared';

/**
 * Plural orientativo (editable) en el idioma de la organización, porque el nombre del módulo es un dato suyo.
 * Español: vocal → +s, z → ces, resto → +es. Inglés: consonante + y → ies; s, x, z, ch, sh → +es; resto → +s.
 * En los demás idiomas se propone el mismo texto.
 */
function pluralize(s: string, locale: Locale): string {
  const word = s.trim();
  if (!word) return '';
  if (locale === 'es') {
    if (/[aeiouáéíóú]$/i.test(word)) return `${word}s`;
    if (/z$/i.test(word)) return `${word.slice(0, -1)}ces`;
    return `${word}es`;
  }
  if (locale === 'en') {
    if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
    if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
    return `${word}s`;
  }
  return word;
}

export function NewModuleModal({ open, onClose, modules }: { open: boolean; onClose: () => void; modules: Module[] }) {
  const { me } = useSession();
  const orgLocale = effectiveLocale(null, me?.workspace?.locale ?? null);
  // Las etiquetas por defecto (campo principal y vista) también son datos de la organización: en español si es su
  // idioma (el texto del código); si no, en el de la interfaz, que es el único catálogo cargado (y suele coincidir).
  const orgText = (text: string) => (orgLocale === 'es' ? text : tk(text));
  const [label, setLabel] = useState('');
  const [plural, setPlural] = useState('');
  const [pluralTouched, setPluralTouched] = useState(false);
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [icon, setIcon] = useState<IconName>('box');
  const [color, setColor] = useState<Color>('indigo');
  const [description, setDescription] = useState('');
  const [primaryLabel, setPrimaryLabel] = useState(() => orgText(msg('Nombre')));
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const submit = useSubmitChangeSet(onClose);
  const taken = useMemo(() => new Map(modules.map((m) => [m.key, { archived: m.archived }])), [modules]);
  const takenKeys = useMemo(() => new Set(modules.map((m) => m.key)), [modules]);

  const syncKey = (pl: string) => {
    if (!keyTouched) setKey(uniqueKey(toKey(pl), takenKeys));
  };

  const errors = {
    label: !label.trim() ? t('Obligatorio') : label.trim().length > 80 ? t('Máximo 80 caracteres') : null,
    plural: !plural.trim() ? t('Obligatorio') : plural.trim().length > 80 ? t('Máximo 80 caracteres') : null,
    key: keyError(key, { taken, what: 'module' }),
    primary: !primaryLabel.trim() ? t('Obligatorio') : primaryLabel.trim().length > 80 ? t('Máximo 80 caracteres') : null,
    description: description.length > 500 ? t('Máximo 500 caracteres') : null,
  };
  const invalid = Object.values(errors).some(Boolean);
  const show = (k: keyof typeof errors) => (showErrors || (k === 'key' && keyTouched) ? errors[k] ?? undefined : undefined);

  const send = () => {
    setShowErrors(true);
    if (invalid) return;
    const module: ModuleInput = {
      key,
      label: label.trim(),
      labelPlural: plural.trim(),
      icon,
      color,
      ...(description.trim() ? { description: description.trim() } : {}),
      primaryField: 'name',
      fields: [{ key: 'name', label: primaryLabel.trim(), type: 'text', required: true }],
      views: [{ key: 'all', label: orgText(msg('Todos los registros')), type: 'table', columns: ['name', 'created_at'], sort: { field: 'created_at', direction: 'desc' } }],
    };
    const summary = t('Nuevo módulo «{name}» (clave {key}) con el campo principal «{primary}» y una vista de tabla. Permisos por defecto: lectura para todos los roles; crear, editar y eliminar para miembros o superior.', { name: plural.trim(), key, primary: primaryLabel.trim() });
    submit.mutate(
      buildChangeSet(
        t('Crear el módulo {name}', { name: plural.trim() }),
        `${summary}${description.trim() ? ` ${t('Descripción: {description}', { description: description.trim() })}` : ''}`,
        [{ op: 'create_module', module }],
        reason,
      ),
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('Nuevo módulo')}
      description={t('Crea la estructura mínima; después podrás añadir campos, opciones y permisos desde esta misma pantalla.')}
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
        <div className="flex items-center gap-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:ring-zinc-800">
          <ModuleBadgeIcon mod={{ icon, color }} size="lg" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{plural.trim() || t('Nuevo módulo')}</div>
            <div className="truncate text-xs text-zinc-500">
              <span className="font-mono">{key || t('clave')}</span> · {t('campo principal: {name}', { name: primaryLabel.trim() || '—' })}
            </div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Nombre en singular')} required error={show('label')}>
            <Input
              value={label}
              maxLength={80}
              placeholder={t('Ej.: Proyecto')}
              invalid={!!show('label')}
              onChange={(e) => {
                setLabel(e.target.value);
                if (!pluralTouched) {
                  const pl = pluralize(e.target.value, orgLocale);
                  setPlural(pl);
                  syncKey(pl);
                }
              }}
            />
          </Field>
          <Field label={t('Nombre en plural')} required error={show('plural')}>
            <Input
              value={plural}
              maxLength={80}
              placeholder={t('Ej.: Proyectos')}
              invalid={!!show('plural')}
              onChange={(e) => {
                setPluralTouched(true);
                setPlural(e.target.value);
                syncKey(e.target.value);
              }}
            />
          </Field>
          <Field label={t('Clave interna')} required error={show('key')} hint={t('Identificador inmutable (snake_case). Se genera desde el plural.')}>
            <Input
              value={key}
              maxLength={40}
              className="font-mono text-[13px]"
              invalid={!!show('key')}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toLowerCase());
              }}
            />
          </Field>
          <Field label={t('Etiqueta del campo principal')} required error={show('primary')} hint={t('Campo de texto obligatorio que identifica cada registro.')}>
            <Input value={primaryLabel} maxLength={80} invalid={!!show('primary')} onChange={(e) => setPrimaryLabel(e.target.value)} />
          </Field>
        </div>
        <Field label={t('Descripción')} error={show('description')} hint={t('Opcional. Ayuda al equipo y a la IA a entender el módulo.')}>
          <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <FieldGroup label={t('Icono')}>
          <IconPicker value={icon} color={color} onChange={setIcon} />
        </FieldGroup>
        <FieldGroup label={t('Color')}>
          <ColorPicker value={color} onChange={setColor} />
        </FieldGroup>
        <ReasonInput value={reason} onChange={setReason} />
        <RiskNote level="low" reasons={[t('Nuevo módulo vacío: no modifica datos existentes.')]} />
      </div>
    </Modal>
  );
}
