import { describe, expect, it } from 'vitest';
import { defaultBlueprint } from '../../shared/default-blueprint';
import { ChangeSetSchema } from '../../shared/changeset';
import { validateBlueprint } from '../src/evolve/validate';
import { applyOperations } from '../src/evolve/apply';
import { assessRisk } from '../src/evolve/risk';
import { computeFormula, parseFormula, FormulaError } from '../../shared/formula';
import { normalizeRecordInput } from '../../shared/records';
import { evaluateConditions } from '../../shared/conditions';
import { resolveTemplate } from '../../shared/templates';

describe('blueprint por defecto', () => {
  it('es válido y no tiene errores semánticos', () => {
    const bp = defaultBlueprint();
    const issues = validateBlueprint(bp);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(bp.modules.map((m) => m.key)).toEqual(['companies', 'contacts', 'deals', 'tasks', 'activities']);
    expect(bp.modules[0].permissions.read).toBe('viewer');
  });
});

describe('aplicación de operaciones', () => {
  it('crea un módulo de contratos con vistas y una automatización por fecha', () => {
    const bp = defaultBlueprint();
    const cs = ChangeSetSchema.parse({
      title: 'Módulo de contratos',
      summary: 'Gestión de contratos con vencimiento',
      operations: [
        {
          op: 'create_module',
          module: {
            key: 'contracts',
            label: 'Contrato',
            labelPlural: 'Contratos',
            icon: 'file-signature',
            primaryField: 'name',
            fields: [
              { key: 'name', label: 'Nombre', type: 'text', required: true },
              { key: 'company', label: 'Empresa', type: 'relation', relation: { module: 'companies' } },
              { key: 'end_date', label: 'Vencimiento', type: 'date' },
              { key: 'owner', label: 'Responsable', type: 'user' },
              { key: 'documents', label: 'Documentos', type: 'file' },
            ],
            views: [
              { key: 'all', label: 'Todos', type: 'table', columns: ['name', 'company', 'end_date'] },
              { key: 'calendar', label: 'Vencimientos', type: 'calendar', dateField: 'end_date' },
            ],
          },
        },
        {
          op: 'upsert_automation',
          automation: {
            key: 'contract_expiry',
            name: 'Aviso de vencimiento',
            trigger: { type: 'date_reached', module: 'contracts', field: 'end_date', offsetDays: -30 },
            actions: [{ type: 'notify', to: { type: 'user_field', field: 'owner' }, title: 'Vence {{record.name}}' }],
          },
        },
      ],
    });
    const { blueprint, errors } = applyOperations(bp, cs.operations);
    expect(errors).toEqual([]);
    expect(validateBlueprint(blueprint).filter((i) => i.level === 'error')).toEqual([]);
    expect(blueprint.modules.find((m) => m.key === 'contracts')?.permissions.create).toBe('member');
    const risk = assessRisk(bp, cs.operations);
    expect(risk.level).toBe('low');
  });

  it('rechaza cambios de tipo incompatibles y archivar campos esenciales', () => {
    const bp = defaultBlueprint();
    const { errors } = applyOperations(bp, [
      { op: 'update_field', module: 'deals', field: 'amount', changes: { type: 'date' } },
      { op: 'archive_field', module: 'deals', field: 'title' },
    ] as any);
    expect(errors).toHaveLength(2);
  });

  it('detecta referencias rotas en vistas y automatizaciones', () => {
    const bp = defaultBlueprint();
    const { blueprint } = applyOperations(bp, [
      { op: 'upsert_view', module: 'deals', view: { key: 'k', label: 'K', type: 'kanban', groupBy: 'amount', filters: [] } },
      {
        op: 'upsert_automation',
        automation: { key: 'x', name: 'X', enabled: true, conditions: [], trigger: { type: 'record_created', module: 'deals' }, actions: [{ type: 'send_webhook', integration: 'nope' }] },
      },
    ] as any);
    const errors = validateBlueprint(blueprint).filter((i) => i.level === 'error');
    expect(errors.map((e) => e.message).join(' | ')).toMatch(/kanban/);
    expect(errors.map((e) => e.message).join(' | ')).toMatch(/Integración inexistente/);
  });

  it('los parches solo cambian lo indicado (sin aplicar valores por defecto)', () => {
    const bp = defaultBlueprint();
    const cs = ChangeSetSchema.parse({
      title: 'Ajustes',
      summary: 'Cambia el color de empresas, un permiso y la etiqueta de la etapa',
      operations: [
        { op: 'update_module', module: 'companies', changes: { color: 'emerald' } },
        { op: 'update_module', module: 'deals', changes: { permissions: { delete: 'admin' } } },
        { op: 'update_field', module: 'deals', field: 'stage', changes: { label: 'Fase' } },
      ],
    });
    expect(cs.operations[0]).toEqual({ op: 'update_module', module: 'companies', changes: { color: 'emerald' } });
    const { blueprint, errors } = applyOperations(bp, cs.operations);
    expect(errors).toEqual([]);
    const companies = blueprint.modules.find((m) => m.key === 'companies')!;
    expect(companies).toMatchObject({ color: 'emerald', icon: 'building', permissions: { read: 'viewer', create: 'member', update: 'member', delete: 'member' } });
    expect(blueprint.modules.find((m) => m.key === 'deals')!.permissions).toEqual({ read: 'viewer', create: 'member', update: 'member', delete: 'admin' });
    const stage = blueprint.modules.find((m) => m.key === 'deals')!.fields.find((f) => f.key === 'stage')!;
    expect(stage).toMatchObject({ label: 'Fase', required: true });
    const risk = assessRisk(bp, cs.operations);
    expect(risk.items[0].level).toBe('low');
    expect(risk.items[1]).toMatchObject({ level: 'medium', message: expect.stringContaining('Se restringen') });
  });

  it('clasifica como riesgo alto integraciones externas y eliminación de opciones', () => {
    const bp = defaultBlueprint();
    const risk = assessRisk(bp, [
      { op: 'upsert_integration', integration: { key: 'zap', name: 'Zapier', type: 'webhook', url: 'https://hooks.example.com/x', enabled: true } },
      { op: 'update_field', module: 'deals', field: 'stage', changes: { options: [{ value: 'nuevo', label: 'Nuevo', color: 'sky' }] } },
    ] as any);
    expect(risk.level).toBe('high');
    expect(risk.dataEgress).toBe(true);
    expect(risk.destructive).toBe(true);
    expect(risk.requiresOwner).toBe(true);
  });
});

describe('fórmulas', () => {
  it('calcula importes ponderados y puntuaciones', () => {
    const now = new Date('2026-06-15T10:00:00Z');
    expect(computeFormula('{amount} * {probability} / 100', 'number', { data: { amount: 1000, probability: 25 }, now })).toBe(250);
    const related = new Map([['COUNT_RELATED|activities|company|', 7]]);
    expect(
      computeFormula('IF({tier} = "estrategica", 30, 0) + MIN(40, COUNT_RELATED("activities", "company") * 4)', 'number', {
        data: { tier: 'estrategica' },
        now,
        related,
      }),
    ).toBe(58);
    expect(computeFormula('DAYS_SINCE({d})', 'number', { data: { d: '2026-06-01' }, now })).toBe(14);
  });

  it('rechaza expresiones peligrosas o mal formadas', () => {
    expect(() => parseFormula('process.exit()')).toThrow(FormulaError);
    expect(() => parseFormula('{a} +')).toThrow(FormulaError);
    expect(() => parseFormula('EVAL("1")')).toThrow(/desconocida/);
  });
});

describe('validación de registros', () => {
  const deals = defaultBlueprint().modules.find((m) => m.key === 'deals')!;
  it('normaliza y aplica valores por defecto', () => {
    const { data, issues } = normalizeRecordInput(deals, { title: ' Proyecto ', amount: '1500,5', stage: 'Propuesta' }, { mode: 'create' });
    expect(issues).toEqual([]);
    expect(data).toMatchObject({ title: 'Proyecto', amount: 1500.5, stage: 'propuesta', probability: 10 });
  });
  it('rechaza campos desconocidos, calculados y obligatorios vacíos', () => {
    const { issues } = normalizeRecordInput(deals, { title: '', foo: 1, weighted_amount: 3 }, { mode: 'create' });
    expect(issues.map((i) => i.field).sort()).toEqual(['foo', 'title', 'weighted_amount']);
  });
});

describe('condiciones y plantillas', () => {
  it('evalúa operadores con plantillas de fechas', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const rec = { id: '1', data: { stage: 'ganado', amount: 500, tags: ['vip'] }, updatedAt: '2026-03-05T10:00:00.000Z' };
    expect(evaluateConditions([{ field: 'stage', operator: 'eq', value: 'GANADO' }], rec, { now })).toBe(true);
    expect(evaluateConditions([{ field: 'tags', operator: 'contains', value: 'vip' }], rec, { now })).toBe(true);
    expect(evaluateConditions([{ field: 'updated_at', operator: 'gte', value: '{{month_start}}' }], rec, { now })).toBe(true);
    expect(evaluateConditions([{ field: 'amount', operator: 'gt', value: 1000 }], rec, { now })).toBe(false);
    expect(resolveTemplate('{{today+3d}}', { now })).toBe('2026-03-13');
  });
});
