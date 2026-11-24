import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';

let env: Awaited<ReturnType<typeof setup>>;
let A: Client;
let B: Client;
let aContactId: string;
let aFileId: string;
let aWorkspace: string;
let bWorkspace: string;

beforeAll(async () => {
  env = await setup();
  A = new Client(env.app);
  B = new Client(env.app);
  aWorkspace = (await A.register('Alicia', 'alicia@a.com', 'Organización A')).workspace.id;
  bWorkspace = (await B.register('Bruno', 'bruno@b.com', 'Organización B')).workspace.id;
  const c = await A.req('POST', '/api/records/contacts', { values: { name: 'Cliente secreto de A', email: 'secreto@a.com' } });
  aContactId = c.body.record.id;
  const f = await A.req('POST', '/api/files', Buffer.from('documento confidencial'), { 'content-type': 'application/octet-stream', 'x-file-name': 'secreto.txt', 'x-record-id': aContactId });
  aFileId = f.body.id;
});
afterAll(async () => env.close());

describe('aislamiento estricto entre organizaciones', () => {
  it('B no puede leer, editar ni borrar un registro de A cambiando el id en la URL', async () => {
    expect((await B.req('GET', `/api/records/contacts/${aContactId}`)).status).toBe(404);
    expect((await B.req('PATCH', `/api/records/contacts/${aContactId}`, { values: { name: 'Hackeado' } })).status).toBe(404);
    expect((await B.req('DELETE', `/api/records/contacts/${aContactId}`)).status).toBe(404);
    expect((await B.req('GET', `/api/records/contacts/${aContactId}/timeline`)).status).toBe(404);
    expect((await B.req('POST', `/api/records/contacts/${aContactId}/notes`, { body: 'intrusión' })).status).toBe(404);
    const still = await A.req('GET', `/api/records/contacts/${aContactId}`);
    expect(still.body.record.data.name).toBe('Cliente secreto de A');
  });

  it('B no ve datos de A en listados, búsqueda global ni selectores', async () => {
    const list = await B.req('GET', '/api/records/contacts');
    expect(list.body.items.find((r: any) => r.id === aContactId)).toBeUndefined();
    const search = await B.req('GET', '/api/search?q=secreto');
    expect(JSON.stringify(search.body)).not.toContain('Cliente secreto');
    const lookup = await B.req('GET', `/api/lookup/contacts?ids=${aContactId}`);
    expect(lookup.body).toEqual([]);
  });

  it('B no puede descargar archivos de A ni enlazar sus registros en relaciones', async () => {
    expect((await B.req('GET', `/api/files/${aFileId}`)).status).toBe(404);
    const rel = await B.req('POST', '/api/records/deals', { values: { title: 'Robo', company: aContactId } });
    expect(rel.status).toBe(422);
    const own = await A.req('GET', `/api/files/${aFileId}`);
    expect(own.status).toBe(200);
    expect(own.raw.body).toBe('documento confidencial');
  });

  it('B no puede asignar como usuario a un miembro de A', async () => {
    const aUser = (await A.req('GET', '/api/auth/me')).body.user.id;
    const r = await B.req('POST', '/api/records/tasks', { values: { title: 'Asignación cruzada', assignee: aUser } });
    expect(r.status).toBe(422);
  });

  it('una API key de A solo accede a A', async () => {
    const k = await A.req('POST', '/api/workspace/api-keys', { name: 'Integración', role: 'member' });
    expect(k.status).toBe(200);
    const api = new Client(env.app);
    const mine = await api.req('GET', `/api/records/contacts/${aContactId}`, undefined, { authorization: `Bearer ${k.body.key}` });
    expect(mine.status).toBe(200);
    const bContact = await B.req('POST', '/api/records/contacts', { values: { name: 'Contacto de B' } });
    const theirs = await api.req('GET', `/api/records/contacts/${bContact.body.record.id}`, undefined, { authorization: `Bearer ${k.body.key}` });
    expect(theirs.status).toBe(404);
    expect((await A.req('DELETE', `/api/workspace/api-keys/${k.body.id}`)).status).toBe(200);
    const revoked = await api.req('GET', '/api/records/contacts', undefined, { authorization: `Bearer ${k.body.key}` });
    expect(revoked.status).toBe(401);
  });

  it('cambiar de organización a una ajena está prohibido', async () => {
    expect((await B.req('POST', '/api/auth/switch-workspace', { workspaceId: aWorkspace })).status).toBe(403);
  });

  it('RLS en PostgreSQL: el contexto de B no ve filas de A aunque la consulta no filtre', async () => {
    const rows = await env.db.tenant(bWorkspace, (q) => q.query(`SELECT id FROM records`));
    expect(rows.rows.find((r: any) => r.id === aContactId)).toBeUndefined();
    const files = await env.db.tenant(bWorkspace, (q) => q.query(`SELECT id FROM files`));
    expect(files.rows).toHaveLength(0);
    const audit = await env.db.tenant(bWorkspace, (q) => q.query(`SELECT workspace_id FROM audit_log`));
    expect(audit.rows.every((r: any) => r.workspace_id === bWorkspace)).toBe(true);
    // Escritura cruzada bloqueada por la política WITH CHECK
    await expect(
      env.db.tenant(bWorkspace, (q) => q.query(`INSERT INTO records (id, workspace_id, module_key, data) VALUES (gen_random_uuid(), $1, 'contacts', '{}')`, [aWorkspace])),
    ).rejects.toThrow(/row-level security/);
    // Sin contexto de organización no se ve nada
    const users = await env.db.tenant(bWorkspace, (q) => q.query(`SELECT email FROM users`));
    expect(users.rows.map((u: any) => u.email)).toEqual(['bruno@b.com']);
  });

  it('el rol de organización no permite leer columnas sensibles de usuarios', async () => {
    await expect(env.db.tenant(bWorkspace, (q) => q.query(`SELECT password_hash FROM users`))).rejects.toThrow(/permission denied/);
  });
});
