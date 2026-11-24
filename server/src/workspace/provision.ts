import { defaultBlueprint } from '../../../shared/default-blueprint';
import type { Db } from '../db/db';
import { newId } from '../lib/crypto';
import { DEFAULT_SETTINGS } from '../crm/context';

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

/** Crea una organización con el CRM por defecto como versión 1 de su blueprint. */
export async function provisionWorkspace(db: Db, input: { name: string; ownerId: string }): Promise<string> {
  const id = newId();
  const slug = `${slugify(input.name)}-${id.slice(0, 6)}`;
  const bp = defaultBlueprint();
  await db.tx(async (q) => {
    await q.query(`INSERT INTO workspaces (id, name, slug, blueprint_version, settings) VALUES ($1,$2,$3,1,$4)`, [id, input.name, slug, JSON.stringify(DEFAULT_SETTINGS)]);
    await q.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [id, input.ownerId]);
    const releaseId = newId();
    await q.query(
      `INSERT INTO blueprint_versions (workspace_id, version, definition, release_id, created_by) VALUES ($1,1,$2,$3,$4)`,
      [id, JSON.stringify(bp), releaseId, input.ownerId],
    );
    await q.query(
      `INSERT INTO releases (id, workspace_id, kind, status, from_version, to_version, title, summary, artifacts, applied_by, approved_by)
       VALUES ($1,$2,'initial','verified',0,1,'Versión inicial del CRM','CRM base: Empresas, Contactos, Oportunidades, Tareas y Actividades.',$3,$4,$4)`,
      [releaseId, id, JSON.stringify(bp.modules.map((m) => ({ path: `blueprint/modules/${m.key}.json`, action: 'create' }))), input.ownerId],
    );
    await q.query(`INSERT INTO ai_settings (workspace_id) VALUES ($1)`, [id]);
  });
  return id;
}
