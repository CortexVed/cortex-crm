import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, FileText, MessageCircle, Paperclip, Pencil, Plus, Send, Sparkles, StickyNote, Trash2, Upload, Zap } from 'lucide-react';
import { ApiError, del, errorMessage, get, patch, post, uploadFile } from '../lib/api';
import { useBlueprint } from '../lib/hooks';
import { useSession } from '../lib/session';
import { ModuleIcon } from '../lib/icons';
import { MODULE_ACCENT } from '../lib/colors';
import { formatBytes, formatDate, relativeTime } from '../lib/format';
import type { Field, Module, RecordItem, Refs } from '../lib/types';
import { recordTitle } from '../../../shared/records';
import type { Color } from '../../../shared/constants';
import { Avatar, Badge, Button, Card, ConfirmDialog, cx, EmptyState, ErrorState, PageLoader, Select, Textarea } from '../components/ui';
import { FieldValue, moduleSections, RecordForm } from '../components/fields';
import { useToast } from '../components/toast';
import { AnalyzeFileButton, canAnalyze, ClassifyButton } from '../components/AiTools';
import NotFound from './NotFound';

interface Detail {
  record: RecordItem;
  related: { module: string; label: string; icon: string; field: string; fieldLabel: string; total: number; items: RecordItem[] }[];
  refs: Refs;
}

function fmtChange(field: Field | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  if (!field) return typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (field.type === 'select') return field.options?.find((o) => o.value === v)?.label ?? String(v);
  if (field.type === 'multi_select' && Array.isArray(v)) return v.map((x) => field.options?.find((o) => o.value === x)?.label ?? x).join(', ');
  if (field.type === 'relation' || field.type === 'user' || field.type === 'file') return 'actualizado';
  if (field.type === 'date' || field.type === 'datetime') return formatDate(String(v), field.type === 'datetime');
  if (field.type === 'boolean') return v ? 'Sí' : 'No';
  return String(v).slice(0, 80);
}

function Timeline({ mod, recordId }: { mod: Module; recordId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['timeline', mod.key, recordId], queryFn: () => get<{ items: any[] }>(`/records/${mod.key}/${recordId}/timeline`) });
  const add = useMutation({
    mutationFn: () => post(`/records/${mod.key}/${recordId}/notes`, { body: note }),
    onSuccess: () => {
      setNote('');
      qc.invalidateQueries({ queryKey: ['timeline', mod.key, recordId] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/notes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['timeline', mod.key, recordId] }),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Card title="Actividad" padded={false}>
      {can('member') && (
        <form className="border-b border-zinc-100 p-3 dark:border-zinc-800" onSubmit={(e) => { e.preventDefault(); if (note.trim()) add.mutate(); }}>
          <Textarea rows={2} placeholder="Escribe una nota…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) add.mutate(); }} />
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="primary" type="submit" loading={add.isPending} disabled={!note.trim()} icon={<StickyNote className="size-3.5" />}>Añadir nota</Button>
          </div>
        </form>
      )}
      {q.isLoading ? (
        <div className="p-4 text-sm text-zinc-400">Cargando actividad…</div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data!.items.length ? (
        <EmptyState title="Sin actividad todavía" />
      ) : (
        <ol className="max-h-[560px] space-y-0 overflow-y-auto p-3 scrollbar-thin">
          {q.data!.items.map((it) => (
            <li key={`${it.kind}-${it.id}`} className="relative flex gap-3 pb-4 pl-1 last:pb-1">
              <span className="absolute left-[15px] top-8 h-[calc(100%-24px)] w-px bg-zinc-200 dark:bg-zinc-800" />
              <span className={cx('z-10 flex size-7 shrink-0 items-center justify-center rounded-full ring-4 ring-white dark:ring-zinc-900', it.kind === 'note' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : it.kind === 'message' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' : it.kind === 'automation' ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800')}>
                {it.kind === 'note' ? <StickyNote className="size-3.5" /> : it.kind === 'message' ? <MessageCircle className="size-3.5" /> : it.kind === 'automation' ? <Zap className="size-3.5" /> : it.actorType === 'ai' ? <Bot className="size-3.5" /> : <Pencil className="size-3.5" />}
              </span>
              <div className="min-w-0 flex-1 pt-0.5 text-sm">
                {it.kind === 'history' && (
                  <>
                    <div>
                      <span className="font-medium">{it.actor}</span>{' '}
                      <span className="text-zinc-500">{it.action === 'create' ? 'creó el registro' : it.action === 'delete' ? 'eliminó el registro' : it.action === 'restore' ? 'restauró el registro' : 'actualizó'}</span>
                    </div>
                    {it.action === 'update' && (
                      <ul className="mt-1 space-y-0.5 text-xs text-zinc-500">
                        {Object.entries(it.changes as Record<string, { from: unknown; to: unknown }>).slice(0, 8).map(([k, c]) => {
                          const f = mod.fields.find((x) => x.key === k);
                          return (
                            <li key={k}>
                              <span className="text-zinc-700 dark:text-zinc-300">{f?.label ?? k}:</span> {fmtChange(f, c.from)} → <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtChange(f, c.to)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                )}
                {it.kind === 'note' && (
                  <div className="rounded-lg bg-amber-50/70 px-3 py-2 dark:bg-amber-500/10">
                    <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">{it.actor}</span>
                      {(it.mine || can('admin')) && (
                        <button aria-label="Eliminar nota" className="text-zinc-400 hover:text-red-600" onClick={() => remove.mutate(it.id)}><Trash2 className="size-3.5" /></button>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{it.body}</p>
                  </div>
                )}
                {it.kind === 'message' && (
                  <div className={cx('rounded-lg px-3 py-2', it.direction === 'inbound' ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'bg-zinc-100 dark:bg-zinc-800')}>
                    <div className="text-xs text-zinc-500">
                      <Badge color={it.channel === 'whatsapp' ? 'green' : 'sky'}>{it.channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</Badge> {it.direction === 'inbound' ? `de ${it.from ?? 'contacto'}` : 'enviado'}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{it.body}</p>
                  </div>
                )}
                {it.kind === 'automation' && (
                  <div>
                    <span className="font-medium">Automatización</span> <span className="text-zinc-500">«{it.automation}»</span>{' '}
                    <Badge color={it.status === 'success' ? 'emerald' : it.status === 'failed' ? 'red' : 'slate'}>{it.status === 'success' ? 'ejecutada' : it.status === 'failed' ? 'con error' : it.status}</Badge>
                    {Array.isArray(it.log) && it.log.length > 0 && <div className="mt-0.5 text-xs text-zinc-500">{it.log.join(' · ')}</div>}
                  </div>
                )}
                <div className="mt-1 text-[11px] text-zinc-400">{relativeTime(it.at)}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Documents({ mod, recordId, canEdit }: { mod: Module; recordId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['files', recordId], queryFn: () => get<any[]>(`/records/${mod.key}/${recordId}/files`) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/files/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['files', recordId] }), onError: (e) => toast(errorMessage(e), 'error') });
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) await uploadFile(f, { recordId });
      qc.invalidateQueries({ queryKey: ['files', recordId] });
      qc.invalidateQueries({ queryKey: ['timeline', mod.key, recordId] });
      toast('Documentos subidos');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Documentos"
      actions={
        canEdit && (
          <label className={cx('inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800', busy && 'pointer-events-none opacity-60')}>
            <Upload className="size-3.5" /> {busy ? 'Subiendo…' : 'Subir'}
            <input type="file" multiple className="sr-only" onChange={(e) => upload(e.target.files)} />
          </label>
        )
      }
      padded={false}
    >
      {q.isLoading ? (
        <div className="p-4 text-sm text-zinc-400">Cargando…</div>
      ) : !q.data?.length ? (
        <p className="px-4 py-5 text-center text-sm text-zinc-500">Sin documentos</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {q.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <FileText className="size-4 shrink-0 text-zinc-400" />
              <a href={`/api/files/${f.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{f.name}</a>
              <span className="text-xs text-zinc-400">{formatBytes(f.size)}</span>
              {canAnalyze(f.name) && <AnalyzeFileButton file={f} mod={mod} recordId={recordId} />}
              {canEdit && (
                <button aria-label="Eliminar documento" className="text-zinc-400 hover:text-red-600" onClick={() => remove.mutate(f.id)}><Trash2 className="size-3.5" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Messaging({ mod, recordId }: { mod: Module; recordId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const conn = useQuery({ queryKey: ['connectors'], queryFn: () => get<{ connectors: { id: string; type: string; name: string; status: string }[] }>('/comms/connectors') });
  const active = (conn.data?.connectors ?? []).filter((c) => c.status === 'active');
  const [connectorId, setConnectorId] = useState('');
  const send = useMutation({
    mutationFn: () => post('/comms/send', { connectorId: connectorId || active[0].id, recordId, text }),
    onSuccess: () => {
      setText('');
      toast('Mensaje enviado');
      qc.invalidateQueries({ queryKey: ['timeline', mod.key, recordId] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!active.length) return null;
  return (
    <Card title="Enviar mensaje">
      <div className="space-y-2">
        {active.length > 1 && (
          <Select value={connectorId || active[0].id} onChange={(e) => setConnectorId(e.target.value)}>
            {active.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
          </Select>
        )}
        <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe un mensaje…" />
        <div className="flex justify-end">
          <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} loading={send.isPending} disabled={!text.trim()} onClick={() => send.mutate()}>Enviar</Button>
        </div>
      </div>
    </Card>
  );
}

export default function RecordPage() {
  const { module = '', id = '' } = useParams();
  const navigate = useNavigate();
  const bp = useBlueprint();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const mod = bp.data?.blueprint.modules.find((m) => m.key === module && !m.archived);
  const q = useQuery({ queryKey: ['record', module, id], queryFn: () => get<Detail>(`/records/${module}/${id}`), enabled: !!mod });
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: (vals: Record<string, unknown>) => patch<{ record: RecordItem; refs: Refs }>(`/records/${module}/${id}`, { values: vals }),
    onSuccess: () => {
      setEditing(false);
      setErrors({});
      qc.invalidateQueries({ queryKey: ['record', module, id] });
      qc.invalidateQueries({ queryKey: ['records', module] });
      qc.invalidateQueries({ queryKey: ['timeline', module, id] });
      toast('Cambios guardados');
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast(errorMessage(e), 'error');
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/records/${module}/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['records', module] });
      toast('Registro eliminado');
      navigate(`/m/${module}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (bp.isLoading || q.isLoading) return <PageLoader />;
  if (!mod) return <NotFound />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="py-24" />;
  const { record, related, refs } = q.data!;
  const title = recordTitle(mod, record.data);
  const canEdit = can(mod.permissions.update);
  const headline = mod.fields.filter((f) => f.type === 'select' && !f.archived).slice(0, 1)[0];
  const hasClassifiable = mod.fields.some((f) => !f.archived && !f.hidden && (f.type === 'select' || f.type === 'multi_select') && !!f.options?.length);
  const editable = Object.fromEntries(mod.fields.filter((f) => !f.archived && f.type !== 'formula').map((f) => [f.key, record.data[f.key] ?? null]));
  const askAi = (prompt: string) => {
    sessionStorage.setItem('evolve-ai-prefill', prompt);
    window.dispatchEvent(new CustomEvent('evolve:open-ai'));
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <Link to={`/m/${mod.key}`} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> {mod.labelPlural}
      </Link>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-2xl', MODULE_ACCENT[mod.color as Color])}>
            <ModuleIcon name={mod.icon} className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{mod.label}</span>·<span>Creado {relativeTime(record.createdAt)}</span>·<span>Última actividad {relativeTime(record.lastActivityAt)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" icon={<Sparkles className="size-3.5 text-fuchsia-500" />} onClick={() => askAi(`Resume esta ficha y sugiere los próximos pasos.`)}>Preguntar a EVOLVE AI</Button>
          {canEdit && hasClassifiable && <ClassifyButton mod={mod} recordId={record.id} data={record.data} />}
          {canEdit && !editing && <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => { setValues(editable); setErrors({}); setEditing(true); }}>Editar</Button>}
          {can(mod.permissions.delete) && <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>Eliminar</Button>}
        </div>
      </div>

      {headline?.options && (
        <div className="flex gap-1 overflow-x-auto rounded-xl bg-white p-1 ring-1 ring-zinc-200/80 scrollbar-thin dark:bg-zinc-900 dark:ring-zinc-800">
          {headline.options.map((o) => {
            const activeIdx = headline.options!.findIndex((x) => x.value === record.data[headline.key]);
            const idx = headline.options!.findIndex((x) => x.value === o.value);
            const active = record.data[headline.key] === o.value;
            return (
              <button
                key={o.value}
                disabled={!canEdit || save.isPending}
                onClick={() => !active && save.mutate({ [headline.key]: o.value })}
                className={cx('flex-1 shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-default', active ? 'bg-brand-600 text-white shadow-sm' : idx < activeIdx ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          <Card title={editing ? 'Editar' : 'Información'} actions={editing && (<><Button size="sm" onClick={() => setEditing(false)}>Cancelar</Button><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(values)}>Guardar</Button></>)}>
            {editing ? (
              <RecordForm mod={mod} values={values} onChange={setValues} errors={errors} refs={refs} recordId={record.id} mode="edit" />
            ) : (
              <div className="space-y-6">
                {moduleSections(mod).map((s) => (
                  <div key={s.title}>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">{s.title}</div>
                    <dl className={cx('grid gap-x-6 gap-y-3', s.columns === 2 && 'sm:grid-cols-2')}>
                      {s.fields.map((f) => (
                        <div key={f.key} className={cx('min-w-0', (f.type === 'long_text' || f.type === 'file') && 'sm:col-span-2')}>
                          <dt className="text-xs text-zinc-500">{f.label}</dt>
                          <dd className="mt-0.5 text-sm"><FieldValue field={f} value={record.data[f.key]} refs={refs} /></dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {related.map((rel) => {
            const relMod = bp.data!.blueprint.modules.find((m) => m.key === rel.module)!;
            const cols = relMod.fields.filter((f) => !f.archived && f.key !== relMod.primaryField && f.key !== rel.field && ['select', 'currency', 'date', 'user', 'email'].includes(f.type)).slice(0, 3);
            return (
              <Card
                key={`${rel.module}-${rel.field}`}
                title={<span className="flex items-center gap-2"><ModuleIcon name={rel.icon} className="size-4 text-zinc-400" /> {rel.label} <span className="font-normal text-zinc-400">({rel.total})</span></span>}
                description={rel.fieldLabel !== mod.label ? `Vinculados por «${rel.fieldLabel}»` : undefined}
                actions={can(relMod.permissions.create) && (
                  <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => { sessionStorage.setItem(`evolve-new-prefill:${rel.module}`, JSON.stringify({ [rel.field]: record.id })); navigate(`/m/${rel.module}?new=1`); }}>
                    Nuevo
                  </Button>
                )}
                padded={false}
              >
                {!rel.items.length ? (
                  <p className="px-4 py-5 text-center text-sm text-zinc-500">Ninguno todavía</p>
                ) : (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {rel.items.map((it) => (
                      <li key={it.id}>
                        <Link to={`/m/${rel.module}/${it.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                          <span className="min-w-0 flex-1 truncate font-medium">{recordTitle(relMod, it.data)}</span>
                          {cols.map((f) => <span key={f.key} className="hidden max-w-40 truncate text-xs sm:block"><FieldValue field={f} value={it.data[f.key]} refs={refs} compact /></span>)}
                        </Link>
                      </li>
                    ))}
                    {rel.total > rel.items.length && <li className="px-4 py-2 text-xs text-zinc-500">Y {rel.total - rel.items.length} más…</li>}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
        <div className="space-y-5">
          <Messaging mod={mod} recordId={record.id} />
          <Timeline mod={mod} recordId={record.id} />
          <Documents mod={mod} recordId={record.id} canEdit={canEdit} />
          <div className="flex items-center gap-2 px-1 text-xs text-zinc-400">
            <Paperclip className="size-3" /> Actualizado {formatDate(record.updatedAt, true)}{record.updatedBy && refs.users[record.updatedBy] ? <> por <Avatar name={refs.users[record.updatedBy]} size="sm" /> {refs.users[record.updatedBy]}</> : null}
          </div>
        </div>
      </div>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger title={`Eliminar ${mod.label.toLowerCase()}`} description={`«${title}» se moverá a la papelera. Un administrador puede restaurarlo y la acción queda en el registro de auditoría.`} confirmLabel="Eliminar" />
    </div>
  );
}
