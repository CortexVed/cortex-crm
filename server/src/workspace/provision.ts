import { defaultBlueprint } from '../../../shared/default-blueprint';
import type { Db } from '../db/db';
import { newId } from '../lib/crypto';
import { DEFAULT_SETTINGS } from '../crm/context';
import { LOCALE_INFO, type Locale } from '../../../shared/i18n';
import { t, withLocale } from '../i18n';

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

// Moneda por defecto según la región del idioma de la organización (euros si no hay otra); se cambia en Ajustes › General.
const REGION_CURRENCY: Readonly<Record<string, string>> = { US: 'USD', GB: 'GBP', BR: 'BRL', JP: 'JPY', MX: 'MXN', AR: 'ARS', CO: 'COP', CL: 'CLP', PE: 'PEN', CH: 'CHF', CA: 'CAD', AU: 'AUD', IN: 'INR' };

export function defaultCurrency(tag: string): string {
  try {
    const region = new Intl.Locale(tag).maximize().region;
    return (region && REGION_CURRENCY[region]) || 'EUR';
  } catch {
    return 'EUR';
  }
}

/**
 * Crea una organización con el CRM por defecto como versión 1 de su blueprint, en su idioma: «Idioma y región»
 * (settings.locale) toma la región por defecto del idioma y los módulos, campos y textos iniciales salen traducidos.
 */
export async function provisionWorkspace(db: Db, input: { name: string; ownerId: string; locale?: Locale; timezone?: string }): Promise<string> {
  const id = newId();
  const slug = `${slugify(input.name)}-${id.slice(0, 6)}`;
  const locale = input.locale ?? 'es';
  const tag = LOCALE_INFO[locale].tag;
  // Zona horaria: la del navegador de quien la crea (si la envía); moneda: la de la región del idioma.
  const settings = { ...DEFAULT_SETTINGS, locale: tag, currency: defaultCurrency(tag), timezone: input.timezone ?? DEFAULT_SETTINGS.timezone };
  const { bp, releaseTitle, releaseSummary } = withLocale(locale, () => ({
    bp: defaultBlueprint({ currency: settings.currency }),
    releaseTitle: t('Versión inicial del CRM'),
    releaseSummary: t('CRM base: Empresas, Contactos, Oportunidades, Tareas y Actividades.'),
  }));
  await db.tx(async (q) => {
    await q.query(`INSERT INTO workspaces (id, name, slug, blueprint_version, settings) VALUES ($1,$2,$3,1,$4)`, [id, input.name, slug, JSON.stringify(settings)]);
    await q.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [id, input.ownerId]);
    const releaseId = newId();
    await q.query(
      `INSERT INTO blueprint_versions (workspace_id, version, definition, release_id, created_by) VALUES ($1,1,$2,$3,$4)`,
      [id, JSON.stringify(bp), releaseId, input.ownerId],
    );
    await q.query(
      `INSERT INTO releases (id, workspace_id, kind, status, from_version, to_version, title, summary, artifacts, applied_by, approved_by)
       VALUES ($1,$2,'initial','verified',0,1,$5,$6,$3,$4,$4)`,
      [releaseId, id, JSON.stringify(bp.modules.map((m) => ({ path: `blueprint/modules/${m.key}.json`, action: 'create' }))), input.ownerId, releaseTitle, releaseSummary],
    );
    await q.query(`INSERT INTO ai_settings (workspace_id) VALUES ($1)`, [id]);
  });
  return id;
}
