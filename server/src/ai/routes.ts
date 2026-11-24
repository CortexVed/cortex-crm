import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_TASKS, AI_TASK_LABELS, hasRole } from '../../../shared/constants';
import type { AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { requireUserSession, requireWorkspace } from '../auth/plugin';
import { AiSettingsInputSchema } from './manager';
import { addMemory, listMemory } from './memory';

/** API del AI PROVIDER MANAGER. Las API keys entran por aquí y NUNCA vuelven a salir. */
export async function aiRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/ai/status', async (req) => {
    const a = requireWorkspace(req);
    const states = await deps.ai.getProviderStates(a.workspaceId);
    const usable = states.filter((s) => s.configured && s.enabled && s.defaultModel && s.id !== 'mock');
    const mock = deps.config.llmEnableMock ? states.filter((s) => s.id === 'mock') : [];
    return { configured: usable.length + mock.length > 0, providers: [...usable, ...mock].map((s) => ({ id: s.id, label: s.label, model: s.defaultModel })) };
  });

  app.get('/ai/providers', async (req) => {
    const a = requireWorkspace(req, 'admin');
    return deps.ai.getProviderStates(a.workspaceId);
  });

  app.put('/ai/providers/:id', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const body = z.object({ apiKey: z.string().max(400).nullable().optional(), enabled: z.boolean().optional(), defaultModel: z.string().max(200).nullable().optional() }).parse(req.body);
    await deps.ai.saveProvider(a.workspaceId, id, body);
    await deps.db.tenant(a.workspaceId, (q) =>
      audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: body.apiKey ? 'ai.provider_key_set' : body.apiKey === null ? 'ai.provider_key_revoked' : 'ai.provider_updated', targetType: 'ai_provider', targetId: id, ip: req.ip, meta: { enabled: body.enabled, defaultModel: body.defaultModel } }),
    );
    return (await deps.ai.getProviderStates(a.workspaceId)).find((s) => s.id === id);
  });

  app.delete('/ai/providers/:id/key', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    await deps.ai.saveProvider(a.workspaceId, id, { apiKey: null });
    await deps.db.tenant(a.workspaceId, (q) => audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'ai.provider_key_revoked', targetType: 'ai_provider', targetId: id, ip: req.ip }));
    return { ok: true };
  });

  app.get('/ai/providers/:id/models', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'admin');
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const { refresh } = z.object({ refresh: z.enum(['0', '1']).optional() }).parse(req.query);
    return deps.ai.listModels(a.workspaceId, id, refresh === '1');
  });

  app.post('/ai/providers/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'admin');
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    return deps.ai.testProvider(a.workspaceId, id);
  });

  app.get('/ai/settings', async (req) => {
    const a = requireWorkspace(req, 'admin');
    const settings = await deps.ai.getSettings(a.workspaceId);
    const routes: Record<string, unknown> = {};
    for (const t of AI_TASKS) routes[t] = await deps.ai.plan(a.workspaceId, t);
    return { settings, tasks: AI_TASKS.map((t) => ({ key: t, label: AI_TASK_LABELS[t] })), effectiveRoutes: routes };
  });

  app.put('/ai/settings', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const body = AiSettingsInputSchema.parse(req.body);
    const saved = await deps.ai.saveSettings(a.workspaceId, body, a.userId);
    await deps.db.tenant(a.workspaceId, (q) => audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'ai.settings_updated', ip: req.ip, meta: { limits: body.limits, defaultProvider: body.defaultProvider, defaultModel: body.defaultModel } }));
    return saved;
  });

  app.get('/ai/usage', async (req) => {
    const a = requireWorkspace(req, 'admin');
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return deps.ai.usage(a.workspaceId, days);
  });

  app.post('/ai/compare', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const body = z
      .object({
        prompt: z.string().trim().min(2).max(8000),
        system: z.string().max(4000).optional(),
        targets: z.array(z.object({ provider: z.string().max(40), model: z.string().max(200) })).min(2).max(4),
      })
      .parse(req.body);
    return { results: await deps.ai.compare(a.workspaceId, { ...body, userId: a.userId }) };
  });

  // ---------------------------------------------------------------- memoria
  app.get('/ai/memory', async (req) => {
    const a = requireWorkspace(req, 'member');
    requireUserSession(req); // datos personales: nunca accesibles con una API key
    return deps.db.tenant(a.workspaceId, (q) => listMemory(q, a.workspaceId, a.userId, { includeUser: true, limit: 200 }));
  });

  app.post('/ai/memory', async (req) => {
    const a = requireWorkspace(req, 'member');
    requireUserSession(req);
    const body = z
      .object({
        scope: z.enum(['org', 'user']),
        kind: z.enum(['decision', 'preference', 'fact', 'instruction']),
        content: z.string().trim().min(3).max(2000),
        // Texto redactado por el asistente (puede venir influido por datos de terceros): se guarda como
        // propuesta y no entra en las instrucciones de la IA hasta que una persona lo confirma.
        fromAssistant: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.scope === 'org' && !hasRole(a.role, 'admin')) throw forbidden('Solo administradores pueden añadir memoria de organización');
    return deps.db.tenant(a.workspaceId, async (q) => {
      const source = body.fromAssistant ? 'assistant' : 'manual';
      const id = await addMemory(q, a.workspaceId, { scope: body.scope, kind: body.kind, content: body.content, source, userId: a.userId, createdBy: a.userId });
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'ai.memory_added', targetType: 'ai_memory', targetId: id, ip: req.ip, meta: { scope: body.scope, kind: body.kind, source } });
      return { id, pending: source === 'assistant' };
    });
  });

  app.patch('/ai/memory/:id', async (req) => {
    const a = requireWorkspace(req, 'member');
    requireUserSession(req); // datos personales: nunca accesibles con una API key
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { content, confirm } = z.object({ content: z.string().trim().min(3).max(2000), confirm: z.boolean().optional() }).parse(req.body);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const m = (await q.query(`SELECT scope, user_id, source FROM ai_memory WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`, [id, a.workspaceId])).rows[0];
      if (!m) throw notFound('Elemento de memoria no encontrado');
      if (m.scope === 'org' ? !hasRole(a.role, 'admin') : m.user_id !== a.userId) throw forbidden();
      // Confirmar una propuesta del asistente la convierte en memoria escrita por una persona.
      const confirmed = !!confirm && m.source === 'assistant';
      await q.query(`UPDATE ai_memory SET content = $1, source = CASE WHEN $3 THEN 'manual' ELSE source END, updated_at = now() WHERE id = $2`, [content, id, confirmed]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: confirmed ? 'ai.memory_confirmed' : 'ai.memory_updated', targetType: 'ai_memory', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  app.delete('/ai/memory/:id', async (req) => {
    const a = requireWorkspace(req, 'member');
    requireUserSession(req); // datos personales: nunca accesibles con una API key
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const m = (await q.query(`SELECT scope, user_id FROM ai_memory WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`, [id, a.workspaceId])).rows[0];
      if (!m) throw notFound('Elemento de memoria no encontrado');
      if (m.scope === 'org' ? !hasRole(a.role, 'admin') : m.user_id !== a.userId) throw forbidden();
      await q.query(`UPDATE ai_memory SET archived_at = now() WHERE id = $1`, [id]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'ai.memory_archived', targetType: 'ai_memory', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });
  void badRequest;
}
