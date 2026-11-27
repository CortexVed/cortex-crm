import { useMutation } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { errorMessage, put } from '../lib/api';
import { effectiveLocale, LOCALE_INFO, LOCALES, setLocale, t, useLocale, type Locale } from '../lib/i18n';
import { useSession } from '../lib/session';
import type { Me } from '../lib/types';
import { useToast } from './toast';
import { Card, cx, Field, Select } from './ui';

/** Opciones de idioma, cada una con su nombre en el propio idioma («Deutsch», «日本語»). */
export function LanguageOptions() {
  return (
    <>
      {LOCALES.map((l) => (
        <option key={l} value={l} lang={LOCALE_INFO[l].tag}>
          {LOCALE_INFO[l].native}
        </option>
      ))}
    </>
  );
}

/** Selector compacto de las pantallas de acceso: cambia el idioma en este navegador. */
export function LanguagePicker({ className }: { className?: string }) {
  const locale = useLocale();
  return (
    <label className={cx('inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400', className)}>
      <Globe className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">{t('Idioma')}</span>
      <select
        value={locale}
        onChange={(e) => void setLocale(e.target.value as Locale)}
        className="cursor-pointer rounded-md bg-transparent py-1 pr-1 text-xs font-medium text-zinc-600 outline-none hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-zinc-300 dark:hover:text-white"
      >
        <LanguageOptions />
      </select>
    </label>
  );
}

/** Ajustes › Mi cuenta: idioma de la interfaz de la persona, guardado en su cuenta (vale en todos sus dispositivos). */
export function LanguageCard({ className }: { className?: string }) {
  const { me, setMe } = useSession();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (locale: Locale | null) => put<Me>('/auth/me/locale', { locale }),
    // La sesión nueva aplica el idioma (la interfaz se vuelve a pintar en él).
    onSuccess: (next) => setMe(next),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!me) return null;
  const orgLocale = effectiveLocale(null, me.workspace?.locale ?? null);
  return (
    <Card className={className} title={t('Idioma')} description={t('Idioma de la interfaz en todos tus dispositivos.')}>
      <Field label={t('Idioma de la interfaz')} hint={t('Si no eliges ninguno, se usa el de tu organización (Ajustes › Organización › Idioma y región).')}>
        <Select value={me.user.locale ?? ''} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value ? (e.target.value as Locale) : null)}>
          <option value="">{t('El de la organización ({language})', { language: LOCALE_INFO[orgLocale].native })}</option>
          <LanguageOptions />
        </Select>
      </Field>
    </Card>
  );
}
