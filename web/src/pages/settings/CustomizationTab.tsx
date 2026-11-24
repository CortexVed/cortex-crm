import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Boxes, CircleDot, FileCode2, FlaskConical, History, ListChecks, Plus, Settings2, ShieldCheck, Table2, Wand2 } from 'lucide-react';
import { Badge, Button, Card, cx, EmptyState, ErrorState, Select, Skeleton } from '../../components/ui';
import { useToast } from '../../components/toast';
import { errorMessage, post } from '../../lib/api';
import { useBlueprint } from '../../lib/hooks';
import type { Blueprint, Field, Module } from '../../lib/types';
import type { Script } from '../../../../shared/blueprint';
import { Segmented } from './ai/shared';
import { FieldsPanel, OptionsModal, OptionsPanel, SettingsPanel, ViewsPanel } from './customization/ModulePanels';
import { NewModuleModal } from './customization/NewModuleModal';
import { ModuleBadgeIcon } from './customization/shared';

type Panel = 'fields' | 'options' | 'views' | 'settings';

const STEPS = [
  { icon: <ListChecks className="size-3.5" />, label: 'Validación' },
  { icon: <FlaskConical className="size-3.5" />, label: 'Pruebas en sandbox' },
  { icon: <ShieldCheck className="size-3.5" />, label: 'Aprobación' },
  { icon: <History className="size-3.5" />, label: 'Nueva versión (con rollback)' },
];

function ModuleList({ modules, current, onSelect, onCreate }: { modules: Module[]; current: Module | undefined; onSelect: (k: string) => void; onCreate: () => void }) {
  return (
    <Card padded={false} title="Módulos" description={`${modules.length} activos`} actions={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onCreate} aria-label="Nuevo módulo" title="Nuevo módulo" />}>
      <nav className="max-h-[60vh] space-y-0.5 overflow-y-auto p-2 scrollbar-thin">
        {modules.map((m) => {
          const active = current?.key === m.key;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => onSelect(m.key)}
              aria-current={active ? 'true' : undefined}
              className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition', active ? 'bg-zinc-900/[0.06] dark:bg-white/10' : 'hover:bg-zinc-900/[0.04] dark:hover:bg-white/5')}
            >
              <ModuleBadgeIcon mod={m} size="sm" />
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-sm', active ? 'font-semibold' : 'font-medium text-zinc-700 dark:text-zinc-300')}>{m.labelPlural}</span>
                <span className="block truncate font-mono text-[11px] text-zinc-400">{m.key}</span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{m.fields.filter((f) => !f.archived).length}</span>
            </button>
          );
        })}
      </nav>
    </Card>
  );
}

/** Editor no-code: cada cambio genera un change set que pasa por el mismo circuito gobernado que la IA. */
/** Scripts de ESTA organización: código a medida que se ejecuta en el sandbox de Cortex CRM. */
function ScriptsCard({ blueprint }: { blueprint: Blueprint }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const scripts = blueprint.scripts ?? [];
  const toggle = useMutation({
    mutationFn: (s: Script) =>
      post<{ id: string }>('/evolve/requests/manual', {
        changeSet: {
          title: `${s.enabled ? 'Desactivar' : 'Activar'} el script «${s.name}»`,
          summary: `${s.enabled ? 'Desactiva' : 'Activa'} el script «${s.name}» de la organización.`,
          operations: [{ op: 'upsert_script', script: { ...s, enabled: !s.enabled } }],
        },
      }),
    onSuccess: (r) => {
      toast('Cambio enviado: se valida y prueba antes de publicarse');
      navigate(`/evolve/requests/${r.id}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const usedBy = (key: string) => blueprint.automations.filter((a) => a.actions.some((x) => x.type === 'run_script' && x.script === key)).map((a) => a.name);
  return (
    <Card
      title={<span className="flex items-center gap-2"><FileCode2 className="size-4 text-violet-500" /> Scripts de la organización</span>}
      description="Lógica a medida que EVOLVE AI ENGINE escribe cuando la configuración no basta. Solo afecta a tu organización, se ejecuta en un sandbox aislado dentro de Cortex CRM (sin red ni archivos, con límite de tiempo y memoria) y se versiona con tu configuración: se puede revertir y nunca se publica en un repositorio."
    >
      {scripts.length === 0 ? (
        <p className="text-sm text-zinc-500">Todavía no hay scripts. Pídeselos a EVOLVE AI ENGINE, por ejemplo: «calcula una puntuación de cada oportunidad según importe, etapa y días sin actividad».</p>
      ) : (
        <ul className="space-y-2">
          {scripts.map((s) => {
            const users = usedBy(s.key);
            return (
              <li key={s.key} className="rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <button type="button" onClick={() => setOpen(open === s.key ? null : s.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm">
                    <span className="font-medium">{s.name}</span>
                    <code className="text-xs text-zinc-500">{s.key}</code>
                    <Badge color={s.enabled ? 'emerald' : 'slate'} dot>{s.enabled ? 'Activo' : 'Desactivado'}</Badge>
                  </button>
                  <span className="text-xs text-zinc-400">{users.length ? `Lo usa: ${users.join(', ')}` : 'Sin automatizaciones'}</span>
                  <Button size="sm" variant="ghost" loading={toggle.isPending && toggle.variables?.key === s.key} onClick={() => toggle.mutate(s)}>
                    {s.enabled ? 'Desactivar' : 'Activar'}
                  </Button>
                </div>
                {open === s.key && (
                  <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                    {s.description && <p className="mb-2 text-xs text-zinc-500">{s.description}</p>}
                    <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-[12px] leading-relaxed text-zinc-100">{s.code}</pre>
                    <p className="mt-1 text-[11px] text-zinc-400">Tiempo máximo por ejecución: {s.timeoutMs} ms. Las ejecuciones aparecen en el historial de cada ficha.</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default function CustomizationTab() {
  const bp = useBlueprint();
  const [params, setParams] = useSearchParams();
  const [panel, setPanel] = useState<Panel>('fields');
  const [creating, setCreating] = useState(false);
  const [optionsFor, setOptionsFor] = useState<Field | null>(null);

  if (bp.isLoading) {
    return (
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Skeleton className="h-80" />
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }
  if (bp.error || !bp.data) return <ErrorState error={bp.error} onRetry={() => bp.refetch()} />;

  const blueprint = bp.data.blueprint;
  const modules = blueprint.modules.filter((m) => !m.archived);
  const mod = modules.find((m) => m.key === params.get('module')) ?? modules[0];
  const select = (k: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('module', k);
        return next;
      },
      { replace: true },
    );
  const currency = bp.data.settings?.currency ?? 'EUR';
  const selectCount = mod ? mod.fields.filter((f) => !f.archived && (f.type === 'select' || f.type === 'multi_select')).length : 0;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200/80 shadow-xs dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
              <Boxes className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Personalización sin código</h2>
              <p className="mt-0.5 max-w-2xl text-sm text-zinc-500">Edita módulos, campos, opciones y permisos. Nada se modifica directamente: cada cambio sigue el mismo circuito gobernado que los de EVOLVE AI.</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge color="slate">Versión actual v{bp.data.version}</Badge>
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
              Nuevo módulo
            </Button>
          </div>
        </div>
        <ol className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          {STEPS.map((s, i) => (
            <li key={s.label} className="inline-flex items-center gap-1.5">
              {i > 0 && <ArrowRight className="size-3 text-zinc-300 dark:text-zinc-600" />}
              <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">
                {s.icon}
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {!mod ? (
        <Card>
          <EmptyState
            icon={<Boxes className="size-5" />}
            title="No hay módulos activos"
            description="Crea el primer módulo para empezar a guardar datos."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                Nuevo módulo
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="space-y-4">
            <div className="lg:hidden">
              <Select value={mod.key} onChange={(e) => select(e.target.value)} aria-label="Módulo">
                {modules.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.labelPlural}
                  </option>
                ))}
              </Select>
            </div>
            <div className="hidden lg:block">
              <ModuleList modules={modules} current={mod} onSelect={select} onCreate={() => setCreating(true)} />
            </div>
            <div className="hidden rounded-xl p-px evolve-gradient lg:block">
              <div className="rounded-[11px] bg-white p-4 dark:bg-zinc-900">
                <Wand2 className="size-5 text-fuchsia-500" />
                <p className="mt-2 text-sm font-medium">Para cambios más complejos, descríbelos en lenguaje natural a EVOLVE AI ENGINE</p>
                <p className="mt-1 text-xs text-zinc-500">Automatizaciones, vistas, paneles, formularios o módulos completos con sus pruebas.</p>
                <Link to="/evolve" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                  Abrir EVOLVE AI ENGINE <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </div>
          </aside>

          <div className="min-w-0 space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <ModuleBadgeIcon mod={mod} size="lg" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="truncate text-base font-semibold">{mod.labelPlural}</h3>
                    <span className="font-mono text-xs text-zinc-400">{mod.key}</span>
                    {mod.system && <Badge color="slate">Módulo base</Badge>}
                  </div>
                  {mod.description && <p className="mt-0.5 text-sm text-zinc-500">{mod.description}</p>}
                </div>
              </div>
              <Link to={`/m/${mod.key}`} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                Ver registros <ArrowRight className="size-3.5" />
              </Link>
            </div>

            <Segmented
              value={panel}
              onChange={setPanel}
              options={[
                { key: 'fields', label: 'Campos', icon: <ListChecks className="size-4" />, count: mod.fields.filter((f) => !f.archived).length },
                { key: 'options', label: 'Opciones y etapas', icon: <CircleDot className="size-4" />, count: selectCount },
                { key: 'views', label: 'Vistas', icon: <Table2 className="size-4" />, count: mod.views.length },
                { key: 'settings', label: 'Ajustes y permisos', icon: <Settings2 className="size-4" /> },
              ]}
            />

            {panel === 'fields' && <FieldsPanel key={mod.key} bp={blueprint} mod={mod} modules={modules} defaultCurrency={currency} onEditOptions={setOptionsFor} />}
            {panel === 'options' && <OptionsPanel mod={mod} onEdit={setOptionsFor} />}
            {panel === 'views' && <ViewsPanel mod={mod} />}
            {panel === 'settings' && <SettingsPanel key={`${mod.key}:${bp.data.version}`} mod={mod} />}

            <div className="rounded-xl bg-gradient-to-br from-brand-50 to-fuchsia-50 p-4 ring-1 ring-brand-100 lg:hidden dark:from-brand-500/10 dark:to-fuchsia-500/10 dark:ring-brand-500/20">
              <p className="text-sm font-medium">Para cambios más complejos, descríbelos en lenguaje natural a EVOLVE AI ENGINE</p>
              <Link to="/evolve" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                Abrir EVOLVE AI ENGINE <ArrowRight className="size-3.5" />
              </Link>
            </div>
          </div>
        </div>
      )}

      <ScriptsCard blueprint={blueprint} />

      {creating && <NewModuleModal open onClose={() => setCreating(false)} modules={blueprint.modules} />}
      {optionsFor && mod && <OptionsModal key={`${mod.key}:${optionsFor.key}`} mod={mod} field={optionsFor} automations={blueprint.automations} onClose={() => setOptionsFor(null)} />}
    </div>
  );
}
