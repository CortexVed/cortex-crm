import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasRole, ROLES, ROLE_RANK, type Role } from '../../../shared/constants';
import { appBaseUrl, type AppDeps } from '../deps';
import type { Queryable } from '../db/db';
import { audit } from '../lib/audit';
import { newId, randomToken, sha256 } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../lib/errors';
import { emailTemplate } from '../lib/mailer';
import { requireUserSession, requireWorkspace } from '../auth/plugin';
import { createInviteToken, createPasswordResetLink, EmailSchema } from '../auth/routes';
import { loadWorkspace, normalizeSettings } from '../crm/context';
import { blueprintForRole } from '../crm/visibility';

const MAX_INVITES_PER_DAY = 100;

/** Texto escrito por usuarios dentro de un correo de la plataforma: sin URLs, dominios ni caracteres de control. */
export function mailSafe(s: string, max = 60): string {
  return s
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/(https?:\/\/|www\.)\S*/gi, '[…]')
    .replace(/[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)+/gu, '[…]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const SettingsSchema = z.object({
  timezone: z.string().max(60).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  locale: z.string().max(20).optional(),
  industry: z.string().max(80).optional(),
  description: z.string().max(1000).optional(),
  approval: z.object({ requireDistinctApprover: z.boolean() }).optional(),
});

export async function workspaceRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/workspace', async (req) => {
    const a = requireWorkspace(req);
    const ws = await deps.db.tenant(a.workspaceId, (q) => loadWorkspace(q, a.workspaceId));
    return { id: ws.id, name: ws.name, slug: ws.slug, plan: ws.plan, version: ws.version, settings: ws.settings, role: a.role };
  });

  app.patch('/workspace', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const body = z.object({ name: z.string().trim().min(2).max(80).optional(), settings: SettingsSchema.optional() }).parse(req.body);
    if (body.settings?.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: body.settings.timezone });
      } catch {
        throw badRequest('Zona horaria no válida');
      }
    }
    if (body.settings?.approval && a.role !== 'owner') throw forbidden('Solo los propietarios pueden cambiar la política de aprobación');
    return deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      const settings = normalizeSettings({ ...ws.settings, ...(body.settings ?? {}), approval: { ...ws.settings.approval, ...(body.settings?.approval ?? {}) } });
      await q.query(`UPDATE workspaces SET name = $1, settings = $2 WHERE id = $3`, [body.name ?? ws.name, JSON.stringify(settings), a.workspaceId]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'workspace.updated', ip: req.ip, meta: { name: body.name, settings: body.settings } });
      return { ok: true, settings };
    });
  });

  app.get('/workspace/members', async (req) => {
    const a = requireWorkspace(req);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = await q.query(
        `SELECT m.user_id, m.role, m.created_at, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at`,
        [a.workspaceId],
      );
      return r.rows.map((m: any) => ({ id: m.user_id, name: m.name, email: m.email, role: m.role, joinedAt: m.created_at }));
    });
  });

  /**
   * Reglas de cambios de miembros. Se ejecuta dentro de una transacción que bloquea las filas de los
   * propietarios: dos propietarios que se degradan a la vez no pueden dejar la organización sin ninguno.
   */
  async function guardMemberChange(q: Queryable, workspaceId: string, actor: { userId: string; role: Role }, targetId: string, newRole?: Role) {
    const owners = (await q.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`, [workspaceId])).rows;
    const target = (await q.query(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [workspaceId, targetId])).rows[0];
    if (!target) throw notFound('Miembro no encontrado');
    if ((target.role === 'owner' || newRole === 'owner') && actor.role !== 'owner') throw forbidden('Solo un propietario puede gestionar propietarios');
    if (newRole === 'admin' && target.role !== 'admin' && actor.role !== 'owner') throw forbidden('Solo un propietario puede nombrar administradores');
    if (actor.role === 'admin' && ROLE_RANK[target.role as Role] >= ROLE_RANK.admin && targetId !== actor.userId) throw forbidden('Un administrador no puede modificar a otro administrador');
    if (target.role === 'owner' && newRole !== 'owner' && owners.length <= 1) throw conflict('La organización necesita al menos un propietario');
    return target.role as Role;
  }

  /** Invitaciones pendientes que la persona ya no puede conceder (tras degradarla o eliminarla). */
  async function dropInvitesBeyond(q: Queryable, workspaceId: string, userId: string, role: Role | null) {
    if (!role || ROLE_RANK[role] < ROLE_RANK.admin) {
      return q.query(`DELETE FROM auth_tokens WHERE kind = 'invite' AND workspace_id = $1 AND created_by = $2 AND used_at IS NULL`, [workspaceId, userId]);
    }
    if (role === 'admin') return q.query(`DELETE FROM auth_tokens WHERE kind = 'invite' AND workspace_id = $1 AND created_by = $2 AND used_at IS NULL AND role = 'admin'`, [workspaceId, userId]);
    return null;
  }

  app.patch('/workspace/members/:userId', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    const prev = await deps.db.tx(async (q) => {
      const before = await guardMemberChange(q, a.workspaceId, a, userId, role);
      await q.query(`UPDATE memberships SET role = $1 WHERE workspace_id = $2 AND user_id = $3`, [role, a.workspaceId, userId]);
      await dropInvitesBeyond(q, a.workspaceId, userId, role);
      return before;
    });
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'member.role_changed', targetType: 'user', targetId: userId, ip: req.ip, meta: { from: prev, to: role } });
    return { ok: true };
  });

  app.delete('/workspace/members/:userId', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const revoked = await deps.db.tx(async (q) => {
      await guardMemberChange(q, a.workspaceId, a, userId);
      await q.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [a.workspaceId, userId]);
      await q.query(`UPDATE sessions SET workspace_id = NULL WHERE user_id = $1 AND workspace_id = $2`, [userId, a.workspaceId]);
      await dropInvitesBeyond(q, a.workspaceId, userId, null);
      // Las API keys creadas por quien sale de la organización dejan de funcionar.
      return q.query(`UPDATE api_keys SET revoked_at = now() WHERE workspace_id = $1 AND created_by = $2 AND revoked_at IS NULL`, [a.workspaceId, userId]);
    });
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'member.removed', targetType: 'user', targetId: userId, ip: req.ip, meta: { apiKeysRevoked: revoked.rowCount } });
    return { ok: true };
  });

  app.post('/workspace/members/:userId/reset-link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'owner');
    requireUserSession(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const t = (
      await deps.db.query(
        `SELECT u.is_platform_admin, m.role, (SELECT count(*)::int FROM memberships mm WHERE mm.user_id = m.user_id) AS orgs
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2`,
        [a.workspaceId, userId],
      )
    ).rows[0];
    if (!t) throw notFound('Miembro no encontrado');
    // Un enlace de recuperación da acceso a TODA la cuenta: solo para cuentas que pertenecen únicamente
    // a esta organización, que no son propietarias ni administradoras de la plataforma.
    if (t.is_platform_admin) throw forbidden('No se pueden generar enlaces para un administrador de la plataforma');
    if (t.role === 'owner') throw forbidden('No se pueden generar enlaces para otro propietario');
    if (t.orgs > 1) throw forbidden('Esta persona pertenece a otras organizaciones: debe recuperar su contraseña por correo');
    if (userId === a.userId) throw forbidden('Usa «Mi cuenta» para cambiar tu propia contraseña');
    // El enlace queda ligado a esta organización y se revalida al usarlo (si la persona entra en otra
    // organización o deja de cumplir las condiciones, deja de servir). Invalida los enlaces anteriores.
    const link = await createPasswordResetLink(deps, req, userId, { createdBy: a.userId, workspaceId: a.workspaceId });
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'member.reset_link_created', targetType: 'user', targetId: userId, ip: req.ip });
    return { link, expiresInMinutes: 30 };
  });

  app.get('/workspace/invites', async (req) => {
    const a = requireWorkspace(req, 'admin');
    const r = await deps.db.query(
      `SELECT id, email, role, created_at, expires_at FROM auth_tokens WHERE workspace_id = $1 AND kind = 'invite' AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [a.workspaceId],
    );
    return r.rows;
  });

  app.post('/workspace/invites', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const body = z.object({ email: EmailSchema, role: z.enum(['admin', 'builder', 'member', 'viewer']) }).parse(req.body);
    if (body.role === 'admin' && a.role !== 'owner') throw forbidden('Solo un propietario puede invitar administradores');
    const already = await deps.db.query(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND lower(u.email) = $2`, [a.workspaceId, body.email]);
    if (already.rows.length) throw conflict('Esa persona ya es miembro');
    // Tope diario por organización: el correo de invitación sale desde el dominio de la plataforma.
    const today = (await deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth_tokens WHERE kind = 'invite' AND workspace_id = $1 AND created_at > now() - interval '24 hours'`, [a.workspaceId])).rows[0].n;
    if (today >= MAX_INVITES_PER_DAY) throw tooMany(`Límite de ${MAX_INVITES_PER_DAY} invitaciones al día alcanzado`);
    const token = await createInviteToken(deps, { workspaceId: a.workspaceId, email: body.email, role: body.role, createdBy: a.userId });
    const link = `${appBaseUrl(deps, req)}/invite/${token}`;
    let emailSent = false;
    if (deps.mailer.enabled) {
      const ws = (await deps.db.query(`SELECT name FROM workspaces WHERE id = $1`, [a.workspaceId])).rows[0];
      // Asunto fijo y nombres saneados: los textos de la organización no pueden convertir el correo en phishing.
      const mail = emailTemplate('Te han invitado a Cortex CRM', `${mailSafe(a.userName)} te invita a colaborar en la organización «${mailSafe(ws.name)}».`, { label: 'Aceptar invitación', url: link }, 'La invitación caduca en 7 días. Si no esperabas este correo, ignóralo.');
      await deps.mailer.send({ to: body.email, subject: 'Te han invitado a una organización en Cortex CRM', ...mail }).then(() => (emailSent = true)).catch(() => {});
      if (emailSent) await deps.db.query(`UPDATE auth_tokens SET delivered = true WHERE token_hash = $1 AND kind = 'invite'`, [sha256(token)]);
    }
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'member.invited', ip: req.ip, meta: { email: body.email, role: body.role, emailSent } });
    // Con correo activo el enlace solo llega al buzón invitado (prueba de propiedad del email).
    return { link: emailSent ? null : link, emailSent };
  });

  app.delete('/workspace/invites/:id', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await deps.db.query(`DELETE FROM auth_tokens WHERE id = $1 AND workspace_id = $2 AND kind = 'invite'`, [id, a.workspaceId]);
    return { ok: true };
  });

  app.get('/workspace/api-keys', async (req) => {
    const a = requireWorkspace(req, 'admin');
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = await q.query(
        `SELECT k.id, k.name, k.prefix, k.role, k.created_at, k.last_used_at, k.revoked_at, u.name AS created_by_name
         FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.workspace_id = $1 ORDER BY k.created_at DESC`,
        [a.workspaceId],
      );
      return r.rows;
    });
  });

  app.post('/workspace/api-keys', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const body = z.object({ name: z.string().trim().min(2).max(60), role: z.enum(['admin', 'builder', 'member', 'viewer']).default('member') }).parse(req.body);
    if (body.role === 'admin' && a.role !== 'owner') throw forbidden('Solo un propietario puede crear claves de administrador');
    const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
    const key = `evk_${prefix}_${randomToken(32)}`;
    const id = newId();
    await deps.db.tenant(a.workspaceId, async (q) => {
      await q.query(`INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, role, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, a.workspaceId, body.name, prefix, sha256(key), body.role, a.userId]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'api_key.created', targetType: 'api_key', targetId: id, ip: req.ip, meta: { name: body.name, role: body.role } });
    });
    // La clave completa solo se muestra una vez.
    return { id, key, prefix, name: body.name, role: body.role };
  });

  app.delete('/workspace/api-keys/:id', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await deps.db.tenant(a.workspaceId, async (q) => {
      const r = await q.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`, [id, a.workspaceId]);
      if (!r.rowCount) throw notFound('Clave no encontrada');
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'api_key.revoked', targetType: 'api_key', targetId: id, ip: req.ip });
    });
    return { ok: true };
  });

  // Secreto con el que se firman los webhooks salientes de una integración (el receptor lo necesita para
  // verificar X-Cortex-Signature). Es derivado (no se almacena), solo para administradores y queda auditado.
  app.post('/workspace/integrations/:key/signing-secret', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { key } = z.object({ key: z.string().min(1).max(60) }).parse(req.params);
    const ws = await deps.db.tenant(a.workspaceId, (q) => loadWorkspace(q, a.workspaceId));
    if (!ws.blueprint.integrations.some((i) => i.key === key)) throw notFound('Integración no encontrada');
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'integration.signing_secret_viewed', targetType: 'integration', targetId: key, ip: req.ip });
    return {
      secret: deps.box.derive(`webhook:${a.workspaceId}:${key}`),
      algorithm: 'HMAC-SHA256',
      headers: { signature: 'X-Cortex-Signature', timestamp: 'X-Cortex-Timestamp', event: 'X-Cortex-Event' },
      signedPayload: '<X-Cortex-Timestamp>.<cuerpo JSON sin modificar>',
    };
  });

  app.get('/workspace/audit', async (req) => {
    const a = requireWorkspace(req, 'admin');
    const qp = z.object({ page: z.coerce.number().int().min(1).default(1), action: z.string().max(60).optional() }).parse(req.query);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const params: unknown[] = [a.workspaceId];
      let where = 'l.workspace_id = $1';
      if (qp.action) {
        params.push(qp.action + '%');
        where += ` AND l.action LIKE $${params.length}`;
      }
      params.push(50, (qp.page - 1) * 50);
      const r = await q.query(
        `SELECT l.id, l.action, l.actor_type, l.target_type, l.target_id, l.meta, l.ip, l.created_at, u.name AS actor_name
         FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id WHERE ${where} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { items: r.rows, page: qp.page };
    });
  });

  app.get('/notifications', async (req) => {
    const a = requireWorkspace(req);
    requireUserSession(req); // datos personales: nunca accesibles con una API key
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = await q.query(`SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE workspace_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`, [a.workspaceId, a.userId]);
      const unread = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL`, [a.workspaceId, a.userId]);
      return { items: r.rows, unread: unread.rows[0].n };
    });
  });

  app.post('/notifications/:id/read', async (req) => {
    const a = requireWorkspace(req);
    requireUserSession(req); // datos personales: nunca accesibles con una API key
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await deps.db.tenant(a.workspaceId, (q) => q.query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND workspace_id = $3`, [id, a.userId, a.workspaceId]));
    return { ok: true };
  });

  app.post('/notifications/read-all', async (req) => {
    const a = requireWorkspace(req);
    requireUserSession(req); // datos personales: nunca accesibles con una API key
    await deps.db.tenant(a.workspaceId, (q) => q.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND workspace_id = $2 AND read_at IS NULL`, [a.userId, a.workspaceId]));
    return { ok: true };
  });

  app.get('/workspace/export', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const data = await deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      // Solo los módulos que el rol puede leer (un admin no exporta lo que no puede ver en la interfaz).
      const readable = ws.blueprint.modules.filter((m) => hasRole(a.role, m.permissions.read)).map((m) => m.key);
      const records = await q.query(
        `SELECT id, module_key, data, created_at, updated_at FROM records WHERE workspace_id = $1 AND deleted_at IS NULL AND module_key = ANY($2::text[]) ORDER BY module_key, created_at LIMIT 100000`,
        [a.workspaceId, readable],
      );
      const notes = await q.query(
        `SELECT n.id, n.record_id, n.body, n.created_at FROM notes n JOIN records r ON r.id = n.record_id AND r.workspace_id = n.workspace_id
          WHERE n.workspace_id = $1 AND n.deleted_at IS NULL AND r.module_key = ANY($2::text[]) LIMIT 100000`,
        [a.workspaceId, readable],
      );
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'workspace.exported', ip: req.ip, meta: { records: records.rows.length, modules: readable } });
      // Mismo filtro que GET /api/blueprint: tampoco paneles, formularios ni automatizaciones de módulos no legibles.
      const blueprint = blueprintForRole(ws.blueprint, a.role);
      return { exportedAt: new Date().toISOString(), workspace: { name: ws.name, version: ws.version, settings: ws.settings }, blueprint, records: records.rows, notes: notes.rows };
    });
    reply.header('Content-Disposition', `attachment; filename="cortex-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  });
}
