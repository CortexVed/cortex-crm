import { Badge } from '../../components/ui';
import { msg, tk } from '../../lib/i18n';

export const STATUS: Record<string, { label: string; color: string }> = {
  queued: { label: msg('En cola'), color: 'slate' },
  planning: { label: msg('Planificando'), color: 'violet' },
  testing: { label: msg('Probando'), color: 'sky' },
  needs_input: { label: msg('Necesita información'), color: 'amber' },
  ready_for_review: { label: msg('Pendiente de aprobación'), color: 'fuchsia' },
  approved: { label: msg('Aprobado'), color: 'indigo' },
  rejected: { label: msg('Rechazado'), color: 'slate' },
  deploying: { label: msg('Publicando'), color: 'sky' },
  applied: { label: msg('Publicado'), color: 'emerald' },
  failed: { label: msg('No supera las pruebas'), color: 'red' },
  rolled_back: { label: msg('Revertido'), color: 'orange' },
  cancelled: { label: msg('Cancelado'), color: 'slate' },
};

export const RISK: Record<string, { label: string; color: string }> = {
  low: { label: msg('Riesgo bajo'), color: 'emerald' },
  medium: { label: msg('Riesgo medio'), color: 'amber' },
  high: { label: msg('Riesgo alto'), color: 'red' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, color: 'slate' };
  return <Badge color={s.color} dot>{tk(s.label)}</Badge>;
}

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return null;
  const r = RISK[risk] ?? { label: risk, color: 'slate' };
  return <Badge color={r.color}>{tk(r.label)}</Badge>;
}

export const RUNNING = new Set(['queued', 'planning', 'testing', 'deploying']);

export const EXAMPLES = [
  msg('Quiero que añadas un módulo para gestionar contratos, con fechas de vencimiento, documentos adjuntos y avisos automáticos.'),
  msg('Quiero añadir una puntuación de clientes basada en compras, actividad comercial y probabilidad de conversión.'),
  msg('Quiero que los comerciales reciban un aviso cuando un cliente importante lleve 15 días sin actividad.'),
  msg('Quiero cambiar completamente el diseño del módulo de oportunidades.'),
  msg('Quiero integrar WhatsApp y que los mensajes de los clientes aparezcan automáticamente en su ficha.'),
  msg('Añade una vista calendario de tareas por prioridad y un panel con las tareas vencidas por comercial.'),
  msg('Usa nuestro color corporativo #0A7F6B, pon el menú lateral oscuro y agrupa el menú en Comercial y Operaciones.'),
  msg('Crea una página de inicio para ventas con KPIs y la lista de oportunidades abiertas.'),
];
