import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, History, MessageSquarePlus, Search, Sparkles, Wand2, X } from 'lucide-react';
import { errorMessage, get, patch, post } from '../lib/api';
import { useBlueprint } from '../lib/hooks';
import { useSession } from '../lib/session';
import { relativeTime } from '../lib/format';
import { Button, cx, IconButton, Spinner } from './ui';
import { Markdown } from './Markdown';
import { useToast } from './toast';

interface Action {
  type: 'record_change' | 'evolution' | 'memory';
  summary: string;
  payload: any;
}
interface Msg {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  toolCalls?: { name: string; isError?: boolean }[];
  actions?: Action[];
  model?: string;
}

const TOOL_LABELS: Record<string, string> = {
  search_records: 'Buscó registros',
  get_record: 'Consultó una ficha',
  list_related: 'Revisó registros relacionados',
  aggregate: 'Calculó métricas',
  propose_record_change: 'Preparó un cambio',
  propose_evolution: 'Preparó una evolución',
  remember: 'Propuso guardar en memoria',
};

function ActionCard({ action, onDone }: { action: Action; onDone: (state: 'done' | 'dismissed') => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'dismissed'>('idle');
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [link, setLink] = useState<string | null>(null);
  const confirm = async () => {
    setState('busy');
    try {
      if (action.type === 'record_change') {
        const p = action.payload;
        if (p.action === 'create') {
          const r = await post(`/records/${p.module}`, { values: p.values });
          setLink(`/m/${p.module}/${r.record.id}`);
        } else {
          await patch(`/records/${p.module}/${p.id}`, { values: p.values });
          setLink(`/m/${p.module}/${p.id}`);
        }
        qc.invalidateQueries({ queryKey: ['records', p.module] });
        qc.invalidateQueries({ queryKey: ['record', p.module] });
        toast('Cambio aplicado');
      } else if (action.type === 'memory') {
        await post('/ai/memory', { scope: action.payload.scope, kind: action.payload.kind, content: action.payload.content, fromAssistant: true });
        toast('Guardado como propuesta: confírmalo en Ajustes → Memoria para que la IA lo use');
      } else {
        const r = await post<{ id: string }>('/evolve/requests', { prompt: action.payload.prompt });
        toast('Petición enviada a EVOLVE AI ENGINE');
        navigate(`/evolve/requests/${r.id}`);
      }
      setState('done');
      onDone('done');
    } catch (e) {
      toast(errorMessage(e), 'error');
      setState('idle');
    }
  };
  const values = action.type === 'record_change' ? Object.entries(action.payload.values ?? {}) : [];
  return (
    <div className="mt-2 rounded-xl bg-white p-3 text-sm ring-1 ring-brand-200 dark:bg-zinc-900 dark:ring-brand-500/30">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
        {action.type === 'evolution' ? <Wand2 className="size-3.5" /> : <Check className="size-3.5" />}
        {action.type === 'evolution' ? 'Propuesta de evolución del CRM' : action.type === 'memory' ? 'Propuesta de memoria' : `${action.payload.action === 'create' ? 'Crear' : 'Actualizar'} ${action.payload.moduleLabel ?? action.payload.module}`}
      </div>
      <p className="mt-1">{action.summary}</p>
      {action.type === 'evolution' && <p className="mt-1 rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{action.payload.prompt}</p>}
      {action.type === 'memory' && <p className="mt-1 rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">«{action.payload.content}» · {action.payload.scope === 'org' ? 'toda la organización' : 'solo para ti'}</p>}
      {action.type === 'record_change' && action.payload.action === 'update' && (
        <p className="mt-1 text-xs text-zinc-500">
          Registro: <Link to={`/m/${action.payload.module}/${action.payload.id}`} className="font-mono text-brand-600 underline">{String(action.payload.id).slice(0, 8)}</Link>
        </p>
      )}
      {values.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-500">
          {values.map(([k, v]) => (
            <li key={k} className="break-words"><span className="text-zinc-700 dark:text-zinc-300">{k}</span>: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</li>
          ))}
        </ul>
      )}
      {state === 'done' ? (
        <div className="mt-2 flex items-center gap-2 text-xs font-medium text-emerald-600">
          <Check className="size-3.5" /> Hecho {link && <Link to={link} className="text-brand-600 underline">Ver</Link>}
        </div>
      ) : state === 'dismissed' ? (
        <div className="mt-2 text-xs text-zinc-400">Descartado</div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" loading={state === 'busy'} onClick={confirm}>Confirmar</Button>
          <Button size="sm" variant="ghost" onClick={() => { setState('dismissed'); onDone('dismissed'); }}>Descartar</Button>
        </div>
      )}
    </div>
  );
}

export function AiPanel({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const { can } = useSession();
  const bp = useBlueprint();
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => get<{ configured: boolean; providers: { id: string; label: string; model: string }[] }>('/ai/status'), staleTime: 30_000 });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const history = useQuery({ queryKey: ['ai-conversations'], queryFn: () => get<{ id: string; title: string; updated_at: string }[]>('/assistant/conversations'), enabled: showHistory });

  const context = useMemo(() => {
    const m = location.pathname.match(/^\/m\/([a-z0-9_]+)(?:\/([0-9a-f-]{36}))?/);
    return { path: location.pathname, module: m?.[1], recordId: m?.[2] };
  }, [location.pathname]);
  const mod = bp.data?.blueprint.modules.find((x) => x.key === context.module);
  const p = location.pathname;
  const contextLabel = mod
    ? context.recordId
      ? `Ficha de ${mod.label.toLowerCase()}`
      : mod.labelPlural
    : p.startsWith('/evolve')
      ? 'EVOLVE AI ENGINE'
      : p.startsWith('/reports')
        ? 'Informes'
        : p.startsWith('/settings')
          ? 'Ajustes'
          : 'Panel';

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setInput('');
      setMessages((m) => [...m, { id: `u${Date.now()}`, role: 'user', content: message }]);
      setSending(true);
      try {
        const r = await post<{ conversationId: string; message: any }>('/assistant/chat', { conversationId: conversationId ?? undefined, message, context: { path: context.path, module: context.module, recordId: context.recordId } });
        setConversationId(r.conversationId);
        setMessages((m) => [...m, { id: r.message.id, role: 'assistant', content: r.message.content, toolCalls: r.message.toolCalls, actions: r.message.actions, model: r.message.model }]);
      } catch (e) {
        setMessages((m) => [...m, { id: `e${Date.now()}`, role: 'error', content: errorMessage(e) }]);
      } finally {
        setSending(false);
      }
    },
    [conversationId, context, sending],
  );

  // Prellenado desde la paleta de comandos o desde una ficha (botón "Preguntar a EVOLVE AI").
  useEffect(() => {
    const consume = () => {
      const pre = sessionStorage.getItem('evolve-ai-prefill');
      if (pre && status.data?.configured) {
        sessionStorage.removeItem('evolve-ai-prefill');
        void send(pre);
      }
    };
    consume();
    window.addEventListener('evolve:open-ai', consume);
    return () => window.removeEventListener('evolve:open-ai', consume);
  }, [send, status.data?.configured]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const loadConversation = async (id: string) => {
    const c = await get<{ messages: any[] }>(`/assistant/conversations/${id}`);
    setConversationId(id);
    setMessages(c.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, toolCalls: m.tool_calls, actions: m.context?.actions, model: m.model })));
    setShowHistory(false);
  };

  const suggestions = context.recordId
    ? ['Resume esta ficha y sugiere próximos pasos', '¿Qué oportunidades tenemos con este cliente?', 'Crea una tarea de seguimiento para mañana']
    : mod
      ? [`¿Cuántos ${mod.labelPlural.toLowerCase()} hay y cómo se reparten?`, `Muéstrame los ${mod.labelPlural.toLowerCase()} sin actividad en 30 días`, `Añade un campo nuevo a ${mod.labelPlural}`]
      : ['¿Cuál es el valor del pipeline abierto?', '¿Qué tareas vencen esta semana?', 'Propón mejoras para nuestro CRM'];

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-white animate-slide-in sm:static sm:inset-auto sm:z-auto sm:w-[400px] sm:shrink-0 sm:border-l sm:border-zinc-200/70 dark:bg-zinc-950 sm:dark:border-zinc-800">
      <div className="relative overflow-hidden border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="absolute inset-x-0 top-0 h-0.5 evolve-gradient" />
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg evolve-gradient text-white"><Sparkles className="size-4" /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">EVOLVE AI</div>
            <div className="truncate text-[11px] text-zinc-500">Contexto: {contextLabel}</div>
          </div>
          <IconButton label="Historial" onClick={() => setShowHistory((s) => !s)}><History className="size-4" /></IconButton>
          <IconButton label="Nueva conversación" onClick={() => { setConversationId(null); setMessages([]); inputRef.current?.focus(); }}><MessageSquarePlus className="size-4" /></IconButton>
          <IconButton label="Cerrar" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        {showHistory && (
          <div className="mt-2 max-h-60 overflow-y-auto rounded-lg ring-1 ring-zinc-200 scrollbar-thin dark:ring-zinc-800">
            {history.isLoading ? <div className="p-3"><Spinner className="size-4" /></div> : !history.data?.length ? <p className="p-3 text-center text-xs text-zinc-500">Sin conversaciones</p> : history.data.map((c) => (
              <button key={c.id} onClick={() => loadConversation(c.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="text-[11px] text-zinc-400">{relativeTime(c.updated_at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {status.isLoading ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : !status.data?.configured ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/10"><Sparkles className="size-5" /></span>
          <h3 className="mt-3 text-sm font-semibold">EVOLVE AI necesita un proveedor de IA</h3>
          <p className="mt-1 text-sm text-zinc-500">Configura al menos una API key (Claude, OpenAI, DeepSeek u OpenRouter). Las claves se cifran y nunca se envían al navegador.</p>
          {can('admin') ? (
            <Link to="/settings/ai" className="mt-4"><Button variant="primary" size="sm">Configurar proveedores</Button></Link>
          ) : (
            <p className="mt-3 text-xs text-zinc-400">Pide a un administrador que configure un proveedor.</p>
          )}
        </div>
      ) : (
        <>
          <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
            {!messages.length && (
              <div className="pt-6">
                <h3 className="text-lg font-semibold tracking-tight">Hola 👋</h3>
                <p className="mt-1 text-sm text-zinc-500">Pregúntame por tus datos, pídeme que prepare registros o describe cómo quieres que evolucione el CRM. Entiendo lo que estás viendo.</p>
                <div className="mt-5 space-y-2">
                  {suggestions.map((s) => (
                    <button key={s} onClick={() => send(s)} className="flex w-full items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2.5 text-left text-sm text-zinc-700 ring-1 ring-zinc-200/70 transition hover:bg-white hover:ring-brand-300 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:ring-brand-500/40">
                      <Search className="size-3.5 text-zinc-400" /> {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-sm text-white">{m.content}</div>
                </div>
              ) : m.role === 'error' ? (
                <div key={m.id} className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20">{m.content}</div>
              ) : (
                <div key={m.id} className="space-y-1.5">
                  {!!m.toolCalls?.length && (
                    <div className="flex flex-wrap gap-1">
                      {m.toolCalls.map((t, i) => (
                        <span key={i} className={cx('rounded-md px-1.5 py-0.5 text-[10px] font-medium', t.isError ? 'bg-red-50 text-red-600 dark:bg-red-500/10' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')}>{TOOL_LABELS[t.name] ?? t.name}</span>
                      ))}
                    </div>
                  )}
                  <Markdown text={m.content || '…'} />
                  {m.actions?.map((a, i) => <ActionCard key={i} action={a} onDone={() => {}} />)}
                  {m.model && <div className="text-[10px] text-zinc-400">{m.model}</div>}
                </div>
              ),
            )}
            {sending && (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <span className="flex gap-1">
                  <span className="size-1.5 animate-bounce rounded-full bg-fuchsia-500 [animation-delay:-0.2s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:-0.1s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-orange-400" />
                </span>
                Pensando y consultando tu CRM…
              </div>
            )}
          </div>
          <form className="border-t border-zinc-100 p-3 dark:border-zinc-800" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
            <div className="flex items-end gap-2 rounded-xl bg-zinc-50 p-1.5 ring-1 ring-zinc-200 focus-within:ring-2 focus-within:ring-brand-500 dark:bg-zinc-900 dark:ring-zinc-800">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
                placeholder="Pregunta o pide algo…"
                className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-zinc-400"
              />
              <Button type="submit" variant="ai" size="sm" className="size-8 shrink-0 px-0" disabled={!input.trim() || sending} aria-label="Enviar"><ArrowUp className="size-4" /></Button>
            </div>
            <p className="mt-1.5 text-center text-[10px] text-zinc-400">{status.data.providers.map((p) => p.label).join(' · ')} · Los cambios siempre requieren tu confirmación</p>
          </form>
        </>
      )}
    </aside>
  );
}
