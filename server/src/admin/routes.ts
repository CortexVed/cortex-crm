import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findModule, BlueprintSchema } from '../../../shared/blueprint';
import type { AppDeps } from '../deps';
import { newId } from '../lib/crypto';
import { AppError, badRequest, notFound } from '../lib/errors';
import { sanitizeUrl } from '../lib/urls';

const CLIENT_ERRORS_PER_HOUR = 300;
import { metricsSnapshot } from '../lib/metrics';
import { requirePlatformAdmin } from '../auth/plugin';
import { makeRecordService, loadWorkspace } from '../crm/context';

export async function adminRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/admin/overview', async (req) => {
    requirePlatformAdmin(req);
    const [ws, users, jobs, errors, llm] = await Promise.all([
      deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspaces`),
      deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
      deps.db.query(`SELECT status, count(*)::int AS n FROM jobs WHERE created_at > now() - interval '7 days' GROUP BY status`),
      deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM error_events WHERE created_at > now() - interval '24 hours'`),
      deps.db.query(`SELECT provider, count(*)::int AS requests, count(*) FILTER (WHERE NOT ok)::int AS errors, COALESCE(sum(cost_usd),0)::float8 AS cost_usd FROM llm_usage WHERE created_at > now() - interval '24 hours' GROUP BY provider`),
    ]);
    const c = deps.config;
    return {
      workspaces: ws.rows[0].n,
      users: users.rows[0].n,
      jobs: jobs.rows,
      errors24h: errors.rows[0].n,
      llm24h: llm.rows,
      config: {
        env: c.env,
        role: c.role,
        appUrl: !!c.appUrl,
        email: !!c.email,
        signupOpen: c.allowSignup,
        platformLlmKeys: Object.fromEntries(Object.entries(c.platformLlmKeys).map(([k, v]) => [k, !!v && c.allowPlatformLlmKeys])),
        database: deps.db.kind,
      },
    };
  });

  app.get('/admin/metrics', async (req) => {
    requirePlatformAdmin(req);
    return metricsSnapshot();
  });

  app.get('/admin/errors', async (req) => {
    requirePlatformAdmin(req);
    return (await deps.db.query(`SELECT id, workspace_id, source, message, context, created_at FROM error_events ORDER BY created_at DESC LIMIT 100`)).rows;
  });

  app.get('/admin/jobs', async (req) => {
    requirePlatformAdmin(req);
    return (await deps.db.query(`SELECT id, workspace_id, type, status, attempts, last_error, run_at, created_at, finished_at FROM jobs ORDER BY created_at DESC LIMIT 100`)).rows;
  });
}

/** Rutas públicas (sin sesión): formularios de captación y registro de errores del cliente. */
export async function publicRoutes(app: FastifyInstance, deps: AppDeps) {
  const findForm = async (slug: string, formKey: string) => {
    const w = (await deps.db.query(`SELECT id FROM workspaces WHERE slug = $1`, [slug])).rows[0];
    if (!w) throw notFound('Formulario no encontrado');
    return deps.db.tenant(w.id, async (q) => {
      const ws = await loadWorkspace(q, w.id);
      const form = ws.blueprint.forms.find((f) => f.key === formKey && f.public);
      if (!form) throw notFound('Formulario no encontrado');
      return { ws, form };
    });
  };

  app.get('/public/forms/:slug/:form', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { slug, form } = z.object({ slug: z.string().max(80), form: z.string().max(40) }).parse(req.params);
    const { ws, form: f } = await findForm(slug, form);
    const mod = findModule(ws.blueprint, f.module)!;
    return {
      organization: ws.name,
      name: f.name,
      submitLabel: f.submitLabel,
      fields: f.fields.map((k) => {
        const fd = mod.fields.find((x) => x.key === k)!;
        return { key: fd.key, label: fd.label, type: fd.type, required: fd.required, options: fd.options, helpText: fd.helpText };
      }),
    };
  });

  app.post('/public/forms/:slug/:form', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const { slug, form } = z.object({ slug: z.string().max(80), form: z.string().max(40) }).parse(req.params);
    const body = z.object({ values: z.record(z.string(), z.unknown()), website: z.string().max(200).optional() }).parse(req.body);
    const { ws, form: f } = await findForm(slug, form);
    // Honeypot: los bots rellenan el campo oculto "website".
    if (body.website) return { ok: true, message: f.successMessage };
    const allowed = Object.fromEntries(Object.entries(body.values).filter(([k]) => f.fields.includes(k)));
    try {
      await deps.db.tenant(ws.id, async (q) => {
        const svc = makeRecordService(q, ws, { type: 'system', id: null }, deps.now);
        await svc.create(f.module, { ...f.defaults, ...allowed });
      });
    } catch (e) {
      // Un duplicado (p. ej. email ya registrado) se acepta en silencio: el formulario público no debe
      // revelar si alguien ya es cliente. El resto de errores de validación sí se devuelven.
      const fields = (e as AppError)?.details as { fields?: { message: string }[] } | undefined;
      const onlyDuplicates = e instanceof AppError && e.status === 422 && !!fields?.fields?.length && fields.fields.every((x) => x.message === 'Ya existe un registro con este valor');
      if (!onlyDuplicates) throw e;
    }
    return { ok: true, message: f.successMessage };
  });

  app.post('/client-errors', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ message: z.string().max(2000), stack: z.string().max(8000).optional(), url: z.string().max(500).optional() }).parse(req.body);
    // Endpoint sin autenticar: tope global por hora y sin duplicados recientes, para que nadie pueda
    // inundar la consola de la plataforma ni hacer crecer la base de datos rotando IPs.
    const recent = (
      await deps.db.query<{ total: number; dup: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE message = $1)::int AS dup FROM error_events WHERE source = 'web' AND created_at > now() - interval '1 hour'`,
        [body.message],
      )
    ).rows[0];
    if (recent.total >= CLIENT_ERRORS_PER_HOUR || recent.dup >= 20) return { ok: true };
    await deps.db.query(`INSERT INTO error_events (id, workspace_id, user_id, source, message, stack, context) VALUES ($1,$2,$3,'web',$4,$5,$6)`, [
      newId(),
      req.auth?.workspaceId ?? null,
      req.auth?.userId ?? null,
      body.message,
      // Las trazas del navegador pueden incluir URLs con tokens: solo se guardan con sesión.
      req.auth?.sessionId ? (body.stack ?? null) : null,
      // Las rutas pueden llevar tokens (/invite/<token>): se enmascaran antes de guardarlas.
      JSON.stringify({ url: body.url ? sanitizeUrl(body.url) : undefined }),
    ]);
    return { ok: true };
  });
  void badRequest;
  void BlueprintSchema;
}
