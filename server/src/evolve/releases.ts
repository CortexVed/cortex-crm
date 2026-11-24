import zlib from 'node:zlib';
import type { Role } from '../../../shared/constants';
import { BlueprintSchema, findModule, type Blueprint } from '../../../shared/blueprint';
import { ChangeSetSchema } from '../../../shared/changeset';
import { normalizeValue } from '../../../shared/records';
import { resolveTemplate } from '../../../shared/templates';
import type { AppDeps } from '../deps';
import type { Queryable } from '../db/db';
import { audit } from '../lib/audit';
import { newId } from '../lib/crypto';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { enqueue } from '../lib/jobs';
import { loadWorkspace } from '../crm/context';
import { PgSideEffects } from '../crm/effects';
import { PgRecordStore, conditionsToSql } from '../crm/store';
import { addMemory } from '../ai/memory';
import { applyOperations } from './apply';
import { validateBlueprint } from './validate';
import { runAcceptanceTests } from './simulator';

interface DataChange {
  module: string;
  field: string;
  value: unknown;
  records: { id: string; before: unknown }[];
}

async function notifyAdmins(q: Queryable, ws: string, title: string, body: string, link: string) {
  await new PgSideEffects(q, ws).notify({ minRole: 'admin', title, body, link, kind: 'evolve' });
}

async function snapshot(q: Queryable, ws: string, modules: string[], reason: string, releaseId: string, actorId: string) {
  if (!modules.length) return null;
  const r = await q.query(`SELECT id, module_key, data, updated_at FROM records WHERE workspace_id = $1 AND module_key = ANY($2::text[]) AND deleted_at IS NULL`, [ws, modules]);
  const content = zlib.gzipSync(Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), modules, records: r.rows })));
  if (content.length > 25 * 1024 * 1024) return null;
  const id = newId();
  await q.query(`INSERT INTO backups (id, workspace_id, release_id, reason, size, content, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, ws, releaseId, reason, content.length, content, actorId]);
  return id;
}

/**
 * PASO 8 — Desplegar: publica el change set aprobado como nueva versión del blueprint en una
 * única transacción (todo o nada), con migraciones de datos reversibles y copia de seguridad.
 */
export const APPROVAL_TTL_DAYS = 7;

export async function deployRequest(deps: AppDeps, ws: string, requestId: string, actor: { userId: string; role: Role }, ip?: string) {
  // Comprobación previa: una aprobación solo vale para la versión sobre la que se planificó y probó,
  // y caduca. Si no, la petición vuelve a necesitar planificación y aprobación (no hay "rebase" silencioso).
  const pre = await deps.db.tenant(ws, async (q) => {
    const r = (await q.query(`SELECT r.status, r.base_version, w.blueprint_version FROM evolution_requests r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = $1 AND r.workspace_id = $2`, [requestId, ws])).rows[0];
    const approval = (await q.query(`SELECT created_at FROM evolution_approvals WHERE request_id = $1 AND decision = 'approve' ORDER BY created_at DESC LIMIT 1`, [requestId])).rows[0];
    return { r, approval };
  });
  if (!pre.r) throw notFound('Petición no encontrada');
  if (pre.r.status === 'approved' && pre.r.base_version !== pre.r.blueprint_version) {
    const msg = `La configuración del CRM cambió (v${pre.r.base_version} → v${pre.r.blueprint_version}) desde que se probó y aprobó este cambio. Refínalo o créalo de nuevo para probarlo y aprobarlo sobre la versión actual.`;
    await deps.db.tenant(ws, (q) => q.query(`UPDATE evolution_requests SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`, [msg, requestId, ws]));
    throw conflict(msg);
  }
  if (pre.r.status === 'approved' && (!pre.approval || Date.now() - new Date(pre.approval.created_at).getTime() > APPROVAL_TTL_DAYS * 86_400_000)) {
    await deps.db.tenant(ws, async (q) => {
      await q.query(`DELETE FROM evolution_approvals WHERE request_id = $1`, [requestId]);
      await q.query(`UPDATE evolution_requests SET status = 'ready_for_review', updated_at = now() WHERE id = $1 AND workspace_id = $2`, [requestId, ws]);
    });
    throw conflict(`La aprobación ha caducado (más de ${APPROVAL_TTL_DAYS} días). Vuelve a revisarla y aprobarla.`);
  }

  const result = await deps.db.tenant(ws, async (q) => {
    const req = (await q.query(`SELECT * FROM evolution_requests WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [requestId, ws])).rows[0];
    if (!req) throw notFound('Petición no encontrada');
    if (req.status !== 'approved') throw conflict('La petición debe estar aprobada antes de publicarse');
    await q.query(`SELECT blueprint_version FROM workspaces WHERE id = $1 FOR UPDATE`, [ws]);
    const current = await loadWorkspace(q, ws);
    const cs = ChangeSetSchema.parse(req.change_set);
    const applied = applyOperations(current.blueprint, cs.operations);
    const issues = applied.errors.length ? applied.errors : validateBlueprint(applied.blueprint).filter((i) => i.level === 'error');
    if (current.version !== req.base_version) {
      throw conflict('La configuración del CRM ha cambiado mientras se publicaba. Vuelve a intentarlo.');
    }
    if (issues.length) throw conflict('El cambio no supera la validación final.', { issues });
    const next = applied.blueprint;
    const releaseId = newId();
    const now = deps.now();

    // Copia de seguridad si hay migraciones de datos o cambios destructivos.
    const destructive = !!req.impact?.destructive;
    const migrated = cs.operations.filter((o) => o.op === 'backfill_field').map((o) => (o as { module: string }).module);
    const backupId = destructive || migrated.length ? await snapshot(q, ws, [...new Set(migrated.length ? migrated : cs.operations.filter((o) => 'module' in o && typeof o.module === 'string').map((o) => (o as any).module))], `Antes de publicar: ${cs.title}`, releaseId, actor.userId) : null;

    // Migraciones de datos (reversibles: se guarda el valor anterior de cada registro).
    const dataChanges: DataChange[] = [];
    for (const op of cs.operations) {
      if (op.op !== 'backfill_field') continue;
      const mod = findModule(next, op.module)!;
      const field = mod.fields.find((f) => f.key === op.field)!;
      const norm = normalizeValue(field, resolveTemplate(op.value, { now, tz: current.settings.timezone }));
      if (!norm.ok) throw unprocessable(`Valor de migración inválido para ${op.module}.${op.field}: ${norm.message}`);
      const params: unknown[] = [ws, op.module, op.field];
      const where = ['workspace_id = $1', 'module_key = $2', 'deleted_at IS NULL', ...conditionsToSql(mod, op.where, params, { now, tz: current.settings.timezone })];
      if (op.onlyEmpty) where.push(`(data->$3 IS NULL OR data->$3 = 'null'::jsonb OR data->>$3 = '')`);
      const rows = (await q.query(`SELECT id, data->$3 AS before FROM records WHERE ${where.join(' AND ')} LIMIT 5001`, params)).rows;
      if (rows.length > 5000) throw conflict(`La migración de ${op.module}.${op.field} afecta a más de 5000 registros; divídela con condiciones`);
      if (rows.length) {
        await q.query(`UPDATE records SET data = jsonb_set(data, ARRAY[$1::text], $2::jsonb, true), updated_at = now() WHERE workspace_id = $3 AND id = ANY($4::uuid[])`, [
          op.field,
          JSON.stringify(norm.value),
          ws,
          rows.map((r: any) => r.id),
        ]);
      }
      dataChanges.push({ module: op.module, field: op.field, value: norm.value, records: rows.map((r: any) => ({ id: r.id, before: r.before ?? null })) });
    }

    const newVersion = current.version + 1;
    await q.query(`INSERT INTO blueprint_versions (workspace_id, version, definition, release_id, created_by) VALUES ($1,$2,$3,$4,$5)`, [ws, newVersion, JSON.stringify(next), releaseId, actor.userId]);
    await q.query(`UPDATE workspaces SET blueprint_version = $1 WHERE id = $2`, [newVersion, ws]);
    const approver = (await q.query(`SELECT user_id FROM evolution_approvals WHERE request_id = $1 AND decision = 'approve' ORDER BY created_at DESC LIMIT 1`, [requestId])).rows[0];
    const report = req.test_report ?? {};
    await q.query(
      `INSERT INTO releases (id, workspace_id, request_id, kind, status, from_version, to_version, title, summary, artifacts, tests, validation, data_changes, approved_by, applied_by)
       VALUES ($1,$2,$3,'apply','applied',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        releaseId,
        ws,
        requestId,
        current.version,
        newVersion,
        cs.title,
        cs.summary,
        JSON.stringify(req.impact?.artifacts ?? []),
        JSON.stringify({ total: report.total ?? 0, failed: report.failed ?? 0, warnings: report.warnings ?? 0, suites: (report.suites ?? []).map((s: any) => ({ name: s.name, cases: s.cases.length, failed: s.cases.filter((c: any) => !c.passed).length })) }),
        JSON.stringify({ issues: (req.validation ?? []).length, errors: (req.validation ?? []).filter((i: any) => i.level === 'error').length, rebased: current.version !== req.base_version, backupId }),
        JSON.stringify(dataChanges),
        approver?.user_id ?? actor.userId,
        actor.userId,
      ],
    );
    await q.query(`UPDATE evolution_requests SET status = 'applied', release_id = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`, [releaseId, requestId, ws]);
    await addMemory(q, ws, { scope: 'org', kind: 'decision', content: `v${newVersion} · ${cs.title}: ${cs.summary.slice(0, 600)}`, source: 'release', sourceRef: releaseId, createdBy: actor.userId });
    await audit(q, { workspaceId: ws, actorId: actor.userId, action: 'evolve.deployed', targetType: 'release', targetId: releaseId, ip, meta: { version: newVersion, title: cs.title, dataChanges: dataChanges.map((d) => ({ module: d.module, field: d.field, rows: d.records.length })) } });
    await notifyAdmins(q, ws, `Nueva versión v${newVersion} publicada`, cs.title, `/evolve/releases`);
    // Recalcular fórmulas afectadas por migraciones de datos.
    if (dataChanges.length) await q.query(`INSERT INTO jobs (id, workspace_id, type, payload) VALUES ($1,$2,'formulas.recompute','{}')`, [newId(), ws]);
    return { releaseId, version: newVersion, tests: cs.tests };
  });

  // PASO 9 — Verificar (y PASO 10 — recuperar automáticamente si falla).
  const verification = await verifyRelease(deps, ws, result.releaseId);
  if (!verification.ok) {
    await rollbackRelease(deps, ws, result.releaseId, { userId: actor.userId, role: 'owner' }, 'Verificación posterior a la publicación fallida', ip);
  }
  return { ...result, verification };
}

export async function verifyRelease(deps: AppDeps, ws: string, releaseId: string) {
  const checks: { name: string; passed: boolean; message?: string }[] = [];
  let ok = true;
  await deps.db.tenant(ws, async (q) => {
    const rel = (await q.query(`SELECT * FROM releases WHERE id = $1 AND workspace_id = $2`, [releaseId, ws])).rows[0];
    if (!rel) throw notFound('Versión no encontrada');
    const loaded = await loadWorkspace(q, ws);
    const errors = validateBlueprint(loaded.blueprint).filter((i) => i.level === 'error');
    checks.push({ name: `Blueprint v${loaded.version} cargado y coherente`, passed: errors.length === 0, message: errors.map((e) => e.message).join('; ') || undefined });
    const store = new PgRecordStore(q, ws);
    const req = rel.request_id ? (await q.query(`SELECT change_set FROM evolution_requests WHERE id = $1`, [rel.request_id])).rows[0] : null;
    const touched = new Set<string>();
    for (const op of req?.change_set?.operations ?? []) if (typeof op.module === 'string') touched.add(op.module);
    for (const key of touched) {
      const mod = findModule(loaded.blueprint, key);
      if (!mod || mod.archived) continue;
      for (const view of mod.views) {
        try {
          await store.list(mod, { filters: view.filters, sort: view.sort, limit: 1, offset: 0 }, { now: deps.now(), tz: loaded.settings.timezone });
          checks.push({ name: `Consulta real de «${mod.labelPlural} › ${view.label}»`, passed: true });
        } catch (e) {
          checks.push({ name: `Consulta real de «${mod.labelPlural} › ${view.label}»`, passed: false, message: (e as Error).message });
        }
      }
    }
    if (req?.change_set?.tests?.length) {
      const members = (await q.query<{ user_id: string; role: Role }>(`SELECT user_id, role FROM memberships WHERE workspace_id = $1`, [ws])).rows.map((m) => ({ id: m.user_id, role: m.role }));
      const results = await runAcceptanceTests(loaded.blueprint, ChangeSetSchema.parse(req.change_set).tests, members, loaded.settings.timezone, deps.now());
      for (const r of results) checks.push({ name: `Prueba de aceptación sobre la versión publicada: ${r.name}`, passed: r.passed, message: r.message });
    }
    ok = checks.every((c) => c.passed);
    await q.query(`UPDATE releases SET status = $1, verification = $2 WHERE id = $3 AND workspace_id = $4`, [ok ? 'verified' : 'failed', JSON.stringify({ ok, checks, at: deps.now().toISOString() }), releaseId, ws]);
  });
  return { ok, checks };
}

/** PASO 10 — Recuperar: vuelve a la versión anterior y revierte las migraciones de datos. */
export async function rollbackRelease(deps: AppDeps, ws: string, releaseId: string, actor: { userId: string; role: Role }, reason: string, ip?: string) {
  return deps.db.tenant(ws, async (q) => {
    const rel = (await q.query(`SELECT * FROM releases WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [releaseId, ws])).rows[0];
    if (!rel) throw notFound('Versión no encontrada');
    if (!['applied', 'verified', 'failed'].includes(rel.status) || rel.kind === 'initial') throw conflict('Esta versión no se puede revertir');
    const wsRow = (await q.query(`SELECT blueprint_version FROM workspaces WHERE id = $1 FOR UPDATE`, [ws])).rows[0];
    if (wsRow.blueprint_version !== rel.to_version) throw conflict('Solo se puede revertir la última versión publicada. Para versiones anteriores usa «Restaurar versión».');
    const prev = (await q.query(`SELECT definition FROM blueprint_versions WHERE workspace_id = $1 AND version = $2`, [ws, rel.from_version])).rows[0];
    if (!prev) throw conflict('No se encontró la versión anterior');
    const newVersion = wsRow.blueprint_version + 1;
    const rollbackId = newId();
    await q.query(`INSERT INTO blueprint_versions (workspace_id, version, definition, release_id, created_by) VALUES ($1,$2,$3,$4,$5)`, [ws, newVersion, JSON.stringify(prev.definition), rollbackId, actor.userId]);
    await q.query(`UPDATE workspaces SET blueprint_version = $1 WHERE id = $2`, [newVersion, ws]);
    let reverted = 0;
    let skipped = 0;
    for (const ch of (rel.data_changes ?? []) as DataChange[]) {
      for (const r of ch.records) {
        const res = await q.query(
          `UPDATE records SET data = CASE WHEN $1::jsonb IS NULL OR $1::jsonb = 'null'::jsonb THEN data - $2::text ELSE jsonb_set(data, ARRAY[$2::text], $1::jsonb, true) END, updated_at = now()
           WHERE workspace_id = $3 AND id = $4 AND data->$2::text = $5::jsonb`,
          [r.before === null || r.before === undefined ? null : JSON.stringify(r.before), ch.field, ws, r.id, JSON.stringify(ch.value)],
        );
        if (res.rowCount) reverted++;
        else skipped++;
      }
    }
    await q.query(`UPDATE releases SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = $1 WHERE id = $2`, [actor.userId, releaseId]);
    await q.query(
      `INSERT INTO releases (id, workspace_id, request_id, kind, status, from_version, to_version, title, summary, validation, applied_by, approved_by)
       VALUES ($1,$2,$3,'rollback','verified',$4,$5,$6,$7,$8,$9,$9)`,
      [rollbackId, ws, rel.request_id, rel.to_version, newVersion, `Rollback: ${rel.title}`, reason, JSON.stringify({ revertedRecords: reverted, skippedRecords: skipped }), actor.userId],
    );
    if (rel.request_id) await q.query(`UPDATE evolution_requests SET status = 'rolled_back', updated_at = now() WHERE id = $1 AND workspace_id = $2`, [rel.request_id, ws]);
    await addMemory(q, ws, { scope: 'org', kind: 'decision', content: `v${newVersion} · Rollback de «${rel.title}»: ${reason}`, source: 'rollback', sourceRef: rollbackId, createdBy: actor.userId });
    await audit(q, { workspaceId: ws, actorId: actor.userId, action: 'evolve.rolled_back', targetType: 'release', targetId: releaseId, ip, meta: { reason, newVersion, reverted, skipped } });
    await notifyAdmins(q, ws, `Rollback a v${newVersion}`, `Se revirtió «${rel.title}»: ${reason}`, `/evolve/releases`);
    return { version: newVersion, revertedRecords: reverted, skippedRecords: skipped };
  });
}

/** Restaura la definición de cualquier versión anterior como una versión nueva (no altera datos). */
export async function restoreVersion(deps: AppDeps, ws: string, version: number, actor: { userId: string }, ip?: string) {
  return deps.db.tenant(ws, async (q) => {
    const target = (await q.query(`SELECT definition FROM blueprint_versions WHERE workspace_id = $1 AND version = $2`, [ws, version])).rows[0];
    if (!target) throw notFound('Versión no encontrada');
    const bp: Blueprint = BlueprintSchema.parse(target.definition);
    const errors = validateBlueprint(bp).filter((i) => i.level === 'error');
    if (errors.length) throw conflict('Esa versión no es válida con la plataforma actual', { errors });
    const wsRow = (await q.query(`SELECT blueprint_version FROM workspaces WHERE id = $1 FOR UPDATE`, [ws])).rows[0];
    const newVersion = wsRow.blueprint_version + 1;
    const releaseId = newId();
    await q.query(`INSERT INTO blueprint_versions (workspace_id, version, definition, release_id, created_by) VALUES ($1,$2,$3,$4,$5)`, [ws, newVersion, JSON.stringify(bp), releaseId, actor.userId]);
    await q.query(`UPDATE workspaces SET blueprint_version = $1 WHERE id = $2`, [newVersion, ws]);
    await q.query(
      `INSERT INTO releases (id, workspace_id, kind, status, from_version, to_version, title, summary, applied_by, approved_by) VALUES ($1,$2,'restore','verified',$3,$4,$5,$6,$7,$7)`,
      [releaseId, ws, wsRow.blueprint_version, newVersion, `Restaurada la versión v${version}`, `Se restauró la configuración de la versión ${version}. Los datos no se modifican.`, actor.userId],
    );
    await audit(q, { workspaceId: ws, actorId: actor.userId, action: 'evolve.version_restored', targetType: 'version', targetId: String(version), ip, meta: { newVersion } });
    return { version: newVersion };
  });
}

export async function enqueuePipeline(q: Queryable, ws: string, requestId: string) {
  await q.query(`INSERT INTO jobs (id, workspace_id, type, payload, max_attempts) VALUES ($1,$2,'evolve.plan',$3,1)`, [newId(), ws, JSON.stringify({ requestId })]);
}
void enqueue;
