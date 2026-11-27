import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasRole } from '../../../shared/constants';
import { ConditionSchema, SYSTEM_QUERY_FIELDS, activeModules, findModule, type Module } from '../../../shared/blueprint';
import { isUuid, recordTitle } from '../../../shared/records';
import type { AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { newId, sha256 } from '../lib/crypto';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../lib/errors';
import { fileObjectKey, ObjectStorageError } from '../lib/object-storage';
import { requireUserSession, requireWorkspace, type WorkspaceAuth } from '../auth/plugin';
import type { Attachment, ChatMessage } from '../ai/types';
import {
  AiQuerySchema,
  classifySystem,
  ClassifySchema,
  classifiableFields,
  describeModules,
  documentSystem,
  DocumentAnalysisSchema,
  MAX_DOCUMENT_CHARS,
  MAX_PDF_BYTES,
  querySystem,
  readableModules,
  sanitizeSuggestions,
  TEXT_MIMES,
  toWidget,
} from './ai-features';
import type { Queryable } from '../db/db';
import { loadWorkspace, makeRecordService, type LoadedWorkspace } from './context';
import { resolveRefs, serializeRecord } from './refs';
import { blueprintForRole } from './visibility';
import { computeWidget } from './dashboards';
import { buildReport, pipelineSnapshot, REPORT_TYPES } from './reports';
import type { Actor } from './record-service';
import { inSentence, msg, promptLanguage, t } from '../i18n';

const ALLOWED_FILES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  zip: 'application/zip',
};
const INLINE_OK = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const WORKSPACE_QUOTA_BYTES = 1024 * 1024 * 1024;

export function actorFrom(a: WorkspaceAuth): Actor {
  return a.apiKeyId ? { type: 'api', id: null, role: a.role } : { type: 'user', id: a.userId, role: a.role };
}

export async function crmRoutes(app: FastifyInstance, deps: AppDeps) {
  const withWs = <T>(req: FastifyRequest, minRole: 'viewer' | 'member' | 'builder' | 'admin' | 'owner', fn: (q: Queryable, ws: LoadedWorkspace, a: WorkspaceAuth) => Promise<T>) => {
    const a = requireWorkspace(req, minRole);
    return deps.db.tenant(a.workspaceId, async (q) => fn(q, await loadWorkspace(q, a.workspaceId), a));
  };
  const readable = (ws: LoadedWorkspace, a: WorkspaceAuth) => activeModules(ws.blueprint).filter((m) => hasRole(a.role, m.permissions.read));
  const canReadFor = (ws: LoadedWorkspace, a: WorkspaceAuth) => (moduleKey: string) => {
    const m = findModule(ws.blueprint, moduleKey);
    return !!m && hasRole(a.role, m.permissions.read);
  };
  /** Los informes agregan datos de varios módulos: exigen permiso de lectura sobre todos ellos. */
  const REPORT_MODULES: Record<string, string[]> = {
    sales: ['deals'],
    conversion: ['deals', 'contacts'],
    activity: ['activities', 'tasks'],
    performance: ['deals', 'activities', 'tasks'],
    customers: ['contacts', 'companies'],
  };
  const assertReportAccess = (ws: LoadedWorkspace, a: WorkspaceAuth, type: string) => {
    const blocked = (REPORT_MODULES[type] ?? []).filter((k) => findModule(ws.blueprint, k) && !canReadFor(ws, a)(k));
    if (blocked.length) throw forbidden('Tu rol no tiene acceso a los datos que usa este informe');
  };
  const moduleFor = (ws: LoadedWorkspace, a: WorkspaceAuth, key: string): Module => {
    const m = findModule(ws.blueprint, key);
    if (!m || m.archived) throw notFound(t('Módulo "{key}" no encontrado', { key }));
    if (!hasRole(a.role, m.permissions.read)) throw forbidden(t('No tienes acceso a {module}', { module: m.labelPlural }));
    return m;
  };

  /**
   * Acceso a un archivo: si está vinculado a un módulo, lo decide el permiso de lectura de ese módulo; si
   * aún no está vinculado (subido en un alta que no se guardó), solo puede verlo quien lo subió.
   */
  const assertFileAccess = (ws: LoadedWorkspace, a: WorkspaceAuth, f: { module_key: string | null; uploaded_by: string | null }) => {
    if (f.module_key) moduleFor(ws, a, f.module_key);
    else if (a.apiKeyId || f.uploaded_by !== a.userId) throw notFound('Archivo no encontrado');
  };

  /**
   * Contenido de un archivo, esté en la base de datos (`storage = 'db'`, los de siempre) o en el bucket S3. Se llama
   * fuera de la transacción (la descarga del bucket no retiene una conexión de la base de datos).
   */
  const readFileContent = async (f: { storage?: string | null; object_key?: string | null; content?: Buffer | Uint8Array | null }): Promise<Buffer> => {
    if (f.storage !== 's3') return Buffer.from(f.content ?? []);
    if (!deps.storage || !f.object_key) {
      throw new AppError(503, 'storage_not_configured', 'Este archivo está guardado en el bucket de archivos, pero la instalación no tiene configurado el bucket (variables S3_*).');
    }
    try {
      return await deps.storage.get(f.object_key);
    } catch (e) {
      throw new AppError(502, 'storage_unavailable', t('No se ha podido leer el archivo. {reason}', { reason: e instanceof ObjectStorageError ? e.message : t('El almacenamiento de archivos no responde.') }));
    }
  };

  app.get('/blueprint', async (req) =>
    withWs(req, 'viewer', async (_q, ws, a) => ({
      version: ws.version,
      settings: ws.settings,
      blueprint: blueprintForRole(ws.blueprint, a.role),
    })),
  );

  app.get('/records/:module', async (req) => {
    const { module } = z.object({ module: z.string().max(40) }).parse(req.params);
    const qp = z
      .object({
        view: z.string().max(40).optional(),
        search: z.string().max(200).optional(),
        filters: z.string().max(2000).optional(),
        sort: z.string().max(60).optional(),
        dir: z.enum(['asc', 'desc']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
      })
      .parse(req.query);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const mod = moduleFor(ws, a, module);
      const view = qp.view ? mod.views.find((v) => v.key === qp.view) : undefined;
      let extra: z.infer<typeof ConditionSchema>[] = [];
      if (qp.filters) {
        try {
          extra = z.array(ConditionSchema).max(20).parse(JSON.parse(qp.filters));
        } catch {
          throw badRequest('Filtros inválidos');
        }
      }
      const known = (f: string) => (SYSTEM_QUERY_FIELDS as readonly string[]).includes(f) || mod.fields.some((x) => x.key === f);
      if (extra.some((c) => !known(c.field))) throw badRequest('Filtro sobre un campo desconocido');
      if (qp.sort && !known(qp.sort)) throw badRequest('Orden sobre un campo desconocido');
      const svc = makeRecordService(q, ws, actorFrom(a));
      const sort = qp.sort ? { field: qp.sort, direction: qp.dir ?? 'asc' } : view?.sort;
      const { items, total } = await svc.ctx.store.list(
        mod,
        { search: qp.search, filters: [...(view?.filters ?? []), ...extra], sort, limit: qp.pageSize, offset: (qp.page - 1) * qp.pageSize },
        { now: deps.now(), tz: ws.settings.timezone },
      );
      return { items: items.map(serializeRecord), total, page: qp.page, pageSize: qp.pageSize, refs: await resolveRefs(q, ws.id, ws.blueprint, items, canReadFor(ws, a)) };
    });
  });

  app.post('/records/:module', async (req) => {
    const { module } = z.object({ module: z.string().max(40) }).parse(req.params);
    const { values } = z.object({ values: z.record(z.string(), z.unknown()) }).parse(req.body);
    return withWs(req, 'viewer', async (q, ws, a) => {
      moduleFor(ws, a, module);
      const rec = await makeRecordService(q, ws, actorFrom(a), deps.now).create(module, values);
      return { record: serializeRecord(rec), refs: await resolveRefs(q, ws.id, ws.blueprint, [rec], canReadFor(ws, a)) };
    });
  });

  app.get('/records/:module/:id', async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const mod = moduleFor(ws, a, module);
      const svc = makeRecordService(q, ws, actorFrom(a));
      const rec = await svc.ctx.store.get(id);
      if (!rec || rec.moduleKey !== mod.key) throw notFound('Registro no encontrado');
      const related: unknown[] = [];
      const relatedItems = [];
      for (const m of readable(ws, a)) {
        for (const f of m.fields) {
          if (f.type !== 'relation' || f.archived || f.relation?.module !== mod.key) continue;
          const { items, total } = await svc.ctx.store.list(m, { filters: [{ field: f.key, operator: 'eq', value: id }], limit: 8, offset: 0, sort: { field: 'created_at', direction: 'desc' } }, { now: deps.now(), tz: ws.settings.timezone });
          relatedItems.push(...items);
          related.push({ module: m.key, label: m.labelPlural, icon: m.icon, field: f.key, fieldLabel: f.label, total, items: items.map(serializeRecord) });
        }
      }
      return { record: serializeRecord(rec), related, refs: await resolveRefs(q, ws.id, ws.blueprint, [rec, ...relatedItems], canReadFor(ws, a)) };
    });
  });

  app.patch('/records/:module/:id', async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    const { values } = z.object({ values: z.record(z.string(), z.unknown()) }).parse(req.body);
    return withWs(req, 'viewer', async (q, ws, a) => {
      moduleFor(ws, a, module);
      const rec = await makeRecordService(q, ws, actorFrom(a), deps.now).update(id, values, module);
      return { record: serializeRecord(rec), refs: await resolveRefs(q, ws.id, ws.blueprint, [rec], canReadFor(ws, a)) };
    });
  });

  app.delete('/records/:module/:id', async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const mod = moduleFor(ws, a, module);
      await makeRecordService(q, ws, actorFrom(a), deps.now).delete(id, module);
      await audit(q, { workspaceId: ws.id, actorId: a.apiKeyId ? null : a.userId, actorType: a.apiKeyId ? 'api' : 'user', action: 'record.deleted', targetType: mod.key, targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  app.post('/records/:module/:id/restore', async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    return withWs(req, 'admin', async (q, ws, a) => {
      moduleFor(ws, a, module);
      const r = await q.query(`UPDATE records SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND workspace_id = $2 AND module_key = $3 AND deleted_at IS NOT NULL`, [id, ws.id, module]);
      if (!r.rowCount) throw notFound('No hay un registro eliminado con ese id');
      await q.query(`INSERT INTO record_history (id, workspace_id, record_id, module_key, action, actor_id, actor_type) VALUES ($1,$2,$3,$4,'restore',$5,'user')`, [newId(), ws.id, id, module, a.userId]);
      await audit(q, { workspaceId: ws.id, actorId: a.userId, action: 'record.restored', targetType: module, targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  app.get('/records/:module/:id/timeline', async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const mod = moduleFor(ws, a, module);
      const exists = await q.query(`SELECT 1 FROM records WHERE id = $1 AND workspace_id = $2 AND module_key = $3`, [id, ws.id, mod.key]);
      if (!exists.rows.length) throw notFound('Registro no encontrado');
      const [history, notes, messages, runs] = await Promise.all([
        q.query(`SELECT h.id, h.action, h.changes, h.actor_type, h.created_at, u.name AS actor_name FROM record_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.workspace_id = $1 AND h.record_id = $2 ORDER BY h.created_at DESC LIMIT 100`, [ws.id, id]),
        q.query(`SELECT n.id, n.body, n.created_at, n.created_by, u.name AS actor_name FROM notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.workspace_id = $1 AND n.record_id = $2 AND n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 100`, [ws.id, id]),
        q.query(`SELECT id, channel, direction, body, from_address, to_address, status, created_at FROM channel_messages WHERE workspace_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT 100`, [ws.id, id]),
        q.query(`SELECT id, automation_key, trigger, status, log, created_at FROM automation_runs WHERE workspace_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT 50`, [ws.id, id]),
      ]);
      const items = [
        ...history.rows.map((h: any) => ({ kind: 'history', id: h.id, at: h.created_at, action: h.action, changes: h.changes, actor: h.actor_name ?? (h.actor_type === 'automation' ? t('Automatización') : h.actor_type === 'api' ? 'API' : t('Sistema')), actorType: h.actor_type })),
        ...notes.rows.map((n: any) => ({ kind: 'note', id: n.id, at: n.created_at, body: n.body, actor: n.actor_name ?? t('Usuario'), mine: n.created_by === a.userId })),
        ...messages.rows.map((m: any) => ({ kind: 'message', id: m.id, at: m.created_at, channel: m.channel, direction: m.direction, body: m.body, from: m.from_address, to: m.to_address, status: m.status })),
        ...runs.rows.map((r: any) => ({ kind: 'automation', id: r.id, at: r.created_at, automation: ws.blueprint.automations.find((x) => x.key === r.automation_key)?.name ?? r.automation_key, status: r.status, log: r.log })),
      ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
      return { items };
    });
  });

  app.post('/records/:module/:id/notes', async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(10_000) }).parse(req.body);
    return withWs(req, 'member', async (q, ws, a) => {
      const mod = moduleFor(ws, a, module);
      // Añadir notas modifica la ficha (y su última actividad): exige permiso de edición del módulo.
      if (!hasRole(a.role, mod.permissions.update)) throw forbidden(t('Tu rol no puede editar {module}', { module: inSentence(mod.labelPlural) }));
      const exists = await q.query(`SELECT 1 FROM records WHERE id = $1 AND workspace_id = $2 AND module_key = $3 AND deleted_at IS NULL`, [id, ws.id, mod.key]);
      if (!exists.rows.length) throw notFound('Registro no encontrado');
      const noteId = newId();
      await q.query(`INSERT INTO notes (id, workspace_id, record_id, body, created_by) VALUES ($1,$2,$3,$4,$5)`, [noteId, ws.id, id, body, a.apiKeyId ? null : a.userId]);
      await q.query(`UPDATE records SET last_activity_at = now() WHERE id = $1 AND workspace_id = $2`, [id, ws.id]);
      return { id: noteId };
    });
  });

  app.delete('/notes/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withWs(req, 'member', async (q, ws, a) => {
      const n = (await q.query(`SELECT created_by FROM notes WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [id, ws.id])).rows[0];
      if (!n) throw notFound('Nota no encontrada');
      if (n.created_by !== a.userId && !hasRole(a.role, 'admin')) throw forbidden('Solo puedes eliminar tus propias notas');
      await q.query(`UPDATE notes SET deleted_at = now() WHERE id = $1 AND workspace_id = $2`, [id, ws.id]);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- archivos

  app.get('/records/:module/:id/files', async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const mod = moduleFor(ws, a, module);
      // El registro debe pertenecer al módulo autorizado (evita listar archivos de módulos restringidos).
      const r = await q.query(
        `SELECT f.id, f.name, f.mime, f.size, f.field_key, f.created_at, u.name AS uploaded_by FROM files f
         JOIN records rec ON rec.id = f.record_id AND rec.workspace_id = f.workspace_id AND rec.module_key = $3
         LEFT JOIN users u ON u.id = f.uploaded_by
         WHERE f.workspace_id = $1 AND f.record_id = $2 AND f.deleted_at IS NULL ORDER BY f.created_at DESC`,
        [ws.id, id, mod.key],
      );
      return r.rows;
    });
  });

  app.post('/files', { bodyLimit: deps.config.maxUploadBytes + 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Envía el archivo como application/octet-stream');
    if (body.length > deps.config.maxUploadBytes) throw badRequest(t('El archivo supera el máximo de {mb} MB', { mb: Math.round(deps.config.maxUploadBytes / 1048576) }));
    const rawName = String(req.headers['x-file-name'] ?? '');
    let name: string;
    try {
      // Sin separadores de ruta, caracteres de control ni de formato (p. ej. U+202E, que invierte el texto
      // y permite disfrazar «factura.doc» como «factura.pdf»).
      name = decodeURIComponent(rawName).replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/\p{Cf}/gu, '').slice(0, 200);
    } catch {
      throw badRequest('Nombre de archivo inválido');
    }
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const mime = ALLOWED_FILES[ext];
    if (!name || !mime) throw badRequest(t('Tipo de archivo no permitido. Admitidos: {types}', { types: Object.keys(ALLOWED_FILES).join(', ') }));
    const recordId = req.headers['x-record-id'] ? String(req.headers['x-record-id']) : null;
    const fieldKey = req.headers['x-field-key'] ? String(req.headers['x-field-key']).slice(0, 40) : null;
    if (recordId && !isUuid(recordId)) throw badRequest('x-record-id inválido');
    // 1) Permisos y cuota. 2) Con bucket, se sube fuera de la transacción (no retiene una conexión de la base de
    // datos mientras dura la subida). 3) Se registra el archivo; si eso falla, se borra el objeto subido.
    const checked = await withWs(req, 'member', async (q, ws, a) => {
      let moduleKey: string | null = null;
      if (recordId) {
        const rec = (await q.query(`SELECT module_key FROM records WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [recordId, ws.id])).rows[0];
        if (!rec) throw notFound('Registro no encontrado');
        const mod = moduleFor(ws, a, rec.module_key);
        if (!hasRole(a.role, mod.permissions.update)) throw forbidden();
        moduleKey = rec.module_key;
      }
      // Cuentan también los archivos borrados hasta que el mantenimiento purga su contenido (size = 0):
      // subir y borrar en bucle no permite superar la cuota.
      const used = await q.query<{ n: number }>(`SELECT COALESCE(sum(size),0)::float8 AS n FROM files WHERE workspace_id = $1`, [ws.id]);
      if (Number(used.rows[0].n) + body.length > WORKSPACE_QUOTA_BYTES) throw badRequest('Se ha alcanzado la cuota de almacenamiento de la organización');
      return { workspaceId: ws.id, moduleKey };
    });
    const id = newId();
    const digest = sha256(body);
    const objectKey = deps.storage ? fileObjectKey(checked.workspaceId, id) : null;
    if (deps.storage && objectKey) {
      try {
        await deps.storage.put(objectKey, body, mime, digest);
      } catch (e) {
        req.log.error({ err: e instanceof ObjectStorageError ? { status: e.status, code: e.code, message: e.message } : String(e) }, 'No se pudo subir el archivo al bucket');
        throw new AppError(502, 'storage_unavailable', 'No se ha podido guardar el archivo en el almacenamiento. Inténtalo de nuevo en unos segundos.');
      }
    }
    try {
      return await withWs(req, 'member', async (q, ws, a) => {
        await q.query(
          `INSERT INTO files (id, workspace_id, record_id, module_key, field_key, name, mime, size, sha256, content, storage, object_key, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, ws.id, recordId, checked.moduleKey, fieldKey, name, mime, body.length, digest, objectKey ? Buffer.alloc(0) : body, objectKey ? 's3' : 'db', objectKey, a.apiKeyId ? null : a.userId],
        );
        if (recordId) await q.query(`UPDATE records SET last_activity_at = now() WHERE id = $1 AND workspace_id = $2`, [recordId, ws.id]);
        return { id, name, mime, size: body.length };
      });
    } catch (e) {
      if (deps.storage && objectKey) await deps.storage.delete(objectKey).catch(() => undefined);
      throw e;
    }
  });

  app.get('/files/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { inline } = z.object({ inline: z.enum(['1', '0']).optional() }).parse(req.query);
    const file = await withWs(req, 'viewer', async (q, ws, a) => {
      const f = (await q.query(`SELECT name, mime, content, storage, object_key, module_key, uploaded_by FROM files WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [id, ws.id])).rows[0];
      if (!f) throw notFound('Archivo no encontrado');
      assertFileAccess(ws, a, f);
      return f;
    });
    const content = await readFileContent(file);
    const disposition = inline === '1' && INLINE_OK.has(file.mime) ? 'inline' : 'attachment';
    reply
      .header('Content-Type', file.mime)
      .header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(content);
  });

  app.delete('/files/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withWs(req, 'member', async (q, ws, a) => {
      const f = (await q.query(`SELECT uploaded_by FROM files WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [id, ws.id])).rows[0];
      if (!f) throw notFound('Archivo no encontrado');
      if (f.uploaded_by !== a.userId && !hasRole(a.role, 'admin')) throw forbidden('Solo puedes eliminar tus archivos');
      await q.query(`UPDATE files SET deleted_at = now() WHERE id = $1 AND workspace_id = $2`, [id, ws.id]);
      await audit(q, { workspaceId: ws.id, actorId: a.userId, action: 'file.deleted', targetType: 'file', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- búsqueda y selectores

  app.get('/lookup/:module', async (req) => {
    const { module } = z.object({ module: z.string().max(40) }).parse(req.params);
    const { q: term, ids } = z.object({ q: z.string().max(200).optional(), ids: z.string().max(4000).optional() }).parse(req.query);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const mod = moduleFor(ws, a, module);
      const idList = ids ? ids.split(',').filter(isUuid).slice(0, 100) : undefined;
      const svc = makeRecordService(q, ws, actorFrom(a));
      const { items } = await svc.ctx.store.list(mod, { search: term, ids: idList, limit: 20, offset: 0, sort: { field: mod.primaryField, direction: 'asc' } }, { now: deps.now(), tz: ws.settings.timezone });
      return items.map((r) => ({ id: r.id, title: recordTitle(mod, r.data) }));
    });
  });

  app.get('/members/lookup', async (req) =>
    withWs(req, 'viewer', async (q, ws) => {
      const r = await q.query(`SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.name`, [ws.id]);
      return r.rows;
    }),
  );

  app.get('/search', async (req) => {
    const { q: term } = z.object({ q: z.string().trim().min(1).max(200) }).parse(req.query);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const svc = makeRecordService(q, ws, actorFrom(a));
      const groups = [];
      for (const mod of readable(ws, a)) {
        const { items, total } = await svc.ctx.store.list(mod, { search: term, limit: 5, offset: 0 }, { now: deps.now(), tz: ws.settings.timezone });
        if (!items.length) continue;
        const sub = mod.fields.find((f) => f.key !== mod.primaryField && ['email', 'text', 'phone'].includes(f.type) && !f.archived);
        groups.push({ module: mod.key, label: mod.labelPlural, icon: mod.icon, total, items: items.map((r) => ({ id: r.id, title: recordTitle(mod, r.data), subtitle: sub ? (r.data[sub.key] as string | undefined) ?? null : null })) });
      }
      return { groups };
    });
  });

  // ---------------------------------------------------------------- paneles e informes

  app.get('/dashboards/:key/data', async (req) => {
    const { key } = z.object({ key: z.string().max(40) }).parse(req.params);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const d = ws.blueprint.dashboards.find((x) => x.key === key);
      if (!d) throw notFound('Panel no encontrado');
      const out: Record<string, unknown> = {};
      for (const w of d.widgets) {
        const mod = findModule(ws.blueprint, w.module);
        out[w.key] = mod && !hasRole(a.role, mod.permissions.read) ? { type: 'error', message: t('Sin acceso') } : await computeWidget(q, ws.id, ws.blueprint, w, { now: deps.now(), tz: ws.settings.timezone, canRead: canReadFor(ws, a) });
      }
      return { dashboard: d, data: out };
    });
  });

  /**
   * Datos de los widgets de una página propia (blueprint.pages). La página se resuelve con la misma visibilidad
   * que /blueprint (rol mínimo de la página y sin bloques de módulos que el rol no puede leer) y solo se calculan
   * los widgets legibles. Las listas de registros las pide el cliente a /records/:module (con sus permisos).
   */
  app.get('/pages/:key/data', async (req) => {
    const { key } = z.object({ key: z.string().max(40) }).parse(req.params);
    return withWs(req, 'viewer', async (q, ws, a) => {
      const page = blueprintForRole(ws.blueprint, a.role).pages.find((p) => p.key === key);
      if (!page) throw notFound('Página no encontrada');
      const canRead = canReadFor(ws, a);
      const data: Record<string, unknown> = {};
      for (const b of page.blocks) {
        if (b.type !== 'widget' || !canRead(b.widget.module)) continue;
        data[b.widget.key] = await computeWidget(q, ws.id, ws.blueprint, b.widget, { now: deps.now(), tz: ws.settings.timezone, canRead });
      }
      return { page, data };
    });
  });

  app.get('/reports/:type', async (req) => {
    const { type } = z.object({ type: z.enum(REPORT_TYPES) }).parse(req.params);
    return withWs(req, 'viewer', async (q, ws, a) => {
      assertReportAccess(ws, a, type);
      return buildReport(q, ws.id, ws.blueprint, type, deps.now());
    });
  });

  app.post('/reports/predictions', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'member');
    const snapshot = await deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      assertReportAccess(ws, a, 'sales');
      const sales = await buildReport(q, ws.id, ws.blueprint, 'sales', deps.now());
      return { deals: await pipelineSnapshot(q, ws.id), kpis: sales.kpis, currency: ws.settings.currency };
    });
    if (!snapshot.deals.length) return { text: t('Todavía no hay oportunidades suficientes para hacer predicciones. Registra oportunidades y vuelve a intentarlo.'), provider: null, model: null };
    const res = await deps.ai.run(a.workspaceId, {
      task: 'crm_analysis',
      userId: a.userId,
      ref: 'predictions',
      system: `Eres un analista comercial senior. Analiza datos agregados y anónimos de un pipeline de ventas. Responde en ${promptLanguage()}, con formato Markdown breve: 1) Previsión de ingresos a 30 y 90 días con supuestos explícitos, 2) Oportunidades en riesgo (por inactividad o antigüedad), 3) Tres recomendaciones accionables. No inventes datos que no estén en la entrada; indica la incertidumbre.`,
      messages: [{ role: 'user', content: `Fecha de hoy: ${deps.now().toISOString().slice(0, 10)}. Moneda: ${snapshot.currency}.\nKPIs: ${JSON.stringify(snapshot.kpis)}\nOportunidades (stage, amount, probability, expected_close, age_days, idle_days):\n${JSON.stringify(snapshot.deals)}` }],
      maxTokens: 6000,
    });
    return { text: res.text, provider: res.provider, model: res.model, costUsd: res.costUsd };
  });

  // ---------------------------------------------------------------- funciones de IA sobre los datos
  // Las llamadas al modelo se hacen FUERA de las transacciones (pueden tardar) y siempre con sesión de usuario.

  /** Consultas en lenguaje natural (tarea sql_generation): la IA propone una consulta estructurada, nunca SQL. */
  app.post('/ai/query', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'viewer');
    requireUserSession(req);
    const { question } = z.object({ question: z.string().trim().min(4, msg('Escribe una pregunta un poco más concreta')).max(500) }).parse(req.body);
    const ctx = await deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      return { ws, modules: readableModules(ws.blueprint, a.role) };
    });
    if (!ctx.modules.length) throw forbidden('Tu rol no tiene acceso a ningún módulo');
    const readableBp = { ...ctx.ws.blueprint, modules: ctx.modules };
    const messages: ChatMessage[] = [
      { role: 'user', content: `Hoy es ${deps.now().toISOString().slice(0, 10)} (zona ${ctx.ws.settings.timezone}, moneda ${ctx.ws.settings.currency}).\nESTRUCTURA (módulo: campos):\n${describeModules(ctx.modules)}\n\nPREGUNTA:\n${question}` },
    ];
    const base = { task: 'sql_generation' as const, system: querySystem(), userId: a.userId, ref: 'ai_query', maxTokens: 2000 };
    let res = await deps.ai.runJson(a.workspaceId, { ...base, messages }, AiQuerySchema, 1);
    let built = toWidget(readableBp, res.value);
    if (!built.widget) {
      // Una ronda de corrección con los problemas concretos, con el mismo modelo.
      messages.push({ role: 'assistant', content: JSON.stringify(res.value) }, { role: 'user', content: `La consulta no es válida:\n${built.problems.map((p) => `- ${p}`).join('\n')}\nCorrígela y devuelve solo el JSON.` });
      res = await deps.ai.runJson(a.workspaceId, { ...base, messages, target: { provider: res.result.provider, model: res.result.model } }, AiQuerySchema, 1);
      built = toWidget(readableBp, res.value);
    }
    if (!built.widget) throw unprocessable(t('No he podido convertir la pregunta en una consulta válida: {problems}', { problems: built.problems.slice(0, 3).join('; ') }));
    const widget = built.widget;
    const data = await deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      if (!canReadFor(ws, a)(widget.module)) throw forbidden();
      return computeWidget(q, ws.id, ws.blueprint, widget, { now: deps.now(), tz: ws.settings.timezone, canRead: canReadFor(ws, a) });
    });
    return { widget, data, explanation: res.value.explanation, provider: res.result.provider, model: res.result.model, costUsd: res.result.costUsd };
  });

  /** Clasificación asistida de un registro (tarea customer_classification): solo propone; el usuario aplica. */
  app.post('/records/:module/:id/classify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { module, id } = z.object({ module: z.string().max(40), id: z.string().uuid() }).parse(req.params);
    const a = requireWorkspace(req, 'member');
    requireUserSession(req);
    const ctx = await withWs(req, 'member', async (q, ws, auth) => {
      const mod = moduleFor(ws, auth, module);
      if (!hasRole(auth.role, mod.permissions.update)) throw forbidden(t('Tu rol no puede modificar {module}', { module: mod.labelPlural }));
      const fields = classifiableFields(mod);
      if (!fields.length) throw badRequest(t('{module} no tiene campos de selección que clasificar', { module: mod.labelPlural }));
      const svc = makeRecordService(q, ws, actorFrom(auth));
      const rec = await svc.ctx.store.get(id);
      if (!rec || rec.moduleKey !== mod.key) throw notFound('Registro no encontrado');
      const refs = await resolveRefs(q, ws.id, ws.blueprint, [rec], canReadFor(ws, auth));
      const values = mod.fields
        .filter((f) => !f.archived && rec.data[f.key] !== undefined && rec.data[f.key] !== null && rec.data[f.key] !== '' && f.type !== 'file')
        .map((f) => {
          const v = rec.data[f.key];
          const shown = f.type === 'relation' ? refs.records[String(v)]?.title : f.type === 'user' ? refs.users[String(v)] : Array.isArray(v) ? v.join(', ') : v;
          return `${f.label} (${f.key}): ${String(shown ?? v).slice(0, 500)}`;
        });
      const notes = (await q.query(`SELECT body, created_at FROM notes WHERE workspace_id = $1 AND record_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`, [ws.id, id])).rows;
      const related: string[] = [];
      for (const m of readable(ws, auth)) {
        for (const f of m.fields) {
          if (f.type !== 'relation' || f.archived || f.relation?.module !== mod.key) continue;
          const n = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL AND data->>$3 = $4`, [ws.id, m.key, f.key, id]);
          if (n.rows[0].n) related.push(`${m.labelPlural} (vía ${f.label}): ${n.rows[0].n}`);
        }
      }
      return { mod, rec, values, notes, related, today: deps.now().toISOString().slice(0, 10) };
    });
    const allowed = classifiableFields(ctx.mod).map((f) => `- ${f.key} (${f.label}${f.type === 'multi_select' ? ', selección múltiple' : ''}): ${f.options!.map((o) => `${o.value}="${o.label}"`).join(', ')}`).join('\n');
    const res = await deps.ai.runJson(
      a.workspaceId,
      {
        task: 'customer_classification',
        system: classifySystem(),
        userId: a.userId,
        ref: id,
        maxTokens: 3000,
        messages: [
          {
            role: 'user',
            content: `Hoy es ${ctx.today}. Módulo: ${ctx.mod.labelPlural}.\nCAMPOS A CLASIFICAR (clave: valores permitidos):\n${allowed}\n\nDATOS DEL REGISTRO:\n${ctx.values.join('\n') || '(sin datos)'}\n\nREGISTROS RELACIONADOS:\n${ctx.related.join('\n') || '(ninguno)'}\n\nÚLTIMAS NOTAS:\n${ctx.notes.map((n: any) => `- ${String(n.created_at).slice(0, 10)}: ${String(n.body).slice(0, 500)}`).join('\n') || '(sin notas)'}`,
          },
        ],
      },
      ClassifySchema,
      1,
    );
    return { summary: res.value.summary, suggestions: sanitizeSuggestions(ctx.mod, ctx.rec.data, res.value.suggestions), provider: res.result.provider, model: res.result.model, costUsd: res.result.costUsd };
  });

  /** Análisis de un documento adjunto (tarea document_analysis): PDF o texto. */
  app.post('/files/:id/analyze', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const a = requireWorkspace(req, 'member');
    requireUserSession(req);
    const doc = await withWs(req, 'member', async (q, ws, auth) => {
      const f = (await q.query(`SELECT name, mime, size, content, storage, object_key, module_key, record_id, uploaded_by FROM files WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [id, ws.id])).rows[0];
      if (!f) throw notFound('Archivo no encontrado');
      assertFileAccess(ws, auth, f);
      let context = 'Documento sin registro asociado';
      if (f.module_key) {
        const mod = moduleFor(ws, auth, f.module_key);
        const rec = f.record_id ? await makeRecordService(q, ws, actorFrom(auth)).ctx.store.get(f.record_id) : null;
        context = rec ? `${mod.label}: «${recordTitle(mod, rec.data)}»` : mod.label;
      }
      return { name: String(f.name), mime: String(f.mime), size: Number(f.size), file: { storage: f.storage as string, object_key: f.object_key as string | null, content: f.content as Buffer }, context, moduleKey: f.module_key as string | null, recordId: f.record_id as string | null, today: deps.now().toISOString().slice(0, 10) };
    });
    let attachment: Attachment;
    let truncated = false;
    // El contenido se lee después de comprobar tipo y tamaño: no se descarga del bucket lo que se va a rechazar.
    if (doc.mime === 'application/pdf') {
      if (doc.size > MAX_PDF_BYTES) throw badRequest(t('El PDF supera los {mb} MB que se pueden analizar', { mb: Math.round(MAX_PDF_BYTES / 1048576) }));
      attachment = { kind: 'pdf', name: doc.name, data: (await readFileContent(doc.file)).toString('base64') };
    } else if (TEXT_MIMES.has(doc.mime)) {
      let text = (await readFileContent(doc.file)).toString('utf8');
      if (text.length > MAX_DOCUMENT_CHARS) {
        text = text.slice(0, MAX_DOCUMENT_CHARS);
        truncated = true;
      }
      attachment = { kind: 'text', name: doc.name, data: text };
    } else {
      throw badRequest('Por ahora se pueden analizar PDF y archivos de texto (txt, csv, md, json)');
    }
    const res = await deps.ai.runJson(
      a.workspaceId,
      {
        task: 'document_analysis',
        system: documentSystem(),
        userId: a.userId,
        ref: id,
        maxTokens: 6000,
        messages: [{ role: 'user', content: `Hoy es ${doc.today}. Contexto: ${doc.context}. Archivo: ${doc.name}${truncated ? ' (recortado: solo se envía el principio)' : ''}. Analiza el documento adjunto.`, attachments: [attachment] }],
      },
      DocumentAnalysisSchema,
      1,
    );
    return { analysis: res.value, file: { id, name: doc.name }, moduleKey: doc.moduleKey, recordId: doc.recordId, truncated, provider: res.result.provider, model: res.result.model, costUsd: res.result.costUsd };
  });
}
