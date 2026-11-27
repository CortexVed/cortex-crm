import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ROLES, ROLE_RANK, type Role } from '../../../shared/constants';
import { appBaseUrl, type AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { burnPasswordCheck, hashPassword, newId, randomToken, safeEqual, sha256, verifyPassword } from '../lib/crypto';
import { AppError, badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../lib/errors';
import { emailTemplate } from '../lib/mailer';
import { provisionWorkspace } from '../workspace/provision';
import { LOCALES } from '../../../shared/i18n';
import { currentLocale, msg, t } from '../i18n';
import { cookieOptions, requireAuth, requireUserSession, SESSION_COOKIE, SESSION_TTL_DAYS } from './plugin';

export const PasswordSchema = z
  .string()
  .min(10, msg('La contraseña debe tener al menos 10 caracteres'))
  .max(200)
  .refine((p) => /[A-Za-zÀ-ÿ]/.test(p) && /[0-9\W_]/.test(p), msg('Combina letras con números o símbolos'));
export const EmailSchema = z.string().trim().toLowerCase().email(msg('Email inválido')).max(254);
const NameSchema = z.string().trim().min(2, msg('Nombre demasiado corto')).max(80);

const STRICT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const LocaleSchema = z.enum(LOCALES);
// Zona horaria IANA del navegador de quien crea la organización (p. ej. 'America/Sao_Paulo').
const TimezoneSchema = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  });
const VERY_STRICT = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

export async function createSession(deps: AppDeps, req: FastifyRequest, reply: FastifyReply, userId: string, workspaceId: string | null) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await deps.db.query(
    `INSERT INTO sessions (id, user_id, workspace_id, csrf_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sha256(token), userId, workspaceId, csrf, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), expires.toISOString()],
  );
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(deps.config, SESSION_TTL_DAYS * 86_400));
  return { csrf, sessionId: sha256(token) };
}

export async function buildMe(deps: AppDeps, userId: string, sessionId: string | null) {
  const u = (await deps.db.query(`SELECT id, name, email, email_verified_at, is_platform_admin, locale FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u) throw unauthorized();
  const s = sessionId ? (await deps.db.query(`SELECT workspace_id, csrf_token FROM sessions WHERE id = $1`, [sessionId])).rows[0] : null;
  const ws = (
    await deps.db.query(
      `SELECT w.id, w.name, w.slug, w.blueprint_version, w.settings->>'locale' AS locale, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId],
    )
  ).rows;
  const current = ws.find((w: any) => w.id === s?.workspace_id) ?? null;
  return {
    // locale: idioma de la interfaz que eligió (null = el de la organización); workspace.locale: «Idioma y región».
    user: { id: u.id, name: u.name, email: u.email, emailVerified: !!u.email_verified_at, isPlatformAdmin: u.is_platform_admin, locale: (u.locale as string | null) ?? null },
    workspace: current ? { id: current.id, name: current.name, slug: current.slug, role: current.role as Role, version: current.blueprint_version, locale: (current.locale as string | null) ?? 'es-ES' } : null,
    workspaces: ws.map((w: any) => ({ id: w.id, name: w.name, role: w.role })),
    csrfToken: s?.csrf_token ?? null,
    features: {
      emailEnabled: deps.mailer.enabled,
      signupEnabled: deps.config.allowSignup,
      // Instalación sin administración de plataforma y con token de instalación configurado.
      platformSetupAvailable: !!deps.config.platformAdminSetupToken && !u.is_platform_admin && !(await anyPlatformAdmin(deps)),
    },
  };
}

async function anyPlatformAdmin(deps: Pick<AppDeps, 'db'>): Promise<boolean> {
  return (await deps.db.query(`SELECT 1 FROM users WHERE is_platform_admin LIMIT 1`)).rows.length > 0;
}

export function createInviteToken(deps: AppDeps, data: { workspaceId: string; email: string; role: Role; createdBy: string }) {
  return createToken(deps, 'invite', { ...data, ttlHours: 24 * 7 });
}

async function createToken(deps: AppDeps, kind: 'password_reset' | 'email_verification' | 'invite', data: { userId?: string; workspaceId?: string; email?: string; role?: Role; createdBy?: string; ttlHours: number }) {
  const token = randomToken(32);
  await deps.db.query(
    `INSERT INTO auth_tokens (id, kind, token_hash, user_id, workspace_id, email, role, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), kind, sha256(token), data.userId ?? null, data.workspaceId ?? null, data.email ?? null, data.role ?? null, data.createdBy ?? null, new Date(Date.now() + data.ttlHours * 3_600_000).toISOString()],
  );
  return token;
}

async function consumeToken(deps: AppDeps, kind: string, token: string) {
  const r = await deps.db.query(
    `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING *`,
    [sha256(token), kind],
  );
  return r.rows[0] ?? null;
}

export async function sendVerification(deps: AppDeps, req: FastifyRequest, user: { id: string; email: string }) {
  const token = await createToken(deps, 'email_verification', { userId: user.id, ttlHours: 48 });
  const url = `${appBaseUrl(deps, req)}/verify-email?token=${encodeURIComponent(token)}`;
  const mail = emailTemplate(t('Verifica tu correo'), t('Confirma tu dirección de email para asegurar tu cuenta de Cortex CRM.'), { label: t('Verificar email'), url }, t('El enlace caduca en 48 horas.'));
  await deps.mailer.send({ to: user.email, subject: t('Verifica tu correo — Cortex CRM'), ...mail }).catch((e) => req.log.error({ err: (e as Error).message }, 'Fallo al enviar verificación'));
}

/**
 * Enlace de restablecimiento. Solo el último enlace de cada persona es válido. Los que genera un
 * propietario quedan ligados a su organización y duran 30 minutos (al usarlos se revalida todo).
 */
export async function createPasswordResetLink(deps: AppDeps, req: FastifyRequest, userId: string, opts: { createdBy?: string; workspaceId?: string } = {}) {
  await revokeResetTokens(deps, userId);
  const token = await createToken(deps, 'password_reset', { userId, createdBy: opts.createdBy, workspaceId: opts.workspaceId, ttlHours: opts.createdBy ? 0.5 : 1 });
  return `${appBaseUrl(deps, req)}/reset-password?token=${encodeURIComponent(token)}`;
}

/** Invalida los enlaces de restablecimiento pendientes de una persona. */
export async function revokeResetTokens(deps: { db: AppDeps['db'] }, userId: string) {
  await deps.db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = 'password_reset' AND used_at IS NULL`, [userId]);
}

/** Un enlace generado por un propietario solo vale si las condiciones de cuando se creó SIGUEN cumpliéndose. */
async function ownerResetLinkStillValid(deps: AppDeps, tok: { user_id: string; workspace_id: string | null; created_by: string }): Promise<boolean> {
  if (!tok.workspace_id) return false;
  const r = (
    await deps.db.query(
      `SELECT u.is_platform_admin,
              (SELECT count(*)::int FROM memberships m WHERE m.user_id = u.id) AS orgs,
              (SELECT role FROM memberships m WHERE m.user_id = u.id AND m.workspace_id = $2) AS target_role,
              (SELECT role FROM memberships m WHERE m.user_id = $3 AND m.workspace_id = $2) AS creator_role
         FROM users u WHERE u.id = $1`,
      [tok.user_id, tok.workspace_id, tok.created_by],
    )
  ).rows[0];
  return !!r && !r.is_platform_admin && r.orgs === 1 && !!r.target_role && r.target_role !== 'owner' && r.creator_role === 'owner' && tok.created_by !== tok.user_id;
}

const MAX_FAILED_LOGINS = 10;
const LOCKED_MESSAGE = msg('Cuenta bloqueada temporalmente por demasiados intentos. Prueba en unos minutos.');

/**
 * Reserva atómica de un intento de contraseña ANTES de comprobarla: aunque lleguen muchas peticiones en
 * paralelo, como mucho se comprueban MAX_FAILED_LOGINS contraseñas por ventana de bloqueo.
 */
async function reservePasswordAttempt(deps: AppDeps, userId: string): Promise<number | null> {
  const r = await deps.db.query<{ failed_logins: number }>(
    `UPDATE users SET failed_logins = failed_logins + 1
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now()) AND failed_logins < $2
      RETURNING failed_logins`,
    [userId, MAX_FAILED_LOGINS],
  );
  if (r.rows[0]) return r.rows[0].failed_logins;
  await deps.db.query(
    `UPDATE users SET locked_until = now() + interval '15 minutes', failed_logins = 0
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now()) AND failed_logins >= $2`,
    [userId, MAX_FAILED_LOGINS],
  );
  return null;
}

async function registerFailedAttempt(deps: AppDeps, req: FastifyRequest, userId: string, attempt: number, opts: { killSessions?: boolean } = {}) {
  if (attempt >= MAX_FAILED_LOGINS) {
    await deps.db.query(`UPDATE users SET locked_until = now() + interval '15 minutes', failed_logins = 0 WHERE id = $1`, [userId]);
    if (opts.killSessions) await deps.db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await audit(deps.db, { workspaceId: null, actorId: userId, action: 'auth.account_locked', ip: req.ip });
  }
  await audit(deps.db, { workspaceId: null, actorId: userId, action: 'auth.login_failed', ip: req.ip });
}

/** Tras una comprobación correcta: limpia el contador salvo que la cuenta se haya bloqueado mientras tanto. */
async function clearPasswordAttempts(deps: AppDeps, userId: string): Promise<boolean> {
  const r = await deps.db.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now()) RETURNING id`, [userId]);
  return !!r.rowCount;
}

async function notifyPasswordChanged(deps: AppDeps, req: FastifyRequest, userId: string, byOwnerOf?: string) {
  if (!deps.mailer.enabled) return;
  const u = (await deps.db.query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u) return;
  const intro = byOwnerOf
    ? t('Un propietario de «{workspace}» ha restablecido la contraseña de tu cuenta de Cortex CRM. Se han cerrado tus sesiones y revocado las API keys creadas desde tu cuenta.', { workspace: byOwnerOf })
    : t('Se ha restablecido la contraseña de tu cuenta de Cortex CRM. Se han cerrado tus sesiones y revocado las API keys creadas desde tu cuenta.');
  const mail = emailTemplate(t('Tu contraseña ha cambiado'), intro, { label: t('Iniciar sesión'), url: `${appBaseUrl(deps, req)}/login` }, t('Si no has sido tú, contacta con el propietario de tu organización inmediatamente.'));
  await deps.mailer.send({ to: u.email, subject: t('Tu contraseña ha cambiado — Cortex CRM'), ...mail }).catch((e) => req.log.error({ err: (e as Error).message }, 'Fallo al enviar aviso de cambio de contraseña'));
}

export async function authRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/config', async () => ({ signupEnabled: deps.config.allowSignup, emailEnabled: deps.mailer.enabled }));

  app.post('/register', STRICT, async (req, reply) => {
    if (!deps.config.allowSignup) throw forbidden('El registro público está desactivado. Pide una invitación.');
    // locale: idioma de la organización nueva (interfaz por defecto, CRM inicial y etiquetas que cree la IA).
    const body = z.object({ name: NameSchema, email: EmailSchema, password: PasswordSchema, workspaceName: z.string().trim().min(2).max(80), locale: LocaleSchema.optional(), timezone: TimezoneSchema.optional() }).parse(req.body);
    const exists = await deps.db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [body.email]);
    if (exists.rows.length) throw conflict('Ya existe una cuenta con ese email. Inicia sesión.');
    // El rol de administrador de plataforma en producción SOLO se concede por CLI (dist/server/cli.js),
    // nunca desde la web. En desarrollo y tests, por comodidad, el primer usuario lo es.
    const anyAdmin = (await deps.db.query(`SELECT 1 FROM users WHERE is_platform_admin LIMIT 1`)).rows.length > 0;
    const isPlatformAdmin = !deps.config.isProd && !anyAdmin;
    const userId = newId();
    await deps.db.query(`INSERT INTO users (id, email, name, password_hash, is_platform_admin, last_login_at) VALUES ($1,$2,$3,$4,$5,now())`, [
      userId,
      body.email,
      body.name,
      await hashPassword(body.password),
      isPlatformAdmin,
    ]);
    const workspaceId = await provisionWorkspace(deps.db, { name: body.workspaceName, ownerId: userId, locale: body.locale ?? currentLocale(), timezone: body.timezone });
    const { sessionId } = await createSession(deps, req, reply, userId, workspaceId);
    await audit(deps.db, { workspaceId, actorId: userId, action: 'auth.register', ip: req.ip, meta: { platformAdmin: isPlatformAdmin } });
    await sendVerification(deps, req, { id: userId, email: body.email });
    return buildMe(deps, userId, sessionId);
  });

  app.post('/login', STRICT, async (req, reply) => {
    const body = z.object({ email: EmailSchema, password: z.string().min(1).max(200) }).parse(req.body);
    const u = (await deps.db.query(`SELECT id, password_hash FROM users WHERE lower(email) = $1`, [body.email])).rows[0];
    if (!u) {
      await burnPasswordCheck(body.password);
      throw unauthorized('Email o contraseña incorrectos');
    }
    const attempt = await reservePasswordAttempt(deps, u.id);
    if (attempt === null) throw tooMany(LOCKED_MESSAGE);
    if (!(await verifyPassword(body.password, u.password_hash))) {
      await registerFailedAttempt(deps, req, u.id, attempt);
      throw unauthorized('Email o contraseña incorrectos');
    }
    // Si la cuenta se bloqueó mientras se comprobaba (ráfaga en paralelo), una contraseña correcta no la desbloquea.
    if (!(await clearPasswordAttempts(deps, u.id))) throw tooMany(LOCKED_MESSAGE);
    await deps.db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    const ws = (await deps.db.query(`SELECT workspace_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [u.id])).rows[0];
    const { sessionId } = await createSession(deps, req, reply, u.id, ws?.workspace_id ?? null);
    await audit(deps.db, { workspaceId: ws?.workspace_id ?? null, actorId: u.id, action: 'auth.login', ip: req.ip });
    return buildMe(deps, u.id, sessionId);
  });

  app.post('/logout', async (req, reply) => {
    if (req.auth?.sessionId) await deps.db.query(`DELETE FROM sessions WHERE id = $1`, [req.auth.sessionId]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const a = requireUserSession(req);
    return buildMe(deps, a.userId, a.sessionId);
  });

  // Idioma de la interfaz de la persona (null: el de su organización). Se guarda en su cuenta, para todos sus dispositivos.
  app.put('/me/locale', async (req) => {
    const a = requireUserSession(req);
    const { locale } = z.object({ locale: LocaleSchema.nullable() }).parse(req.body);
    await deps.db.query(`UPDATE users SET locale = $1 WHERE id = $2`, [locale, a.userId]);
    return buildMe(deps, a.userId, a.sessionId);
  });

  app.post('/switch-workspace', async (req) => {
    const a = requireUserSession(req);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(req.body);
    const m = await deps.db.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND workspace_id = $2`, [a.userId, workspaceId]);
    if (!m.rows.length) throw forbidden('No perteneces a esa organización');
    await deps.db.query(`UPDATE sessions SET workspace_id = $1 WHERE id = $2`, [workspaceId, a.sessionId]);
    return buildMe(deps, a.userId, a.sessionId);
  });

  app.post('/workspaces', STRICT, async (req) => {
    const a = requireUserSession(req);
    const { name, timezone } = z.object({ name: z.string().trim().min(2).max(80), timezone: TimezoneSchema.optional() }).parse(req.body);
    const owned = await deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND role = 'owner'`, [a.userId]);
    if ((owned.rows[0]?.n ?? 0) >= 10) throw forbidden('Has alcanzado el máximo de organizaciones propias');
    const id = await provisionWorkspace(deps.db, { name, ownerId: a.userId, locale: currentLocale(), timezone });
    await deps.db.query(`UPDATE sessions SET workspace_id = $1 WHERE id = $2`, [id, a.sessionId]);
    await audit(deps.db, { workspaceId: id, actorId: a.userId, action: 'workspace.create', ip: req.ip });
    return buildMe(deps, a.userId, a.sessionId);
  });

  app.get('/sessions', async (req) => {
    const a = requireUserSession(req);
    const r = await deps.db.query(`SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, [a.userId]);
    return r.rows.map((s: any) => ({ id: s.id.slice(0, 16), current: s.id === a.sessionId, ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at }));
  });

  app.delete('/sessions/:id', async (req) => {
    const a = requireUserSession(req);
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }).parse(req.params);
    const r = await deps.db.query(`DELETE FROM sessions WHERE user_id = $1 AND left(id, 16) = $2 AND id <> $3`, [a.userId, id, a.sessionId]);
    if (!r.rowCount) throw notFound('Sesión no encontrada');
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'auth.session_revoked', ip: req.ip });
    return { ok: true };
  });

  app.post('/logout-all', async (req) => {
    const a = requireUserSession(req);
    await deps.db.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [a.userId, a.sessionId]);
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'auth.logout_all', ip: req.ip });
    return { ok: true };
  });

  app.post('/password/forgot', VERY_STRICT, async (req) => {
    const { email } = z.object({ email: EmailSchema }).parse(req.body);
    const u = (await deps.db.query(`SELECT id, email FROM users WHERE lower(email) = $1`, [email])).rows[0];
    if (u) {
      const url = await createPasswordResetLink(deps, req, u.id); // invalida los enlaces anteriores
      const mail = emailTemplate(t('Restablecer contraseña'), t('Has solicitado restablecer tu contraseña de Cortex CRM.'), { label: t('Elegir nueva contraseña'), url }, t('Si no lo has solicitado, ignora este mensaje. El enlace caduca en 1 hora.'));
      await deps.mailer.send({ to: u.email, subject: t('Restablecer contraseña — Cortex CRM'), ...mail }).catch((e) => req.log.error({ err: (e as Error).message }, 'Fallo al enviar recuperación'));
      await audit(deps.db, { workspaceId: null, actorId: u.id, action: 'auth.password_reset_requested', ip: req.ip });
    }
    // Respuesta idéntica exista o no la cuenta (no permite enumerar usuarios).
    return { ok: true, emailEnabled: deps.mailer.enabled };
  });

  app.post('/password/reset', STRICT, async (req) => {
    const body = z.object({ token: z.string().min(20).max(200), password: PasswordSchema }).parse(req.body);
    const tok = await consumeToken(deps, 'password_reset', body.token);
    if (!tok) throw badRequest('El enlace no es válido o ha caducado');
    let ownerOf: string | undefined;
    if (tok.created_by) {
      // Enlace generado por un propietario: todas las condiciones se revalidan AHORA (no solo al crearlo).
      if (!(await ownerResetLinkStillValid(deps, tok))) {
        await audit(deps.db, { workspaceId: tok.workspace_id, actorId: tok.created_by, action: 'auth.owner_reset_link_refused', targetType: 'user', targetId: tok.user_id, ip: req.ip });
        throw badRequest('El enlace ya no es válido. Pide uno nuevo.');
      }
      ownerOf = (await deps.db.query(`SELECT name FROM workspaces WHERE id = $1`, [tok.workspace_id])).rows[0]?.name;
    }
    await deps.db.query(`UPDATE users SET password_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2`, [await hashPassword(body.password), tok.user_id]);
    await deps.db.query(`DELETE FROM sessions WHERE user_id = $1`, [tok.user_id]);
    await revokeResetTokens(deps, tok.user_id);
    // Recuperar una cuenta revoca las API keys creadas desde ella (quien la tuvo comprometida pudo crearlas).
    const keys = await deps.db.query(`UPDATE api_keys SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL`, [tok.user_id]);
    await audit(deps.db, { workspaceId: tok.workspace_id ?? null, actorId: tok.user_id, action: 'auth.password_reset', ip: req.ip, meta: { byOwner: !!tok.created_by, apiKeysRevoked: keys.rowCount } });
    await notifyPasswordChanged(deps, req, tok.user_id, ownerOf);
    return { ok: true, apiKeysRevoked: keys.rowCount ?? 0 };
  });

  app.post('/password/change', STRICT, async (req) => {
    const a = requireUserSession(req);
    const body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: PasswordSchema }).parse(req.body);
    const u = (await deps.db.query(`SELECT password_hash FROM users WHERE id = $1`, [a.userId])).rows[0];
    if (!u) throw unauthorized();
    // Adivinar la contraseña actual cuenta para el mismo bloqueo que el login (y tras el límite cierra las sesiones).
    const attempt = await reservePasswordAttempt(deps, a.userId);
    if (attempt === null) throw tooMany(LOCKED_MESSAGE);
    if (!(await verifyPassword(body.currentPassword, u.password_hash))) {
      await registerFailedAttempt(deps, req, a.userId, attempt, { killSessions: true });
      throw new AppError(400, 'invalid_password', 'La contraseña actual no es correcta');
    }
    if (!(await clearPasswordAttempts(deps, a.userId))) throw tooMany(LOCKED_MESSAGE);
    await deps.db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(body.newPassword), a.userId]);
    await deps.db.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [a.userId, a.sessionId]);
    await revokeResetTokens(deps, a.userId);
    await audit(deps.db, { workspaceId: a.workspaceId, actorId: a.userId, action: 'auth.password_changed', ip: req.ip });
    return { ok: true };
  });

  app.post('/verify-email', STRICT, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    const tok = await consumeToken(deps, 'email_verification', token);
    if (!tok) throw badRequest('El enlace no es válido o ha caducado');
    // Verificar el email solo prueba la posesión del buzón: NUNCA concede privilegios (el rol de
    // plataforma se concede únicamente por CLI).
    await deps.db.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [tok.user_id]);
    await audit(deps.db, { workspaceId: null, actorId: tok.user_id, action: 'auth.email_verified', ip: req.ip });
    return { ok: true };
  });

  // Instalación nueva (p. ej. desde la plantilla de Railway): quien demuestre conocer el token de instalación
  // (PLATFORM_ADMIN_SETUP_TOKEN, visible solo para quien accede a las variables del despliegue) pasa a ser
  // administrador de la plataforma. Solo mientras no haya ninguno: después, la CLI del contenedor.
  app.post('/platform-admin/claim', VERY_STRICT, async (req) => {
    const a = requireUserSession(req);
    const { token } = z.object({ token: z.string().trim().min(1).max(256) }).parse(req.body);
    const expected = deps.config.platformAdminSetupToken;
    if (!expected) throw notFound('Esta instalación no tiene token de instalación');
    if (await anyPlatformAdmin(deps)) throw conflict('La plataforma ya tiene administración. Para añadir a más personas usa la CLI del contenedor.');
    if (!safeEqual(sha256(token), sha256(expected))) {
      await audit(deps.db, { workspaceId: null, actorId: a.userId, action: 'platform.admin_claim_failed', ip: req.ip });
      throw forbidden('El token de instalación no es correcto');
    }
    await deps.db.tx(async (q) => {
      // Dos reclamaciones simultáneas: solo la primera llega a conceder el rol.
      if (deps.db.kind === 'pg') await q.query('SELECT pg_advisory_xact_lock($1)', [7_270_428]);
      if ((await q.query(`SELECT 1 FROM users WHERE is_platform_admin LIMIT 1`)).rows.length) throw conflict('La plataforma ya tiene administración.');
      await q.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [a.userId]);
      await audit(q, { workspaceId: null, actorId: a.userId, action: 'platform.admin_granted_by_setup_token', ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/verify-email/resend', VERY_STRICT, async (req) => {
    const a = requireUserSession(req);
    if (a.emailVerified) return { ok: true, alreadyVerified: true };
    await sendVerification(deps, req, { id: a.userId, email: a.email });
    return { ok: true, emailEnabled: deps.mailer.enabled };
  });

  app.get('/invite/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.params);
    const r = await deps.db.query(
      `SELECT t.email, t.role, w.name AS workspace_name, (SELECT 1 FROM users u WHERE lower(u.email) = lower(t.email)) AS user_exists
       FROM auth_tokens t JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.token_hash = $1 AND t.kind = 'invite' AND t.used_at IS NULL AND t.expires_at > now()`,
      [sha256(token)],
    );
    const inv = r.rows[0];
    if (!inv) throw notFound('Invitación no válida o caducada');
    return { email: inv.email, role: inv.role, workspaceName: inv.workspace_name, userExists: !!inv.user_exists };
  });

  app.post('/invite/accept', STRICT, async (req, reply) => {
    const body = z.object({ token: z.string().min(20).max(200), name: NameSchema.optional(), password: PasswordSchema.optional() }).parse(req.body);
    const pending = (await deps.db.query(`SELECT * FROM auth_tokens WHERE token_hash = $1 AND kind = 'invite' AND used_at IS NULL AND expires_at > now()`, [sha256(body.token)])).rows[0];
    if (!pending) throw badRequest('Invitación no válida o caducada');
    const role: Role = ROLES.includes(pending.role) && ROLE_RANK[pending.role as Role] < ROLE_RANK.owner ? pending.role : 'member';
    // La invitación solo vale mientras quien la envió conserve permiso para conceder ese rol
    // (si lo eliminan o lo degradan, sus invitaciones pendientes dejan de servir).
    const creator = pending.created_by ? (await deps.db.query(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [pending.workspace_id, pending.created_by])).rows[0] : null;
    const canGrant = !!creator && (role === 'admin' ? creator.role === 'owner' : ROLE_RANK[creator.role as Role] >= ROLE_RANK.admin);
    if (!canGrant) throw badRequest('La invitación ya no es válida: quien la envió ya no tiene permiso para concederla.');
    const existing = (await deps.db.query(`SELECT id, email_verified_at FROM users WHERE lower(email) = lower($1)`, [pending.email])).rows[0];
    if (existing) {
      // La invitación solo puede aceptarla la propia cuenta invitada, con sesión iniciada.
      if (!req.auth?.sessionId || req.auth.userId !== existing.id) throw forbidden('Inicia sesión con la cuenta invitada para aceptar');
      // Con correo activo, la cuenta debe haber demostrado que el buzón es suyo: así nadie que registre el
      // email de otra persona puede aceptar las invitaciones que se le envían.
      if (deps.mailer.enabled && !existing.email_verified_at) throw forbidden('Verifica tu email antes de aceptar la invitación (revisa tu correo o pide un nuevo enlace en «Mi cuenta»).');
    } else if (!body.name || !body.password) {
      throw badRequest('Indica tu nombre y una contraseña para crear la cuenta');
    }
    // El token se consume ANTES de crear nada: dos aceptaciones simultáneas no pueden crear dos cuentas.
    const tok = await consumeToken(deps, 'invite', body.token);
    if (!tok) throw badRequest('Invitación no válida o caducada');
    let userId: string;
    if (existing) userId = existing.id;
    else {
      userId = newId();
      // El email solo se da por verificado si ESTA invitación se entregó por correo (entonces el enlace
      // nunca se devolvió a quien invita); si el envío falló o no hay correo, queda pendiente de verificación.
      await deps.db.query(`INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES ($1,$2,$3,$4,${tok.delivered === true ? 'now()' : 'NULL'})`, [userId, tok.email, body.name!, await hashPassword(body.password!)]);
    }
    await deps.db.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [tok.workspace_id, userId, role]);
    // Al pertenecer a otra organización, los enlaces de restablecimiento pendientes dejan de valer.
    await revokeResetTokens(deps, userId);
    await audit(deps.db, { workspaceId: tok.workspace_id, actorId: userId, action: 'workspace.invite_accepted', ip: req.ip, meta: { role } });
    if (req.auth?.sessionId && req.auth.userId === userId) {
      await deps.db.query(`UPDATE sessions SET workspace_id = $1 WHERE id = $2`, [tok.workspace_id, req.auth.sessionId]);
      return buildMe(deps, userId, req.auth.sessionId);
    }
    const { sessionId } = await createSession(deps, req, reply, userId, tok.workspace_id);
    return buildMe(deps, userId, sessionId);
  });
  void requireAuth;
}
