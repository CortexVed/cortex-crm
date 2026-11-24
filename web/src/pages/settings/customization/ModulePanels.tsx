import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  AlignLeft,
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Calendar,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  CircleDot,
  Coins,
  Columns3,
  Filter,
  Hash,
  Link2,
  Mail,
  Paperclip,
  Pencil,
  Percent,
  Phone,
  Plus,
  Sigma,
  SquareKanban,
  Star,
  Table2,
  Tags,
  ToggleLeft,
  Type,
  User,
  Users,
  Wand2,
} from 'lucide-react';
import { FIELD_TYPE_LABELS, ROLE_LABELS, ROLE_RANK, ROLES, type Color, type FieldType, type IconName, type Role } from '../../../../../shared/constants';
import { Alert, Badge, Button, Card, ConfirmDialog, cx, EmptyState, Field, IconButton, Input, Select, Textarea, Toggle } from '../../../components/ui';
import type { Blueprint, Field as BpField, Module, View } from '../../../lib/types';
import { useSession } from '../../../lib/session';
import { FieldGroup } from '../ai/shared';
import { AddFieldModal, EditFieldModal, fieldTypeDetail, OptionsModal } from './FieldDialogs';
import { buildChangeSet, ColorPicker, COLOR_LABELS, IconPicker, ModuleBadgeIcon, PERMISSION_LABELS, ReasonInput, RiskNote, useSubmitChangeSet, type RiskLevel } from './shared';

const TYPE_ICON: Record<FieldType, ReactNode> = {
  text: <Type className="size-4" />,
  long_text: <AlignLeft className="size-4" />,
  number: <Hash className="size-4" />,
  currency: <Coins className="size-4" />,
  percent: <Percent className="size-4" />,
  date: <Calendar className="size-4" />,
  datetime: <CalendarClock className="size-4" />,
  boolean: <ToggleLeft className="size-4" />,
  email: <Mail className="size-4" />,
  phone: <Phone className="size-4" />,
  url: <Link2 className="size-4" />,
  select: <CircleDot className="size-4" />,
  multi_select: <Tags className="size-4" />,
  relation: <Link2 className="size-4 rotate-45" />,
  user: <User className="size-4" />,
  rating: <Star className="size-4" />,
  file: <Paperclip className="size-4" />,
  formula: <Sigma className="size-4" />,
};

const VIEW_META: Record<View['type'], { label: string; icon: ReactNode }> = {
  table: { label: 'Tabla', icon: <Table2 className="size-4" /> },
  kanban: { label: 'Kanban', icon: <SquareKanban className="size-4" /> },
  calendar: { label: 'Calendario', icon: <CalendarDays className="size-4" /> },
};

const PRIMARY_TYPES = new Set<FieldType>(['text', 'email', 'phone', 'url', 'number', 'select', 'date']);
const SYSTEM_LABELS: Record<string, string> = { created_at: 'Fecha de creación', updated_at: 'Última modificación', last_activity_at: 'Última actividad', id: 'ID', created_by: 'Creado por' };

const fieldLabel = (mod: Module, key: string) => mod.fields.find((f) => f.key === key)?.label ?? SYSTEM_LABELS[key] ?? key;

/** Dónde se usa un campo (vistas, fórmulas, automatizaciones, paneles, formularios, ficha). */
function fieldUsages(bp: Blueprint, mod: Module, key: string): string[] {
  const out: string[] = [];
  for (const v of mod.views) {
    const roles: string[] = [];
    if (v.columns?.includes(key)) roles.push('columna');
    if (v.groupBy === key) roles.push('agrupación');
    if (v.cardFields?.includes(key)) roles.push('tarjeta');
    if (v.dateField === key) roles.push('fecha');
    if (v.colorBy === key) roles.push('color');
    if (v.sort?.field === key) roles.push('orden');
    if (v.filters?.some((c) => c.field === key)) roles.push('filtro');
    if (roles.length) out.push(`Vista «${v.label}» (${roles.join(', ')})`);
  }
  for (const s of mod.layout ?? []) if (s.fields.includes(key)) out.push(`Ficha, sección «${s.title}»`);
  for (const f of mod.fields) if (f.type === 'formula' && !f.archived && f.key !== key && f.formula?.expression.includes(`{${key}}`)) out.push(`Fórmula «${f.label}»`);
  for (const a of bp.automations) {
    if (a.trigger.module !== mod.key) continue;
    const inTrigger = 'field' in a.trigger && a.trigger.field === key;
    if (inTrigger || a.conditions.some((c) => c.field === key) || a.actions.some((x) => x.type === 'update_field' && x.field === key)) out.push(`Automatización «${a.name}»`);
  }
  for (const d of bp.dashboards) for (const w of d.widgets) if (w.module === mod.key && (w.field === key || w.groupBy === key || w.dateField === key || w.filters.some((c) => c.field === key))) out.push(`Panel «${d.label}» › «${w.title}»`);
  for (const fm of bp.forms) if (fm.module === mod.key && fm.fields.includes(key)) out.push(`Formulario «${fm.name}»`);
  return out;
}

// ---------------------------------------------------------------- campos

export function FieldsPanel({ bp, mod, modules, defaultCurrency, onEditOptions }: { bp: Blueprint; mod: Module; modules: Module[]; defaultCurrency: string; onEditOptions: (f: BpField) => void }) {
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BpField | null>(null);
  const [confirm, setConfirm] = useState<{ field: BpField; action: 'archive' | 'restore' } | null>(null);
  const [reason, setReason] = useState('');
  const submit = useSubmitChangeSet(() => setConfirm(null));
  const archivedCount = mod.fields.filter((f) => f.archived).length;
  const fields = mod.fields.filter((f) => showArchived || !f.archived);
  const usages = confirm?.action === 'archive' ? fieldUsages(bp, mod, confirm.field.key) : [];

  const runConfirm = () => {
    if (!confirm) return;
    const { field, action } = confirm;
    submit.mutate(
      action === 'archive'
        ? buildChangeSet(`Archivar el campo «${field.label}» de ${mod.labelPlural}`, `Se archiva el campo ${field.key} («${field.label}») del módulo ${mod.labelPlural}. Los datos se conservan y el campo se puede restaurar.${usages.length ? ` Se usa en: ${usages.join('; ')}.` : ''}`, [{ op: 'archive_field', module: mod.key, field: field.key }], reason)
        : buildChangeSet(`Restaurar el campo «${field.label}» de ${mod.labelPlural}`, `Se restaura el campo archivado ${field.key} («${field.label}») del módulo ${mod.labelPlural} con sus datos.`, [{ op: 'restore_field', module: mod.key, field: field.key }], reason),
    );
  };

  return (
    <Card
      padded={false}
      title="Campos"
      description="Clave, tipo y reglas de cada campo. La clave y el tipo son inmutables una vez creados."
      actions={
        <>
          {archivedCount > 0 && (
            <span className="hidden sm:inline-flex">
              <Toggle checked={showArchived} onChange={setShowArchived} label={`Archivados (${archivedCount})`} />
            </span>
          )}
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Añadir campo
          </Button>
        </>
      }
    >
      {archivedCount > 0 && (
        <div className="border-b border-zinc-100 px-4 py-2 sm:hidden dark:border-zinc-800">
          <Toggle checked={showArchived} onChange={setShowArchived} label={`Mostrar archivados (${archivedCount})`} />
        </div>
      )}
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {fields.map((f) => {
          const isPrimary = mod.primaryField === f.key;
          const detail = fieldTypeDetail(f, modules);
          const isSelect = f.type === 'select' || f.type === 'multi_select';
          const archiveBlocked = f.system ? 'Los campos de sistema no se pueden archivar' : isPrimary ? 'Es el campo principal: elige otro en «Ajustes y permisos» antes de archivarlo' : null;
          return (
            <li key={f.key} className={cx('flex items-start gap-3 px-4 py-3', f.archived && 'bg-zinc-50/70 dark:bg-zinc-950/30')}>
              <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', f.archived ? 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800' : 'bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300')}>{TYPE_ICON[f.type]}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={cx('text-sm font-medium', f.archived && 'text-zinc-500 line-through decoration-zinc-300')}>{f.label}</span>
                  {isPrimary && <Badge color="violet">Principal</Badge>}
                  {f.required && <Badge color="amber">Obligatorio</Badge>}
                  {f.unique && <Badge color="sky">Único</Badge>}
                  {f.system && <Badge color="slate">Sistema</Badge>}
                  {f.hidden && <Badge color="slate">Oculto</Badge>}
                  {f.archived && <Badge color="slate">Archivado</Badge>}
                </div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                  <span className="font-mono">{f.key}</span>
                  <span aria-hidden>·</span>
                  <span>{FIELD_TYPE_LABELS[f.type]}</span>
                  {detail && (
                    <>
                      <span aria-hidden>·</span>
                      <span className={cx('max-w-full truncate', f.type === 'formula' && 'font-mono')} title={detail}>
                        {detail}
                      </span>
                    </>
                  )}
                </div>
                {f.helpText && <p className="mt-0.5 truncate text-xs text-zinc-400" title={f.helpText}>{f.helpText}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {!f.archived && (
                  <>
                    <IconButton label="Editar etiqueta y reglas" onClick={() => setEditing(f)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    {isSelect && (
                      <IconButton label="Editar opciones" onClick={() => onEditOptions(f)}>
                        <Tags className="size-4" />
                      </IconButton>
                    )}
                  </>
                )}
                {f.archived ? (
                  <IconButton label="Restaurar campo" onClick={() => setConfirm({ field: f, action: 'restore' })}>
                    <ArchiveRestore className="size-4" />
                  </IconButton>
                ) : (
                  <span title={archiveBlocked ?? undefined} className="inline-flex">
                    <IconButton label={archiveBlocked ?? 'Archivar campo'} disabled={!!archiveBlocked} onClick={() => setConfirm({ field: f, action: 'archive' })} className="hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-500">
                      <Archive className="size-4" />
                    </IconButton>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {adding && <AddFieldModal open onClose={() => setAdding(false)} mod={mod} modules={modules} defaultCurrency={defaultCurrency} />}
      {editing && <EditFieldModal mod={mod} field={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => {
          setConfirm(null);
          setReason('');
        }}
        onConfirm={runConfirm}
        loading={submit.isPending}
        danger={confirm?.action === 'archive'}
        title={confirm?.action === 'archive' ? `¿Archivar el campo «${confirm.field.label}»?` : `¿Restaurar el campo «${confirm?.field.label ?? ''}»?`}
        description={confirm?.action === 'archive' ? 'Los datos se conservan y podrás restaurarlo, pero el campo desaparecerá de formularios, fichas y listados.' : 'El campo volverá a estar disponible con los datos que tenía.'}
        confirmLabel="Enviar cambio"
      >
        <div className="space-y-3">
          {confirm?.action === 'archive' && usages.length > 0 && (
            <Alert tone="warning" title="Este campo se está usando">
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {usages.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
              <p className="mt-1.5">El sandbox validará estas dependencias; si alguna se rompe, el cambio no superará las pruebas.</p>
            </Alert>
          )}
          <ReasonInput value={reason} onChange={setReason} />
          <RiskNote level={confirm?.action === 'archive' ? 'high' : 'low'} reasons={confirm?.action === 'archive' ? ['Archivar un campo se considera un cambio destructivo.'] : []} />
        </div>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------- opciones y etapas

export function OptionsPanel({ mod, onEdit }: { mod: Module; onEdit: (f: BpField) => void }) {
  const selects = mod.fields.filter((f) => !f.archived && (f.type === 'select' || f.type === 'multi_select'));
  if (!selects.length) {
    return (
      <Card>
        <EmptyState icon={<CircleDot className="size-5" />} title="Este módulo no tiene campos de selección" description="Añade un campo de tipo «Selección» o «Selección múltiple» desde la pestaña Campos para definir estados, etapas o etiquetas." />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {selects.map((f) => {
        const kanban = mod.views.filter((v) => v.type === 'kanban' && v.groupBy === f.key);
        const options = f.options ?? [];
        return (
          <Card
            key={f.key}
            title={
              <span className="inline-flex items-center gap-2">
                {f.label}
                {kanban.length > 0 && <Badge color="violet">Etapas del pipeline</Badge>}
              </span>
            }
            description={
              <>
                <span className="font-mono">{f.key}</span> · {FIELD_TYPE_LABELS[f.type]} · {options.length} opci{options.length === 1 ? 'ón' : 'ones'}
                {kanban.length > 0 && ` · columnas de ${kanban.map((v) => `«${v.label}»`).join(', ')}`}
              </>
            }
            actions={
              <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => onEdit(f)}>
                Editar
              </Button>
            }
          >
            {kanban.length > 0 ? (
              <ol className="flex flex-wrap items-center gap-1">
                {options.map((o, i) => (
                  <li key={o.value} className="inline-flex items-center gap-1">
                    {i > 0 && <ChevronRight className="size-3.5 text-zinc-300 dark:text-zinc-600" />}
                    <Badge color={o.color} dot>
                      {o.label}
                    </Badge>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {options.map((o) => (
                  <Badge key={o.value} color={o.color} dot>
                    {o.label}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- vistas

export function ViewsPanel({ mod }: { mod: Module }) {
  return (
    <div className="space-y-4">
      <Card padded={false} title="Vistas" description="Cómo se listan los registros del módulo.">
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {mod.views.map((v) => {
            const meta = VIEW_META[v.type];
            const details: { icon: ReactNode; text: string }[] = [];
            if (v.groupBy) details.push({ icon: <SquareKanban className="size-3" />, text: `Agrupa por ${fieldLabel(mod, v.groupBy)}` });
            if (v.dateField) details.push({ icon: <CalendarDays className="size-3" />, text: `Fecha: ${fieldLabel(mod, v.dateField)}` });
            if (v.columns?.length) details.push({ icon: <Columns3 className="size-3" />, text: `${v.columns.length} columnas: ${v.columns.map((c) => fieldLabel(mod, c)).join(', ')}` });
            if (v.cardFields?.length) details.push({ icon: <Columns3 className="size-3" />, text: `Tarjeta: ${v.cardFields.map((c) => fieldLabel(mod, c)).join(', ')}` });
            if (v.sort) details.push({ icon: <ArrowUpDown className="size-3" />, text: `Orden: ${fieldLabel(mod, v.sort.field)} (${v.sort.direction === 'desc' ? 'descendente' : 'ascendente'})` });
            if (v.filters?.length) details.push({ icon: <Filter className="size-3" />, text: `${v.filters.length} filtro${v.filters.length === 1 ? '' : 's'}` });
            return (
              <li key={v.key} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{v.label}</span>
                    <Badge>{meta.label}</Badge>
                    <span className="font-mono text-[11px] text-zinc-400">{v.key}</span>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {details.map((d) => (
                      <li key={d.text} className="flex items-start gap-1.5 text-xs text-zinc-500">
                        <span className="mt-0.5 shrink-0">{d.icon}</span>
                        <span className="min-w-0">{d.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <div className="flex flex-col gap-3 rounded-xl bg-gradient-to-br from-brand-50 to-fuchsia-50 p-4 ring-1 ring-brand-100 sm:flex-row sm:items-center sm:justify-between dark:from-brand-500/10 dark:to-fuchsia-500/10 dark:ring-brand-500/20">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">Para crear vistas nuevas (kanban, calendario, filtros, columnas…) descríbelas en lenguaje natural a EVOLVE AI ENGINE.</p>
        <Link to="/evolve" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
          <Wand2 className="size-4" /> Abrir EVOLVE AI ENGINE
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ajustes y permisos

type Perms = Module['permissions'];
const PERM_KEYS: (keyof Perms)[] = ['read', 'create', 'update', 'delete'];

export function SettingsPanel({ mod }: { mod: Module }) {
  const { me } = useSession();
  const myRole = me?.workspace?.role;
  const [label, setLabel] = useState(mod.label);
  const [labelPlural, setLabelPlural] = useState(mod.labelPlural);
  const [description, setDescription] = useState(mod.description ?? '');
  const [icon, setIcon] = useState<IconName>(mod.icon);
  const [color, setColor] = useState<Color>(mod.color as Color);
  const [primaryField, setPrimaryField] = useState(mod.primaryField);
  const [perms, setPerms] = useState<Perms>({ ...mod.permissions });
  const [reason, setReason] = useState('');
  const submit = useSubmitChangeSet();

  const errors = {
    label: !label.trim() ? 'Obligatorio' : label.trim().length > 80 ? 'Máximo 80 caracteres' : null,
    labelPlural: !labelPlural.trim() ? 'Obligatorio' : labelPlural.trim().length > 80 ? 'Máximo 80 caracteres' : null,
    description: description.length > 500 ? 'Máximo 500 caracteres' : null,
  };
  const invalid = Object.values(errors).some(Boolean);
  const primaryOptions = mod.fields.filter((f) => !f.archived && PRIMARY_TYPES.has(f.type));

  const changes: string[] = [];
  if (label.trim() !== mod.label) changes.push(`nombre «${mod.label}» → «${label.trim()}»`);
  if (labelPlural.trim() !== mod.labelPlural) changes.push(`plural «${mod.labelPlural}» → «${labelPlural.trim()}»`);
  if (description.trim() !== (mod.description ?? '')) changes.push('descripción');
  if (icon !== mod.icon) changes.push(`icono ${mod.icon} → ${icon}`);
  if (color !== mod.color) changes.push(`color ${COLOR_LABELS[mod.color as keyof typeof COLOR_LABELS] ?? mod.color} → ${COLOR_LABELS[color as keyof typeof COLOR_LABELS] ?? color}`);
  if (primaryField !== mod.primaryField) changes.push(`campo principal ${fieldLabel(mod, mod.primaryField)} → ${fieldLabel(mod, primaryField)}`);
  const permChanges = PERM_KEYS.filter((k) => perms[k] !== mod.permissions[k]);
  for (const k of permChanges) changes.push(`${PERMISSION_LABELS[k].toLowerCase()}: ${ROLE_LABELS[mod.permissions[k]]} → ${ROLE_LABELS[perms[k]]}`);
  const dirty = changes.length > 0;
  const loosened = permChanges.filter((k) => ROLE_RANK[perms[k]] < ROLE_RANK[mod.permissions[k]]);
  const restricted = permChanges.filter((k) => ROLE_RANK[perms[k]] > ROLE_RANK[mod.permissions[k]]);
  const lockedOut = !!myRole && ROLE_RANK[perms.read] > ROLE_RANK[myRole];

  // El servidor clasifica cualquier update_module con permisos como riesgo medio (alto si se amplían).
  const risk: RiskLevel = loosened.length ? 'high' : 'medium';
  const reasons: string[] = [];
  if (loosened.length) reasons.push(`Se amplían permisos (${loosened.map((k) => PERMISSION_LABELS[k].toLowerCase()).join(', ')}): más roles tendrán acceso a los datos.`);
  if (restricted.length) reasons.push(`Se restringen permisos (${restricted.map((k) => PERMISSION_LABELS[k].toLowerCase()).join(', ')}).`);
  if (!permChanges.length) reasons.push('Los ajustes del módulo se revisan como cambio de riesgo medio.');

  const send = () => {
    if (invalid || !dirty) return;
    submit.mutate(
      buildChangeSet(
        `Ajustes del módulo ${mod.labelPlural}`,
        `Cambios en el módulo ${mod.labelPlural} (${mod.key}): ${changes.join('; ')}.`,
        [
          {
            op: 'update_module',
            module: mod.key,
            // Se envían todos los valores (también los no modificados): el esquema de cambios
            // rellenaría icono, color y permisos por defecto si faltasen.
            changes: {
              label: label.trim(),
              labelPlural: labelPlural.trim(),
              icon,
              color,
              primaryField,
              permissions: perms,
              ...(description.trim() !== (mod.description ?? '') ? { description: description.trim() } : mod.description !== undefined ? { description: mod.description } : {}),
            },
          },
        ],
        reason,
      ),
    );
  };

  const reset = () => {
    setLabel(mod.label);
    setLabelPlural(mod.labelPlural);
    setDescription(mod.description ?? '');
    setIcon(mod.icon);
    setColor(mod.color);
    setPrimaryField(mod.primaryField);
    setPerms({ ...mod.permissions });
    setReason('');
  };

  return (
    <div className="space-y-4">
      <Card title="Identidad del módulo" description="Nombre, icono y color con que aparece en el menú, los listados y la IA.">
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:ring-zinc-800">
            <ModuleBadgeIcon mod={{ icon, color }} size="lg" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{labelPlural.trim() || 'Sin nombre'}</div>
              <div className="truncate text-xs text-zinc-500">Vista previa · un registro: {label.trim() || '—'}</div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre en singular" required error={errors.label ?? undefined}>
              <Input value={label} maxLength={80} invalid={!!errors.label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Nombre en plural" required error={errors.labelPlural ?? undefined}>
              <Input value={labelPlural} maxLength={80} invalid={!!errors.labelPlural} onChange={(e) => setLabelPlural(e.target.value)} />
            </Field>
          </div>
          <Field label="Descripción" error={errors.description ?? undefined} hint="Ayuda al equipo y a la IA a entender para qué sirve el módulo.">
            <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <FieldGroup label="Icono">
            <IconPicker value={icon} color={color} onChange={setIcon} />
          </FieldGroup>
          <FieldGroup label="Color">
            <ColorPicker value={color} onChange={setColor} />
          </FieldGroup>
          <Field label="Campo principal" hint="Identifica cada registro en listados, búsquedas y relaciones.">
            <Select value={primaryField} onChange={(e) => setPrimaryField(e.target.value)} className="sm:w-80">
              {primaryOptions.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label} ({FIELD_TYPE_LABELS[f.type]})
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><Users className="size-4 text-brand-500" /> Permisos</span>} description="Rol mínimo necesario para cada acción sobre los registros de este módulo.">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {PERM_KEYS.map((k) => {
              const changed = perms[k] !== mod.permissions[k];
              return (
                <Field key={k} label={PERMISSION_LABELS[k]} hint={changed ? `Antes: ${ROLE_LABELS[mod.permissions[k]]}` : undefined}>
                  <Select value={perms[k]} onChange={(e) => setPerms({ ...perms, [k]: e.target.value as Role })} className={cx(changed && 'ring-brand-400 dark:ring-brand-500/60')}>
                    {[...ROLES].reverse().map((r) => (
                      <option key={r} value={r}>
                        {r === 'owner' ? 'Solo propietarios' : `${ROLE_LABELS[r]} o superior`}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            })}
          </div>
          {lockedOut && <Alert tone="warning">Con este permiso de lectura tu rol ({ROLE_LABELS[myRole!]}) dejará de ver el módulo cuando se publique.</Alert>}
          {loosened.length > 0 && <Alert tone="danger" title="Ampliar permisos es un cambio de riesgo alto">Requiere la aprobación de un propietario con confirmación explícita.</Alert>}
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <ReasonInput value={reason} onChange={setReason} />
          {dirty && <RiskNote level={risk} reasons={reasons} />}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-zinc-500">{dirty ? `${changes.length} cambio${changes.length === 1 ? '' : 's'} pendiente${changes.length === 1 ? '' : 's'}: se enviarán juntos como una petición.` : 'Sin cambios pendientes.'}</span>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={!dirty || submit.isPending} onClick={reset}>
                Descartar
              </Button>
              <Button variant="primary" loading={submit.isPending} disabled={!dirty || invalid} onClick={send}>
                Enviar cambio
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export { OptionsModal };
