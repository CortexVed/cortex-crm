import { useMemo, useState } from 'react';
import type { Color, IconName } from '../../../../../shared/constants';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import type { Module } from '../../../lib/types';
import { FieldGroup } from '../ai/shared';
import { buildChangeSet, ColorPicker, IconPicker, keyError, ModuleBadgeIcon, ReasonInput, RiskNote, toKey, uniqueKey, useSubmitChangeSet, type ModuleInput } from './shared';

/** Plural orientativo en español (editable): vocal → +s, z → ces, resto → +es. */
function pluralize(s: string): string {
  const t = s.trim();
  if (!t) return '';
  if (/[aeiouáéíóú]$/i.test(t)) return `${t}s`;
  if (/z$/i.test(t)) return `${t.slice(0, -1)}ces`;
  return `${t}es`;
}

export function NewModuleModal({ open, onClose, modules }: { open: boolean; onClose: () => void; modules: Module[] }) {
  const [label, setLabel] = useState('');
  const [plural, setPlural] = useState('');
  const [pluralTouched, setPluralTouched] = useState(false);
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [icon, setIcon] = useState<IconName>('box');
  const [color, setColor] = useState<Color>('indigo');
  const [description, setDescription] = useState('');
  const [primaryLabel, setPrimaryLabel] = useState('Nombre');
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const submit = useSubmitChangeSet(onClose);
  const taken = useMemo(() => new Map(modules.map((m) => [m.key, { archived: m.archived }])), [modules]);
  const takenKeys = useMemo(() => new Set(modules.map((m) => m.key)), [modules]);

  const syncKey = (pl: string) => {
    if (!keyTouched) setKey(uniqueKey(toKey(pl), takenKeys));
  };

  const errors = {
    label: !label.trim() ? 'Obligatorio' : label.trim().length > 80 ? 'Máximo 80 caracteres' : null,
    plural: !plural.trim() ? 'Obligatorio' : plural.trim().length > 80 ? 'Máximo 80 caracteres' : null,
    key: keyError(key, { taken, what: 'módulo' }),
    primary: !primaryLabel.trim() ? 'Obligatorio' : primaryLabel.trim().length > 80 ? 'Máximo 80 caracteres' : null,
    description: description.length > 500 ? 'Máximo 500 caracteres' : null,
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
      views: [{ key: 'all', label: 'Todos los registros', type: 'table', columns: ['name', 'created_at'], sort: { field: 'created_at', direction: 'desc' } }],
    };
    submit.mutate(
      buildChangeSet(
        `Crear el módulo ${plural.trim()}`,
        `Nuevo módulo «${plural.trim()}» (clave ${key}) con el campo principal «${primaryLabel.trim()}» y una vista de tabla. Permisos por defecto: lectura para todos los roles; crear, editar y eliminar para miembros o superior.${description.trim() ? ` Descripción: ${description.trim()}` : ''}`,
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
      title="Nuevo módulo"
      description="Crea la estructura mínima; después podrás añadir campos, opciones y permisos desde esta misma pantalla."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={submit.isPending} disabled={showErrors && invalid} onClick={send}>
            Enviar cambio
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:ring-zinc-800">
          <ModuleBadgeIcon mod={{ icon, color }} size="lg" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{plural.trim() || 'Nuevo módulo'}</div>
            <div className="truncate text-xs text-zinc-500">
              <span className="font-mono">{key || 'clave'}</span> · campo principal: {primaryLabel.trim() || '—'}
            </div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre en singular" required error={show('label')}>
            <Input
              value={label}
              maxLength={80}
              placeholder="Ej.: Proyecto"
              invalid={!!show('label')}
              onChange={(e) => {
                setLabel(e.target.value);
                if (!pluralTouched) {
                  const pl = pluralize(e.target.value);
                  setPlural(pl);
                  syncKey(pl);
                }
              }}
            />
          </Field>
          <Field label="Nombre en plural" required error={show('plural')}>
            <Input
              value={plural}
              maxLength={80}
              placeholder="Ej.: Proyectos"
              invalid={!!show('plural')}
              onChange={(e) => {
                setPluralTouched(true);
                setPlural(e.target.value);
                syncKey(e.target.value);
              }}
            />
          </Field>
          <Field label="Clave interna" required error={show('key')} hint="Identificador inmutable (snake_case). Se genera desde el plural.">
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
          <Field label="Etiqueta del campo principal" required error={show('primary')} hint="Campo de texto obligatorio que identifica cada registro.">
            <Input value={primaryLabel} maxLength={80} invalid={!!show('primary')} onChange={(e) => setPrimaryLabel(e.target.value)} />
          </Field>
        </div>
        <Field label="Descripción" error={show('description')} hint="Opcional. Ayuda al equipo y a la IA a entender el módulo.">
          <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <FieldGroup label="Icono">
          <IconPicker value={icon} color={color} onChange={setIcon} />
        </FieldGroup>
        <FieldGroup label="Color">
          <ColorPicker value={color} onChange={setColor} />
        </FieldGroup>
        <ReasonInput value={reason} onChange={setReason} />
        <RiskNote level="low" reasons={['Nuevo módulo vacío: no modifica datos existentes.']} />
      </div>
    </Modal>
  );
}
