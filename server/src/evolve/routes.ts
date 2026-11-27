import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONFIRM_WORDS, hasRole, RISK_LABELS, ROLE_LABELS, type Role } from '../../../shared/constants';
import { BlueprintSchema, type Blueprint } from '../../../shared/blueprint';
import { ChangeSetSchema } from '../../../shared/changeset';
import type { AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { newId } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { requireUserSession, requireWorkspace } from '../auth/plugin';
import { contextLocale, msg, t, tk } from '../i18n';
import { loadWorkspace } from '../crm/context';
import { blueprintForRole } from '../crm/visibility';
import { closeOpenSteps, PIPELINE_STEPS } from './pipeline';
import { deployRequest, enqueuePipeline, restoreVersion, rollbackRelease } from './releases';
import { assessTransition } from './risk';

const REQUEST_KINDS = ['config', 'code', 'script', 'platform', 'security', 'advice'] as const;
/** Peticiones de cambio (las auditorías y el asesor tienen su propia pantalla). */
const CHANGE_KINDS = ['config', 'code', 'script', 'platform'];

/** Rol mínimo para ver una petición según su tipo: los informes de seguridad son solo para administración. */
function kindMinRole(kind: string): Role {
  return kind === 'security' ? 'admin' : kind === 'advice' ? 'builder' : 'viewer';
}

/** Módulos que toca un change set (cualquier propiedad "module" de sus operaciones, a cualquier nivel). */
export function touchedModules(changeSet: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'module') {
        if (typeof x === 'string') out.add(x);
        else if (x && typeof x === 'object' && typeof (x as { key?: unknown }).key === 'string') out.add((x as { key: string }).key);
      }
      walk(x, depth + 1);
    }
  };
  walk((changeSet as { operations?: unknown } | null)?.operations, 0);
  return [...out];
}

/**
 * ¿Puede este rol ver todo lo que muestra la petición? El informe de pruebas y el impacto contienen
 * muestras de registros reales de los módulos que toca: sin lectura sobre alguno, se oculta el detalle.
 * Los módulos nuevos (aún sin datos) no restringen.
 */
function canSeeAll(bp: Blueprint, role: Role, changeSet: unknown): boolean {
  return touchedModules(changeSet).every((key) => {
    const m = bp.modules.find((x) => x.key === key);
    return !m || hasRole(role, m.permissions.read);
  });
}

/** Personas que han refinado la petición: con "aprobador distinto" tampoco pueden aprobarla. */
function refinersOf(conversation: unknown): Set<string> {
  const list = Array.isArray(conversation) ? (conversation as { role?: string; by?: string }[]) : [];
  return new Set(list.filter((m) => m?.role === 'feedback' && typeof m.by === 'string').map((m) => m.by!));
}

export async function evolveRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/evolve/steps', async () => PIPELINE_STEPS.map((s) => ({ key: s.key, label: tk(s.label) })));

  app.get('/evolve/requests', async (req) => {
    const a = requireWorkspace(req, 'viewer');
    const { kind } = z.object({ kind: z.enum(REQUEST_KINDS).optional() }).parse(req.query);
    if (kind && !hasRole(a.role, kindMinRole(kind))) throw forbidden(t('Requiere {role}', { role: tk(ROLE_LABELS[kindMinRole(kind)]) }));
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = await q.query(
        `SELECT r.id, r.kind, r.source, r.prompt, r.status, r.risk, r.change_set->>'title' AS title, r.created_at, r.updated_at, u.name AS requested_by_name
         FROM evolution_requests r LEFT JOIN users u ON u.id = r.requested_by WHERE r.workspace_id = $1 AND r.kind = ANY($2::text[]) ORDER BY r.created_at DESC LIMIT 100`,
        [a.workspaceId, kind ? [kind] : CHANGE_KINDS],
      );
      // El texto de las peticiones puede describir datos o planes internos: solo lo ve quien construye.
      if (hasRole(a.role, 'builder')) return r.rows;
      return r.rows.map((row) => ({ ...row, prompt: null }));
    });
  });

  app.post('/evolve/requests', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'builder');
    requireUserSession(req);
    const { prompt } = z.object({ prompt: z.string().trim().min(8, msg('Describe el cambio con un poco más de detalle')).max(4000) }).parse(req.body);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      const id = newId();
      await q.query(`INSERT INTO evolution_requests (id, workspace_id, requested_by, kind, source, prompt, status, base_version) VALUES ($1,$2,$3,'config','ai',$4,'queued',$5)`, [id, a.workspaceId, a.userId, prompt, ws.version]);
      await enqueuePipeline(q, a.workspaceId, id);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'evolve.requested', targetType: 'evolution_request', targetId: id, ip: req.ip, meta: { prompt: prompt.slice(0, 300) } });
      return { id };
    });
  });

  app.post('/evolve/requests/manual', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { changeSet } = z.object({ changeSet: ChangeSetSchema }).parse(req.body);
    if (!changeSet.operations.length) throw badRequest('El cambio no contiene operaciones');
    return deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      const id = newId();
      await q.query(
        `INSERT INTO evolution_requests (id, workspace_id, requested_by, kind, source, prompt, status, base_version, change_set) VALUES ($1,$2,$3,'config','manual',$4,'queued',$5,$6)`,
        [id, a.workspaceId, a.userId, changeSet.title, ws.version, JSON.stringify(changeSet)],
      );
      await enqueuePipeline(q, a.workspaceId, id);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'evolve.manual_change', targetType: 'evolution_request', targetId: id, ip: req.ip, meta: { title: changeSet.title } });
      return { id };
    });
  });

  app.get('/evolve/requests/:id', async (req) => {
    const a = requireWorkspace(req, 'viewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = (await q.query(`SELECT r.*, u.name AS requested_by_name FROM evolution_requests r LEFT JOIN users u ON u.id = r.requested_by WHERE r.id = $1 AND r.workspace_id = $2`, [id, a.workspaceId])).rows[0];
      if (!r) throw notFound('Petición no encontrada');
      if (!hasRole(a.role, kindMinRole(r.kind))) throw notFound('Petición no encontrada');
      const ws = await loadWorkspace(q, a.workspaceId);
      const requiredRole = r.risk === 'high' ? 'owner' : 'admin';
      const visible = hasRole(a.role, 'builder') && canSeeAll(ws.blueprint, a.role, r.change_set);
      const policy = {
        requiredRole,
        requiredRoleLabel: tk(ROLE_LABELS[requiredRole]),
        needsConfirmation: r.risk === 'high',
        requireDistinctApprover: ws.settings.approval.requireDistinctApprover,
        canApprove:
          visible &&
          !a.apiKeyId &&
          hasRole(a.role, requiredRole) &&
          !(ws.settings.approval.requireDistinctApprover && (r.requested_by === a.userId || refinersOf(r.conversation).has(a.userId))),
        currentVersion: ws.version,
      };
      if (!visible) {
        // Sin acceso a todo lo que toca: solo el resumen (sin prompt, plan, pruebas con muestras ni conversación).
        return {
          id: r.id,
          kind: r.kind,
          source: r.source,
          status: r.status,
          risk: r.risk,
          title: r.change_set?.title ?? null,
          summary: r.change_set?.summary ?? null,
          created_at: r.created_at,
          updated_at: r.updated_at,
          requested_by_name: r.requested_by_name,
          redacted: true,
          approvals: [],
          release: null,
          policy: { ...policy, canApprove: false },
        };
      }
      const approvals = (await q.query(`SELECT a.decision, a.comment, a.created_at, u.name FROM evolution_approvals a LEFT JOIN users u ON u.id = a.user_id WHERE a.request_id = $1 ORDER BY a.created_at`, [id])).rows;
      const release = r.release_id ? (await q.query(`SELECT id, to_version, status, verification, created_at FROM releases WHERE id = $1 AND workspace_id = $2`, [r.release_id, a.workspaceId])).rows[0] : null;
      return { ...r, approvals, release, redacted: false, policy };
    });
  });

  app.post('/evolve/requests/:id/refine', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'builder');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { feedback } = z.object({ feedback: z.string().trim().min(3).max(3000) }).parse(req.body);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = (await q.query(`SELECT status, source, kind, requested_by, change_set FROM evolution_requests WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, a.workspaceId])).rows[0];
      if (!r || !CHANGE_KINDS.includes(r.kind)) throw notFound('Petición no encontrada');
      // Refinar reescribe el plan que otra persona pidió: solo quien la pidió o administración.
      if (r.requested_by !== a.userId && !hasRole(a.role, 'admin')) throw forbidden('Solo quien hizo la petición o un administrador pueden refinarla');
      if (r.source !== 'ai') throw conflict('Solo se pueden refinar peticiones generadas por IA');
      if (!['ready_for_review', 'failed', 'needs_input', 'rejected'].includes(r.status)) throw conflict('Esta petición no se puede refinar en su estado actual');
      const ws = await loadWorkspace(q, a.workspaceId);
      if (!canSeeAll(ws.blueprint, a.role, r.change_set)) throw forbidden('La petición afecta a módulos que no puedes ver');
      await q.query(
        `UPDATE evolution_requests SET conversation = conversation || $1::jsonb, status = 'queued', progress = '[]', base_version = $2, error = NULL, updated_at = now() WHERE id = $3`,
        [JSON.stringify([{ role: 'feedback', content: feedback, by: a.userId, at: deps.now().toISOString() }]), ws.version, id],
      );
      await q.query(`DELETE FROM evolution_approvals WHERE request_id = $1`, [id]);
      await enqueuePipeline(q, a.workspaceId, id);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'evolve.refined', targetType: 'evolution_request', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  app.post('/evolve/requests/:id/approve', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ comment: z.string().max(2000).optional(), confirmation: z.string().max(20).optional() }).parse(req.body ?? {});
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = (await q.query(`SELECT * FROM evolution_requests WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, a.workspaceId])).rows[0];
      if (!r || !CHANGE_KINDS.includes(r.kind)) throw notFound('Petición no encontrada');
      if (r.status !== 'ready_for_review') throw conflict('La petición no está pendiente de revisión');
      if (!r.test_report?.passed) throw conflict('No se puede aprobar un cambio con pruebas fallidas');
      const requiredRole = r.risk === 'high' ? 'owner' : 'admin';
      if (!hasRole(a.role, requiredRole)) throw forbidden(t('{risk}: requiere {role}', { risk: tk(RISK_LABELS[r.risk] ?? r.risk), role: tk(ROLE_LABELS[requiredRole]) }));
      if (r.risk === 'high' && body.confirmation !== CONFIRM_WORDS.apply) throw badRequest(t('Escribe {word} para confirmar un cambio de riesgo alto', { word: CONFIRM_WORDS.apply }));
      const ws = await loadWorkspace(q, a.workspaceId);
      // Nadie aprueba a ciegas: quien aprueba debe poder ver todos los módulos que el cambio toca.
      if (!canSeeAll(ws.blueprint, a.role, r.change_set)) throw forbidden('El cambio afecta a módulos que no puedes ver: debe aprobarlo alguien con acceso');
      if (ws.settings.approval.requireDistinctApprover && (r.requested_by === a.userId || refinersOf(r.conversation).has(a.userId))) {
        throw forbidden('La política de la organización exige que apruebe una persona distinta a quien lo solicitó o refinó');
      }
      await q.query(`INSERT INTO evolution_approvals (id, workspace_id, request_id, user_id, decision, comment) VALUES ($1,$2,$3,$4,'approve',$5)`, [newId(), a.workspaceId, id, a.userId, body.comment ?? null]);
      await q.query(`UPDATE evolution_requests SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'evolve.approved', targetType: 'evolution_request', targetId: id, ip: req.ip, meta: { risk: r.risk } });
      return { ok: true };
    });
  });

  app.post('/evolve/requests/:id/reject', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ comment: z.string().max(2000).optional() }).parse(req.body ?? {});
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = (await q.query(`SELECT status FROM evolution_requests WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, a.workspaceId])).rows[0];
      if (!r) throw notFound('Petición no encontrada');
      if (!['ready_for_review', 'approved', 'needs_input', 'failed'].includes(r.status)) throw conflict('La petición no se puede rechazar en su estado actual');
      await q.query(`INSERT INTO evolution_approvals (id, workspace_id, request_id, user_id, decision, comment) VALUES ($1,$2,$3,$4,'reject',$5)`, [newId(), a.workspaceId, id, a.userId, body.comment ?? null]);
      await q.query(`UPDATE evolution_requests SET status = 'rejected', updated_at = now() WHERE id = $1`, [id]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'evolve.rejected', targetType: 'evolution_request', targetId: id, ip: req.ip });
      return { ok: true };
    });
  });

  app.post('/evolve/requests/:id/cancel', async (req) => {
    const a = requireWorkspace(req, 'builder');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = (await q.query(`SELECT status, requested_by, progress FROM evolution_requests WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, a.workspaceId])).rows[0];
      if (!r) throw notFound('Petición no encontrada');
      if (r.requested_by !== a.userId && !hasRole(a.role, 'admin')) throw forbidden();
      if (['applied', 'rolled_back', 'deploying'].includes(r.status)) throw conflict('Ya no se puede cancelar');
      // Los pasos que estaban trabajando quedan cerrados como cancelados (no siguen «en curso» en el progreso).
      const closing = closeOpenSteps(r.progress, 'skipped', t('Cancelado'), deps.now().toISOString());
      await q.query(`UPDATE evolution_requests SET status = 'cancelled', progress = progress || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(closing)]);
      return { ok: true };
    });
  });

  app.post('/evolve/requests/:id/deploy', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = (await deps.db.tenant(a.workspaceId, (q) => q.query(`SELECT risk FROM evolution_requests WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId]))).rows[0];
    if (!r) throw notFound('Petición no encontrada');
    if (r.risk === 'high' && a.role !== 'owner') throw forbidden('Solo un propietario puede publicar cambios de riesgo alto');
    return deployRequest(deps, a.workspaceId, id, { userId: a.userId, role: a.role }, req.ip);
  });

  app.get('/evolve/releases', async (req) => {
    const a = requireWorkspace(req, 'viewer');
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = await q.query(
        `SELECT r.id, r.kind, r.status, r.from_version, r.to_version, r.title, r.summary, r.artifacts, r.tests, r.validation, r.verification,
                jsonb_array_length(r.data_changes) AS data_changes_count, r.created_at, r.rolled_back_at, r.request_id,
                ua.name AS approved_by_name, up.name AS applied_by_name, ur.name AS rolled_back_by_name
         FROM releases r LEFT JOIN users ua ON ua.id = r.approved_by LEFT JOIN users up ON up.id = r.applied_by LEFT JOIN users ur ON ur.id = r.rolled_back_by
         WHERE r.workspace_id = $1 ORDER BY r.to_version DESC, r.created_at DESC LIMIT 200`,
        [a.workspaceId],
      );
      const ws = await loadWorkspace(q, a.workspaceId);
      return { currentVersion: ws.version, items: r.rows };
    });
  });

  app.post('/evolve/releases/:id/rollback', async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { confirmation, reason } = z.object({ confirmation: z.string().max(20), reason: z.string().max(500).optional() }).parse(req.body);
    if (confirmation !== CONFIRM_WORDS.revert) throw badRequest(t('Escribe {word} para confirmar', { word: CONFIRM_WORDS.revert }));
    if (a.role !== 'owner') {
      // Revertir un cambio de riesgo alto es también una decisión de riesgo alto, igual que revertir una
      // restauración o volver a un estado que reactiva algo peligroso (permisos amplios, webhooks, scripts…).
      const denied = await deps.db.tenant(a.workspaceId, async (q) => {
        const rel = (await q.query(`SELECT rel.request_id, rel.from_version, r.risk FROM releases rel LEFT JOIN evolution_requests r ON r.id = rel.request_id WHERE rel.id = $1 AND rel.workspace_id = $2`, [id, a.workspaceId])).rows[0];
        if (!rel) throw notFound('Versión no encontrada');
        if (rel.risk === 'high') return msg('Revertir un cambio de riesgo alto requiere el rol de propietario');
        if (!rel.request_id) return msg('Revertir una restauración requiere el rol de propietario');
        const prev = (await q.query(`SELECT definition FROM blueprint_versions WHERE workspace_id = $1 AND version = $2`, [a.workspaceId, rel.from_version])).rows[0];
        if (!prev) return null; // rollbackRelease responde con el error adecuado
        const target = BlueprintSchema.safeParse(prev.definition);
        if (!target.success) return msg('La versión anterior no es válida: solo un propietario puede restaurarla');
        const ws = await loadWorkspace(q, a.workspaceId);
        const transition = assessTransition(ws.blueprint, target.data);
        return transition.level === 'high'
          ? t('Revertir reactivaría elementos de riesgo alto ({items}): requiere el rol de propietario', { items: transition.items.slice(0, 3).map((i) => i.message).join('; ') })
          : null;
      });
      if (denied) throw forbidden(denied);
    }
    return rollbackRelease(deps, a.workspaceId, id, { userId: a.userId, role: a.role }, reason?.trim() || t('Rollback manual'), req.ip);
  });

  app.get('/evolve/versions/:v', async (req) => {
    const a = requireWorkspace(req, 'viewer');
    const { v } = z.object({ v: z.coerce.number().int().min(1) }).parse(req.params);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const r = (await q.query(`SELECT version, definition, created_at FROM blueprint_versions WHERE workspace_id = $1 AND version = $2`, [a.workspaceId, v])).rows[0];
      if (!r) throw notFound('Versión no encontrada');
      // Igual que /blueprint: nada de módulos sin permiso de lectura ni de configuración sensible para el rol.
      const bp = BlueprintSchema.parse(r.definition);
      return { version: r.version, createdAt: r.created_at, blueprint: blueprintForRole(bp, a.role) };
    });
  });

  app.post('/evolve/versions/:v/restore', async (req) => {
    const a = requireWorkspace(req, 'owner');
    requireUserSession(req);
    const { v } = z.object({ v: z.coerce.number().int().min(1) }).parse(req.params);
    const { confirmation } = z.object({ confirmation: z.string().max(20) }).parse(req.body);
    if (confirmation !== CONFIRM_WORDS.restore) throw badRequest(t('Escribe {word} para confirmar', { word: CONFIRM_WORDS.restore }));
    return restoreVersion(deps, a.workspaceId, v, { userId: a.userId }, req.ip);
  });

  app.get('/evolve/backups', async (req) => {
    const a = requireWorkspace(req, 'owner');
    return deps.db.tenant(a.workspaceId, async (q) => (await q.query(`SELECT id, release_id, reason, size, created_at FROM backups WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`, [a.workspaceId])).rows);
  });

  app.get('/evolve/backups/:id/download', async (req, reply) => {
    const a = requireWorkspace(req, 'owner');
    requireUserSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await deps.db.tenant(a.workspaceId, async (q) => {
      const b = (await q.query(`SELECT content, created_at FROM backups WHERE id = $1 AND workspace_id = $2`, [id, a.workspaceId])).rows[0];
      if (!b) throw notFound('Copia no encontrada');
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'backup.downloaded', targetType: 'backup', targetId: id, ip: req.ip });
      return b;
    });
    reply.header('Content-Type', 'application/json').header('Content-Disposition', `attachment; filename="evolve-backup-${id.slice(0, 8)}.json"`);
    return reply.send(zlib.gunzipSync(Buffer.from(row.content)));
  });

  // Auditoría de seguridad y asesor: se ejecutan en el worker y el cliente consulta el resultado.
  app.post('/evolve/security-review', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'admin');
    requireUserSession(req);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      const id = newId();
      await q.query(`INSERT INTO evolution_requests (id, workspace_id, requested_by, kind, source, prompt, status, base_version) VALUES ($1,$2,$3,'security','ai',$4,'queued',$5)`, [id, a.workspaceId, a.userId, t('Auditoría de seguridad'), ws.version]);
      await q.query(`INSERT INTO jobs (id, workspace_id, type, payload, max_attempts, locale) VALUES ($1,$2,'evolve.security',$3,1,$4)`, [newId(), a.workspaceId, JSON.stringify({ requestId: id, platformAdmin: a.isPlatformAdmin }), contextLocale()]);
      await audit(q, { workspaceId: a.workspaceId, actorId: a.userId, action: 'security.review_requested', targetId: id, ip: req.ip });
      return { id };
    });
  });

  app.post('/evolve/advice', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireWorkspace(req, 'builder');
    requireUserSession(req);
    return deps.db.tenant(a.workspaceId, async (q) => {
      const ws = await loadWorkspace(q, a.workspaceId);
      const id = newId();
      await q.query(`INSERT INTO evolution_requests (id, workspace_id, requested_by, kind, source, prompt, status, base_version) VALUES ($1,$2,$3,'advice','ai',$4,'queued',$5)`, [id, a.workspaceId, a.userId, t('Propuestas de mejora'), ws.version]);
      await q.query(`INSERT INTO jobs (id, workspace_id, type, payload, max_attempts, locale) VALUES ($1,$2,'evolve.advice',$3,1,$4)`, [newId(), a.workspaceId, JSON.stringify({ requestId: id }), contextLocale()]);
      return { id };
    });
  });
}
