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

/**
 * Caché de blueprints parseados por (organización, versión): las versiones son inmutables. Es LRU y con tope
 * por tamaño (no por número): sin límite de módulos, un blueprint puede ocupar varios MB y 500 entradas de
 * ese tamaño agotarían la memoria.
 */
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const cache = new Map<string, { blueprint: Blueprint; bytes: number }>();
let cacheBytes = 0;

function cacheGet(key: string): Blueprint | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit); // más reciente al final
  return hit.blueprint;
}

function cachePut(key: string, blueprint: Blueprint, bytes: number) {
  if (bytes > CACHE_MAX_BYTES) return;
  const prev = cache.get(key);
  if (prev) {
    cacheBytes -= prev.bytes;
    cache.delete(key);
  }
  while (cacheBytes + bytes > CACHE_MAX_BYTES && cache.size) {
    const [oldest, entry] = cache.entries().next().value as [string, { bytes: number }];
    cache.delete(oldest);
    cacheBytes -= entry.bytes;
  }
  cache.set(key, { blueprint, bytes });
  cacheBytes += bytes;
}

/** Solo para pruebas: tamaño actual de la caché. */
export function blueprintCacheStats() {
  return { entries: cache.size, bytes: cacheBytes, maxBytes: CACHE_MAX_BYTES };
}

export async function loadWorkspace(q: Queryable, workspaceId: string) {
  // La definición (que puede ocupar varios MB) solo se trae de la base de datos si no está en la caché.
  const r = await q.query(`SELECT id, name, slug, plan, blueprint_version, settings FROM workspaces WHERE id = $1`, [workspaceId]);
  const row = r.rows[0];
  if (!row) throw notFound('Organización no encontrada');
  const key = `${workspaceId}:${row.blueprint_version}`;
  let blueprint = cacheGet(key);
  if (!blueprint) {
    const def = (await q.query(`SELECT definition FROM blueprint_versions WHERE workspace_id = $1 AND version = $2`, [workspaceId, row.blueprint_version])).rows[0]?.definition;
    blueprint = BlueprintSchema.parse(def);
    cachePut(key, blueprint, Buffer.byteLength(typeof def === 'string' ? def : JSON.stringify(def ?? null)));
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
