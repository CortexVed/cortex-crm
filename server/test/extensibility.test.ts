import { describe, expect, it } from 'vitest';
import { defaultBlueprint } from '../../shared/default-blueprint';
import type { Blueprint } from '../../shared/blueprint';
import type { Operation } from '../../shared/changeset';
import { blueprintForRole, referencedModules } from '../src/crm/visibility';
import { assessRisk, assessTransition } from '../src/evolve/risk';

/**
 * La plataforma puede crecer sin límite: el motor de código fuente puede añadir tipos nuevos de acción, de bloque
 * o de operación, pero no puede tocar el motor de riesgo ni la visibilidad por rol (núcleo protegido). Estas
 * pruebas fijan que lo que esas piezas no conocen se trata siempre del lado seguro.
 */

// Simula tipos que una versión futura añadiría (el esquema actual no los admite).
const asOps = (ops: unknown[]) => ops as Operation[];
const withExtras = (bp: Blueprint, extra: Partial<Record<'automations' | 'pages', unknown[]>>) => ({ ...bp, ...extra }) as unknown as Blueprint;

function restricted(): Blueprint {
  const bp = defaultBlueprint();
  // Un módulo que solo leen administradores
  return { ...bp, modules: bp.modules.map((m) => (m.key === 'deals' ? { ...m, permissions: { ...m.permissions, read: 'admin' as const } } : m)) };
}

describe('riesgo de lo que la plataforma añada en el futuro', () => {
  it('una automatización con una acción desconocida es de riesgo alto', () => {
    const bp = defaultBlueprint();
    const r = assessRisk(bp, asOps([{ op: 'upsert_automation', automation: { key: 'leer_facturas', name: 'Leer facturas', enabled: true, trigger: { type: 'record_created', module: 'companies' }, conditions: [], actions: [{ type: 'ai_extract', module: 'companies', fields: ['name'] }] } }]));
    expect(r.level).toBe('high');
    expect(r.items[0].message).toMatch(/acción nueva de la plataforma \(ai_extract\)/);
  });

  it('una operación desconocida es de riesgo alto (nunca suma riesgo bajo por omisión)', () => {
    const r = assessRisk(defaultBlueprint(), asOps([{ op: 'upsert_report', report: { key: 'informe' } }]));
    expect(r.level).toBe('high');
    expect(r.items[0].message).toMatch(/Operación nueva de la plataforma \(upsert_report\)/);
  });

  it('una página con un tipo de bloque desconocido es de riesgo medio', () => {
    const r = assessRisk(defaultBlueprint(), asOps([{ op: 'upsert_page', page: { key: 'informes', label: 'Informes', icon: 'layers', minRole: 'viewer', blocks: [{ type: 'ai_report', modules: ['deals'], width: 'full' }] } }]));
    expect(r.level).toBe('medium');
    expect(r.items[0].message).toMatch(/tipo de bloque nuevo/);
  });

  it('restaurar una versión que reactiva una acción desconocida es de riesgo alto', () => {
    const current = defaultBlueprint();
    const target = withExtras(current, { automations: [...current.automations, { key: 'x', name: 'X', enabled: true, trigger: { type: 'record_created', module: 'companies' }, conditions: [], actions: [{ type: 'ai_extract' }] }] });
    expect(assessTransition(current, target).level).toBe('high');
  });
});

describe('visibilidad de lo que la plataforma añada en el futuro', () => {
  it('detecta los módulos que referencia cualquier configuración', () => {
    const bp = defaultBlueprint();
    expect(referencedModules(bp, { type: 'ai_report', modules: ['deals', 'companies'], nested: { widget: { module: 'tasks' } }, to: { type: 'new_record', key: 'contacts' } }).sort()).toEqual(['companies', 'contacts', 'deals', 'tasks']);
    expect(referencedModules(bp, { type: 'heading', text: 'Hola' })).toEqual([]);
  });

  it('un bloque desconocido solo se muestra a quien puede leer todos los módulos que usa', () => {
    const bp = withExtras(restricted(), {
      pages: [{ key: 'p', label: 'P', icon: 'layers', minRole: 'viewer', blocks: [{ type: 'ai_report', modules: ['deals'], width: 'full' }, { type: 'ai_report', modules: ['companies'], width: 'full' }, { type: 'mapa', width: 'full' }] }],
    });
    const member = blueprintForRole(bp, 'member').pages[0].blocks as unknown as { type: string; modules?: string[] }[];
    expect(member.map((b) => b.modules?.[0] ?? b.type)).toEqual(['companies', 'mapa']);
    const admin = blueprintForRole(bp, 'admin').pages[0].blocks;
    expect(admin).toHaveLength(3);
  });

  it('una automatización con una acción desconocida sobre un módulo restringido no la ve quien no puede leerlo', () => {
    const base = restricted();
    const bp = withExtras(base, {
      automations: [...base.automations, { key: 'copia', name: 'Copia', enabled: true, trigger: { type: 'record_created', module: 'companies' }, conditions: [], actions: [{ type: 'ai_extract', module: 'deals' }] }],
    });
    expect(blueprintForRole(bp, 'builder').automations.some((a) => a.key === 'copia')).toBe(false);
    expect(blueprintForRole(bp, 'admin').automations.some((a) => a.key === 'copia')).toBe(true);
  });
});
