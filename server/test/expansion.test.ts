import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import { BLUEPRINT_LIMITS, BlueprintSchema, type Blueprint } from '../../shared/blueprint';
import { CHANGESET_LIMITS } from '../../shared/changeset';
import { defaultBlueprint } from '../../shared/default-blueprint';
import { validateBlueprint } from '../src/evolve/validate';
import { blueprintCacheStats, loadWorkspace } from '../src/crm/context';
import { blueprintForPlanner, PLANNER_FULL_BLUEPRINT_CHARS, PLANNER_INDEX_CHARS, plannerMessage, relevantModules } from '../src/evolve/planner-context';

/**
 * Capacidad de expansión: sin límites prácticos de módulos, planificación de blueprints grandes y peticiones
 * grandes generadas por partes.
 */

function makeModule(key: string, fields = 6, extra: Record<string, unknown> = {}) {
  return {
    key,
    label: `Módulo ${key}`,
    labelPlural: `Módulos ${key}`,
    primaryField: 'name',
    fields: [{ key: 'name', label: 'Nombre', type: 'text', required: true }, ...Array.from({ length: fields - 1 }, (_, i) => ({ key: `f${i}`, label: `Campo ${i}`, type: 'text', ...extra }))],
    views: [{ key: 'all', label: 'Todos', type: 'table', columns: ['name'] }],
  };
}

function bigBlueprint(modules: number, fields = 6): Blueprint {
  const base = defaultBlueprint();
  return BlueprintSchema.parse({ ...base, modules: [...base.modules, ...Array.from({ length: modules }, (_, i) => makeModule(`mod_${i}`, fields))] });
}

describe('límites del blueprint', () => {
  it('admite cientos de módulos con muchos campos (los límites son de abuso, no de uso)', () => {
    expect(BLUEPRINT_LIMITS.modules).toBeGreaterThanOrEqual(1000);
    expect(CHANGESET_LIMITS.operations).toBeGreaterThanOrEqual(1000);
    const bp = bigBlueprint(300, 150);
    expect(bp.modules.length).toBe(305);
    expect(validateBlueprint(bp).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('el único tope global es el tamaño total', () => {
    const helpText = 'x'.repeat(300);
    const base = defaultBlueprint();
    const huge = BlueprintSchema.parse({ ...base, modules: Array.from({ length: 2000 }, (_, i) => makeModule(`m_${i}`, 45, { helpText })) });
    const errors = validateBlueprint(huge).filter((i) => i.level === 'error');
    expect(errors.some((e) => e.path === 'blueprint' && e.message.includes('MB'))).toBe(true);
  });
});

describe('contexto del planificador', () => {
  it('con un blueprint pequeño envía el blueprint completo', () => {
    const view = blueprintForPlanner(defaultBlueprint(), 'añade un campo a contactos');
    expect(view.mode).toBe('full');
  });

  it('con un blueprint enorme envía un índice acotado y el detalle de los módulos nombrados y relacionados', () => {
    const base = bigBlueprint(400, 40);
    // mod_10 se relaciona con mod_11 para comprobar que el detalle incluye las relaciones
    const bp = BlueprintSchema.parse({
      ...base,
      modules: base.modules.map((m) => (m.key === 'mod_10' ? { ...m, fields: [...m.fields, { key: 'socio', label: 'Socio', type: 'relation', relation: { module: 'mod_11' } }] } : m)),
    });
    expect(JSON.stringify(bp).length).toBeGreaterThan(PLANNER_FULL_BLUEPRINT_CHARS);
    const view = blueprintForPlanner(bp, 'En «Módulos mod_10» añade un campo de prioridad');
    expect(view.mode).toBe('index');
    expect(view.detailed).toEqual(expect.arrayContaining(['mod_10', 'mod_11']));
    expect(view.detailed).not.toContain('mod_200');
    expect(view.content).toContain('- mod_399 (Módulo mod_399');
    expect(view.content.length).toBeLessThan(PLANNER_INDEX_CHARS + 120_000);
    expect(relevantModules(bp, 'nada que ver')).toEqual([]);
    const msg = plannerMessage({ orgName: 'Grande SL', settings: { timezone: 'Europe/Madrid', currency: 'EUR' }, version: 7, blueprint: bp, releases: [], memory: [], prompt: 'En mod_10 añade prioridad' });
    expect(msg).toContain('resumido por tamaño');
  });
});

describe('peticiones grandes: plan por partes', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  beforeAll(async () => {
    env = await setup();
    owner = new Client(env.app);
    await owner.register('Gran', 'gran@example.com', 'Expansión SL');
  });
  afterAll(async () => env.close());

  const moduleOp = (key: string, label: string, extraFields: unknown[] = []) => ({ op: 'create_module', module: { ...makeModule(key, 2), label, labelPlural: `${label}s`, fields: [...makeModule(key, 2).fields, ...extraFields] } });
  const countTest = (module: string) => ({ name: `Se crea un registro en ${module}`, steps: [{ action: 'create', module, values: { name: 'Prueba' }, as: 'r' }, { action: 'expect_count', module, equals: 1 }] });

  async function run(prompt: string) {
    const r = await owner.req('POST', '/api/evolve/requests', { prompt });
    expect(r.status).toBe(200);
    await env.drain();
    return (await owner.req('GET', `/api/evolve/requests/${r.body.id}`)).body;
  }

  it('genera cada parte sobre el resultado de las anteriores y lo presenta como un único cambio', async () => {
    const seen: string[] = [];
    env.setMock((req) => {
      const last = req.messages.at(-1);
      const msg = last && 'content' in last ? String(last.content) : '';
      seen.push(msg);
      if (msg.includes('Parte que debes generar ahora: Almacén')) {
        return { text: JSON.stringify({ title: 'Almacén', summary: 'Almacenes', operations: [moduleOp('almacenes', 'Almacén')], tests: [countTest('almacenes')] }) };
      }
      if (msg.includes('Parte que debes generar ahora: Inventario')) {
        return {
          text: JSON.stringify({
            title: 'Inventario',
            summary: 'Artículos por almacén',
            operations: [moduleOp('articulos', 'Artículo', [{ key: 'almacen', label: 'Almacén', type: 'relation', relation: { module: 'almacenes' } }])],
            tests: [countTest('articulos')],
          }),
        };
      }
      return {
        text: JSON.stringify({
          title: 'ERP de almacén',
          summary: 'Almacenes e inventario',
          operations: [],
          tests: [],
          outline: [
            { key: 'almacen', title: 'Almacén', description: 'Módulo de almacenes' },
            { key: 'inventario', title: 'Inventario', description: 'Artículos con relación a su almacén' },
          ],
        }),
      };
    });
    const r = await run('Crea un ERP de almacén completo con almacenes, artículos e inventario');
    expect(r.status).toBe('ready_for_review');
    expect(r.change_set.title).toBe('ERP de almacén');
    expect(r.change_set.operations.map((o: any) => o.module.key)).toEqual(['almacenes', 'articulos']);
    expect(r.change_set.tests).toHaveLength(2);
    expect(r.test_report.passed).toBe(true);
    // La segunda parte vio el módulo creado por la primera
    const second = seen.find((m) => m.includes('Parte que debes generar ahora: Inventario'))!;
    expect(second).toContain('"key":"almacenes"');
    expect(second).toContain('(ya generada');
    expect(r.llm.map((l: any) => l.phase)).toEqual(expect.arrayContaining(['plan', 'plan_part_almacen', 'plan_part_inventario']));
    expect(r.progress.some((p: any) => String(p.detail ?? '').includes('en 2 partes'))).toBe(true);
  });

  it('el blueprint se carga una vez por versión (caché acotada por tamaño)', async () => {
    const wsId = (await owner.req('GET', '/api/workspace')).body.id as string;
    const a = await env.db.tenant(wsId, (q) => loadWorkspace(q, wsId));
    const b = await env.db.tenant(wsId, (q) => loadWorkspace(q, wsId));
    expect(b.blueprint).toBe(a.blueprint);
    const stats = blueprintCacheStats();
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
  });

  it('si una parte falla en las pruebas, solo se regenera esa parte', async () => {
    let inventoryCalls = 0;
    let storeCalls = 0;
    env.setMock((req) => {
      const last = req.messages.at(-1);
      const msg = last && 'content' in last ? String(last.content) : '';
      if (msg.includes('Parte que debes generar ahora: Proveedores')) {
        storeCalls++;
        return { text: JSON.stringify({ title: 'Proveedores', summary: 'Proveedores', operations: [moduleOp('proveedores', 'Proveedor')], tests: [countTest('proveedores')] }) };
      }
      if (msg.includes('Parte que debes generar ahora: Compras')) {
        inventoryCalls++;
        // Primer intento: relación con un módulo que no existe (falla la validación del sandbox)
        const target = inventoryCalls === 1 ? 'proveedorez' : 'proveedores';
        return {
          text: JSON.stringify({
            title: 'Compras',
            summary: 'Pedidos de compra',
            operations: [moduleOp('compras', 'Compra', [{ key: 'proveedor', label: 'Proveedor', type: 'relation', relation: { module: target } }])],
            tests: [countTest('compras')],
          }),
        };
      }
      return {
        text: JSON.stringify({
          title: 'Compras a proveedores',
          summary: 'Proveedores y pedidos',
          operations: [],
          tests: [],
          outline: [
            { key: 'proveedores', title: 'Proveedores', description: 'Módulo de proveedores' },
            { key: 'compras', title: 'Compras', description: 'Pedidos con relación al proveedor' },
          ],
        }),
      };
    });
    const r = await run('Quiero gestionar proveedores y compras con pedidos');
    expect(r.status).toBe('ready_for_review');
    expect(inventoryCalls).toBe(2);
    expect(storeCalls).toBe(1);
    const compras = r.change_set.operations.find((o: any) => o.module.key === 'compras');
    expect(compras.module.fields.find((f: any) => f.key === 'proveedor').relation.module).toBe('proveedores');
  });
});
