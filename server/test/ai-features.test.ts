import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import { planningTask } from '../src/evolve/pipeline';
import { automaticFindings } from '../src/evolve/security';

/**
 * Funciones de IA sobre los datos (consultas, clasificación, documentos) y correcciones del motor:
 * cancelación durante la planificación, fallo del motor de código, secretos de webhooks y auditoría.
 */

type Env = Awaited<ReturnType<typeof setup>>;
const PASSWORD = 'Contraseña-Segura-123';

async function join(env: Env, inviter: Client, email: string, role: string, name: string) {
  const inv = await inviter.req('POST', '/api/workspace/invites', { email, role });
  if (inv.status !== 200) throw new Error(`invite ${inv.status}: ${JSON.stringify(inv.body)}`);
  const client = new Client(env.app);
  const acc = await client.req('POST', '/api/auth/invite/accept', { token: env.inviteToken(email), name, password: PASSWORD });
  client.csrf = acc.body.csrfToken;
  return { client, id: acc.body.user.id as string };
}

let env: Env;
let owner: Client;
let companyId: string;

beforeAll(async () => {
  env = await setup();
  owner = new Client(env.app);
  await owner.register('Nora', 'nora@example.com', 'Datos SL');
  companyId = (await owner.req('POST', '/api/records/companies', { values: { name: 'Initech', industry: 'tecnologia' } })).body.record.id;
  await owner.req('POST', '/api/records/deals', { values: { title: 'Licencias Initech', amount: 30000, stage: 'propuesta', company: companyId } });
  await owner.req('POST', '/api/records/deals', { values: { title: 'Soporte Initech', amount: 12000, stage: 'propuesta', company: companyId } });
  await owner.req('POST', '/api/records/deals', { values: { title: 'Formación', amount: 5000, stage: 'nuevo' } });
});
afterAll(async () => env.close());

describe('consultas en lenguaje natural (tarea sql_generation)', () => {
  it('convierte la pregunta en una consulta estructurada, la valida y la ejecuta con los datos reales', async () => {
    let seen = '';
    env.setMock((req) => {
      seen = req.messages[0].role === 'user' ? req.messages[0].content : '';
      return { text: JSON.stringify({ title: 'Importe por etapa', type: 'bar', module: 'deals', aggregate: 'sum', field: 'amount', groupBy: 'stage', filters: [], explanation: 'Suma del importe agrupada por etapa' }) };
    });
    const r = await owner.req('POST', '/api/ai/query', { question: '¿Cuánto importe hay en cada etapa?' });
    expect(r.status).toBe(200);
    expect(seen).toContain('deals (Oportunidades)');
    expect(r.body.widget).toMatchObject({ type: 'bar', module: 'deals', aggregate: 'sum', field: 'amount', groupBy: 'stage' });
    const points = Object.fromEntries(r.body.data.points.map((p: any) => [p.key, p.value]));
    expect(points).toMatchObject({ propuesta: 42000, nuevo: 5000 });
    const usage = (await env.db.query<{ task: string }>(`SELECT task FROM llm_usage ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(usage.task).toBe('sql_generation');
  });

  it('si la consulta no es válida pide una corrección; si sigue sin serlo responde 422 sin ejecutar nada', async () => {
    let calls = 0;
    env.setMock(() => {
      calls++;
      return { text: JSON.stringify({ title: 'X', type: 'metric', module: 'deals', aggregate: 'sum', field: 'title', filters: [] }) };
    });
    const r = await owner.req('POST', '/api/ai/query', { question: 'Suma de títulos' });
    expect(r.status).toBe(422);
    expect(calls).toBe(2);
  });

  it('respeta los permisos: un módulo restringido no existe para la IA y las relaciones no revelan títulos', async () => {
    const restrict = await owner.req('POST', '/api/evolve/requests/manual', { changeSet: { title: 'Restringir oportunidades', summary: 'Solo administradores', operations: [{ op: 'update_module', module: 'deals', changes: { permissions: { read: 'admin' } } }] } });
    await env.drain();
    expect((await owner.req('POST', `/api/evolve/requests/${restrict.body.id}/approve`, {})).status).toBe(200);
    expect((await owner.req('POST', `/api/evolve/requests/${restrict.body.id}/deploy`)).status).toBe(200);
    const dealId = (await owner.req('GET', '/api/records/deals')).body.items[0].id;
    await owner.req('POST', '/api/records/tasks', { values: { title: 'Revisar contrato', deal: dealId } });
    const member = await join(env, owner, 'analista@example.com', 'member', 'Analista');

    let prompt = '';
    env.setMock((req) => {
      prompt = req.messages[0].role === 'user' ? req.messages[0].content : '';
      return { text: JSON.stringify({ title: 'Importe total', type: 'metric', module: 'deals', aggregate: 'sum', field: 'amount', filters: [] }) };
    });
    expect((await member.client.req('POST', '/api/ai/query', { question: '¿Cuánto vale el pipeline?' })).status).toBe(422);
    expect(prompt).not.toContain('deals (Oportunidades)');

    env.setMock(() => ({ text: JSON.stringify({ title: 'Tareas por oportunidad', type: 'bar', module: 'tasks', aggregate: 'count', groupBy: 'deal', filters: [] }) }));
    const r = await member.client.req('POST', '/api/ai/query', { question: 'Tareas por oportunidad' });
    expect(r.status).toBe(200);
    const labels = r.body.data.points.map((p: any) => p.label);
    expect(labels).toContain('Registro restringido');
    expect(labels.join(' ')).not.toContain('Initech');
  });

  it('exige sesión de usuario (no disponible con API key)', async () => {
    const k = await owner.req('POST', '/api/workspace/api-keys', { name: 'BI', role: 'viewer' });
    const r = await new Client(env.app).req('POST', '/api/ai/query', { question: '¿Cuántos contactos hay?' }, { authorization: `Bearer ${k.body.key}` });
    expect(r.status).toBe(403);
  });
});

describe('clasificación asistida (tarea customer_classification)', () => {
  it('solo devuelve sugerencias válidas que cambian algo; nada se guarda hasta aplicarlas', async () => {
    env.setMock(() => ({
      text: JSON.stringify({
        summary: 'Cliente tecnológico con dos oportunidades abiertas',
        suggestions: [
          { field: 'tier', value: 'alta', confidence: 0.8, reason: '42.000 € en propuesta' },
          { field: 'industry', value: 'tecnologia', confidence: 0.9, reason: 'ya es tecnológica' },
          { field: 'tier', value: 'platino', confidence: 0.9, reason: 'valor inexistente' },
          { field: 'name', value: 'Otro', confidence: 0.9, reason: 'no es un campo de selección' },
          { field: 'tags', value: 'vip', confidence: 0.7, reason: 'gran cuenta' },
        ],
      }),
    }));
    const r = await owner.req('POST', `/api/records/companies/${companyId}/classify`);
    expect(r.status).toBe(200);
    expect(r.body.suggestions.map((s: any) => `${s.field}=${s.value}`)).toEqual(['tier=alta', 'tags=vip']);
    expect(r.body.suggestions.find((s: any) => s.field === 'tags').multi).toBe(true);
    const rec = await owner.req('GET', `/api/records/companies/${companyId}`);
    expect(rec.body.record.data.tier).toBe('media'); // valor por defecto: la sugerencia no se aplica sola
    const usage = (await env.db.query<{ task: string }>(`SELECT task FROM llm_usage ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(usage.task).toBe('customer_classification');
  });

  it('un lector no puede pedir clasificaciones', async () => {
    const viewer = await join(env, owner, 'lector@example.com', 'viewer', 'Lector');
    expect((await viewer.client.req('POST', `/api/records/companies/${companyId}/classify`)).status).toBe(403);
  });
});

describe('análisis de documentos (tarea document_analysis)', () => {
  it('envía el documento como adjunto (DATO) y devuelve el análisis estructurado', async () => {
    const upload = await owner.req('POST', '/api/files', Buffer.from('Contrato de soporte con Initech. Importe: 12.000 EUR. Vence el 2027-03-31. Penalización del 5% por retraso.'), {
      'content-type': 'application/octet-stream',
      'x-file-name': 'contrato.txt',
      'x-record-id': companyId,
    });
    expect(upload.status).toBe(200);
    let attachment: any = null;
    env.setMock((req) => {
      const m = req.messages[0];
      attachment = m.role === 'user' ? m.attachments?.[0] : null;
      return { text: JSON.stringify({ summary: 'Contrato de soporte anual', keyPoints: ['Penalización del 5%'], dates: [{ date: '2027-03-31', description: 'Vencimiento' }], amounts: [{ amount: 12000, currency: 'EUR', description: 'Importe' }], risks: ['Penalización por retraso'], suggestedTasks: [{ title: 'Preparar renovación', dueDate: '2027-02-28' }] }) };
    });
    const r = await owner.req('POST', `/api/files/${upload.body.id}/analyze`);
    expect(r.status).toBe(200);
    expect(attachment).toMatchObject({ kind: 'text', name: 'contrato.txt' });
    expect(attachment.data).toContain('Penalización del 5%');
    expect(r.body.analysis.dates[0].date).toBe('2027-03-31');
    expect(r.body.recordId).toBe(companyId);
    const usage = (await env.db.query<{ task: string }>(`SELECT task FROM llm_usage ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(usage.task).toBe('document_analysis');
  });

  it('rechaza formatos que no se pueden analizar', async () => {
    const png = await owner.req('POST', '/api/files', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'application/octet-stream', 'x-file-name': 'logo.png', 'x-record-id': companyId });
    expect(png.status).toBe(200);
    expect((await owner.req('POST', `/api/files/${png.body.id}/analyze`)).status).toBe(400);
  });
});

describe('EVOLVE AI ENGINE: correcciones', () => {
  it('las peticiones de automatización se planifican con el modelo de la tarea "automations"', async () => {
    expect(planningTask('Cuando una oportunidad pase a ganada, avisa al responsable')).toBe('automations');
    expect(planningTask('Recuérdame llamar a los clientes sin actividad cada lunes')).toBe('automations');
    expect(planningTask('Añade un campo NIF a las empresas')).toBe('feature_creation');
    env.setMock(() => ({ text: JSON.stringify({ title: 'Aviso', summary: 'Aviso al ganar', operations: [{ op: 'upsert_automation', automation: { key: 'won_notice', name: 'Aviso al ganar', trigger: { type: 'field_changed', module: 'tasks', field: 'status', to: 'completada' }, actions: [{ type: 'notify', to: { type: 'role', role: 'admin' }, title: 'Tarea completada' }] } }], tests: [] }) }));
    const r = await owner.req('POST', '/api/evolve/requests', { prompt: 'Cuando se complete una tarea, avisa a los administradores' });
    await env.drain();
    const usage = (await env.db.query<{ task: string }>(`SELECT task FROM llm_usage WHERE ref = $1 ORDER BY created_at LIMIT 1`, [r.body.id])).rows[0];
    expect(usage.task).toBe('automations');
  });

  it('una petición cancelada durante la planificación no se "revive"', async () => {
    let requestId = '';
    env.setMock(() => {
      // Se cancela mientras el modelo "piensa" (antes de que el pipeline continúe).
      void env.db.query(`UPDATE evolution_requests SET status = 'cancelled' WHERE id = $1`, [requestId]);
      return { text: JSON.stringify({ title: 'Campo web', summary: 'Web en empresas', operations: [{ op: 'add_field', module: 'companies', field: { key: 'web2', label: 'Web 2', type: 'url' } }], tests: [] }) };
    });
    const created = await owner.req('POST', '/api/evolve/requests', { prompt: 'Añade un segundo campo web a las empresas' });
    requestId = created.body.id;
    await env.drain();
    const r = (await owner.req('GET', `/api/evolve/requests/${requestId}`)).body;
    expect(r.status).toBe('cancelled');
    expect(r.progress.map((p: any) => p.step)).not.toContain('develop');
  });

  it('al fallar o cancelar una petición, ningún paso se queda «en curso»', async () => {
    const lastOf = (progress: any[]) => {
      const m = new Map<string, any>();
      for (const p of progress) m.set(p.step, p);
      return m;
    };
    const stillRunning = (progress: any[]) => [...lastOf(progress).values()].filter((p) => p.status === 'running');

    // Falla el proveedor mientras planifica: el paso «plan» se cierra como fallido.
    env.setMock(() => {
      throw new Error('Proveedor caído');
    });
    const failed = await owner.req('POST', '/api/evolve/requests', { prompt: 'Añade un campo de referencia a las empresas' });
    await env.drain();
    const f = (await owner.req('GET', `/api/evolve/requests/${failed.body.id}`)).body;
    expect(f.status).toBe('failed');
    expect(lastOf(f.progress).get('plan')).toMatchObject({ status: 'failed', detail: 'Interrumpido por un error' });
    expect(stillRunning(f.progress)).toEqual([]);

    // Se cancela con un paso trabajando: queda cerrado como cancelado y el trabajo pendiente no añade pasos nuevos.
    const created = await owner.req('POST', '/api/evolve/requests', { prompt: 'Añade un campo de referencia a los contactos' });
    const now = new Date().toISOString();
    await env.db.query(`UPDATE evolution_requests SET status = 'planning', progress = $2::jsonb WHERE id = $1`, [
      created.body.id,
      JSON.stringify([{ step: 'interpret', status: 'done', at: now }, { step: 'plan', status: 'running', at: now }]),
    ]);
    expect((await owner.req('POST', `/api/evolve/requests/${created.body.id}/cancel`)).status).toBe(200);
    await env.drain();
    const c = (await owner.req('GET', `/api/evolve/requests/${created.body.id}`)).body;
    expect(c.status).toBe('cancelled');
    expect(lastOf(c.progress).get('plan')).toMatchObject({ status: 'skipped', detail: 'Cancelado' });
    expect(stillRunning(c.progress)).toEqual([]);
    expect(c.progress).toHaveLength(3);
  });

  it('lo que necesita la plataforma queda registrado: nada se publica en repositorios externos', async () => {
    env.setMock(() => ({ text: JSON.stringify({ title: 'Integración ERP', summary: 'Requiere un conector nuevo', operations: [], tests: [], questions: [], requiresPlatformChange: true, platformRequest: 'Conector OAuth con el ERP' }) }));
    const req = await owner.req('POST', '/api/evolve/requests', { prompt: 'Conecta el CRM con nuestro ERP propietario' });
    await env.drain();
    const r = (await owner.req('GET', `/api/evolve/requests/${req.body.id}`)).body;
    expect(r.kind).toBe('platform');
    expect(r.status).toBe('needs_input');
    expect(r.change_set.platformRequest).toBe('Conector OAuth con el ERP');
    expect(r.codeChange).toBeUndefined();
    // El antiguo motor que creaba ramas y pull requests ya no existe
    expect((await owner.req('POST', `/api/evolve/requests/${req.body.id}/code`)).status).toBe(404);
    expect((await owner.req('GET', '/api/evolve/code/status')).status).toBe(404);
  });
});

describe('webhooks salientes y auditoría', () => {
  it('un administrador puede consultar el secreto de firma (auditado); un miembro no', async () => {
    const m = await owner.req('POST', '/api/evolve/requests/manual', { changeSet: { title: 'Webhook ERP', summary: 'Integración', operations: [{ op: 'upsert_integration', integration: { key: 'erp', name: 'ERP', type: 'webhook', url: 'https://erp.example.com/hook', includeFields: ['name'] } }] } });
    await env.drain();
    expect((await owner.req('POST', `/api/evolve/requests/${m.body.id}/approve`, { confirmation: 'APLICAR' })).status).toBe(200);
    expect((await owner.req('POST', `/api/evolve/requests/${m.body.id}/deploy`)).status).toBe(200);
    const ws = (await owner.req('GET', '/api/workspace')).body.id;
    const r = await owner.req('POST', '/api/workspace/integrations/erp/signing-secret');
    expect(r.status).toBe(200);
    expect(r.body.secret).toBe(env.deps.box.derive(`webhook:${ws}:erp`));
    expect((await owner.req('POST', '/api/workspace/integrations/nope/signing-secret')).status).toBe(404);
    const member = await join(env, owner, 'webhooks-member@example.com', 'member', 'Miembro');
    expect((await member.client.req('POST', '/api/workspace/integrations/erp/signing-secret')).status).toBe(403);
    const audit = await owner.req('GET', '/api/workspace/audit?action=integration.');
    expect(audit.body.items.some((i: any) => i.action === 'integration.signing_secret_viewed' && i.target_id === 'erp')).toBe(true);
  });

  it('las API keys no acceden a datos personales de su creador', async () => {
    const k = await owner.req('POST', '/api/workspace/api-keys', { name: 'Integración', role: 'member' });
    const bearer = { authorization: `Bearer ${k.body.key}` };
    const api = new Client(env.app);
    expect((await api.req('GET', '/api/notifications', undefined, bearer)).status).toBe(403);
    expect((await api.req('GET', '/api/assistant/conversations', undefined, bearer)).status).toBe(403);
    expect((await api.req('GET', '/api/ai/memory', undefined, bearer)).status).toBe(403);
    expect((await api.req('GET', '/api/records/companies', undefined, bearer)).status).toBe(200);
  });

  it('la revisión de seguridad detecta bloqueos de cuentas del equipo', async () => {
    const victim = await join(env, owner, 'bloqueo@example.com', 'member', 'Bloqueada');
    void victim;
    for (let i = 0; i < 10; i++) await new Client(env.app).req('POST', '/api/auth/login', { email: 'bloqueo@example.com', password: 'incorrecta-123456' });
    const ws = (await owner.req('GET', '/api/workspace')).body.id;
    const findings = await automaticFindings(env.deps, ws, { platformAdmin: false });
    expect(findings.some((f) => f.title === 'Cuentas bloqueadas por intentos fallidos')).toBe(true);
  });

  it('las versiones antiguas no exponen la estructura de módulos que el rol no puede leer', async () => {
    const viewer = await join(env, owner, 'versiones@example.com', 'viewer', 'Lectora');
    const current = (await owner.req('GET', '/api/blueprint')).body.version;
    const v = await viewer.client.req('GET', `/api/evolve/versions/${current}`);
    expect(v.status).toBe(200);
    expect(v.body.blueprint.modules.map((m: any) => m.key)).not.toContain('deals');
    const asOwner = await owner.req('GET', `/api/evolve/versions/${current}`);
    expect(asOwner.body.blueprint.modules.map((m: any) => m.key)).toContain('deals');
  });
});
