import http from 'node:http';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup } from './helpers';
import { loadConfig } from '../src/config';
import { createJobHandlers } from '../src/worker';
import { objectUrl, signV4, uriEncode } from '../src/lib/object-storage';

/**
 * Archivos adjuntos en un bucket compatible con S3 (el bucket de la plantilla de Railway). La firma se valida con
 * el ejemplo oficial de AWS; el resto, contra un S3 simulado que comprueba la firma de cada petición.
 */

const AKID = 'cortex-test-access-key';
const SECRET = 'test-secret-key-for-the-fake-s3-server-123456';
const BUCKET = 'cortex-files-test';

/** S3 mínimo (estilo path): guarda objetos en memoria y rechaza toda petición mal firmada. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const log: { method: string; path: string }[] = [];
  let failNext: number | null = null;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    log.push({ method: req.method ?? '', path: url.pathname });
    const deny = (status: number, code: string) => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
    };
    if (failNext) {
      const s = failNext;
      failNext = null;
      return deny(s, 'InternalError');
    }
    // Firma: se recalcula con lo recibido (la exactitud del firmante la garantiza el vector oficial de AWS).
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(String(req.headers.authorization ?? ''));
    if (!m || m[1] !== AKID) return deny(403, 'InvalidAccessKeyId');
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    const signedNames = m[4].split(';');
    const extra: Record<string, string> = {};
    for (const n of signedNames) if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(n)) extra[n] = String(req.headers[n] ?? '');
    const date = new Date(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const expected = signV4({ method: req.method ?? '', url, headers: extra, payloadHash, accessKeyId: AKID, secretAccessKey: SECRET, region: m[3], date }).authorization;
    if (expected !== req.headers.authorization) return deny(403, 'SignatureDoesNotMatch');
    if (req.method === 'PUT' && crypto.createHash('sha256').update(body).digest('hex') !== payloadHash) return deny(400, 'XAmzContentSHA256Mismatch');
    const [, bucket, ...rest] = url.pathname.split('/');
    if (bucket !== BUCKET) return deny(404, 'NoSuchBucket');
    const key = decodeURIComponent(rest.join('/'));
    if (req.method === 'PUT') {
      objects.set(key, { body, type: String(req.headers['content-type'] ?? '') });
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'GET') {
      const o = objects.get(key);
      if (!o) return deny(404, 'NoSuchKey');
      res.writeHead(200, { 'content-type': o.type });
      return res.end(o.body);
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    deny(405, 'MethodNotAllowed');
  });
  return {
    objects,
    log,
    failOnce: (status: number) => {
      failNext = status;
    },
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('firma AWS Signature V4', () => {
  it('coincide con el ejemplo oficial de AWS (GET Object con Range)', () => {
    const headers = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('URL del objeto en estilo virtual-host (Railway) y path, con la clave codificada', () => {
    expect(objectUrl({ endpoint: 'https://t3.storageapi.dev', bucket: 'bucket-abc', pathStyle: false }, 'files/ws/1').href).toBe('https://bucket-abc.t3.storageapi.dev/files/ws/1');
    expect(objectUrl({ endpoint: 'http://127.0.0.1:9000', bucket: 'b-1', pathStyle: true }, 'files/a b/ñ').href).toBe('http://127.0.0.1:9000/b-1/files/a%20b/%C3%B1');
    expect(uriEncode('a/b c+d~', true)).toBe('a/b%20c%2Bd~');
  });
});

describe('configuración del bucket', () => {
  const base = { NODE_ENV: 'test' };
  it('sin variables, los archivos van a PostgreSQL; con las de la plantilla, al bucket', () => {
    expect(loadConfig(base).objectStorage).toBeNull();
    const c = loadConfig(base, { S3_ENDPOINT: 'https://t3.storageapi.dev', S3_BUCKET: 'bucket-abc', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }).objectStorage;
    expect(c).toEqual({ endpoint: 'https://t3.storageapi.dev', bucket: 'bucket-abc', accessKeyId: 'k', secretAccessKey: 's', region: 'auto', pathStyle: false });
    // El endpoint sin protocolo se toma como https.
    expect(loadConfig(base, { S3_ENDPOINT: 't3.storageapi.dev', S3_BUCKET: 'bucket-abc', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }).objectStorage?.endpoint).toBe('https://t3.storageapi.dev');
  });

  it('a medias no arranca (no guarda los archivos en silencio en otro sitio)', () => {
    expect(() => loadConfig(base, { S3_BUCKET: 'bucket-abc' })).toThrow(/S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY/);
    expect(() => loadConfig(base, { AWS_S3_BUCKET_NAME: 'bucket-abc', AWS_ACCESS_KEY_ID: 'k' })).toThrow(/AWS_ENDPOINT_URL/);
    expect(() => loadConfig(base, { S3_ENDPOINT: 'https://x.dev', S3_BUCKET: 'Mal_Nombre', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })).toThrow(/nombre de bucket/);
  });

  it('unas credenciales de AWS para otra cosa no activan el bucket; http solo en local y fuera de producción', () => {
    expect(loadConfig(base, { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' }).objectStorage).toBeNull();
    expect(loadConfig(base, { AWS_ENDPOINT_URL: 'https://s3.example.com', AWS_S3_BUCKET_NAME: 'b-1', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_DEFAULT_REGION: 'eu-west-1' }).objectStorage?.region).toBe('eu-west-1');
    expect(() => loadConfig(base, { S3_ENDPOINT: 'http://s3.example.com', S3_BUCKET: 'b-1', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })).toThrow(/https/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', APP_ENCRYPTION_KEY: 'a'.repeat(10) + 'bcdefghijklmnopqrstuvwxyz0123456789', APP_URL: 'https://crm.example.com' }, { S3_ENDPOINT: 'http://127.0.0.1:9000', S3_BUCKET: 'b-1', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }),
    ).toThrow(/https/);
  });
});

describe('archivos en el bucket', () => {
  const s3 = fakeS3();
  let env: Awaited<ReturnType<typeof setup>>;
  let c: Client;
  let companyId: string;
  let workspaceId: string;
  beforeAll(async () => {
    const endpoint = await s3.start();
    env = await setup({ env: { S3_ENDPOINT: endpoint, S3_BUCKET: BUCKET, S3_ACCESS_KEY_ID: AKID, S3_SECRET_ACCESS_KEY: SECRET, S3_FORCE_PATH_STYLE: 'true' } });
    c = new Client(env.app);
    const reg = await c.register('Bea', 'bea@example.com', 'Bucket SL');
    workspaceId = reg.workspace.id;
    companyId = (await c.req('POST', '/api/records/companies', { values: { name: 'Initech' } })).body.record.id;
  });
  afterAll(async () => {
    await env.close();
    await s3.stop();
  });

  it('sube el archivo al bucket (firmado) y la base de datos solo guarda la referencia', async () => {
    const content = Buffer.from('Contrato de soporte con Initech. Importe: 12.000 EUR.');
    const up = await c.req('POST', '/api/files', content, { 'content-type': 'application/octet-stream', 'x-file-name': 'contrato.txt', 'x-record-id': companyId });
    expect(up.status).toBe(200);
    const row = (await env.db.query(`SELECT storage, object_key, size, octet_length(content) AS stored FROM files WHERE id = $1`, [up.body.id])).rows[0];
    expect(row).toMatchObject({ storage: 's3', object_key: `files/${workspaceId}/${up.body.id}`, size: content.length, stored: 0 });
    const obj = s3.objects.get(row.object_key);
    expect(obj?.body.equals(content)).toBe(true);
    expect(obj?.type).toBe('text/plain');

    // Descarga a través de la aplicación (con permisos), nunca con una URL del bucket.
    const down = await c.req('GET', `/api/files/${up.body.id}`);
    expect(down.status).toBe(200);
    expect(down.raw.rawPayload.equals(content)).toBe(true);
    expect(down.headers['content-disposition']).toContain("filename*=UTF-8''contrato.txt");
  });

  it('el análisis con IA lee el documento del bucket', async () => {
    const up = await c.req('POST', '/api/files', Buffer.from('Vence el 2027-03-31. Penalización del 5% por retraso.'), { 'content-type': 'application/octet-stream', 'x-file-name': 'clausulas.txt', 'x-record-id': companyId });
    let attachment: any = null;
    env.setMock((req) => {
      const m = req.messages[0];
      attachment = m.role === 'user' ? m.attachments?.[0] : null;
      return { text: JSON.stringify({ summary: 'Cláusulas', keyPoints: [], dates: [{ date: '2027-03-31', description: 'Vencimiento' }], amounts: [], risks: [], suggestedTasks: [] }) };
    });
    const r = await c.req('POST', `/api/files/${up.body.id}/analyze`);
    expect(r.status).toBe(200);
    expect(attachment.data).toContain('Penalización del 5%');
  });

  it('los archivos guardados antes en la base de datos se siguen descargando', async () => {
    const id = crypto.randomUUID();
    await env.db.query(`INSERT INTO files (id, workspace_id, record_id, module_key, name, mime, size, sha256, content, uploaded_by) SELECT $1, $2, $3, 'companies', 'antiguo.txt', 'text/plain', 7, 'x', $4, id FROM users WHERE email = 'bea@example.com'`, [id, workspaceId, companyId, Buffer.from('antiguo')]);
    const down = await c.req('GET', `/api/files/${id}`);
    expect(down.status).toBe(200);
    expect(down.raw.rawPayload.toString()).toBe('antiguo');
  });

  it('si el bucket falla al subir, responde 502 y no queda ningún archivo a medias', async () => {
    const before = Number((await env.db.query(`SELECT count(*)::int AS n FROM files`)).rows[0].n);
    s3.failOnce(500);
    const up = await c.req('POST', '/api/files', Buffer.from('no llegará'), { 'content-type': 'application/octet-stream', 'x-file-name': 'fallo.txt' });
    expect(up.status).toBe(502);
    expect(up.body.error.code).toBe('storage_unavailable');
    expect(Number((await env.db.query(`SELECT count(*)::int AS n FROM files`)).rows[0].n)).toBe(before);
  });

  it('borrado: pasados 7 días, el mantenimiento elimina el objeto del bucket', async () => {
    const up = await c.req('POST', '/api/files', Buffer.from('temporal'), { 'content-type': 'application/octet-stream', 'x-file-name': 'temporal.txt', 'x-record-id': companyId });
    const key = `files/${workspaceId}/${up.body.id}`;
    expect(s3.objects.has(key)).toBe(true);
    expect((await c.req('DELETE', `/api/files/${up.body.id}`)).status).toBe(200);
    expect((await c.req('GET', `/api/files/${up.body.id}`)).status).toBe(404);
    // Recién borrado se conserva (7 días); después, el mantenimiento borra el objeto y lo marca como purgado.
    await env.db.query(`UPDATE files SET deleted_at = now() - interval '8 days' WHERE id = $1`, [up.body.id]);
    await createJobHandlers(env.deps)['maintenance.cleanup']({} as any, { signal: new AbortController().signal } as any);
    expect(s3.objects.has(key)).toBe(false);
    expect((await env.db.query(`SELECT size FROM files WHERE id = $1`, [up.body.id])).rows[0].size).toBe(0);
  });

  it('sin el bucket configurado, un archivo del bucket da un error claro (no un archivo vacío)', async () => {
    const plain = await setup();
    const u = new Client(plain.app);
    const reg = await u.register('Sin Bucket', 'sinbucket@example.com', 'Sin Bucket SL');
    const id = crypto.randomUUID();
    await plain.db.query(`INSERT INTO files (id, workspace_id, name, mime, size, sha256, content, storage, object_key, uploaded_by) SELECT $1, $2, 'b.txt', 'text/plain', 3, 'x', ''::bytea, 's3', 'files/x/y', id FROM users WHERE email = 'sinbucket@example.com'`, [id, reg.workspace.id]);
    const down = await u.req('GET', `/api/files/${id}`);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('storage_not_configured');
    await plain.close();
  });
});
