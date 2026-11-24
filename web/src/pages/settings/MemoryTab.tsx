import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, Brain, Building2, GitBranch, ListChecks, Lock, MessageSquare, Pencil, Plus, Scale, Search, SlidersHorizontal, User, UserPen } from 'lucide-react';
import type { Color } from '../../../../shared/constants';
import { Badge, Button, Card, ConfirmDialog, cx, EmptyState, ErrorState, Field, IconButton, Input, Modal, Select, Skeleton, Textarea } from '../../components/ui';
import { useToast } from '../../components/toast';
import { del, get, patch, post } from '../../lib/api';
import { formatDate, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { AI_KEYS, describeError, FieldGroup, Segmented } from './ai/shared';

type Kind = 'decision' | 'preference' | 'fact' | 'instruction';
type Scope = 'org' | 'user';

interface MemoryItem {
  id: string;
  scope: Scope;
  kind: string;
  content: string;
  source: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  user_id: string | null;
}

const KINDS: { key: Kind; label: string; plural: string; color: Color; icon: ReactNode; description: string; example: string }[] = [
  { key: 'decision', label: 'Decisión', plural: 'Decisiones', color: 'violet', icon: <Scale className="size-3" />, description: 'Algo que ya se ha decidido y la IA debe respetar.', example: 'Ej.: Los importes de las oportunidades se registran sin IVA.' },
  { key: 'preference', label: 'Preferencia', plural: 'Preferencias', color: 'sky', icon: <SlidersHorizontal className="size-3" />, description: 'Cómo prefieres que trabaje o responda la IA.', example: 'Ej.: Prefiero respuestas breves, con tablas cuando haya cifras.' },
  { key: 'fact', label: 'Hecho', plural: 'Hechos', color: 'emerald', icon: <BookOpen className="size-3" />, description: 'Un dato estable sobre el negocio o el equipo.', example: 'Ej.: Vendemos solo a empresas (B2B) en España y Portugal.' },
  { key: 'instruction', label: 'Instrucción', plural: 'Instrucciones', color: 'amber', icon: <ListChecks className="size-3" />, description: 'Una regla que la IA debe seguir siempre.', example: 'Ej.: No propongas nunca campos para guardar datos bancarios.' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.key, k])) as Record<Kind, (typeof KINDS)[number]>;

const SOURCES: Record<string, { label: string; icon: ReactNode }> = {
  manual: { label: 'Añadido a mano', icon: <UserPen className="size-3" /> },
  assistant: { label: 'Propuesto por el asistente · pendiente de confirmar', icon: <MessageSquare className="size-3" /> },
  release: { label: 'Publicación de versión', icon: <GitBranch className="size-3" /> },
  rollback: { label: 'Reversión de versión', icon: <GitBranch className="size-3" /> },
};

const MIN = 3;
const MAX = 2000;

function MemoryRow({ item, canEdit, onArchive }: { item: MemoryItem; canEdit: boolean; onArchive: (item: MemoryItem) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.content);
  const save = useMutation({
    mutationFn: (content: string) => patch(`/ai/memory/${item.id}`, { content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AI_KEYS.memory });
      setEditing(false);
      toast('Memoria actualizada');
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
  const confirmItem = useMutation({
    mutationFn: () => patch(`/ai/memory/${item.id}`, { content: item.content, confirm: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AI_KEYS.memory });
      toast('Confirmado: la IA ya lo tendrá en cuenta');
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
  const pending = item.source === 'assistant';
  const kind = KIND[item.kind as Kind];
  const source = SOURCES[item.source];
  const edited = new Date(item.updated_at).getTime() - new Date(item.created_at).getTime() > 60_000;
  const trimmed = text.trim();
  const valid = trimmed.length >= MIN && trimmed.length <= MAX;
  const submit = () => {
    if (!valid) return;
    if (trimmed === item.content) {
      setEditing(false);
      return;
    }
    save.mutate(trimmed);
  };
  return (
    <li className="group px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge color={kind?.color ?? 'slate'}>
              {kind?.icon}
              {kind?.label ?? item.kind}
            </Badge>
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
              {source?.icon}
              {source?.label ?? item.source}
            </span>
            {(item.source === 'release' || item.source === 'rollback') && (
              <Link to="/evolve/releases" className="text-[11px] font-medium text-brand-600 hover:underline dark:text-brand-400">
                Ver versiones
              </Link>
            )}
          </div>
          {editing ? (
            <div className="space-y-2">
              <Textarea
                autoFocus
                rows={3}
                value={text}
                invalid={!valid}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditing(false);
                    setText(item.content);
                  }
                }}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cx('text-xs', valid ? 'text-zinc-500' : 'text-red-600 dark:text-red-400')}>{valid ? `${trimmed.length} / ${MAX} · Ctrl+Enter para guardar` : `Entre ${MIN} y ${MAX} caracteres`}</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={save.isPending}
                    onClick={() => {
                      setEditing(false);
                      setText(item.content);
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button size="sm" variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
                    Guardar
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{item.content}</p>
          )}
          {pending && !editing && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <span>La IA no lo usará hasta que lo revises y confirmes.</span>
              {canEdit && (
                <Button size="sm" variant="secondary" loading={confirmItem.isPending} onClick={() => confirmItem.mutate()}>
                  Confirmar
                </Button>
              )}
            </div>
          )}
          <div className="mt-1.5 text-[11px] text-zinc-400" title={formatDate(item.updated_at, true)}>
            Añadido {relativeTime(item.created_at)}
            {edited && ` · editado ${relativeTime(item.updated_at)}`}
          </div>
        </div>
        {!editing &&
          (canEdit ? (
            <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
              <IconButton
                label="Editar"
                onClick={() => {
                  setText(item.content);
                  setEditing(true);
                }}
              >
                <Pencil className="size-4" />
              </IconButton>
              <IconButton label="Archivar" onClick={() => onArchive(item)} className="hover:text-red-600">
                <Archive className="size-4" />
              </IconButton>
            </div>
          ) : (
            <span className="shrink-0 p-2 text-zinc-300 dark:text-zinc-600" title="Solo los administradores pueden modificar la memoria de la organización">
              <Lock className="size-3.5" />
            </span>
          ))}
      </div>
    </li>
  );
}

function AddMemoryModal({ open, onClose, isAdmin }: { open: boolean; onClose: () => void; isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [scope, setScope] = useState<Scope>(isAdmin ? 'org' : 'user');
  const [kind, setKind] = useState<Kind>('decision');
  const [content, setContent] = useState('');
  const trimmed = content.trim();
  const valid = trimmed.length >= MIN && trimmed.length <= MAX && (scope === 'user' || isAdmin);
  const reset = () => {
    setContent('');
    setKind('decision');
    setScope(isAdmin ? 'org' : 'user');
  };
  const add = useMutation({
    mutationFn: () => post<{ id: string }>('/ai/memory', { scope, kind, content: trimmed }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AI_KEYS.memory });
      toast(scope === 'org' ? 'Añadido a la memoria de la organización' : 'Añadido a tu memoria personal');
      reset();
      onClose();
    },
    onError: (e) => toast(describeError(e), 'error'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Añadir a la memoria de la IA"
      description="Escribe una frase clara y autocontenida: la IA la leerá como contexto en futuras peticiones."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={add.isPending} disabled={!valid} onClick={() => add.mutate()}>
            Añadir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldGroup label="Ámbito" hint={!isAdmin ? 'Solo los administradores pueden añadir memoria de organización.' : scope === 'org' ? 'Visible para toda la organización y usada en todas las peticiones.' : 'Solo para ti: la IA la usa cuando trabaja en tus peticiones.'}>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { key: 'org', label: 'Organización', icon: <Building2 className="size-4" />, disabled: !isAdmin, title: !isAdmin ? 'Solo administradores' : undefined },
              { key: 'user', label: 'Personal', icon: <User className="size-4" /> },
            ]}
          />
        </FieldGroup>
        <Field label="Tipo" hint={KIND[kind].description}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Contenido" required hint={`${trimmed.length} / ${MAX} caracteres`} error={content && trimmed.length < MIN ? `Mínimo ${MIN} caracteres` : trimmed.length > MAX ? `Máximo ${MAX} caracteres` : undefined}>
          <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder={KIND[kind].example} />
        </Field>
      </div>
    </Modal>
  );
}

function MemorySection({ title, description, icon, items, total, canEdit, onArchive, empty }: { title: string; description: string; icon: ReactNode; items: MemoryItem[]; total: number; canEdit: (i: MemoryItem) => boolean; onArchive: (i: MemoryItem) => void; empty: string }) {
  return (
    <Card
      padded={false}
      title={
        <span className="inline-flex items-center gap-2">
          {icon} {title}
          <span className="rounded-full bg-zinc-100 px-1.5 text-[11px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{total}</span>
        </span>
      }
      description={description}
    >
      {items.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {items.map((it) => (
            <MemoryRow key={it.id} item={it} canEdit={canEdit(it)} onArchive={onArchive} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-zinc-500">{empty}</p>
      )}
    </Card>
  );
}

/** Memoria auditable de la IA por organización (y por usuario). */
export default function MemoryTab() {
  const { can } = useSession();
  const isAdmin = can('admin');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: AI_KEYS.memory, queryFn: () => get<MemoryItem[]>('/ai/memory'), staleTime: 15_000 });
  const [kind, setKind] = useState<'all' | Kind>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [archiving, setArchiving] = useState<MemoryItem | null>(null);

  const archive = useMutation({
    mutationFn: (id: string) => del(`/ai/memory/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AI_KEYS.memory });
      setArchiving(null);
      toast('Elemento archivado: la IA ya no lo tendrá en cuenta');
    },
    onError: (e) => toast(describeError(e), 'error'),
  });

  const items = useMemo(() => q.data ?? [], [q.data]);
  const term = search.trim().toLowerCase();
  const filtered = items.filter((i) => (kind === 'all' || i.kind === kind) && (!term || i.content.toLowerCase().includes(term)));
  const org = filtered.filter((i) => i.scope === 'org');
  const mine = filtered.filter((i) => i.scope === 'user');
  const count = (k: Kind) => items.filter((i) => i.kind === k).length;
  const filterActive = kind !== 'all' || !!term;

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-2xl bg-white p-5 ring-1 ring-zinc-200/80 shadow-xs dark:bg-zinc-900 dark:ring-zinc-800">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 size-56 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl evolve-gradient text-white shadow-sm shadow-fuchsia-500/25">
              <Brain className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Memoria de EVOLVE AI</h2>
              <p className="mt-0.5 max-w-2xl text-sm leading-relaxed text-zinc-500">
                Decisiones, preferencias, hechos e instrucciones que el asistente y el motor de evolución usan como contexto en cada petición. Es exclusiva de esta organización, auditable y editable. Cada publicación o reversión de versión añade automáticamente una decisión.
              </p>
            </div>
          </div>
          <Button variant="primary" className="shrink-0" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Añadir
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full max-w-lg" />
          <Skeleton className="h-64" />
          <Skeleton className="h-40" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={<Brain className="size-5" />}
            title="La memoria está vacía"
            description="Añade las decisiones y reglas de tu negocio para que la IA las respete. También se irá llenando sola con cada versión publicada."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                Añadir el primer elemento
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Segmented
              size="sm"
              value={kind}
              onChange={setKind}
              options={[{ key: 'all' as const, label: 'Todo', count: items.length }, ...KINDS.map((k) => ({ key: k.key, label: k.plural, count: count(k.key) }))]}
            />
            <div className="relative w-full lg:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar en la memoria…" className="pl-9" aria-label="Buscar en la memoria" />
            </div>
          </div>

          <MemorySection
            title="Organización"
            description={isAdmin ? 'Compartida por toda la organización y usada en todas las peticiones de IA.' : 'Compartida por toda la organización. Solo los administradores pueden modificarla.'}
            icon={<Building2 className="size-4 text-brand-500" />}
            items={org}
            total={org.length}
            canEdit={() => isAdmin}
            onArchive={setArchiving}
            empty={filterActive ? 'Ningún elemento de la organización coincide con el filtro.' : 'Todavía no hay memoria de organización.'}
          />
          <MemorySection
            title="Personal"
            description="Solo para ti: la IA la tiene en cuenta cuando trabaja en tus peticiones."
            icon={<User className="size-4 text-sky-500" />}
            items={mine}
            total={mine.length}
            canEdit={() => true}
            onArchive={setArchiving}
            empty={filterActive ? 'Ningún elemento personal coincide con el filtro.' : 'No tienes memoria personal. Puedes pedirle al asistente que recuerde tus preferencias o añadirlas aquí.'}
          />
        </>
      )}

      <AddMemoryModal open={adding} onClose={() => setAdding(false)} isAdmin={isAdmin} />
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        onConfirm={() => archiving && archive.mutate(archiving.id)}
        loading={archive.isPending}
        danger
        title="¿Archivar este elemento de memoria?"
        description="La IA dejará de tenerlo en cuenta en las próximas peticiones. La acción queda registrada en la auditoría."
        confirmLabel="Archivar"
      >
        {archiving && <p className="line-clamp-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-950/40 dark:text-zinc-300 dark:ring-zinc-800">{archiving.content}</p>}
      </ConfirmDialog>
    </div>
  );
}
