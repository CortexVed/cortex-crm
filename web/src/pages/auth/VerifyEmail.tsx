import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button } from '../../components/ui';
import { errorMessage, post } from '../../lib/api';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * La verificación necesita un clic explícito: abrir el enlace (o que lo abra un escáner de correo o una
 * vista previa) no la completa por sí solo.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const raw = params.get('token') ?? '';
  const token = TOKEN_RE.test(raw) ? raw : '';
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>(token ? 'idle' : 'error');
  const [error, setError] = useState(token ? '' : 'Enlace incompleto o mal copiado');
  const qc = useQueryClient();
  const verify = () => {
    setState('loading');
    post('/auth/verify-email', { token })
      .then(() => {
        setState('ok');
        qc.invalidateQueries({ queryKey: ['me'] });
      })
      .catch((e) => {
        setState('error');
        setError(errorMessage(e));
      });
  };
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Verificación de email</h1>
      {(state === 'idle' || state === 'loading') && (
        <>
          <p className="text-sm text-zinc-500">Confirma que esta dirección de email es tuya para terminar de proteger tu cuenta.</p>
          <Button variant="primary" className="w-full" loading={state === 'loading'} onClick={verify}>
            Verificar mi email
          </Button>
        </>
      )}
      {state === 'ok' && <Alert tone="success" title="¡Email verificado!">Gracias, tu cuenta está protegida.</Alert>}
      {state === 'error' && <Alert tone="danger" title="No se pudo verificar">{error}</Alert>}
      <Link to="/" className="block text-center text-sm font-medium text-brand-600 hover:underline">Ir al CRM</Link>
    </div>
  );
}
