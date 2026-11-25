import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Sparkles } from 'lucide-react';
import { ApiError, errorMessage, get, post } from '../lib/api';
import { useBlueprint } from '../lib/hooks';
import { useSession } from '../lib/session';
import { ModuleIcon } from '../lib/icons';
import type { Blueprint, Module, Page, PageBlock, RecordList, WidgetData } from '../lib/types';
import type { BlockWidth } from '../../../shared/appearance';
import { Alert, Button, Card, cx, EmptyState, ErrorState, Field, PageHeader, PageLoader, Skeleton } from '../components/ui';
import { COMPOSITE_FIELD_TYPES, FieldInput } from '../components/fields';
import { Markdown } from '../components/Markdown';
import { RecordTable, type TableSort } from '../components/RecordTable';
import { WidgetBody } from '../components/WidgetBody';
import { useToast } from '../components/toast';
import NotFound from './NotFound';

/** Rejilla de 6 columnas: completo 6, mitad 3, tercio 2 y dos tercios 4 (en pantallas medianas, tercios a la mitad). */
export const BLOCK_SPAN: Record<BlockWidth, string> = {
  full: 'md:col-span-6',
  half: 'md:col-span-3',
  third: 'md:col-span-3 lg:col-span-2',
  two_thirds: 'md:col-span-3 lg:col-span-4',
};

type Target = { type: 'module' | 'page' | 'dashboard' | 'new_record'; key: string };

/** Ruta de destino de un botón de página. */
export function targetPath(to: Target): string {
  if (to.type === 'module') return `/m/${to.key}`;
  if (to.type === 'new_record') return `/m/${to.key}?new=1`;
  if (to.type === 'page') return `/p/${to.key}`;
  return `/?panel=${encodeURIComponent(to.key)}`;
}

const activeModule = (bp: Blueprint, key: string): Module | undefined => bp.modules.find((m) => m.key === key && !m.archived);

function RecordsBlock({ block, mod, fit }: { block: Extract<PageBlock, { type: 'records' }>; mod: Module; fit: boolean }) {
  const navigate = useNavigate();
  const view = block.view ? mod.views.find((v) => v.key === block.view) : undefined;
  const [sort, setSort] = useState<TableSort | null>(null);
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (view) p.set('view', view.key);
    if (block.filters.length) p.set('filters', JSON.stringify(block.filters));
    if (sort) {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    }
    p.set('page', '1');
    p.set('pageSize', String(block.limit));
    return p.toString();
  }, [view, block.filters, block.limit, sort]);
  // Misma clave que ModulePage: crear o editar registros refresca también los bloques de las páginas.
  const list = useQuery({ queryKey: ['records', mod.key, qs], queryFn: () => get<RecordList>(`/records/${mod.key}?${qs}`), placeholderData: keepPreviousData });
  const title = block.title ?? (view ? `${mod.labelPlural} · ${view.label}` : mod.labelPlural);
  return (
    <Card
      padded={false}
      className="h-full"
      title={title}
      description={list.data ? `${list.data.total} ${list.data.total === 1 ? 'registro' : 'registros'}${list.data.total > list.data.items.length ? ` · se muestran ${list.data.items.length}` : ''}` : undefined}
      actions={
        <Link to={`/m/${mod.key}${view ? `?view=${view.key}` : ''}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
          Ver todos <ArrowRight className="size-3" />
        </Link>
      }
    >
      {list.isLoading ? (
        <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} className="py-8" />
      ) : !list.data!.items.length ? (
        <EmptyState icon={<ModuleIcon name={mod.icon} className="size-5" />} title={`No hay ${mod.labelPlural.toLowerCase()}`} className="py-8" />
      ) : (
        <RecordTable bare fit={fit} mod={mod} columns={block.columns?.length ? block.columns : view?.columns} data={list.data!} sort={sort ?? (view?.sort ? { field: view.sort.field, dir: view.sort.direction } : null)} setSort={setSort} onOpen={(r) => navigate(`/m/${mod.key}/${r.id}`)} />
      )}
    </Card>
  );
}

/** Formulario interno (blueprint.forms) dentro de una página: crea el registro con la API normal y los permisos de quien lo usa. */
function FormBlock({ formKey, blueprint }: { formKey: string; blueprint: Blueprint }) {
  const form = blueprint.forms.find((f) => f.key === formKey);
  const mod = form ? activeModule(blueprint, form.module) : undefined;
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = useMutation({
    mutationFn: () => {
      const filled = Object.fromEntries(Object.entries(values).filter(([k, v]) => form!.fields.includes(k) && v !== null && v !== undefined && v !== ''));
      return post(`/records/${mod!.key}`, { values: { ...form!.defaults, ...filled } });
    },
    onSuccess: () => {
      toast(form!.successMessage);
      setValues({});
      setErrors({});
      qc.invalidateQueries({ queryKey: ['records', mod!.key] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast(errorMessage(e), 'error');
    },
  });
  if (!form || !mod) return null;
  const fields = form.fields.map((k) => mod.fields.find((f) => f.key === k && !f.archived)).filter((f): f is NonNullable<typeof f> => !!f);
  return (
    <Card title={form.name} className="h-full">
      {!can(mod.permissions.create) ? (
        <p className="text-sm text-zinc-500">Tu rol no puede crear {mod.labelPlural.toLowerCase()}.</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          {fields.map((f) => (
            <Field key={f.key} as={COMPOSITE_FIELD_TYPES.has(f.type) ? 'div' : 'label'} label={f.label} required={f.required} error={errors[f.key]}>
              <FieldInput field={f} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} invalid={!!errors[f.key]} />
            </Field>
          ))}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={submit.isPending}>
              {form.submitLabel}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function BlockView({ block, blueprint, data, dataError }: { block: PageBlock; blueprint: Blueprint; data: Record<string, WidgetData> | undefined; dataError: boolean }) {
  const navigate = useNavigate();
  switch (block.type) {
    case 'heading': {
      const cls = block.level === 1 ? 'text-2xl font-semibold tracking-tight' : block.level === 3 ? 'text-xs font-semibold uppercase tracking-wider text-zinc-500' : 'text-lg font-semibold tracking-tight';
      const Tag = block.level === 1 ? 'h2' : block.level === 3 ? 'h4' : 'h3';
      return <Tag className={cx(cls, 'pt-2')}>{block.text}</Tag>;
    }
    case 'text':
      return <Markdown text={block.markdown} className="space-y-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300" />;
    case 'divider':
      return <hr className="my-1 border-zinc-200 dark:border-zinc-800" />;
    case 'widget': {
      const w = block.widget;
      if (!activeModule(blueprint, w.module)) return null;
      return (
        <Card title={w.title} className="h-full">
          {dataError ? <p className="text-sm text-zinc-500">No se han podido calcular los datos.</p> : <WidgetBody w={w} data={data?.[w.key]} />}
        </Card>
      );
    }
    case 'records': {
      const mod = activeModule(blueprint, block.module);
      return mod ? <RecordsBlock block={block} mod={mod} fit={block.width !== 'full'} /> : null;
    }
    case 'form':
      return <FormBlock formKey={block.form} blueprint={blueprint} />;
    case 'buttons': {
      const items = block.items.filter((it) => (it.to.type === 'module' || it.to.type === 'new_record' ? !!activeModule(blueprint, it.to.key) : true));
      if (!items.length) return null;
      return (
        <div className="flex flex-wrap items-center gap-2">
          {items.map((it, i) => (
            <Button key={i} variant={it.style ?? (i === 0 ? 'primary' : 'secondary')} onClick={() => navigate(targetPath(it.to))}>
              {it.label}
            </Button>
          ))}
        </div>
      );
    }
  }
}

/** Página propia de la organización (también como página de inicio, ver Dashboard). */
export function PageView({ page }: { page: Page }) {
  const bp = useBlueprint();
  const { can } = useSession();
  const navigate = useNavigate();
  const hasWidgets = page.blocks.some((b) => b.type === 'widget');
  // Bajo la clave ['dashboard', …]: las pantallas que modifican registros ya invalidan ['dashboard'].
  const data = useQuery({ queryKey: ['dashboard', 'page', page.key, bp.data?.version], queryFn: () => get<{ data: Record<string, WidgetData> }>(`/pages/${page.key}/data`), enabled: hasWidgets });
  const blueprint = bp.data?.blueprint;
  if (!blueprint) return <PageLoader />;
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <ModuleIcon name={page.icon} className="size-5" />
          </span>
        }
        title={page.label}
        description={page.description}
        actions={
          can('builder') && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Sparkles className="size-3.5 text-fuchsia-500" />}
              onClick={() => {
                sessionStorage.setItem('evolve-prefill', `En la página «${page.label}»: `);
                navigate('/evolve');
              }}
            >
              Evolucionar página
            </Button>
          )
        }
      />
      {data.error && <Alert tone="warning">No se han podido calcular los widgets: {errorMessage(data.error)}</Alert>}
      {page.blocks.length === 0 ? (
        <Card>
          <EmptyState icon={<Sparkles className="size-5" />} title="Esta página todavía no tiene contenido" description="Pide a EVOLVE AI ENGINE que añada indicadores, listas de registros, textos o botones." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
          {page.blocks.map((b, i) => (
            <div key={i} className={cx('min-w-0', BLOCK_SPAN[b.width])}>
              <BlockView block={b} blueprint={blueprint} data={data.data?.data} dataError={!!data.error} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ruta /p/:page. */
export default function CustomPage() {
  const { page: key = '' } = useParams();
  const bp = useBlueprint();
  if (bp.isLoading) return <PageLoader />;
  if (bp.error) return <ErrorState error={bp.error} onRetry={() => bp.refetch()} className="py-24" />;
  const page = bp.data?.blueprint.pages?.find((p) => p.key === key);
  if (!page) return <NotFound />;
  return <PageView key={page.key} page={page} />;
}
