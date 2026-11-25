import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronDown, Code2, Inbox } from 'lucide-react';
import { errorMessage, get, post } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { Badge, Button, Card, cx, EmptyState, ErrorState, Skeleton, Textarea } from '../../components/ui';
import { useToast } from '../../components/toast';
import { changeLink, STATUS, type PlatformRequest } from './codeTypes';

/**
 * Bandeja de las peticiones de EVOLVE que las organizaciones no pueden resolver con su configuración
 * (necesitan una funcionalidad de la plataforma). Cada una se puede convertir en un cambio del código fuente.
 */
export function PlatformInbox({ canCreate, blockedReason }: { canCreate: boolean; blockedReason: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const list = useQuery({ queryKey: ['platform-code', 'inbox'], queryFn: () => get<PlatformRequest[]>('/platform/requests') });
  const convert = useMutation({
    mutationFn: (id: string) => post<{ id: string }>(`/platform/requests/${id}/source-change`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: (r) => {
      setNote('');
      qc.invalidateQueries({ queryKey: ['platform-code'] });
      navigate(changeLink(r.id));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <Card title={<span className="flex items-center gap-2"><Inbox className="size-4 text-brand-500" /> Peticiones de las organizaciones</span>} description="Lo que EVOLVE no puede construir solo para una organización (integraciones con OAuth, pantallas nuevas…) queda registrado aquí." padded={false}>
      {list.isLoading ? (
        <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data!.length ? (
        <EmptyState icon={<Inbox className="size-5" />} title="No hay peticiones de plataforma" description="Cuando una organización pida algo que necesite código nuevo de la plataforma, aparecerá aquí." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data!.map((r) => {
            const isOpen = open === r.id;
            const status = r.source_change_status ? STATUS[r.source_change_status] : null;
            return (
              <li key={r.id} className="px-4 py-3">
                <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(isOpen ? null : r.id)}>
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800">
                    <Building2 className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{r.title ?? 'Petición de plataforma'}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      {r.workspace_name} · {r.requested_by_name ?? '—'} · {relativeTime(r.created_at)}
                    </span>
                    {r.platform_request && <span className={cx('mt-1 block text-sm text-zinc-600 dark:text-zinc-400', !isOpen && 'line-clamp-2')}>{r.platform_request}</span>}
                  </span>
                  {status && <Badge color={status.color} dot>{status.label}</Badge>}
                  <ChevronDown className={cx('mt-1 size-4 shrink-0 text-zinc-400 transition', isOpen && 'rotate-180')} />
                </button>
                {isOpen && (
                  <div className="mt-3 space-y-3 pl-11">
                    <div className="rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/40">
                      <div className="text-xs font-medium text-zinc-500">Petición original de la organización</div>
                      <p className="mt-1 whitespace-pre-wrap">{r.prompt}</p>
                    </div>
                    {r.source_change_id ? (
                      <Link to={changeLink(r.source_change_id)} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                        <Code2 className="size-4" /> Ver el cambio de código
                      </Link>
                    ) : (
                      <div className="space-y-2">
                        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Indicaciones para el agente (opcional): alcance, decisiones de diseño…" />
                        <div className="flex flex-wrap items-center gap-2">
                          <Button variant="ai" size="sm" icon={<Code2 className="size-4" />} disabled={!canCreate} loading={convert.isPending && convert.variables === r.id} onClick={() => convert.mutate(r.id)}>
                            Convertir en cambio de código
                          </Button>
                          {!canCreate && blockedReason && <span className="text-xs text-zinc-500">{blockedReason}</span>}
                        </div>
                        <p className="text-xs text-zinc-500">El texto lo escribió la organización: el agente lo trata como un dato y el cambio sigue el proceso completo (CI, revisión y tu aprobación).</p>
                      </div>
                    )}
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
