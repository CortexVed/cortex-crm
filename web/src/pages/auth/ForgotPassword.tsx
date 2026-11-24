import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Field, Input } from '../../components/ui';
import { errorMessage, post } from '../../lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<{ emailEnabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setDone(await post('/auth/password/forgot', { email }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Recuperar contraseña</h1>
        <p className="mt-1 text-sm text-zinc-500">Te enviaremos un enlace para elegir una nueva.</p>
      </div>
      {done ? (
        done.emailEnabled ? (
          <Alert tone="success" title="Revisa tu correo">Si existe una cuenta con ese email, recibirás un enlace válido durante 1 hora.</Alert>
        ) : (
          <Alert tone="warning" title="El envío de correo no está configurado">Pide a un propietario de tu organización que genere un enlace de recuperación desde Ajustes › Equipo.</Alert>
        )
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={loading}>Enviar enlace</Button>
        </form>
      )}
      <Link to="/login" className="block text-center text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">Volver al inicio de sesión</Link>
    </div>
  );
}
