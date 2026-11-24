import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cx } from './ui';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const Ctx = createContext<(message: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={cx('pointer-events-auto flex items-start gap-2.5 rounded-xl bg-white px-3.5 py-3 text-sm shadow-lg ring-1 animate-pop dark:bg-zinc-900', t.tone === 'error' ? 'ring-red-200 dark:ring-red-500/30' : 'ring-zinc-200 dark:ring-zinc-800')}>
              {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : t.tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-sky-500" />}
              <span className="flex-1">{t.message}</span>
              <button aria-label="Cerrar" className="text-zinc-400 hover:text-zinc-700" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
