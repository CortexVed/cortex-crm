import { Badge } from '../../components/ui';

export const STATUS: Record<string, { label: string; color: string }> = {
  queued: { label: 'En cola', color: 'slate' },
  planning: { label: 'Planificando', color: 'violet' },
  testing: { label: 'Probando', color: 'sky' },
  needs_input: { label: 'Necesita información', color: 'amber' },
  ready_for_review: { label: 'Pendiente de aprobación', color: 'fuchsia' },
  approved: { label: 'Aprobado', color: 'indigo' },
  rejected: { label: 'Rechazado', color: 'slate' },
  deploying: { label: 'Publicando', color: 'sky' },
  applied: { label: 'Publicado', color: 'emerald' },
  failed: { label: 'No supera las pruebas', color: 'red' },
  rolled_back: { label: 'Revertido', color: 'orange' },
  cancelled: { label: 'Cancelado', color: 'slate' },
};

export const RISK: Record<string, { label: string; color: string }> = {
  low: { label: 'Riesgo bajo', color: 'emerald' },
  medium: { label: 'Riesgo medio', color: 'amber' },
  high: { label: 'Riesgo alto', color: 'red' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, color: 'slate' };
  return <Badge color={s.color} dot>{s.label}</Badge>;
}

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return null;
  const r = RISK[risk] ?? { label: risk, color: 'slate' };
  return <Badge color={r.color}>{r.label}</Badge>;
}

export const RUNNING = new Set(['queued', 'planning', 'testing', 'deploying']);

export const EXAMPLES = [
  'Quiero que añadas un módulo para gestionar contratos, con fechas de vencimiento, documentos adjuntos y avisos automáticos.',
  'Quiero añadir una puntuación de clientes basada en compras, actividad comercial y probabilidad de conversión.',
  'Quiero que los comerciales reciban un aviso cuando un cliente importante lleve 15 días sin actividad.',
  'Quiero cambiar completamente el diseño del módulo de oportunidades.',
  'Quiero integrar WhatsApp y que los mensajes de los clientes aparezcan automáticamente en su ficha.',
  'Añade una vista calendario de tareas por prioridad y un panel con las tareas vencidas por comercial.',
  'Usa nuestro color corporativo #0A7F6B, pon el menú lateral oscuro y agrupa el menú en Comercial y Operaciones.',
  'Crea una página de inicio para ventas con KPIs y la lista de oportunidades abiertas.',
];
