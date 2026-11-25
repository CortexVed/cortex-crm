import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, LayoutGrid, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { errorMessage, get, post } from '../lib/api';
import { useBlueprint } from '../lib/hooks';
import { useSession } from '../lib/session';
import { formatValue } from '../lib/format';
import type { Dashboard as DashboardT, Widget, WidgetData } from '../lib/types';
import { Button, Card, cx, EmptyState, ErrorState, Field, Input, Modal, PageLoader, Select, Skeleton } from '../components/ui';
import { WidgetBody } from '../components/WidgetBody';
import { useToast } from '../components/toast';
import { PageView } from './CustomPage';

const SIZE: Record<string, string> = { sm: 'md:col-span-1', md: 'md:col-span-2', lg: 'md:col-span-2 xl:col-span-2', xl: 'md:col-span-2 xl:col-span-4' };

function AddWidget({ dashboard, open, onClose }: { dashboard: DashboardT; open: boolean; onClose: () => void }) {
  const { data } = useBlueprint();
  const toast = useToast();
  const navigate = useNavigate();
  const modules = (data?.blueprint.modules ?? []).filter((m) => !m.archived);
  const [w, setW] = useState({ title: '', type: 'metric' as Widget['type'], module: modules[0]?.key ?? '', aggregate: 'count' as Widget['aggregate'], field: '', groupBy: '', dateField: 'created_at', size: 'sm' as Widget['size'] });
  const mod = modules.find((m) => m.key === w.module);
  const numeric = mod?.fields.filter((f) => !f.archived && ['number', 'currency', 'percent', 'rating'].includes(f.type)) ?? [];
  const groupable = mod?.fields.filter((f) => !f.archived && ['select', 'user', 'boolean', 'relation', 'multi_select'].includes(f.type)) ?? [];
  const dates = [{ key: 'created_at', label: 'Fecha de creación' }, ...(mod?.fields.filter((f) => !f.archived && ['date', 'datetime'].includes(f.type)) ?? [])];
  const submit = useMutation({
    mutationFn: () => {
      const key = `w_${Date.now().toString(36)}`;
      const widget: Record<string, unknown> = { key, title: w.title, type: w.type, module: w.module, aggregate: w.type === 'list' ? 'count' : w.aggregate, size: w.size, filters: [] };
      if (w.aggregate !== 'count' && w.field) widget.field = w.field;
      if (w.type === 'bar' || w.type === 'donut') widget.groupBy = w.groupBy;
      if (w.type === 'line') widget.dateField = w.dateField;
      return post<{ id: string }>('/evolve/requests/manual', {
        changeSet: { title: `Panel: añadir widget «${w.title}»`, summary: `Añade el widget «${w.title}» al panel ${dashboard.label}.`, operations: [{ op: 'upsert_dashboard', dashboard: { ...dashboard, widgets: [...dashboard.widgets, widget] } }] },
      });
    },
    onSuccess: (r) => {
      toast('Cambio enviado: se valida y prueba en el sandbox antes de publicarse');
      onClose();
      navigate(`/evolve/requests/${r.id}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const valid = w.title.trim().length > 1 && w.module && (w.aggregate === 'count' || w.field || w.type === 'list') && (!(w.type === 'bar' || w.type === 'donut') || w.groupBy);
  return (
    <Modal open={open} onClose={onClose} title="Añadir widget" description="El panel es parte de la configuración versionada: el cambio se valida y publica como una nueva versión." footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={!valid} loading={submit.isPending} onClick={() => submit.mutate()}>Proponer cambio</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Título" className="sm:col-span-2"><Input value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} placeholder="Ej.: Importe ganado por comercial" /></Field>
        <Field label="Tipo">
          <Select value={w.type} onChange={(e) => setW({ ...w, type: e.target.value as Widget['type'] })}>
            <option value="metric">Métrica</option><option value="bar">Barras</option><option value="donut">Donut</option><option value="line">Evolución</option><option value="list">Lista</option>
          </Select>
        </Field>
        <Field label="Módulo">
          <Select value={w.module} onChange={(e) => setW({ ...w, module: e.target.value, field: '', groupBy: '' })}>
            {modules.map((m) => <option key={m.key} value={m.key}>{m.labelPlural}</option>)}
          </Select>
        </Field>
        {w.type !== 'list' && (
          <Field label="Cálculo">
            <Select value={w.aggregate} onChange={(e) => setW({ ...w, aggregate: e.target.value as Widget['aggregate'] })}>
              <option value="count">Contar registros</option><option value="sum" disabled={!numeric.length}>Sumar</option><option value="avg" disabled={!numeric.length}>Media</option>
            </Select>
          </Field>
        )}
        {w.type !== 'list' && w.aggregate !== 'count' && (
          <Field label="Campo numérico">
            <Select value={w.field} onChange={(e) => setW({ ...w, field: e.target.value })}><option value="">Elige…</option>{numeric.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
          </Field>
        )}
        {(w.type === 'bar' || w.type === 'donut') && (
          <Field label="Agrupar por">
            <Select value={w.groupBy} onChange={(e) => setW({ ...w, groupBy: e.target.value })}><option value="">Elige…</option>{groupable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
          </Field>
        )}
        {w.type === 'line' && (
          <Field label="Fecha">
            <Select value={w.dateField} onChange={(e) => setW({ ...w, dateField: e.target.value })}>{dates.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
          </Field>
        )}
        <Field label="Tamaño">
          <Select value={w.size} onChange={(e) => setW({ ...w, size: e.target.value as Widget['size'] })}><option value="sm">Pequeño</option><option value="md">Mediano</option><option value="lg">Grande</option><option value="xl">Ancho completo</option></Select>
        </Field>
      </div>
    </Modal>
  );
}

export default function Dashboard() {
  const { me, can } = useSession();
  const bp = useBlueprint();
  const navigate = useNavigate();
  const toast = useToast();
  const dashboards = bp.data?.blueprint.dashboards ?? [];
  // Inicio de la organización (navigation.home): una página propia o un panel. «?panel=<clave>» abre un panel concreto.
  const [params, setParams] = useSearchParams();
  const panel = params.get('panel');
  const home = bp.data?.blueprint.navigation?.home;
  const homePage = !panel && home?.type === 'page' ? bp.data?.blueprint.pages?.find((p) => p.key === home.key) : undefined;
  const dashboard = dashboards.find((d) => d.key === (panel ?? (home?.type === 'dashboard' ? home.key : undefined))) ?? dashboards[0];
  const data = useQuery({ queryKey: ['dashboard', dashboard?.key, bp.data?.version], queryFn: () => get<{ data: Record<string, WidgetData> }>(`/dashboards/${dashboard!.key}/data`), enabled: !!dashboard && !homePage });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const removeWidget = useMutation({
    mutationFn: (key: string) =>
      post<{ id: string }>('/evolve/requests/manual', {
        changeSet: { title: `Panel: quitar widget`, summary: `Quita el widget «${dashboard!.widgets.find((w) => w.key === key)?.title}» del panel ${dashboard!.label}.`, operations: [{ op: 'upsert_dashboard', dashboard: { ...dashboard!, widgets: dashboard!.widgets.filter((w) => w.key !== key) } }] },
      }),
    onSuccess: (r) => { toast('Cambio enviado a revisión'); navigate(`/evolve/requests/${r.id}`); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  }, []);

  if (bp.isLoading) return <PageLoader />;
  if (bp.error) return <ErrorState error={bp.error} onRetry={() => bp.refetch()} className="py-24" />;
  if (homePage) return <PageView key={homePage.key} page={homePage} />;
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm text-zinc-500">{new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">{greeting}, {me?.user.name.split(' ')[0]}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dashboards.length > 1 && (
            // El ancho va en un envoltorio: la clase base w-full del Select no se puede anular con className.
            <div className="w-48">
              <Select aria-label="Panel" value={dashboard?.key} onChange={(e) => setParams({ panel: e.target.value })}>
                {dashboards.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </Select>
            </div>
          )}
          {can('admin') && dashboard && (
            <>
              <Button size="sm" icon={<LayoutGrid className="size-3.5" />} variant={editing ? 'primary' : 'secondary'} onClick={() => setEditing((e) => !e)}>{editing ? 'Terminar' : 'Personalizar'}</Button>
              {editing && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Widget</Button>}
            </>
          )}
        </div>
      </div>

      {can('builder') && (
        <button onClick={() => navigate('/evolve')} className="group relative flex w-full items-center gap-4 overflow-hidden rounded-2xl bg-zinc-950 p-5 text-left text-white ring-1 ring-zinc-800 transition hover:ring-fuchsia-500/50 dark:bg-zinc-900">
          <div className="absolute -right-10 -top-16 size-56 rounded-full bg-fuchsia-600/30 blur-3xl transition group-hover:bg-fuchsia-500/40" />
          <div className="absolute -bottom-20 left-20 size-56 rounded-full bg-brand-600/30 blur-3xl" />
          <span className="relative flex size-11 shrink-0 items-center justify-center rounded-xl evolve-gradient"><Wand2 className="size-5" /></span>
          <span className="relative min-w-0 flex-1">
            <span className="block text-sm font-semibold">Haz evolucionar tu CRM</span>
            <span className="block truncate text-sm text-zinc-400">«Quiero un módulo de contratos con avisos de vencimiento» · «Avisa a los comerciales si un cliente importante lleva 15 días sin actividad»</span>
          </span>
          <ArrowRight className="relative size-5 text-zinc-400 transition group-hover:translate-x-0.5 group-hover:text-white" />
        </button>
      )}

      {!dashboard ? (
        <Card><EmptyState icon={<Sparkles className="size-5" />} title="No hay paneles configurados" description="Pide a EVOLVE AI ENGINE que cree un panel con las métricas que necesites." /></Card>
      ) : data.error ? (
        <ErrorState error={data.error} onRetry={() => data.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {dashboard.widgets.map((w) => (
            <Card
              key={w.key}
              className={cx(SIZE[w.size] ?? '', 'animate-pop')}
              title={w.title}
              actions={editing && (
                <button aria-label="Quitar widget" className="text-zinc-400 hover:text-red-600" onClick={() => removeWidget.mutate(w.key)}><Trash2 className="size-4" /></button>
              )}
            >
              <WidgetBody w={w} data={data.data?.data[w.key]} />
            </Card>
          ))}
        </div>
      )}
      {dashboard && <AddWidget dashboard={dashboard} open={adding} onClose={() => setAdding(false)} />}
    </div>
  );
}
