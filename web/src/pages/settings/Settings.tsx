import { Navigate, useNavigate, useParams } from 'react-router';
import { PageHeader, Tabs } from '../../components/ui';
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

const TABS: { key: TabKey; label: string; min: Role | null; platform?: boolean }[] = [
  { key: 'general', label: 'Organización', min: 'viewer' },
  { key: 'account', label: 'Mi cuenta', min: null },
  { key: 'team', label: 'Equipo', min: 'viewer' },
  { key: 'customization', label: 'Personalización', min: 'admin' },
  { key: 'appearance', label: 'Apariencia', min: 'admin' },
  { key: 'ai', label: 'Proveedores de IA', min: 'admin' },
  { key: 'memory', label: 'Memoria de IA', min: 'member' },
  { key: 'channels', label: 'Canales', min: 'viewer' },
  { key: 'api-keys', label: 'API keys', min: 'admin' },
  { key: 'audit', label: 'Auditoría', min: 'admin' },
  { key: 'platform', label: 'Plataforma', min: null, platform: true },
];

export default function Settings() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { can, me } = useSession();
  const visible = TABS.filter((t) => (t.platform ? me?.user.isPlatformAdmin : t.min === null || can(t.min)));
  const current = visible.find((t) => t.key === tab);
  if (!current) return <Navigate to="/settings/general" replace />;
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader title="Ajustes" description="Configuración de la organización, el equipo, la IA y la seguridad." />
      <Tabs tabs={visible.map((t) => ({ key: t.key, label: t.label }))} value={current.key} onChange={(k) => navigate(`/settings/${k}`)} />
      <div className="animate-fade-in">
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
