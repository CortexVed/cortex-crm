import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';

let env: Awaited<ReturnType<typeof setup>>;
let c: Client;
let userId: string;

beforeAll(async () => {
  env = await setup();
  c = new Client(env.app);
  userId = (await c.register('Marta', 'marta@example.com', 'Ventas SL')).user.id;
});
afterAll(async () => env.close());

describe('CRM: registros, relaciones y automatizaciones', () => {
  let companyId: string;
  let dealId: string;

  it('crea empresa y contacto relacionados y resuelve referencias', async () => {
    const co = await c.req('POST', '/api/records/companies', { values: { name: 'Globex', tier: 'estrategica', owner: userId } });
    expect(co.status).toBe(200);
    companyId = co.body.record.id;
    expect(co.body.record.data.status).toBe('prospecto'); // valor por defecto
    const ct = await c.req('POST', '/api/records/contacts', { values: { name: 'Homer Simpson', email: 'homer@globex.com', company: companyId, tags: ['vip'] } });
    expect(ct.status).toBe(200);
    expect(ct.body.refs.records[companyId].title).toBe('Globex');
  });

  it('valida unicidad, tipos y relaciones', async () => {
    const dup = await c.req('POST', '/api/records/contacts', { values: { name: 'Otro', email: 'HOMER@globex.com' } });
    expect(dup.status).toBe(422);
    const badType = await c.req('POST', '/api/records/deals', { values: { title: 'X', amount: 'mucho' } });
    expect(badType.status).toBe(422);
    const badRel = await c.req('POST', '/api/records/deals', { values: { title: 'X', company: '00000000-0000-4000-8000-000000000000' } });
    expect(badRel.status).toBe(422);
  });

  it('calcula fórmulas y ejecuta automatizaciones (ganada → probabilidad 100)', async () => {
    const d = await c.req('POST', '/api/records/deals', { values: { title: 'Contrato Globex', amount: 20000, probability: 25, company: companyId, owner: userId } });
    expect(d.status).toBe(200);
    dealId = d.body.record.id;
    expect(d.body.record.data.weighted_amount).toBe(5000);
    const won = await c.req('PATCH', `/api/records/deals/${dealId}`, { values: { stage: 'ganado' } });
    expect(won.body.record.data.probability).toBe(100);
    expect(won.body.record.data.weighted_amount).toBe(20000);
  });

  it('ficha con relaciones inversas, historial y notas', async () => {
    await c.req('POST', `/api/records/companies/${companyId}/notes`, { body: 'Reunión de seguimiento muy positiva' });
    const detail = await c.req('GET', `/api/records/companies/${companyId}`);
    const deals = detail.body.related.find((r: any) => r.module === 'deals');
    expect(deals.total).toBe(1);
    const contacts = detail.body.related.find((r: any) => r.module === 'contacts');
    expect(contacts.total).toBe(1);
    const tl = await c.req('GET', `/api/records/deals/${dealId}/timeline`);
    const kinds = tl.body.items.map((i: any) => i.kind);
    expect(kinds).toContain('history');
    expect(kinds).toContain('automation');
    const companyTl = await c.req('GET', `/api/records/companies/${companyId}/timeline`);
    expect(companyTl.body.items.some((i: any) => i.kind === 'note')).toBe(true);
  });

  it('listados con búsqueda, filtros, orden y vistas', async () => {
    await c.req('POST', '/api/records/deals', { values: { title: 'Pequeña venta', amount: 500 } });
    const search = await c.req('GET', '/api/records/deals?search=globex');
    expect(search.body.total).toBe(1);
    const filters = encodeURIComponent(JSON.stringify([{ field: 'amount', operator: 'gte', value: 1000 }]));
    const filtered = await c.req('GET', `/api/records/deals?filters=${filters}`);
    expect(filtered.body.items.map((i: any) => i.data.title)).toEqual(['Contrato Globex']);
    const sorted = await c.req('GET', '/api/records/deals?sort=amount&dir=asc');
    expect(sorted.body.items[0].data.title).toBe('Pequeña venta');
    const view = await c.req('GET', '/api/records/tasks?view=open');
    expect(view.status).toBe(200);
    const bad = await c.req('GET', `/api/records/deals?filters=${encodeURIComponent(JSON.stringify([{ field: 'no_existe', operator: 'eq', value: 1 }]))}`);
    expect(bad.status).toBe(400);
  });

  it('archivos: sube, lista, descarga y rechaza tipos peligrosos', async () => {
    const up = await c.req('POST', '/api/files', Buffer.from('%PDF-1.4 test'), { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Contrato firmado.pdf'), 'x-record-id': dealId });
    expect(up.status).toBe(200);
    const list = await c.req('GET', `/api/records/deals/${dealId}/files`);
    expect(list.body[0].name).toBe('Contrato firmado.pdf');
    const dl = await c.req('GET', `/api/files/${up.body.id}`);
    expect(dl.headers['content-disposition']).toContain('attachment');
    const html = await c.req('POST', '/api/files', Buffer.from('<script>alert(1)</script>'), { 'content-type': 'application/octet-stream', 'x-file-name': 'xss.html' });
    expect(html.status).toBe(400);
  });

  it('borrado con control: soft delete auditado y restauración por administradores', async () => {
    const t = await c.req('POST', '/api/records/tasks', { values: { title: 'Temporal' } });
    expect((await c.req('DELETE', `/api/records/tasks/${t.body.record.id}`)).status).toBe(200);
    expect((await c.req('GET', `/api/records/tasks/${t.body.record.id}`)).status).toBe(404);
    expect((await c.req('POST', `/api/records/tasks/${t.body.record.id}/restore`)).status).toBe(200);
    expect((await c.req('GET', `/api/records/tasks/${t.body.record.id}`)).status).toBe(200);
    const audit = await c.req('GET', '/api/workspace/audit?action=record.');
    expect(audit.body.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(['record.deleted', 'record.restored']));
  });

  it('panel e informes con datos reales', async () => {
    const dash = await c.req('GET', '/api/dashboards/main/data');
    expect(dash.status).toBe(200);
    expect(dash.body.data.contacts_total).toMatchObject({ type: 'metric', value: 1 });
    expect(dash.body.data.pipeline_by_stage.type).toBe('bar');
    expect(dash.body.data.new_contacts.points).toHaveLength(12);
    for (const type of ['sales', 'conversion', 'activity', 'performance', 'customers']) {
      const r = await c.req('GET', `/api/reports/${type}`);
      expect(r.status, type).toBe(200);
      expect(r.body.available, type).toBe(true);
    }
    const sales = await c.req('GET', '/api/reports/sales');
    expect(sales.body.kpis[0].value).toBe(20000);
  });

  it('automatizaciones programadas en BD real: recordatorio de tarea, sin duplicados', async () => {
    const reminder = new Date(Date.now() - 3_600_000).toISOString();
    const t = await c.req('POST', '/api/records/tasks', { values: { title: 'Llamar a Globex', reminder_at: reminder, assignee: userId } });
    expect(t.status).toBe(200);
    const { runScheduledAutomations } = await import('../src/crm/automations');
    const { loadWorkspace, makeRecordService } = await import('../src/crm/context');
    const ws = (await c.req('GET', '/api/auth/me')).body.workspace.id;
    for (let i = 0; i < 2; i++) {
      await env.db.tenant(ws, async (q) => runScheduledAutomations(makeRecordService(q, await loadWorkspace(q, ws), { type: 'system', id: null })));
    }
    const notes = await c.req('GET', '/api/notifications');
    const reminders = notes.body.items.filter((n: any) => n.title === 'Recordatorio: Llamar a Globex');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].link).toBe(`/m/tasks/${t.body.record.id}`);
  });

  it('búsqueda global', async () => {
    const r = await c.req('GET', '/api/search?q=homer');
    expect(r.body.groups[0].module).toBe('contacts');
  });
});
