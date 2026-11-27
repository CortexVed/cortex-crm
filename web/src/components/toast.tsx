import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { t } from '../lib/i18n';
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
    setToasts((list) => [...list.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      {createPortal(
        // Abajo en el centro del espacio libre. Con el panel de EVOLVE AI abierto (que publica --ai-offset-right y
        // --ai-offset-bottom), los avisos se apartan: antes tapaban su campo de pregunta y se quedaban sus clics.
        <div
          className="pointer-events-none fixed left-0 z-[60] mx-auto flex flex-col gap-2"
          style={{
            right: 'var(--ai-offset-right, 0px)',
            bottom: 'calc(1rem + var(--ai-offset-bottom, 0px))',
            width: 'min(380px, calc(100vw - var(--ai-offset-right, 0px) - 2rem))',
          }}
          aria-live="polite"
        >
          {toasts.map((item) => (
            <div key={item.id} className={cx('pointer-events-auto flex items-start gap-2.5 rounded-xl bg-white px-3.5 py-3 text-sm shadow-lg ring-1 origin-bottom animate-pop dark:bg-zinc-900', item.tone === 'error' ? 'ring-red-200 dark:ring-red-500/30' : 'ring-zinc-200 dark:ring-zinc-800')}>
              {item.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : item.tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-sky-500" />}
              <span className="flex-1">{item.message}</span>
              <button aria-label={t('Cerrar')} className="text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => setToasts((x) => x.filter((y) => y.id !== item.id))}>
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
