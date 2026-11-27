import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { EmptyState, Button } from '../components/ui';
import { t } from '../lib/i18n';

export default function NotFound() {
  return (
    <EmptyState
      className="py-24"
      icon={<Compass className="size-5" />}
      title={t('Página no encontrada')}
      description={t('Puede que el módulo se haya archivado o que el enlace no sea correcto.')}
      action={
        <Link to="/">
          <Button variant="primary">{t('Volver al panel')}</Button>
        </Link>
      }
    />
  );
}
