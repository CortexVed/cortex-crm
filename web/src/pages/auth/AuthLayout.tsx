import { Outlet } from 'react-router';
import { History, ShieldCheck, Sparkles } from 'lucide-react';
import { LanguagePicker } from '../../components/LanguageSelect';
import { useTheme } from '../../lib/hooks';
import { t, tx } from '../../lib/i18n';

export function AuthLayout() {
  useTheme();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-zinc-950 p-10 text-white lg:flex lg:flex-col">
        <div className="absolute -left-32 -top-32 size-[480px] rounded-full bg-brand-600/40 blur-3xl" />
        <div className="absolute -bottom-40 right-0 size-[420px] rounded-full bg-fuchsia-600/30 blur-3xl" />
        <div className="relative flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-bold tracking-tight">
            Cortex <span className="evolve-text">CRM</span>
          </span>
        </div>
        <div className="relative mt-auto max-w-lg">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">{tx('El CRM que <em>evoluciona</em> con tus palabras.', { em: (c) => <span className="evolve-text">{c}</span> })}</h2>
          <p className="mt-4 text-zinc-400">{t('Pide nuevos módulos, campos, automatizaciones o integraciones en lenguaje natural. La IA los planifica, los prueba en un entorno aislado y tú decides qué se publica.')}</p>
          <ul className="mt-8 space-y-3 text-sm text-zinc-300">
            <li className="flex items-center gap-3">
              <Sparkles className="size-4 text-fuchsia-400" /> {t('Multi-LLM: Claude, OpenAI, DeepSeek y OpenRouter')}
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="size-4 text-emerald-400" /> {t('Aprobación humana, auditoría y aislamiento por organización')}
            </li>
            <li className="flex items-center gap-3">
              <History className="size-4 text-sky-400" /> {t('Versiones, pruebas automáticas y rollback en un clic')}
            </li>
          </ul>
        </div>
        <p className="relative mt-10 text-xs text-zinc-500">© Cortex CRM</p>
      </div>
      <div className="relative flex items-center justify-center p-6 sm:p-10">
        <LanguagePicker className="absolute right-4 top-4 sm:right-6 sm:top-6" />
        <div className="w-full max-w-sm animate-pop">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <img src="/favicon.svg" alt="" className="size-8" />
            <span className="text-lg font-bold">
              Cortex <span className="evolve-text">CRM</span>
            </span>
          </div>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
