import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Field, Input } from '../../components/ui';
import { ApiError, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { Me } from '../../lib/types';

export default function Login() {
  const { me, setMe } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => get<{ signupEnabled: boolean; emailEnabled: boolean }>('/auth/config') });
  const next = params.get('next');
  // Solo rutas internas: sin "//", sin barras invertidas (los navegadores las tratan como "/") ni caracteres de control.
  const safeNext = next && /^\/(?![/\\])[^\\\u0000-\u001f]*$/.test(next) ? next : '/';
  if (me) return <Navigate to={safeNext} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await post<Me>('/auth/login', { email, password });
      setMe(res);
      navigate(safeNext, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inicia sesión</h1>
        <p className="mt-1 text-sm text-zinc-500">Bienvenido de nuevo a tu CRM.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Email">
        <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Contraseña">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Link to="/forgot-password" className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">¿Has olvidado la contraseña?</Link>
      </div>
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        Entrar
      </Button>
      {cfg.data?.signupEnabled && (
        <p className="text-center text-sm text-zinc-500">
          ¿No tienes cuenta? <Link to="/register" className="font-medium text-brand-600 hover:underline dark:text-brand-400">Crea tu organización</Link>
        </p>
      )}
    </form>
  );
}
