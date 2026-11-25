import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, History, MessageSquarePlus, Search, Sparkles, Wand2, X } from 'lucide-react';
import { ApiError, errorMessage, get, patch, post } from '../lib/api';
import { useBlueprint, useMediaQuery } from '../lib/hooks';
import { useSession } from '../lib/session';
import { relativeTime } from '../lib/format';
import { Button, cx, ErrorState, IconButton, Spinner, useEscapeLayer } from './ui';
import { Markdown } from './Markdown';
import { useToast } from './toast';

type ActionState = 'done' | 'dismissed';
interface Action {
  type: 'record_change' | 'evolution' | 'memory';
  summary: string;
  payload: any;
  /** Guardado en el servidor: el historial no vuelve a ofrecer «Confirmar» en una propuesta ya resuelta. */
  state?: ActionState;
  /** Registro creado o actualizado, o petición de EVOLVE resultante. */
  ref?: string;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Desde xl el panel es una columna junto al contenido; por debajo, una capa encima (igual que lo trata el Layout). */
const DOCKED_QUERY = '(min-width: 1280px)';
/** Una respuesta normal tarda segundos; pasado este tiempo, «Pensando…» no se queda para siempre. */
const CHAT_TIMEOUT_MS = 240_000;

function actionLink(action: Action, ref: string | undefined): string | null {
  if (action.type === 'record_change') {
    const id = ref ?? (action.payload?.action === 'update' ? action.payload.id : undefined);
    return id ? `/m/${action.payload.module}/${id}` : null;
  }
  if (action.type === 'evolution' && ref) return `/evolve/requests/${ref}`;
  return null;
}

function ActionCard({ action, messageId, index }: { action: Action; messageId: string; index: number }) {
  const [state, setState] = useState<'idle' | 'busy' | ActionState>(action.state ?? 'idle');
  const [ref, setRef] = useState<string | undefined>(action.ref);
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Se recuerda en el servidor para el historial. Si falla, la tarjeta sigue mostrando el estado: aplicar el cambio
  // ya fue por las rutas normales (con sus permisos); esto solo evita volver a ofrecerlo.
  const remember = (s: ActionState, r?: string) => {
    post(`/assistant/messages/${messageId}/actions/${index}`, { state: s, ...(r && UUID.test(r) ? { ref: r } : {}) }).catch(() => {});
  };
  const confirm = async () => {
    setState('busy');
    try {
      let r: string | undefined;
      if (action.type === 'record_change') {
        const p = action.payload;
        if (p.action === 'create') {
          r = (await post<{ record: { id: string } }>(`/records/${p.module}`, { values: p.values })).record.id;
        } else {
          await patch(`/records/${p.module}/${p.id}`, { values: p.values });
          r = String(p.id);
        }
        // El cambio se ve en listas, fichas, cronologías, relacionados de otras fichas y paneles.
        for (const key of ['records', 'record', 'timeline', 'dashboard']) qc.invalidateQueries({ queryKey: [key] });
        toast('Cambio aplicado');
      } else if (action.type === 'memory') {
        await post('/ai/memory', { scope: action.payload.scope, kind: action.payload.kind, content: action.payload.content, fromAssistant: true });
        qc.invalidateQueries({ queryKey: ['ai', 'memory'] });
        toast('Guardado como propuesta: confírmalo en Ajustes → Memoria para que la IA lo use');
      } else {
        r = (await post<{ id: string }>('/evolve/requests', { prompt: action.payload.prompt })).id;
        toast('Petición enviada a EVOLVE AI ENGINE');
        navigate(`/evolve/requests/${r}`);
      }
      setRef(r);
      setState('done');
      remember('done', r);
    } catch (e) {
      toast(errorMessage(e), 'error');
      setState('idle');
    }
  };
  const dismiss = () => {
    setState('dismissed');
    remember('dismissed');
  };
  const values = action.type === 'record_change' ? Object.entries(action.payload.values ?? {}) : [];
  const link = state === 'done' ? actionLink(action, ref) : null;
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
        <div className="mt-2 flex items-center gap-2 text-xs font-medium text-emerald-600 animate-fade-in dark:text-emerald-400">
          <Check className="size-3.5" /> Hecho {link && <Link to={link} className="text-brand-600 underline dark:text-brand-400">Ver</Link>}
        </div>
      ) : state === 'dismissed' ? (
        <div className="mt-2 text-xs text-zinc-400 animate-fade-in">Descartado</div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" loading={state === 'busy'} onClick={confirm}>Confirmar</Button>
          <Button size="sm" variant="ghost" disabled={state === 'busy'} onClick={dismiss}>Descartar</Button>
        </div>
      )}
    </div>
  );
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function AiPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const bp = useBlueprint();
  const docked = useMediaQuery(DOCKED_QUERY);
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => get<{ configured: boolean; providers: { id: string; label: string; model: string }[] }>('/ai/status'), staleTime: 30_000 });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Cada conversación nueva o cargada abre una «época»: la respuesta que llega de una época anterior se descarta
  // (antes se colaba en la conversación nueva y la volvía a convertir en la anterior).
  const epoch = useRef(0);
  const loadSeq = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  // El siguiente desplazamiento al final es instantáneo: al cargar una conversación o al volver a mostrar el panel.
  const jump = useRef(true);
  const history = useQuery({ queryKey: ['ai-conversations'], queryFn: () => get<{ id: string; title: string; updated_at: string }[]>('/assistant/conversations'), enabled: showHistory });

  // Escape cierra la capa; acoplado como columna (xl) no, para no cerrarlo al pulsar Escape en cualquier parte.
  useEscapeLayer(open && !docked, onClose);
  // Los avisos (toast.tsx) se apartan del panel abierto: a su izquierda desde sm (ocupa los 400 px de la derecha) y,
  // en móvil, donde ocupa toda la pantalla, por encima del campo de pregunta.
  const fullScreen = !useMediaQuery('(min-width: 640px)');
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement.style;
    root.setProperty('--ai-offset-right', fullScreen ? '0px' : '400px');
    root.setProperty('--ai-offset-bottom', fullScreen ? '6.5rem' : '0px');
    return () => {
      root.removeProperty('--ai-offset-right');
      root.removeProperty('--ai-offset-bottom');
    };
  }, [open, fullScreen]);

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
      const mine = epoch.current;
      setInput('');
      setMessages((m) => [...m, { id: `u${Date.now()}`, role: 'user', content: message }]);
      setSending(true);
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      try {
        const r = await post<{ conversationId: string; message: any }>(
          '/assistant/chat',
          { conversationId: conversationId ?? undefined, message, context: { path: context.path, module: context.module, recordId: context.recordId } },
          { signal: ctrl.signal, timeoutMs: CHAT_TIMEOUT_MS },
        );
        if (epoch.current !== mine) return;
        setConversationId(r.conversationId);
        setMessages((m) => [...m, { id: r.message.id, role: 'assistant', content: r.message.content, toolCalls: r.message.toolCalls, actions: r.message.actions, model: r.message.model }]);
        qc.invalidateQueries({ queryKey: ['ai-conversations'] });
      } catch (e) {
        if (epoch.current !== mine) return;
        // El servidor sigue y guarda la respuesta en la conversación aunque el navegador deje de esperar.
        const content = e instanceof ApiError && e.code === 'timeout' ? 'La respuesta está tardando demasiado. Si termina, la verás al abrir esta conversación desde el historial.' : errorMessage(e);
        setMessages((m) => [...m, { id: `e${Date.now()}`, role: 'error', content }]);
      } finally {
        if (inFlight.current === ctrl) inFlight.current = null;
        if (epoch.current === mine) setSending(false);
      }
    },
    [conversationId, context, sending, qc],
  );

  // Prellenado desde la paleta de comandos o desde una ficha (botón "Preguntar a EVOLVE AI"). Mientras hay una
  // respuesta en curso se espera (antes se borraba el prellenado y la pregunta se perdía).
  useEffect(() => {
    const consume = () => {
      if (sending || !status.data?.configured) return;
      let pre: string | null = null;
      try {
        pre = sessionStorage.getItem('evolve-ai-prefill');
        if (pre) sessionStorage.removeItem('evolve-ai-prefill');
      } catch {
        /* sin almacenamiento */
      }
      if (pre) void send(pre);
    };
    consume();
    window.addEventListener('evolve:open-ai', consume);
    return () => window.removeEventListener('evolve:open-ai', consume);
  }, [send, sending, status.data?.configured]);

  useLayoutEffect(() => {
    if (open) jump.current = true;
  }, [open]);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !open) return;
    el.scrollTo({ top: el.scrollHeight, behavior: jump.current || prefersReducedMotion() ? 'auto' : 'smooth' });
    jump.current = false;
  }, [messages, sending, open]);

  // Al abrirlo a petición de la persona, el foco va a la pregunta (no en pantallas táctiles: abriría el teclado; ni
  // al cargar la página en pantallas anchas, donde está abierto por defecto y robaría el foco a la página).
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (!open || (first && window.matchMedia(DOCKED_QUERY).matches)) return;
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Deja de esperar la respuesta en curso (el servidor la termina y la guarda en el historial de la conversación).
  const stop = () => {
    inFlight.current?.abort();
    inFlight.current = null;
    epoch.current++;
    setSending(false);
    setMessages((m) => [...m, { id: `e${Date.now()}`, role: 'error', content: 'Has detenido la respuesta.' }]);
  };

  const newConversation = () => {
    inFlight.current?.abort();
    inFlight.current = null;
    epoch.current++;
    loadSeq.current++;
    setLoadingId(null);
    setSending(false);
    setConversationId(null);
    setMessages([]);
    setShowHistory(false);
    inputRef.current?.focus();
  };

  const loadConversation = async (id: string) => {
    const seq = ++loadSeq.current;
    setLoadingId(id);
    try {
      const c = await get<{ messages: any[] }>(`/assistant/conversations/${id}`);
      if (loadSeq.current !== seq) return;
      inFlight.current?.abort();
      inFlight.current = null;
      epoch.current++;
      setSending(false);
      jump.current = true;
      setConversationId(id);
      setMessages(c.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, toolCalls: m.tool_calls, actions: m.context?.actions, model: m.model })));
      setShowHistory(false);
    } catch (e) {
      if (loadSeq.current === seq) toast(errorMessage(e), 'error');
    } finally {
      if (loadSeq.current === seq) setLoadingId(null);
    }
  };

  const suggestions = context.recordId
    ? ['Resume esta ficha y sugiere próximos pasos', '¿Qué oportunidades tenemos con este cliente?', 'Crea una tarea de seguimiento para mañana']
    : mod
      ? [`¿Cuántos ${mod.labelPlural.toLowerCase()} hay y cómo se reparten?`, `Muéstrame los ${mod.labelPlural.toLowerCase()} sin actividad en 30 días`, `Añade un campo nuevo a ${mod.labelPlural}`]
      : ['¿Cuál es el valor del pipeline abierto?', '¿Qué tareas vencen esta semana?', 'Propón mejoras para nuestro CRM'];

  return (
    <aside
      aria-label="EVOLVE AI"
      className={cx(
        open ? 'flex' : 'hidden',
        // Por debajo de xl, una capa sobre el contenido (a pantalla completa en móvil); desde xl, una columna a su lado.
        'fixed inset-0 z-40 flex-col bg-white animate-slide-in sm:left-auto sm:w-[400px] sm:border-l sm:border-zinc-200/70 sm:shadow-2xl dark:bg-zinc-950 sm:dark:border-zinc-800',
        'xl:static xl:z-auto xl:shrink-0 xl:shadow-none',
      )}
    >
      <div className="relative overflow-hidden border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="absolute inset-x-0 top-0 h-0.5 evolve-gradient" />
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg evolve-gradient text-white"><Sparkles className="size-4" /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">EVOLVE AI</div>
            <div className="truncate text-[11px] text-zinc-500">Contexto: {contextLabel}</div>
          </div>
          <IconButton label="Historial" aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}><History className="size-4" /></IconButton>
          <IconButton label="Nueva conversación" onClick={newConversation}><MessageSquarePlus className="size-4" /></IconButton>
          <IconButton label="Cerrar" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        {showHistory && (
          <div className="mt-2 max-h-60 origin-top overflow-y-auto rounded-lg ring-1 ring-zinc-200 animate-pop scrollbar-thin dark:ring-zinc-800">
            {history.isLoading ? (
              <div className="flex justify-center p-3"><Spinner className="size-4" /></div>
            ) : history.error && !history.data ? (
              <div className="p-3 text-center text-xs text-red-600 dark:text-red-400">
                {errorMessage(history.error)}{' '}
                <button className="font-medium underline" onClick={() => history.refetch()}>Reintentar</button>
              </div>
            ) : !history.data?.length ? (
              <p className="p-3 text-center text-xs text-zinc-500">Sin conversaciones</p>
            ) : (
              history.data.map((c) => (
                <button
                  key={c.id}
                  onClick={() => loadConversation(c.id)}
                  aria-current={c.id === conversationId ? 'true' : undefined}
                  className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900', c.id === conversationId && 'bg-zinc-50 dark:bg-zinc-900')}
                >
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {loadingId === c.id ? <Spinner className="size-3.5" /> : <span className="text-[11px] text-zinc-400">{relativeTime(c.updated_at)}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {status.isLoading ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : status.error && !status.data ? (
        // Un fallo al consultar el estado no es «falta un proveedor»: se muestra el error y se puede reintentar.
        <ErrorState error={status.error} onRetry={() => status.refetch()} className="flex-1" />
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
          <div ref={listRef} role="log" className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 scrollbar-thin">
            {!messages.length && (
              <div className="pt-6">
                <h3 className="text-lg font-semibold tracking-tight">Hola 👋</h3>
                <p className="mt-1 text-sm text-zinc-500">Pregúntame por tus datos, pídeme que prepare registros o describe cómo quieres que evolucione el CRM. Entiendo lo que estás viendo.</p>
                <div className="mt-5 space-y-2">
                  {suggestions.map((s) => (
                    <button key={s} onClick={() => send(s)} className="flex w-full items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2.5 text-left text-sm text-zinc-700 ring-1 ring-zinc-200/70 transition hover:bg-white hover:ring-brand-300 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:ring-brand-500/40">
                      <Search className="size-3.5 shrink-0 text-zinc-400" /> {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-sm text-white">{m.content}</div>
                </div>
              ) : m.role === 'error' ? (
                <div key={m.id} role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20">{m.content}</div>
              ) : (
                <div key={m.id} className="space-y-1.5">
                  {!!m.toolCalls?.length && (
                    <div className="flex flex-wrap gap-1">
                      {m.toolCalls.map((t, i) => (
                        <span key={i} className={cx('rounded-md px-1.5 py-0.5 text-[10px] font-medium', t.isError ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')}>{TOOL_LABELS[t.name] ?? t.name}</span>
                      ))}
                    </div>
                  )}
                  <Markdown text={m.content || '…'} />
                  {m.actions?.map((a, i) => <ActionCard key={i} action={a} messageId={m.id} index={i} />)}
                  {m.model && <div className="text-[10px] text-zinc-400">{m.model}</div>}
                </div>
              ),
            )}
            {sending && (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <span className="flex gap-1" aria-hidden>
                  <span className="size-1.5 animate-bounce rounded-full bg-fuchsia-500 [animation-delay:-0.2s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:-0.1s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-orange-400" />
                </span>
                Pensando y consultando tu CRM…
                <button type="button" onClick={stop} className="ml-auto rounded-md px-2 py-0.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
                  Detener
                </button>
              </div>
            )}
          </div>
          <form className="border-t border-zinc-100 p-3 dark:border-zinc-800" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
            <div className="flex items-end gap-2 rounded-xl bg-zinc-50 p-1.5 ring-1 ring-zinc-200 focus-within:ring-2 focus-within:ring-brand-500 dark:bg-zinc-900 dark:ring-zinc-800">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                aria-label="Pregunta para EVOLVE AI"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }}
                placeholder="Pregunta o pide algo…"
                className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none field-sizing-content placeholder:text-zinc-400"
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
