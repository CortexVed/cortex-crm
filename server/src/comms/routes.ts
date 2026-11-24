import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appBaseUrl, type AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { hmacHex, newId, randomToken, safeEqual } from '../lib/crypto';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { requireUserSession, requireWorkspace } from '../auth/plugin';
import { hasRole, type Role } from '../../../shared/constants';
import { findModule } from '../../../shared/blueprint';
import type { Queryable } from '../db/db';
import { loadWorkspace } from '../crm/context';
import { PgSideEffects } from '../crm/effects';
import {
  CONNECTOR_TYPES,
  phoneDigits,
  telegramDeleteWebhook,
  telegramSend,
  telegramSetWebhook,
  telegramVerify,
  whatsappSend,
  whatsappVerify,
} from './connectors';

// Límite por CONECTOR (token de la URL), no por IP: Telegram y Meta envían desde pocas IPs compartidas por
// todas las organizaciones, así que un conector con mucho tráfico no deja sin servicio a los demás.
const HOOK_LIMIT = { config: { rateLimit: { max: 240, timeWindow: '1 minute', keyGenerator: (req: { params: unknown; ip: string }) => `hook:${(req.params as { token?: string })?.token ?? req.ip}` } } };

export async function commsRoutes(app: FastifyInstance, deps: AppDeps) {
  const aad = (ws: string, id: string) => `connector:${ws}:${id}`;
  const secretsOf = (row: any) => (row.secret_ciphertext ? (JSON.parse(deps.box.decrypt(row.secret_ciphertext, aad(row.workspace_id, row.id))) as Record<string, string>) : {});
  const tgSecret = (id: string) => deps.box.derive(`telegram:${id}`).slice(0, 64);

  app.get('/comms/connectors', async (req) => {
    const a = requireWorkspace(req);
    const rows = await deps.db.tenant(a.workspaceId, async (q) => (await q.query(`SELECT id, type, name, status, config, last_error, last_event_at, created_at, webhook_token FROM connectors WHERE workspace_id = $1 ORDER BY created_at`, [a.workspaceId])).rows);
    const base = appBaseUrl(deps, req);
    return {
      types: CONNECTOR_TYPES,
      connectors: rows.map((r: any) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        status: r.status,
        config: r.config,
        lastError: r.last_error,
        lastEventAt: r.last_event_at,
        createdAt: r.created_at,
        webhookUrl: a.role === 'owner' || a.role === 'admin' ? `${base}/api/hooks/${r.type}/${r.webhook_token}` : undefined,
      })),
    };
  });

  app.post('/comms/connectors', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const body = z.object({ type: z.string().max(30), name: z.string().trim().min(2).max(80), credentials: z.record(z.string(), z.string().max(1000)) }).parse(req.body);
    const def = CONNECTOR_TYPES.find((t) => t.type === body.type);
    if (!def) throw badRequest('Tipo de canal desconocido');
    if (def.status !== 'available') throw badRequest(`${def.label} todavía no está disponible: ${def.plannedReason}`);
    for (const f of def.fields) if (!body.credentials[f.key]?.trim()) throw badRequest(`Falta "${f.label}"`);
    const id = newId();
    const webhookToken = randomToken(24);
    const base = appBaseUrl(deps, req);
    let config: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    if (def.type === 'telegram') {
      const token = body.credentials.botToken.trim();
      const me = await telegramVerify(deps.fetchImpl, token);
      if (!base.startsWith('https://')) throw badRequest('Telegram requiere que la aplicación tenga una URL pública HTTPS (APP_URL)');
      await telegramSetWebhook(deps.fetchImpl, token, `${base}/api/hooks/telegram/${webhookToken}`, tgSecret(id));
      config = { botUsername: me.username };
      secrets.botToken = token;
    } else if (def.type === 'whatsapp') {
      const info = await whatsappVerify(deps.fetchImpl, body.credentials.phoneNumberId.trim(), body.credentials.accessToken.trim());
      config = { phoneNumberId: body.credentials.phoneNumberId.trim(), displayPhone: info.displayPhone, verifiedName: info.name };
      secrets.accessToken = body.credentials.accessToken.trim();
      secrets.appSecret = body.credentials.appSecret.trim();
      secrets.verifyToken = randomToken(18);
    }
    await deps.db.tenant(a.workspaceId, async (q) => {
      await q.query(
        `INSERT INTO connectors (id, workspace_id, type, name, status, config, secret_ciphertext, webhook_token, created_by) VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8)`,
        [id, a.workspaceId, def.type, body.name, JSON.stringify(config), deps.box.encrypt(JSON.stringify(secrets), aad(a.workspaceId, id)), webhookToken, a.userId],
      );
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'connector.created', targetType: 'connector', targetId: id, ip: req.ip, meta: { type: def.type } });
    });
    return {
      id,
      webhookUrl: `${base}/api/hooks/${def.type}/${webhookToken}`,
      // Solo para WhatsApp: el token de verificación se muestra una vez para configurarlo en Meta.
      verifyToken: def.type === 'whatsapp' ? secrets.verifyToken : undefined,
    };
  });

  app.delete('/comms/connectors/:id', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await deps.db.tenant(a.workspaceId, async (q) => {
      const row = (await q.query(`SELECT * FROM connectors WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId])).rows[0];
      if (!row) throw notFound('Canal no encontrado');
      if (row.type === 'telegram') await telegramDeleteWebhook(deps.fetchImpl, secretsOf(row).botToken);
      await q.query(`DELETE FROM connectors WHERE id = $1`, [id]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'connector.deleted', targetType: 'connector', targetId: id, ip: req.ip });
    });
    return { ok: true };
  });

  /** Registro al que se puede vincular o escribir: debe existir y el rol debe poder editar su módulo. */
  const editableRecord = async (q: Queryable, a: { workspaceId: string; role: Role }, recordId: string) => {
    const ws = await loadWorkspace(q, a.workspaceId);
    const rec = (await q.query(`SELECT id, module_key, data FROM records WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [recordId, a.workspaceId])).rows[0];
    const mod = rec ? findModule(ws.blueprint, rec.module_key) : undefined;
    // Misma respuesta si no existe o no se puede leer: no revela qué registros existen.
    if (!rec || !mod || !hasRole(a.role, mod.permissions.read)) throw notFound('Registro no encontrado');
    if (!hasRole(a.role, mod.permissions.update)) throw forbidden(`Tu rol no puede editar ${mod.labelPlural.toLowerCase()}`);
    return rec;
  };

  app.get('/comms/inbox', async (req) => {
    const a = requireWorkspace(req, 'member');
    return deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      const readable = ws.blueprint.modules.filter((m) => hasRole(a.role, m.permissions.read)).map((m) => m.key);
      // Solo mensajes de fichas que el rol puede leer; los mensajes aún sin vincular, solo administradores.
      return (
        await q.query(
          `SELECT m.id, m.channel, m.direction, m.from_address, m.body, m.record_id, m.created_at
             FROM channel_messages m LEFT JOIN records r ON r.id = m.record_id AND r.workspace_id = m.workspace_id
            WHERE m.workspace_id = $1 AND ((m.record_id IS NULL AND $3) OR r.module_key = ANY($2::text[]))
            ORDER BY m.created_at DESC LIMIT 100`,
          [a.workspaceId, readable, hasRole(a.role, 'admin')],
        )
      ).rows;
    });
  });

  app.post('/comms/messages/:id/link', async (req) => {
    const a = requireWorkspace(req, 'member');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { recordId } = z.object({ recordId: z.string().uuid() }).parse(req.body);
    await deps.db.tenant(a.workspaceId, async (q) => {
      await editableRecord(q, a, recordId);
      const msg = (await q.query(`SELECT m.record_id, r.module_key FROM channel_messages m LEFT JOIN records r ON r.id = m.record_id WHERE m.id = $1 AND m.workspace_id = $2`, [id, a.workspaceId])).rows[0];
      if (!msg) throw notFound('Mensaje no encontrado');
      // Mover un mensaje ya vinculado exige poder editar también la ficha de origen; los no vinculados, administradores.
      if (msg.record_id) await editableRecord(q, a, msg.record_id);
      else if (!hasRole(a.role, 'admin')) throw notFound('Mensaje no encontrado');
      await q.query(`UPDATE channel_messages SET record_id = $1 WHERE id = $2 AND workspace_id = $3`, [recordId, id, a.workspaceId]);
    });
    return { ok: true };
  });

  app.post('/comms/send', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'member');
    const body = z.object({ connectorId: z.string().uuid(), recordId: z.string().uuid(), text: z.string().trim().min(1).max(4000) }).parse(req.body);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const c = (await q.query(`SELECT * FROM connectors WHERE id = $1 AND workspace_id = $2 AND status = 'active'`, [body.connectorId, a.workspaceId])).rows[0];
      if (!c) throw notFound('Canal no disponible');
      const rec = await editableRecord(q, a, body.recordId);
      const s = secretsOf(c);
      let externalId = '';
      let to = '';
      if (c.type === 'telegram') {
        const last = (await q.query(`SELECT payload FROM channel_messages WHERE workspace_id = $1 AND record_id = $2 AND channel = 'telegram' AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`, [a.workspaceId, rec.id])).rows[0];
        const chatId = last?.payload?.chatId;
        if (!chatId) throw badRequest('Este contacto todavía no ha escrito al bot de Telegram (Telegram no permite iniciar conversaciones).');
        to = String(chatId);
        externalId = await telegramSend(deps.fetchImpl, s.botToken, chatId, body.text);
      } else if (c.type === 'whatsapp') {
        to = phoneDigits(rec.data.phone);
        if (to.length < 8) throw badRequest('El registro no tiene un teléfono válido');
        externalId = await whatsappSend(deps.fetchImpl, c.config.phoneNumberId, s.accessToken, to, body.text);
      }
      const id = newId();
      await q.query(
        `INSERT INTO channel_messages (id, workspace_id, connector_id, channel, direction, external_id, to_address, body, record_id, status) VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,'sent')`,
        [id, a.workspaceId, c.id, c.type, externalId, to, body.text, rec.id],
      );
      await q.query(`UPDATE records SET last_activity_at = now() WHERE id = $1 AND workspace_id = $2`, [rec.id, a.workspaceId]);
      return { id, externalId };
    });
  });

  // ---------------------------------------------------------------- webhooks entrantes (sin sesión)

  const connectorByToken = async (type: string, token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return (await deps.db.query(`SELECT * FROM connectors WHERE webhook_token = $1 AND type = $2 AND status = 'active'`, [token, type])).rows[0] ?? null;
  };

  const storeInbound = async (c: any, msg: { externalId: string; from: string; body: string; payload: Record<string, unknown>; match: { field: 'phone' | 'telegram'; value: string } }) => {
    await deps.db.tenant(c.workspace_id, async (q) => {
      const dup = await q.query(`SELECT 1 FROM channel_messages WHERE workspace_id = $1 AND channel = $2 AND external_id = $3`, [c.workspace_id, c.type, msg.externalId]);
      if (dup.rows.length) return;
      let recordId: string | null = null;
      if (msg.match.value) {
        // Coincidencia EXACTA (teléfono completo en formato internacional, sin símbolos) y solo si es única:
        // comparar los últimos dígitos mezclaba números de países distintos y respondía a otra persona.
        const r =
          msg.match.field === 'phone'
            ? await q.query(`SELECT id, data FROM records WHERE workspace_id = $1 AND module_key = 'contacts' AND deleted_at IS NULL AND regexp_replace(COALESCE(data->>'phone',''), '\\D', '', 'g') = $2 LIMIT 2`, [c.workspace_id, msg.match.value.replace(/\D/g, '')])
            : await q.query(`SELECT id, data FROM records WHERE workspace_id = $1 AND module_key = 'contacts' AND deleted_at IS NULL AND lower(ltrim(data->>'telegram', '@')) = lower($2) LIMIT 2`, [c.workspace_id, msg.match.value]);
        recordId = r.rows.length === 1 ? r.rows[0].id : null;
        if (recordId) {
          await q.query(`UPDATE records SET last_activity_at = now() WHERE id = $1`, [recordId]);
          const owner = r.rows[0].data?.owner;
          const effects = new PgSideEffects(q, c.workspace_id);
          // El aviso incluye el texto del mensaje: solo si el responsable puede leer los contactos.
          const readRole = (await loadWorkspace(q, c.workspace_id)).blueprint.modules.find((m) => m.key === 'contacts')?.permissions.read ?? 'owner';
          if (typeof owner === 'string') await effects.notify({ userIds: [owner], title: `Nuevo mensaje de ${c.type === 'whatsapp' ? 'WhatsApp' : 'Telegram'}`, body: msg.body.slice(0, 140), link: `/m/contacts/${recordId}`, kind: 'message', readRole });
        }
      }
      await q.query(
        `INSERT INTO channel_messages (id, workspace_id, connector_id, channel, direction, external_id, from_address, body, payload, record_id) VALUES ($1,$2,$3,$4,'inbound',$5,$6,$7,$8,$9)`,
        [newId(), c.workspace_id, c.id, c.type, msg.externalId, msg.from, msg.body.slice(0, 8000), JSON.stringify(msg.payload), recordId],
      );
      await q.query(`UPDATE connectors SET last_event_at = now() WHERE id = $1`, [c.id]);
    });
  };

  app.post('/hooks/telegram/:token', HOOK_LIMIT, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(80) }).parse(req.params);
    const c = await connectorByToken('telegram', token);
    if (!c) throw notFound();
    const header = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    if (!safeEqual(header, tgSecret(c.id))) throw unauthorized('Firma inválida');
    const update = req.body as any;
    const m = update?.message;
    if (m?.text) {
      await storeInbound(c, {
        externalId: `${m.chat?.id}:${m.message_id}`,
        from: m.from?.username ? `@${m.from.username}` : String(m.from?.first_name ?? m.chat?.id ?? ''),
        body: String(m.text),
        payload: { chatId: m.chat?.id, fromId: m.from?.id, firstName: m.from?.first_name },
        match: { field: 'telegram', value: m.from?.username ?? '' },
      });
    }
    return reply.send({ ok: true });
  });

  app.get('/hooks/whatsapp/:token', HOOK_LIMIT, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(80) }).parse(req.params);
    const qp = req.query as Record<string, string>;
    const c = await connectorByToken('whatsapp', token);
    if (!c) throw notFound();
    const s = secretsOf(c);
    if (qp['hub.mode'] === 'subscribe' && qp['hub.verify_token'] && safeEqual(qp['hub.verify_token'], s.verifyToken)) {
      return reply.type('text/plain').send(String(qp['hub.challenge'] ?? ''));
    }
    throw forbidden('Token de verificación inválido');
  });

  app.post('/hooks/whatsapp/:token', HOOK_LIMIT, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(80) }).parse(req.params);
    const c = await connectorByToken('whatsapp', token);
    if (!c) throw notFound();
    const s = secretsOf(c);
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = `sha256=${hmacHex(s.appSecret, (req.rawBody ?? Buffer.alloc(0)).toString('utf8'))}`;
    if (!req.rawBody || !safeEqual(sig, expected)) throw unauthorized('Firma inválida');
    const body = req.body as any;
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const v = change?.value;
        for (const m of v?.messages ?? []) {
          if (m?.type !== 'text') continue;
          const name = v?.contacts?.find((x: any) => x.wa_id === m.from)?.profile?.name;
          await storeInbound(c, { externalId: String(m.id), from: name ? `${name} (+${m.from})` : `+${m.from}`, body: String(m.text?.body ?? ''), payload: { waId: m.from, timestamp: m.timestamp }, match: { field: 'phone', value: phoneDigits(m.from) } });
        }
      }
    }
    return reply.send({ ok: true });
  });
}
