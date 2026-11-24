import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, ErrorState, Field, Input, Spinner } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useSession } from '../../lib/session';
import { ROLE_LABELS, type Role } from '../../../../shared/constants';
import type { Me } from '../../lib/types';

/** Formato de los tokens que emite el servidor (32 bytes en base64url). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export default function AcceptInvite() {
  const { token: raw = '' } = useParams();
  // Nunca se interpola en una URL un valor que no tenga la forma de un token (evita que un enlace manipulado
  // haga que el navegador llame a otras rutas de la API con la sesión del usuario).
  const token = TOKEN_RE.test(raw) ? raw : '';
  const { me, setMe } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => get<{ email: string; role: Role; workspaceName: string; userExists: boolean }>(`/auth/invite/${encodeURIComponent(token)}`),
    retry: false,
    enabled: !!token,
  });
  const accept = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await post<Me>('/auth/invite/accept', info.data?.userExists ? { token } : { token, name, password });
      setMe(res);
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  if (!token) return <Alert tone="danger" title="Enlace no válido">El enlace de invitación está incompleto o mal copiado. Pide a quien te invitó que te envíe uno nuevo.</Alert>;
  if (info.isLoading) return <Spinner />;
  if (info.error) return <ErrorState error={info.error} />;
  const inv = info.data!;
  const wrongUser = inv.userExists && me && me.user.email.toLowerCase() !== inv.email.toLowerCase();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Únete a {inv.workspaceName}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Invitación para <strong>{inv.email}</strong> con rol <strong>{ROLE_LABELS[inv.role]}</strong>.
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {inv.userExists ? (
        !me ? (
          <Alert tone="info" title="Ya tienes una cuenta">
            <Link className="font-semibold underline" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Inicia sesión con {inv.email}</Link> para aceptar.
          </Alert>
        ) : wrongUser ? (
          <Alert tone="warning">Has iniciado sesión como {me.user.email}. Cierra sesión y entra con {inv.email} para aceptar.</Alert>
        ) : (
          <Button variant="primary" className="w-full" loading={loading} onClick={accept}>Aceptar invitación</Button>
        )
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void accept(); }} className="space-y-4">
          <Field label="Tu nombre">
            <Input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Elige una contraseña" hint="Mínimo 10 caracteres combinando letras con números o símbolos.">
            <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={loading}>Crear cuenta y unirme</Button>
        </form>
      )}
    </div>
  );
}
