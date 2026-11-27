import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, Button, Field, Input } from '../../components/ui';
import { errorMessage, post } from '../../lib/api';
import { t } from '../../lib/i18n';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(t('Las contraseñas no coinciden'));
    setLoading(true);
    setError(null);
    try {
      await post('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  if (!token) return <Alert tone="danger">{t('Enlace incompleto. Solicita uno nuevo.')}</Alert>;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">{t('Nueva contraseña')}</h1>
      {done ? (
        <>
          <Alert tone="success" title={t('Contraseña actualizada')}>{t('Por seguridad hemos cerrado todas tus sesiones abiertas.')}</Alert>
          <Link to="/login" className="block text-center text-sm font-medium text-brand-600 hover:underline">{t('Iniciar sesión')}</Link>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('Nueva contraseña')} hint={t('Mínimo 10 caracteres combinando letras con números o símbolos.')}>
            <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label={t('Repite la contraseña')}>
            <Input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={loading}>{t('Guardar contraseña')}</Button>
        </form>
      )}
    </div>
  );
}
