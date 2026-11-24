import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Field, Input } from '../../components/ui';
import { ApiError, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { Me } from '../../lib/types';

export default function Register() {
  const { me, setMe } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => get<{ signupEnabled: boolean }>('/auth/config') });
  if (me) return <Navigate to="/" replace />;
  if (cfg.data && !cfg.data.signupEnabled) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Registro cerrado</h1>
        <p className="text-sm text-zinc-500">El registro público está desactivado. Pide una invitación a un administrador de tu organización.</p>
        <Link to="/login" className="text-sm font-medium text-brand-600 hover:underline">Volver al inicio de sesión</Link>
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
      const res = await post<Me>('/auth/register', form);
      setMe(res);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const details = (err.details as { path: string; message: string }[] | undefined) ?? [];
        if (Array.isArray(details) && details.length) setFieldErrors(Object.fromEntries(details.map((d) => [d.path, d.message])));
        setError(err.message);
      } else setError('No se pudo crear la cuenta');
    } finally {
      setLoading(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Crea tu organización</h1>
        <p className="mt-1 text-sm text-zinc-500">Tu CRM queda listo en segundos, aislado del resto de organizaciones.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Tu nombre" error={fieldErrors.name}>
        <Input required autoComplete="name" value={form.name} onChange={set('name')} />
      </Field>
      <Field label="Email de trabajo" error={fieldErrors.email}>
        <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
      </Field>
      <Field label="Contraseña" hint="Mínimo 10 caracteres combinando letras con números o símbolos." error={fieldErrors.password}>
        <Input type="password" required autoComplete="new-password" minLength={10} value={form.password} onChange={set('password')} />
      </Field>
      <Field label="Nombre de la empresa" error={fieldErrors.workspaceName}>
        <Input required value={form.workspaceName} onChange={set('workspaceName')} />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        Crear cuenta
      </Button>
      <p className="text-center text-sm text-zinc-500">
        ¿Ya tienes cuenta? <Link to="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">Inicia sesión</Link>
      </p>
    </form>
  );
}
