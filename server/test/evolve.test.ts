import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, CONTRACTS_CHANGESET, setup } from './helpers';

let env: Awaited<ReturnType<typeof setup>>;
let owner: Client;

beforeAll(async () => {
  env = await setup();
  owner = new Client(env.app);
  await owner.register('Olga', 'olga@example.com', 'Evolución SL');
});
afterAll(async () => env.close());

async function runRequest(prompt: string) {
  const r = await owner.req('POST', '/api/evolve/requests', { prompt });
  expect(r.status).toBe(200);
  await env.drain();
  return (await owner.req('GET', `/api/evolve/requests/${r.body.id}`)).body;
}

describe('EVOLVE AI ENGINE: flujo completo', () => {
  let requestId: string;
  let releaseId: string;

  it('interpreta, planifica, prueba en sandbox y presenta el cambio para aprobación', async () => {
    let seenSystem = '';
    env.setMock((req) => {
      seenSystem = req.system ?? '';
      return { text: JSON.stringify(CONTRACTS_CHANGESET) };
    });
    const r = await runRequest('Quiero un módulo para gestionar contratos con fechas de vencimiento, documentos adjuntos y avisos automáticos.');
    requestId = r.id;
    expect(seenSystem).toContain('REGLAS INQUEBRANTABLES');
    expect(r.status).toBe('ready_for_review');
    expect(r.risk).toBe('low');
    expect(r.test_report.passed).toBe(true);
    const suites = r.test_report.suites.map((s: any) => s.key);
    expect(suites).toEqual(['validation', 'compatibility', 'integration', 'acceptance', 'security']);
    const acceptance = r.test_report.suites.find((s: any) => s.key === 'acceptance');
    expect(acceptance.cases[0]).toMatchObject({ name: 'Avisa al responsable 30 días antes del vencimiento', passed: true });
    expect(r.impact.tables[0]).toMatchObject({ module: 'contracts', action: 'create' });
    expect(r.impact.artifacts.map((a: any) => a.path)).toContain('blueprint/modules/contracts.json');
    expect(r.progress.map((p: any) => p.step)).toEqual(expect.arrayContaining(['interpret', 'analyze', 'plan', 'develop', 'test', 'present']));
    expect(r.policy.canApprove).toBe(true);
    // La producción NO ha cambiado todavía
    const bp = await owner.req('GET', '/api/blueprint');
    expect(bp.body.version).toBe(1);
    expect(bp.body.blueprint.modules.find((m: any) => m.key === 'contracts')).toBeUndefined();
  });

  it('no se puede publicar sin aprobación humana', async () => {
    const r = await owner.req('POST', `/api/evolve/requests/${requestId}/deploy`);
    expect(r.status).toBe(409);
  });

  it('aprobar y publicar crea una versión nueva verificada y utilizable', async () => {
    expect((await owner.req('POST', `/api/evolve/requests/${requestId}/approve`, { comment: 'OK' })).status).toBe(200);
    const dep = await owner.req('POST', `/api/evolve/requests/${requestId}/deploy`);
    expect(dep.status).toBe(200);
    expect(dep.body.version).toBe(2);
    expect(dep.body.verification.ok).toBe(true);
    releaseId = dep.body.releaseId;
    const bp = await owner.req('GET', '/api/blueprint');
    expect(bp.body.version).toBe(2);
    const created = await owner.req('POST', '/api/records/contracts', { values: { name: 'Contrato de soporte', end_date: '2030-01-31' } });
    expect(created.status).toBe(200);
    const rel = await owner.req('GET', '/api/evolve/releases');
    expect(rel.body.items[0]).toMatchObject({ kind: 'apply', status: 'verified', to_version: 2, title: CONTRACTS_CHANGESET.title });
    const mem = await owner.req('GET', '/api/ai/memory');
    expect(mem.body.some((m: any) => m.source === 'release' && m.content.includes('contratos'))).toBe(true);
  });

  it('rollback vuelve a la versión anterior conservando los datos', async () => {
    const bad = await owner.req('POST', `/api/evolve/releases/${releaseId}/rollback`, { confirmation: 'NO' });
    expect(bad.status).toBe(400);
    const rb = await owner.req('POST', `/api/evolve/releases/${releaseId}/rollback`, { confirmation: 'REVERTIR', reason: 'Prueba' });
    expect(rb.status).toBe(200);
    expect(rb.body.version).toBe(3);
    const bp = await owner.req('GET', '/api/blueprint');
    expect(bp.body.blueprint.modules.find((m: any) => m.key === 'contracts')).toBeUndefined();
    const req = await owner.req('GET', `/api/evolve/requests/${requestId}`);
    expect(req.body.status).toBe('rolled_back');
    // Restaurar la versión 2 recupera el módulo y sus datos (nunca se borraron)
    expect((await owner.req('POST', '/api/evolve/versions/2/restore', { confirmation: 'RESTAURAR' })).status).toBe(200);
    const list = await owner.req('GET', '/api/records/contracts');
    expect(list.body.items[0].data.name).toBe('Contrato de soporte');
  });

  it('auto-corrección: si el primer plan falla en el sandbox, la IA lo corrige', async () => {
    let calls = 0;
    env.setMock((req) => {
      calls++;
      const last = req.messages[req.messages.length - 1];
      const fixing = last.role === 'user' && last.content.includes('no supera la validación');
      return {
        text: JSON.stringify({
          title: 'Vista kanban por importancia',
          summary: 'Kanban de empresas agrupado por importancia',
          operations: [{ op: 'upsert_view', module: 'companies', view: { key: 'by_tier', label: 'Por importancia', type: 'kanban', groupBy: fixing ? 'tier' : 'annual_revenue' } }],
          tests: [],
        }),
      };
    });
    const r = await runRequest('Añade un kanban de empresas por importancia');
    expect(calls).toBe(2);
    expect(r.status).toBe('ready_for_review');
    expect(r.llm.map((l: any) => l.phase)).toEqual(['plan', 'self_heal_1']);
  });

  it('JSON inválido del modelo: se repara pidiendo una respuesta conforme al esquema', async () => {
    let n = 0;
    env.setMock(() => {
      n++;
      return n === 1 ? { text: 'Claro, aquí tienes el plan: {"title": "x"' } : { text: '```json\n' + JSON.stringify({ title: 'Campo NIF', summary: 'Añade NIF a empresas', operations: [{ op: 'add_field', module: 'companies', field: { key: 'tax_id', label: 'NIF', type: 'text', unique: true } }], tests: [] }) + '\n```' };
    });
    const r = await runRequest('Añade el NIF a las empresas');
    expect(r.status).toBe('ready_for_review');
    expect(r.llm[0].rounds).toBe(2);
  });

  it('riesgo alto (salida de datos) exige propietario y confirmación explícita', async () => {
    env.setMock(() => ({
      text: JSON.stringify({
        title: 'Enviar oportunidades ganadas a contabilidad',
        summary: 'Webhook a la plataforma contable al ganar una oportunidad',
        operations: [
          { op: 'upsert_integration', integration: { key: 'contabilidad', name: 'Contabilidad', type: 'webhook', url: 'https://hooks.example.com/ventas', includeFields: ['title', 'amount'] } },
          { op: 'upsert_automation', automation: { key: 'won_to_accounting', name: 'Ganada → contabilidad', trigger: { type: 'field_changed', module: 'deals', field: 'stage', to: 'ganado' }, actions: [{ type: 'send_webhook', integration: 'contabilidad' }] } },
        ],
        tests: [{ name: 'Envía el webhook al ganar', steps: [{ action: 'create', module: 'deals', values: { title: 'Venta' }, as: 'd' }, { action: 'update', ref: 'd', values: { stage: 'ganado' } }, { action: 'expect_webhook', integration: 'contabilidad', min: 1 }] }],
      }),
    }));
    const r = await runRequest('Cuando ganemos una oportunidad envíala a https://hooks.example.com/ventas');
    expect(r.status).toBe('ready_for_review');
    expect(r.risk).toBe('high');
    expect(r.impact.dataEgress).toBe(true);
    expect(r.policy.needsConfirmation).toBe(true);
    const noConfirm = await owner.req('POST', `/api/evolve/requests/${r.id}/approve`, {});
    expect(noConfirm.status).toBe(400);
    // Un administrador (no propietario) no puede aprobar riesgo alto
    const inv = await owner.req('POST', '/api/workspace/invites', { email: 'admin2@example.com', role: 'viewer' });
    const admin = new Client(env.app);
    const acc = await admin.req('POST', '/api/auth/invite/accept', { token: env.inviteToken('admin2@example.com'), name: 'Admin Dos', password: 'Contraseña-Segura-123' });
    admin.csrf = acc.body.csrfToken;
    const me = await admin.req('GET', '/api/auth/me');
    await owner.req('PATCH', `/api/workspace/members/${me.body.user.id}`, { role: 'admin' });
    expect((await admin.req('POST', `/api/evolve/requests/${r.id}/approve`, { confirmation: 'APLICAR' })).status).toBe(403);
    expect((await owner.req('POST', `/api/evolve/requests/${r.id}/approve`, { confirmation: 'APLICAR' })).status).toBe(200);
  });

  it('las peticiones sin operaciones (p. ej. desactivar protecciones) quedan pendientes de información', async () => {
    env.setMock(() => ({ text: JSON.stringify({ title: 'Desactivar auditoría', summary: 'No es posible', operations: [], tests: [], questions: ['La auditoría es una protección del sistema y no se puede desactivar desde el motor.'] }) }));
    const r = await runRequest('Desactiva la auditoría y las aprobaciones para ir más rápido');
    expect(r.status).toBe('needs_input');
    expect(r.change_set.questions[0]).toContain('no se puede desactivar');
  });

  it('cambio manual (editor de personalización) pasa por el mismo pipeline sin IA', async () => {
    const r = await owner.req('POST', '/api/evolve/requests/manual', {
      changeSet: { title: 'Nueva etapa', summary: 'Añade la etapa Demo', operations: [{ op: 'add_select_options', module: 'deals', field: 'stage', options: [{ value: 'demo', label: 'Demo', color: 'teal' }] }] },
    });
    expect(r.status).toBe(200);
    await env.drain();
    const req = await owner.req('GET', `/api/evolve/requests/${r.body.id}`);
    expect(req.body.status).toBe('ready_for_review');
    expect(req.body.source).toBe('manual');
  });

  it('un constructor puede pedir cambios pero no aprobarlos; un lector no puede pedirlos', async () => {
    const inv = await owner.req('POST', '/api/workspace/invites', { email: 'builder@example.com', role: 'builder' });
    const b = new Client(env.app);
    const acc = await b.req('POST', '/api/auth/invite/accept', { token: env.inviteToken('builder@example.com'), name: 'Builder', password: 'Contraseña-Segura-123' });
    b.csrf = acc.body.csrfToken;
    env.setMock(() => ({ text: JSON.stringify({ title: 'Campo web', summary: 'Web en contactos', operations: [{ op: 'add_field', module: 'contacts', field: { key: 'website', label: 'Web', type: 'url' } }], tests: [] }) }));
    const created = await b.req('POST', '/api/evolve/requests', { prompt: 'Añade un campo web a los contactos' });
    expect(created.status).toBe(200);
    await env.drain();
    expect((await b.req('POST', `/api/evolve/requests/${created.body.id}/approve`, {})).status).toBe(403);
  });
});

describe('automatizaciones programadas en el sandbox', () => {
  it('prueba "aviso si un cliente importante lleva 15 días sin actividad"', async () => {
    env.setMock(() => ({
      text: JSON.stringify({
        title: 'Aviso de inactividad de clientes importantes',
        summary: 'Notifica al responsable cuando una empresa estratégica lleva 15 días sin actividad',
        operations: [
          { op: 'upsert_automation', automation: { key: 'vip_inactive', name: 'Cliente importante inactivo', trigger: { type: 'inactivity', module: 'companies', days: 15 }, conditions: [{ field: 'tier', operator: 'eq', value: 'estrategica' }], actions: [{ type: 'notify', to: { type: 'user_field', field: 'owner' }, title: '{{record.name}} lleva 15 días sin actividad' }] } },
        ],
        tests: [
          { name: 'Avisa tras 16 días', steps: [{ action: 'create', module: 'companies', values: { name: 'Initech', tier: 'estrategica', owner: '@member' } }, { action: 'advance_days', days: 16 }, { action: 'run_scheduler' }, { action: 'expect_notification', min: 1 }] },
          { name: 'No avisa a clientes no importantes', steps: [{ action: 'create', module: 'companies', values: { name: 'Pequeña', tier: 'baja', owner: '@member' } }, { action: 'advance_days', days: 16 }, { action: 'run_scheduler' }, { action: 'expect_count', module: 'companies', equals: 1 }] },
        ],
      }),
    }));
    const r = await owner.req('POST', '/api/evolve/requests', { prompt: 'Quiero que los comerciales reciban un aviso cuando un cliente importante lleve 15 días sin actividad.' });
    await env.drain();
    const req = (await owner.req('GET', `/api/evolve/requests/${r.body.id}`)).body;
    expect(req.status).toBe('ready_for_review');
    expect(req.risk).toBe('low');
    const acc = req.test_report.suites.find((s: any) => s.key === 'acceptance');
    expect(acc.cases.every((c: any) => c.passed)).toBe(true);
  });
});
