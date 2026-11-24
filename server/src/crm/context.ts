import { BlueprintSchema, type Blueprint } from '../../../shared/blueprint';
import { DEFAULT_TZ } from '../../../shared/time';
import type { Queryable } from '../db/db';
import { notFound } from '../lib/errors';
import { PgSideEffects } from './effects';
import { RecordService, type Actor } from './record-service';
import { PgRecordStore } from './store';

export interface WorkspaceSettings {
  timezone: string;
  currency: string;
  locale: string;
  industry?: string;
  description?: string;
  approval: { requireDistinctApprover: boolean };
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  timezone: DEFAULT_TZ,
  currency: 'EUR',
  locale: 'es-ES',
  approval: { requireDistinctApprover: false },
};

export function normalizeSettings(raw: unknown): WorkspaceSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorkspaceSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    approval: { ...DEFAULT_SETTINGS.approval, ...(s.approval ?? {}) },
  };
}

// Caché de blueprints parseados por (organización, versión): las versiones son inmutables.
const cache = new Map<string, Blueprint>();

export async function loadWorkspace(q: Queryable, workspaceId: string) {
  const r = await q.query(
    `SELECT w.id, w.name, w.slug, w.plan, w.blueprint_version, w.settings, bv.definition
     FROM workspaces w LEFT JOIN blueprint_versions bv ON bv.workspace_id = w.id AND bv.version = w.blueprint_version
     WHERE w.id = $1`,
    [workspaceId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Organización no encontrada');
  const key = `${workspaceId}:${row.blueprint_version}`;
  let blueprint = cache.get(key);
  if (!blueprint) {
    blueprint = BlueprintSchema.parse(row.definition);
    if (cache.size > 500) cache.clear();
    cache.set(key, blueprint);
  }
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    plan: row.plan as string,
    version: row.blueprint_version as number,
    settings: normalizeSettings(row.settings),
    blueprint,
  };
}

export type LoadedWorkspace = Awaited<ReturnType<typeof loadWorkspace>>;

export function makeRecordService(q: Queryable, ws: LoadedWorkspace, actor: Actor, now: () => Date = () => new Date()) {
  return new RecordService({
    workspaceId: ws.id,
    blueprint: ws.blueprint,
    store: new PgRecordStore(q, ws.id),
    effects: new PgSideEffects(q, ws.id),
    actor,
    now,
    tz: ws.settings.timezone,
  });
}
