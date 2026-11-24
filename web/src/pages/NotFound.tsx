import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { EmptyState, Button } from '../components/ui';

export default function NotFound() {
  return (
    <EmptyState
      className="py-24"
      icon={<Compass className="size-5" />}
      title="Página no encontrada"
      description="Puede que el módulo se haya archivado o que el enlace no sea correcto."
      action={
        <Link to="/">
          <Button variant="primary">Volver al panel</Button>
        </Link>
      }
    />
  );
}
