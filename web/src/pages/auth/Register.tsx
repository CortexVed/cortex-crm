import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LanguageOptions } from '../../components/LanguageSelect';
import { Alert, Button, Field, Input, Select } from '../../components/ui';
import { ApiError, get, post } from '../../lib/api';
import { browserTimeZone, setLocale, t, tx, useLocale, type Locale } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import type { Me } from '../../lib/types';

// Cambiar de idioma vuelve a montar la aplicación: lo escrito (salvo la contraseña) se conserva aquí.
let draft = { name: '', email: '', workspaceName: '' };

export default function Register() {
  const { me, setMe } = useSession();
  const navigate = useNavigate();
  const locale = useLocale();
  const [form, setForm] = useState({ ...draft, password: '' });
  useEffect(() => {
    draft = { name: form.name, email: form.email, workspaceName: form.workspaceName };
  }, [form.name, form.email, form.workspaceName]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => get<{ signupEnabled: boolean }>('/auth/config') });
  if (me) return <Navigate to="/" replace />;
  if (cfg.data && !cfg.data.signupEnabled) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{t('Registro cerrado')}</h1>
        <p className="text-sm text-zinc-500">{t('El registro público está desactivado. Pide una invitación a un administrador de tu organización.')}</p>
        <Link to="/login" className="text-sm font-medium text-brand-600 hover:underline">
          {t('Volver al inicio de sesión')}
        </Link>
      </div>
    );
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setLoading(true);
    try {
      // El idioma de la interfaz es también el de la organización nueva (su CRM inicial sale en él).
      const res = await post<Me>('/auth/register', { ...form, locale, timezone: browserTimeZone() });
      draft = { name: '', email: '', workspaceName: '' };
      setMe(res);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const details = (err.details as { path: string; message: string }[] | undefined) ?? [];
        if (Array.isArray(details) && details.length) setFieldErrors(Object.fromEntries(details.map((d) => [d.path, d.message])));
        setError(err.message);
      } else setError(t('No se pudo crear la cuenta'));
    } finally {
      setLoading(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('Crea tu organización')}</h1>
        <p className="mt-1 text-sm text-zinc-500">{t('Tu CRM queda listo en segundos, aislado del resto de organizaciones.')}</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={t('Tu nombre')} error={fieldErrors.name}>
        <Input required autoComplete="name" value={form.name} onChange={set('name')} />
      </Field>
      <Field label={t('Email de trabajo')} error={fieldErrors.email}>
        <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
      </Field>
      <Field label={t('Contraseña')} hint={t('Mínimo 10 caracteres combinando letras con números o símbolos.')} error={fieldErrors.password}>
        <Input type="password" required autoComplete="new-password" minLength={10} value={form.password} onChange={set('password')} />
      </Field>
      <Field label={t('Nombre de la empresa')} error={fieldErrors.workspaceName}>
        <Input required value={form.workspaceName} onChange={set('workspaceName')} />
      </Field>
      <Field label={t('Idioma')} hint={t('El de la interfaz y el de los módulos y campos con los que empieza tu CRM. Cada persona puede cambiar el suyo después.')} error={fieldErrors.locale}>
        <Select value={locale} onChange={(e) => void setLocale(e.target.value as Locale)}>
          <LanguageOptions />
        </Select>
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        {t('Crear cuenta')}
      </Button>
      <p className="text-center text-sm text-zinc-500">
        {tx('¿Ya tienes cuenta? <link>Inicia sesión</link>', {
          link: (c) => (
            <Link to="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
              {c}
            </Link>
          ),
        })}
      </p>
    </form>
  );
}
