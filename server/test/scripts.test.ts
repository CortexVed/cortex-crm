import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import { runScript, ScriptError } from '../src/crm/scripts';

/**
 * Scripts por organización: código a medida que se ejecuta en un sandbox QuickJS (WebAssembly)
 * dentro de la plataforma, versionado con el blueprint de cada organización. Nada se publica fuera.
 */

describe('sandbox de scripts (QuickJS/WebAssembly)', () => {
  const input = { record: { id: 'r1', module: 'deals', data: { amount: 42000, stage: 'propuesta' } }, previous: null, trigger: 'record_created', related: {}, refs: {}, now: '2026-11-23T10:00:00.000Z', tz: 'Europe/Madrid' };

  it('ejecuta run(input) como función pura y devuelve intenciones validadas', async () => {
    const r = await runScript(`function run(input) { console.log('importe', input.record.data.amount); return { update: { probability: input.record.data.amount > 40000 ? 60 : 30 }, log: ['ok'] }; }`, input);
    expect(r.output).toEqual({ update: { probability: 60 }, log: ['ok'] });
    expect(r.logs).toEqual(['importe 42000']);
  });

  it('no tiene acceso al servidor: ni process, ni require, ni fetch, ni módulos', async () => {
    const r = await runScript(
      `function run() {
        var out = [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof globalThis.process, typeof setTimeout];
        try { out.push(String(Function('return typeof process')())); } catch (e) { out.push('error'); }
        return { log: out };
      }`,
      input,
    );
    expect(r.output.log).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('corta los bucles infinitos por tiempo', async () => {
    const t0 = Date.now();
    await expect(runScript('function run() { while (true) {} }', input, { timeoutMs: 100 })).rejects.toThrow(/Tiempo máximo/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('corta el consumo excesivo de memoria', async () => {
    // 8 MB por iteración: con el límite de 16 MB el sandbox se queda sin memoria enseguida.
    await expect(runScript('function run() { var a = []; while (true) a.push(new Float64Array(1e6)); }', input, { timeoutMs: 3000 })).rejects.toThrow(/Memoria máxima/);
  });

  it('rechaza resultados con forma no permitida y scripts sin run()', async () => {
    await expect(runScript('function run() { return { borrarTodo: true }; }', input)).rejects.toThrow(/Resultado no válido/);
    await expect(runScript('var x = 1;', input)).rejects.toThrow(/function run/);
    await expect(runScript('function run() { throw new Error("fallo previsto"); }', input)).rejects.toThrow(ScriptError);
  });

  it('lo que hace el script no contamina el proceso anfitrión', async () => {
    await runScript('function run() { Object.prototype.contaminado = 1; Array.prototype.push = null; return {}; }', input);
    expect(({} as Record<string, unknown>).contaminado).toBeUndefined();
    expect(typeof [].push).toBe('function');
  });
});

const SCORE_CODE = `function run(input) {
  var d = input.record.data;
  var s = Math.min(100, Math.round((d.amount || 0) / 1000) + (d.stage === 'negociacion' ? 30 : 0));
  if (d.score === s) return {};
  return { update: { score: s }, log: ['puntuación ' + s] };
}`;

describe('EVOLVE AI ENGINE con scripts por organización', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let owner: Client;
  let releaseId = '';
  beforeAll(async () => {
    env = await setup();
    owner = new Client(env.app);
    await owner.register('Sara', 'sara@example.com', 'Scripts SL');
  });
  afterAll(async () => env.close());

  it('el planificador especifica el script, el desarrollador escribe el código y el sandbox lo prueba', async () => {
    const systems: string[] = [];
    env.setMock((req) => {
      systems.push(req.system ?? '');
      if ((req.system ?? '').includes('Eres el desarrollador')) return { text: JSON.stringify({ code: SCORE_CODE, notes: 'Redondeo a enteros' }) };
      return {
        text: JSON.stringify({
          title: 'Puntuación de oportunidades',
          summary: 'Calcula una puntuación de 0 a 100 según importe y etapa',
          operations: [
            { op: 'add_field', module: 'deals', field: { key: 'score', label: 'Puntuación', type: 'number' } },
            { op: 'upsert_script', script: { key: 'deal_score', name: 'Puntuación de oportunidades', description: 'score = min(100, importe/1000 redondeado + 30 si la etapa es negociación)', code: '' } },
            { op: 'upsert_automation', automation: { key: 'score_on_save', name: 'Calcular puntuación', trigger: { type: 'record_created', module: 'deals' }, actions: [{ type: 'run_script', script: 'deal_score' }] } },
          ],
          tests: [{ name: 'Puntúa una oportunidad en negociación', steps: [{ action: 'create', module: 'deals', values: { title: 'Gran cuenta', amount: 50000, stage: 'negociacion' }, as: 'd' }, { action: 'expect_field', ref: 'd', field: 'score', equals: 80 }] }],
        }),
      };
    });
    const created = await owner.req('POST', '/api/evolve/requests', { prompt: 'Quiero una puntuación automática de cada oportunidad según su importe y su etapa' });
    await env.drain();
    const r = (await owner.req('GET', `/api/evolve/requests/${created.body.id}`)).body;
    expect(r.status).toBe('ready_for_review');
    expect(r.kind).toBe('script');
    expect(r.risk).toBe('high'); // código a medida → lo aprueba un propietario
    expect(r.change_set.operations.find((o: any) => o.op === 'upsert_script').script.code).toBe(SCORE_CODE);
    expect(systems.some((s) => s.includes('Eres el desarrollador'))).toBe(true);
    const tasks = (await env.db.query<{ task: string }>(`SELECT task FROM llm_usage WHERE ref = $1 ORDER BY created_at`, [created.body.id])).rows.map((x) => x.task);
    expect(tasks).toContain('code_modification');
    const acceptance = r.test_report.suites.find((s: any) => s.key === 'acceptance');
    expect(acceptance.cases[0].passed).toBe(true);
    const security = r.test_report.suites.find((s: any) => s.key === 'security');
    expect(security.cases.some((c: any) => c.name.includes('se ejecuta aislado') && c.passed)).toBe(true);

    expect((await owner.req('POST', `/api/evolve/requests/${created.body.id}/approve`, { confirmation: 'APLICAR' })).status).toBe(200);
    const dep = await owner.req('POST', `/api/evolve/requests/${created.body.id}/deploy`);
    expect(dep.status).toBe(200);
    expect(dep.body.verification.ok).toBe(true);
    releaseId = dep.body.releaseId;
  });

  it('en producción el script se ejecuta en cada alta y su ejecución queda registrada', async () => {
    const deal = await owner.req('POST', '/api/records/deals', { values: { title: 'Renovación', amount: 20000, stage: 'propuesta' } });
    expect(deal.status).toBe(200);
    const fresh = await owner.req('GET', `/api/records/deals/${deal.body.record.id}`);
    expect(fresh.body.record.data.score).toBe(20);
    const run = (await env.db.query<{ status: string; log: string[] }>(`SELECT status, log FROM automation_runs WHERE record_id = $1 AND automation_key = 'score_on_save'`, [deal.body.record.id])).rows[0];
    expect(run.status).toBe('success');
    expect(run.log.join(' ')).toContain('[script] puntuación 20');
  });

  it('cada organización es independiente: otra organización no tiene ni el script ni sus efectos', async () => {
    const other = new Client(env.app);
    await other.register('Otro', 'otro@example.com', 'Otra Empresa SL');
    const bp = (await other.req('GET', '/api/blueprint')).body.blueprint;
    expect(bp.scripts).toEqual([]);
    const deal = await other.req('POST', '/api/records/deals', { values: { title: 'Ajeno', amount: 90000, stage: 'negociacion' } });
    expect(deal.body.record.data.score).toBeUndefined();
  });

  it('un script que falla no impide guardar: la ejecución queda como fallida con el motivo', async () => {
    const m = await owner.req('POST', '/api/evolve/requests/manual', {
      changeSet: {
        title: 'Validar importes enormes',
        summary: 'Avisa con un error si el importe es desproporcionado',
        operations: [
          { op: 'upsert_script', script: { key: 'huge_amount', name: 'Importes enormes', code: 'function run(input) { if ((input.record.data.amount || 0) > 1000000) throw new Error("importe fuera de rango"); return {}; }', timeoutMs: 200 } },
          { op: 'upsert_automation', automation: { key: 'huge_check', name: 'Revisar importe', trigger: { type: 'record_created', module: 'deals' }, actions: [{ type: 'run_script', script: 'huge_amount' }] } },
        ],
      },
    });
    await env.drain();
    expect((await owner.req('POST', `/api/evolve/requests/${m.body.id}/approve`, { confirmation: 'APLICAR' })).status).toBe(200);
    expect((await owner.req('POST', `/api/evolve/requests/${m.body.id}/deploy`)).status).toBe(200);
    const deal = await owner.req('POST', '/api/records/deals', { values: { title: 'Error de tecleo', amount: 5000000, stage: 'nuevo' } });
    expect(deal.status).toBe(200);
    const run = (await env.db.query<{ status: string; log: string[] }>(`SELECT status, log FROM automation_runs WHERE record_id = $1 AND automation_key = 'huge_check'`, [deal.body.record.id])).rows[0];
    expect(run.status).toBe('failed');
    expect(run.log.join(' ')).toContain('importe fuera de rango');
  });

  it('un script que no se ejecuta bien en el sandbox no se puede publicar', async () => {
    const m = await owner.req('POST', '/api/evolve/requests/manual', {
      changeSet: {
        title: 'Script roto',
        summary: 'Bucle infinito',
        operations: [
          { op: 'upsert_script', script: { key: 'loop', name: 'Bucle', code: 'function run() { while (true) {} }', timeoutMs: 100 } },
          { op: 'upsert_automation', automation: { key: 'loop_auto', name: 'Bucle', trigger: { type: 'record_created', module: 'companies' }, actions: [{ type: 'run_script', script: 'loop' }] } },
        ],
      },
    });
    await env.drain();
    const r = (await owner.req('GET', `/api/evolve/requests/${m.body.id}`)).body;
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.test_report)).toContain('Tiempo máximo');
    expect((await owner.req('POST', `/api/evolve/requests/${m.body.id}/approve`, { confirmation: 'APLICAR' })).status).toBe(409);
  });

  it('el rollback y la restauración retiran los scripts como cualquier otra configuración', async () => {
    const rel = (await owner.req('GET', '/api/evolve/releases')).body.items;
    // La última publicación (script de importes) se revierte; la de puntuación queda activa.
    const latest = rel.find((x: any) => x.kind === 'apply' && x.id !== releaseId);
    expect((await owner.req('POST', `/api/evolve/releases/${latest.id}/rollback`, { confirmation: 'REVERTIR' })).status).toBe(200);
    let bp = (await owner.req('GET', '/api/blueprint')).body.blueprint;
    expect(bp.scripts.map((s: any) => s.key)).toEqual(['deal_score']);
    // Restaurar la versión inicial deja la organización sin scripts.
    expect((await owner.req('POST', '/api/evolve/versions/1/restore', { confirmation: 'RESTAURAR' })).status).toBe(200);
    bp = (await owner.req('GET', '/api/blueprint')).body.blueprint;
    expect(bp.scripts).toEqual([]);
    const deal = await owner.req('POST', '/api/records/deals', { values: { title: 'Tras restaurar', amount: 30000, stage: 'propuesta' } });
    expect(deal.body.record.data.score).toBeUndefined();
  });
});
