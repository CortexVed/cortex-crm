import { Navigate, useNavigate, useParams } from 'react-router';
import { PageHeader, Tabs } from '../../components/ui';
import { msg, t, tk } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import type { Role } from '../../../../shared/constants';
import GeneralTab from './GeneralTab';
import AccountTab from './AccountTab';
import TeamTab from './TeamTab';
import AiTab from './AiTab';
import MemoryTab from './MemoryTab';
import ChannelsTab from './ChannelsTab';
import ApiKeysTab from './ApiKeysTab';
import AuditTab from './AuditTab';
import CustomizationTab from './CustomizationTab';
import AppearanceTab from './AppearanceTab';
import PlatformTab from './PlatformTab';

type TabKey = 'general' | 'account' | 'team' | 'customization' | 'appearance' | 'ai' | 'memory' | 'channels' | 'api-keys' | 'audit' | 'platform';

// Nombres marcados con msg(): se traducen al pintar las pestañas, con tk().
const TABS: { key: TabKey; label: string; min: Role | null; platform?: boolean }[] = [
  { key: 'general', label: msg('Organización'), min: 'viewer' },
  { key: 'account', label: msg('Mi cuenta'), min: null },
  { key: 'team', label: msg('Equipo'), min: 'viewer' },
  { key: 'customization', label: msg('Personalización'), min: 'admin' },
  { key: 'appearance', label: msg('Apariencia'), min: 'admin' },
  { key: 'ai', label: msg('Proveedores de IA'), min: 'admin' },
  { key: 'memory', label: msg('Memoria de IA'), min: 'member' },
  { key: 'channels', label: msg('Canales'), min: 'viewer' },
  { key: 'api-keys', label: msg('API keys'), min: 'admin' },
  { key: 'audit', label: msg('Auditoría'), min: 'admin' },
  { key: 'platform', label: msg('Plataforma'), min: null, platform: true },
];

export default function Settings() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can, me } = useSession();
  const visible = TABS.filter((item) => (item.platform ? me?.user.isPlatformAdmin : item.min === null || can(item.min)));
  const current = visible.find((item) => item.key === tab);
  if (!current) return <Navigate to="/settings/general" replace />;
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader title={t('Ajustes')} description={t('Configuración de la organización, el equipo, la IA y la seguridad.')} />
      <Tabs tabs={visible.map((item) => ({ key: item.key, label: tk(item.label) }))} value={current.key} onChange={(k) => navigate(`/settings/${k}`)} />
      {/* key por pestaña: la animación de entrada se repite en cada cambio (antes solo en la primera). */}
      <div key={current.key} className="animate-fade-in">
        {current.key === 'general' && <GeneralTab />}
        {current.key === 'account' && <AccountTab />}
        {current.key === 'team' && <TeamTab />}
        {current.key === 'customization' && <CustomizationTab />}
        {current.key === 'appearance' && <AppearanceTab />}
        {current.key === 'ai' && <AiTab />}
        {current.key === 'memory' && <MemoryTab />}
        {current.key === 'channels' && <ChannelsTab />}
        {current.key === 'api-keys' && <ApiKeysTab />}
        {current.key === 'audit' && <AuditTab />}
        {current.key === 'platform' && <PlatformTab />}
      </div>
    </div>
  );
}
