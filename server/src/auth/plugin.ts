import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasRole, ROLE_RANK, type Role } from '../../../shared/constants';
import type { Db } from '../db/db';
import { safeEqual, sha256 } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import type { AppConfig } from '../config';
import { applyIdentityLocale, t } from '../i18n';

export const SESSION_COOKIE = 'evolve_session';
export const SESSION_TTL_DAYS = 14;
export const SESSION_MAX_DAYS = 90;

export interface AuthContext {
  userId: string;
  userName: string;
  email: string;
  workspaceId: string | null;
  role: Role | null;
  sessionId: string | null;
  apiKeyId: string | null;
  isPlatformAdmin: boolean;
  csrfToken: string | null;
  emailVerified: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    rawBody?: Buffer;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT = [/^\/api\/hooks\//, /^\/api\/public\//, /^\/api\/client-errors$/];

export function expectedOrigins(req: FastifyRequest, config: AppConfig): string[] {
  const out: string[] = [];
  if (config.appUrl) out.push(new URL(config.appUrl).origin);
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (host) out.push(`${req.protocol}://${host}`);
  return out;
}

export function cookieOptions(config: AppConfig, maxAgeSec: number) {
  return { httpOnly: true, secure: config.isProd, sameSite: 'lax' as const, path: '/', maxAge: maxAgeSec };
}

export function registerAuth(app: FastifyInstance, deps: { db: Db; config: AppConfig }) {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Se usa la ruta ya resuelta por el router (o la ruta decodificada) para que codificaciones como
    // "/%61pi/..." no se salten la autenticación ni la protección CSRF.
    let rawPath = req.url.split('?')[0];
    try {
      rawPath = decodeURIComponent(rawPath);
    } catch {
      /* ruta mal codificada: se evalúa tal cual */
    }
    // Rutas inexistentes: no hay nada que autorizar (responden 404) y así no se consulta la base de datos.
    if (!req.routeOptions?.url) return;
    const path = req.routeOptions.url ?? rawPath;
    if (!path.startsWith('/api/')) return;
    const mutating = !SAFE_METHODS.has(req.method);

    // 1) API keys de organización (integraciones / API pública). No usan cookies => sin CSRF.
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) {
      const token = authz.slice(7).trim();
      if (!token.startsWith('evk_')) throw unauthorized('Token inválido');
      // La clave solo es válida mientras su creador siga siendo miembro, y nunca con más rol que él.
      const r = await deps.db.query(
        `SELECT k.id, k.workspace_id, k.role, k.created_by, k.last_used_at, k.name AS key_name, u.email, u.locale AS user_locale, m.role AS creator_role,
                w.settings->>'locale' AS org_locale
         FROM api_keys k
         JOIN memberships m ON m.workspace_id = k.workspace_id AND m.user_id = k.created_by
         JOIN workspaces w ON w.id = k.workspace_id
         LEFT JOIN users u ON u.id = k.created_by
         WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
        [sha256(token)],
      );
      const k = r.rows[0];
      if (!k) throw unauthorized('API key inválida o revocada');
      const effectiveRole: Role = ROLE_RANK[k.role as Role] <= ROLE_RANK[k.creator_role as Role] ? k.role : k.creator_role;
      applyIdentityLocale(req, k.user_locale, k.org_locale);
      req.auth = {
        userId: k.created_by,
        userName: `API: ${k.key_name ?? t('integración')}`,
        email: k.email ?? '',
        workspaceId: k.workspace_id,
        role: effectiveRole,
        sessionId: null,
        apiKeyId: k.id,
        isPlatformAdmin: false,
        csrfToken: null,
        emailVerified: true,
      };
      if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 300_000) {
        await deps.db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [k.id]);
      }
      return;
    }

    // 2) Sesión por cookie httpOnly.
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const sid = sha256(token);
      const r = await deps.db.query(
        `SELECT s.id, s.user_id, s.workspace_id, s.csrf_token, s.created_at, s.expires_at, s.last_seen_at,
                u.name, u.email, u.email_verified_at, u.is_platform_admin, u.locale AS user_locale, m.role,
                w.settings->>'locale' AS org_locale
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
         LEFT JOIN workspaces w ON w.id = s.workspace_id AND m.role IS NOT NULL
         WHERE s.id = $1 AND s.expires_at > now()`,
        [sid],
      );
      const s = r.rows[0];
      if (!s) {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
      } else {
        req.auth = {
          userId: s.user_id,
          userName: s.name,
          email: s.email,
          workspaceId: s.role ? s.workspace_id : null,
          role: s.role ?? null,
          sessionId: s.id,
          apiKeyId: null,
          isPlatformAdmin: s.is_platform_admin,
          csrfToken: s.csrf_token,
          emailVerified: !!s.email_verified_at,
        };
        applyIdentityLocale(req, s.user_locale, s.role ? s.org_locale : null);
        // Caducidad deslizante con máximo absoluto.
        const now = Date.now();
        const exp = new Date(s.expires_at).getTime();
        const created = new Date(s.created_at).getTime();
        if (exp - now < (SESSION_TTL_DAYS / 2) * 86_400_000 && now - created < SESSION_MAX_DAYS * 86_400_000) {
          const newExp = new Date(Math.min(now + SESSION_TTL_DAYS * 86_400_000, created + SESSION_MAX_DAYS * 86_400_000));
          await deps.db.query(`UPDATE sessions SET expires_at = $1, last_seen_at = now() WHERE id = $2`, [newExp.toISOString(), sid]);
          reply.setCookie(SESSION_COOKIE, token, cookieOptions(deps.config, Math.floor((newExp.getTime() - now) / 1000)));
        } else if (now - new Date(s.last_seen_at).getTime() > 300_000) {
          await deps.db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [sid]);
        }
        // Protección CSRF: token por sesión en cabecera + comprobación de origen.
        if (mutating && !CSRF_EXEMPT.some((re) => re.test(path))) {
          const header = req.headers['x-csrf-token'];
          if (typeof header !== 'string' || !safeEqual(header, s.csrf_token)) throw forbidden('Token CSRF inválido o ausente');
        }
      }
    }

    if (mutating && !CSRF_EXEMPT.some((re) => re.test(path))) {
      const origin = req.headers.origin;
      if (origin && !expectedOrigins(req, deps.config).includes(origin)) throw forbidden('Origen no permitido');
    }
  });
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export type WorkspaceAuth = AuthContext & { workspaceId: string; role: Role };

export function requireWorkspace(req: FastifyRequest, minRole: Role = 'viewer'): WorkspaceAuth {
  const a = requireAuth(req);
  if (!a.workspaceId || !a.role) throw forbidden('No perteneces a ninguna organización activa');
  if (!hasRole(a.role, minRole)) throw forbidden();
  return a as WorkspaceAuth;
}

export function requireUserSession(req: FastifyRequest): AuthContext {
  const a = requireAuth(req);
  if (!a.sessionId) throw forbidden('Esta acción requiere una sesión de usuario (no disponible con API key)');
  return a;
}

export function requirePlatformAdmin(req: FastifyRequest): AuthContext {
  const a = requireUserSession(req);
  if (!a.isPlatformAdmin) throw forbidden('Solo administradores de la plataforma');
  return a;
}
