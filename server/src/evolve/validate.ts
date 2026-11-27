import {
  BLUEPRINT_LIMITS,
  SYSTEM_QUERY_FIELDS,
  findModule,
  type Blueprint,
  type Field,
  type Module,
  type Widget,
} from '../../../shared/blueprint';
import { contrastRatio, navHrefKind, sanitizeCustomCss } from '../../../shared/appearance';
import { ROLE_LABELS } from '../../../shared/constants';
import { collectFieldRefs, collectRelatedCalls, parseFormula } from '../../../shared/formula';
import { normalizeValue } from '../../../shared/records';
import { isPrivateHostname } from '../lib/ssrf';
import { t, tk, tp } from '../i18n';

export interface Issue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

const SYSTEM_DATES = new Set(['created_at', 'updated_at', 'last_activity_at']);
const NUMERIC = new Set(['number', 'currency', 'percent', 'rating']);
const PRIMARY_TYPES = new Set(['text', 'email', 'phone', 'url', 'number', 'select', 'date']);
const WRITABLE_EXCLUDED = new Set(['formula']);
/** Límites de coste: cada escritura recalcula las fórmulas del módulo (y las que dependen de él). */
export const MAX_FORMULAS_PER_MODULE = 300;
export const MAX_FORMULA_CHARS = 2_000_000;

function isNumeric(f: Field | undefined): boolean {
  if (!f) return false;
  return NUMERIC.has(f.type) || (f.type === 'formula' && f.formula?.resultType === 'number');
}

function isTemplate(v: unknown): boolean {
  return typeof v === 'string' && v.includes('{{');
}

export function validateBlueprint(bp: Blueprint): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });
  // Único tope global: el tamaño. Los recuentos (módulos, campos…) son muy altos (BLUEPRINT_LIMITS).
  const bytes = Buffer.byteLength(JSON.stringify(bp));
  if (bytes > BLUEPRINT_LIMITS.maxBlueprintBytes) err('blueprint', t('La configuración ocupa {size} MB; el máximo es {max} MB', { size: Math.round(bytes / 1048576), max: BLUEPRINT_LIMITS.maxBlueprintBytes / 1048576 }));
  /** Claves repetidas; `duplicated` da el mensaje completo de cada una. */
  const dupes = (keys: string[], path: string, duplicated: (key: string) => string) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) err(path, duplicated(k));
      seen.add(k);
    }
  };

  dupes(bp.modules.map((m) => m.key), 'modules', (key) => t('Módulo duplicado: "{key}"', { key }));

  const activeField = (m: Module, k: string) => {
    const f = m.fields.find((x) => x.key === k);
    return f && !f.archived ? f : undefined;
  };
  const queryable = (m: Module, k: string) => (SYSTEM_QUERY_FIELDS as readonly string[]).includes(k) || !!activeField(m, k);
  const isDateLike = (m: Module, k: string) => SYSTEM_DATES.has(k) || ['date', 'datetime'].includes(activeField(m, k)?.type ?? '');

  for (const m of bp.modules) {
    const p = `modules.${m.key}`;
    dupes(m.fields.map((f) => f.key), `${p}.fields`, (key) => t('Campo duplicado: "{key}"', { key }));
    dupes(m.views.map((v) => v.key), `${p}.views`, (key) => t('Vista duplicada: "{key}"', { key }));

    const pf = activeField(m, m.primaryField);
    if (!pf) err(`${p}.primaryField`, t('El campo principal "{field}" no existe o está archivado', { field: m.primaryField }));
    else if (!PRIMARY_TYPES.has(pf.type)) err(`${p}.primaryField`, t('El campo principal debe ser de texto, número, fecha o selección'));

    const formulas = m.fields.filter((f) => f.type === 'formula' && !f.archived);
    if (formulas.length > MAX_FORMULAS_PER_MODULE) err(`${p}.fields`, t('Demasiados campos calculados ({count}); el máximo por módulo es {max}', { count: formulas.length, max: MAX_FORMULAS_PER_MODULE }));

    // Campos
    const formulaGraph = new Map<string, Set<string>>();
    for (const f of m.fields) {
      const fp = `${p}.fields.${f.key}`;
      if (f.type === 'relation' && f.relation) {
        const target = findModule(bp, f.relation.module);
        if (!target) err(fp, t('Relación con un módulo inexistente "{module}"', { module: f.relation.module }));
        else if (target.archived && !f.archived) warn(fp, t('Relación con un módulo archivado "{module}"', { module: target.key }));
      }
      if (f.type === 'formula' && f.formula) {
        try {
          const ast = parseFormula(f.formula.expression);
          const refs = collectFieldRefs(ast);
          for (const r of refs) {
            if (SYSTEM_DATES.has(r)) continue;
            if (r === f.key) err(fp, t('La fórmula no puede referenciarse a sí misma'));
            else if (!activeField(m, r)) err(fp, t('La fórmula usa un campo inexistente {ref}', { ref: `{${r}}` }));
          }
          formulaGraph.set(
            f.key,
            new Set([...refs].filter((r) => m.fields.find((x) => x.key === r)?.type === 'formula')),
          );
          for (const c of collectRelatedCalls(ast)) {
            const target = findModule(bp, c.module);
            if (!target) {
              err(fp, t('{fn} usa un módulo inexistente "{module}"', { fn: c.fn, module: c.module }));
              continue;
            }
            const rel = activeField(target, c.field);
            if (!rel || rel.type !== 'relation' || rel.relation?.module !== m.key) {
              err(fp, t('{fn}: "{module}.{field}" debe ser una relación hacia "{target}"', { fn: c.fn, module: c.module, field: c.field, target: m.key }));
            }
            if (c.fn !== 'COUNT_RELATED' && !isNumeric(activeField(target, c.valueField ?? ''))) {
              err(fp, t('{fn}: "{module}.{field}" debe ser numérico', { fn: c.fn, module: c.module, field: c.valueField }));
            }
          }
        } catch (e) {
          err(fp, t('Fórmula inválida: {error}', { error: tk((e as Error).message) }));
        }
      }
      if (f.defaultValue !== undefined && f.defaultValue !== null && !isTemplate(f.defaultValue) && f.type !== 'formula') {
        const r = normalizeValue(f, f.defaultValue);
        if (!r.ok) err(fp, t('Valor por defecto inválido: {message}', { message: tk(r.message) }));
      }
    }
    // Ciclos entre fórmulas
    const visiting = new Set<string>();
    const done = new Set<string>();
    const dfs = (k: string): boolean => {
      if (visiting.has(k)) return true;
      if (done.has(k)) return false;
      visiting.add(k);
      for (const n of formulaGraph.get(k) ?? []) if (dfs(n)) return true;
      visiting.delete(k);
      done.add(k);
      return false;
    };
    for (const k of formulaGraph.keys()) if (dfs(k)) err(`${p}.fields.${k}`, t('Dependencia circular entre fórmulas'));

    // Vistas
    for (const v of m.views) {
      const vp = `${p}.views.${v.key}`;
      for (const c of v.columns ?? []) if (!queryable(m, c)) warn(vp, t('La columna "{column}" no existe o está archivada', { column: c }));
      for (const c of v.cardFields ?? []) if (!queryable(m, c)) warn(vp, t('El campo de tarjeta "{field}" no existe o está archivado', { field: c }));
      if (v.type === 'kanban') {
        const g = v.groupBy ? activeField(m, v.groupBy) : undefined;
        if (!g || g.type !== 'select') err(vp, t('Una vista kanban necesita agrupar por un campo de selección'));
      }
      if (v.type === 'calendar' && (!v.dateField || !isDateLike(m, v.dateField))) {
        err(vp, t('Una vista calendario necesita un campo de fecha'));
      }
      if (v.colorBy && activeField(m, v.colorBy)?.type !== 'select') warn(vp, t('colorBy "{field}" debería ser un campo de selección', { field: v.colorBy }));
      if (v.sort && !queryable(m, v.sort.field)) err(vp, t('No se puede ordenar por "{field}"', { field: v.sort.field }));
      for (const f of v.filters) if (!queryable(m, f.field)) err(vp, t('Filtro sobre campo inexistente "{field}"', { field: f.field }));
    }
    // Diseño de ficha
    for (const [i, s] of (m.layout ?? []).entries()) {
      for (const k of s.fields) {
        const f = m.fields.find((x) => x.key === k);
        if (!f) err(`${p}.layout[${i}]`, t('La sección "{section}" incluye un campo inexistente "{field}"', { section: s.title, field: k }));
        else if (f.archived) warn(`${p}.layout[${i}]`, t('La sección "{section}" incluye el campo archivado "{field}"', { section: s.title, field: k }));
      }
    }
  }

  const formulaChars = bp.modules.reduce((n, m) => n + m.fields.reduce((k, f) => k + (f.type === 'formula' && !f.archived ? (f.formula?.expression.length ?? 0) : 0), 0), 0);
  if (formulaChars > MAX_FORMULA_CHARS) err('modules', t('Las fórmulas suman {count} caracteres; el máximo es {max}', { count: formulaChars, max: MAX_FORMULA_CHARS }));

  // Automatizaciones
  dupes(bp.automations.map((a) => a.key), 'automations', (key) => t('Automatización duplicada: "{key}"', { key }));
  for (const a of bp.automations) {
    const ap = `automations.${a.key}`;
    const m = findModule(bp, a.trigger.module);
    if (!m) {
      err(ap, t('El disparador usa un módulo inexistente "{module}"', { module: a.trigger.module }));
      continue;
    }
    if (m.archived && a.enabled) warn(ap, t('El módulo "{module}" está archivado', { module: m.key }));
    const trigger = a.trigger;
    if (trigger.type === 'field_changed' && !activeField(m, trigger.field)) err(ap, t('El disparador usa un campo inexistente "{field}"', { field: trigger.field }));
    if (trigger.type === 'date_reached' && !['date', 'datetime'].includes(activeField(m, trigger.field)?.type ?? '')) {
      err(ap, t('El disparador por fecha necesita un campo de fecha ("{field}")', { field: trigger.field }));
    }
    for (const c of a.conditions) if (!queryable(m, c.field)) err(ap, t('Condición sobre campo inexistente "{field}"', { field: c.field }));
    for (const [i, act] of a.actions.entries()) {
      const xp = `${ap}.actions[${i}]`;
      if (act.type === 'update_field') {
        const f = activeField(m, act.field);
        if (!f || WRITABLE_EXCLUDED.has(f.type) || f.type === 'file') err(xp, t('No se puede actualizar el campo "{field}"', { field: act.field }));
        else if (!isTemplate(act.value) && act.value !== null) {
          const r = normalizeValue(f, act.value);
          if (!r.ok) err(xp, t('Valor inválido para "{field}": {message}', { field: act.field, message: tk(r.message) }));
        }
        if (trigger.type === 'record_updated') warn(xp, t('Actualizar el mismo módulo en cada edición puede encadenar ejecuciones (el motor limita la profundidad a 3).'));
      } else if (act.type === 'create_record') {
        const target = findModule(bp, act.module);
        if (!target) err(xp, t('Módulo inexistente "{module}"', { module: act.module }));
        else if (target.key === m.key && a.enabled && !a.conditions.length && (trigger.type === 'record_created' || trigger.type === 'field_changed')) {
          // Cada registro creado vuelve a disparar la automatización: bucle sin condición que lo corte.
          err(xp, t('Bucle: al crearse un registro de "{module}" se crearía otro en el mismo módulo, que la volvería a disparar. Añade una condición que lo evite.', { module: m.key }));
        } else {
          for (const k of Object.keys(act.values)) {
            const f = activeField(target, k);
            if (!f || WRITABLE_EXCLUDED.has(f.type)) err(xp, t('Campo inexistente o no editable "{module}.{field}"', { module: act.module, field: k }));
          }
          if (act.linkField) {
            const lf = activeField(target, act.linkField);
            if (!lf || lf.type !== 'relation' || lf.relation?.module !== m.key) {
              err(xp, t('linkField "{field}" debe ser una relación de "{module}" hacia "{target}"', { field: act.linkField, module: act.module, target: m.key }));
            }
          }
        }
      } else if (act.type === 'send_webhook') {
        if (!bp.integrations.some((i) => i.key === act.integration)) err(xp, t('Integración inexistente "{integration}"', { integration: act.integration }));
      } else if (act.type === 'notify' && act.to.type === 'user_field') {
        if (activeField(m, act.to.field)?.type !== 'user') err(xp, t('"{field}" debe ser un campo de usuario', { field: act.to.field }));
      } else if (act.type === 'run_script') {
        const s = (bp.scripts ?? []).find((x) => x.key === act.script);
        if (!s) err(xp, t('Script inexistente "{script}"', { script: act.script }));
        else if (!s.enabled && a.enabled) warn(xp, t('El script "{script}" está desactivado: la acción no hará nada', { script: act.script }));
        if (trigger.type === 'record_updated') warn(xp, t('Un script en cada edición puede encadenar ejecuciones si actualiza el registro (el motor limita la profundidad a 3).'));
      }
    }
  }

  // Scripts de la organización (sandbox)
  dupes((bp.scripts ?? []).map((s) => s.key), 'scripts', (key) => t('Script duplicado: "{key}"', { key }));
  for (const s of bp.scripts ?? []) {
    const sp = `scripts.${s.key}`;
    if (!s.code.trim()) err(sp, t('El script "{script}" no tiene código', { script: s.key }));
    else if (!/function\s+run\s*\(/.test(s.code)) err(sp, t('El script "{script}" debe definir function run(input)', { script: s.key }));
    if (/\b(require|import)\s*\(|^\s*import\s/m.test(s.code)) err(sp, t('El script "{script}" no puede importar módulos (el sandbox no tiene acceso a ellos)', { script: s.key }));
    if (!bp.automations.some((a) => a.actions.some((x) => x.type === 'run_script' && x.script === s.key))) warn(sp, t('Ninguna automatización usa el script "{script}"', { script: s.key }));
  }

  // Paneles (las mismas reglas de widgets se aplican a los widgets de las páginas)
  const checkWidget = (w: Widget, wp: string) => {
    const m = findModule(bp, w.module);
    if (!m) {
      err(wp, t('Módulo inexistente "{module}"', { module: w.module }));
      return;
    }
    if (w.aggregate !== 'count' && !isNumeric(activeField(m, w.field ?? ''))) err(wp, t('"{field}" debe ser numérico para {aggregate}', { field: w.field, aggregate: w.aggregate }));
    if ((w.type === 'bar' || w.type === 'donut') && (!w.groupBy || !queryable(m, w.groupBy))) err(wp, t('El gráfico necesita un campo de agrupación válido'));
    if (w.type === 'line' && (!w.dateField || !isDateLike(m, w.dateField))) err(wp, t('El gráfico de evolución necesita un campo de fecha'));
    for (const f of w.filters) if (!queryable(m, f.field)) err(wp, t('Filtro sobre campo inexistente "{field}"', { field: f.field }));
  };
  dupes(bp.dashboards.map((d) => d.key), 'dashboards', (key) => t('Panel duplicado: "{key}"', { key }));
  for (const d of bp.dashboards) {
    dupes(d.widgets.map((w) => w.key), `dashboards.${d.key}`, (key) => t('Widget duplicado: "{key}"', { key }));
    for (const w of d.widgets) checkWidget(w, `dashboards.${d.key}.${w.key}`);
  }

  // Integraciones
  dupes(bp.integrations.map((i) => i.key), 'integrations', (key) => t('Integración duplicada: "{key}"', { key }));
  for (const i of bp.integrations) {
    try {
      const u = new URL(i.url);
      if (u.protocol !== 'https:') err(`integrations.${i.key}`, t('Solo se permiten webhooks HTTPS'));
      if (u.username || u.password) err(`integrations.${i.key}`, t('La URL no puede incluir credenciales'));
      if (isPrivateHostname(u.hostname)) err(`integrations.${i.key}`, t('No se permiten destinos internos o privados (protección SSRF)'));
    } catch {
      err(`integrations.${i.key}`, t('URL inválida'));
    }
  }

  // Formularios
  dupes(bp.forms.map((f) => f.key), 'forms', (key) => t('Formulario duplicado: "{key}"', { key }));
  for (const form of bp.forms) {
    const fp = `forms.${form.key}`;
    const m = findModule(bp, form.module);
    if (!m) {
      err(fp, t('Módulo inexistente "{module}"', { module: form.module }));
      continue;
    }
    for (const k of form.fields) {
      const f = activeField(m, k);
      if (!f || f.type === 'formula' || f.type === 'file') err(fp, t('Campo no válido en formulario "{field}"', { field: k }));
      if (form.public && f && (f.type === 'user' || f.type === 'relation')) err(fp, t('Un formulario público no puede incluir el campo interno "{field}"', { field: k }));
    }
    for (const f of m.fields) {
      if (f.required && !f.archived && f.defaultValue === undefined && !form.fields.includes(f.key) && form.defaults[f.key] === undefined) {
        warn(fp, t('El formulario no incluye el campo obligatorio "{field}"', { field: f.key }));
      }
    }
  }

  // Capa visual: apariencia, páginas y menú. Las referencias (módulos, vistas, paneles, páginas, formularios)
  // deben existir; un módulo archivado solo avisa (su bloque o su enlace dejan de mostrarse).
  const look = bp.appearance;
  if (look) {
    const ratio = contrastRatio(look.brandColor, '#ffffff');
    if (ratio < 3) warn('appearance.brandColor', t('El texto blanco sobre el color principal {color} tiene poco contraste ({ratio}:1): los botones principales pueden leerse mal', { color: look.brandColor, ratio: ratio.toFixed(1) }));
    if (look.accentColor && look.accentColor === look.brandColor) warn('appearance.accentColor', t('El color de acento es igual al principal'));
    // Los errores del CSS llegan como claves del catálogo (o ya traducidos).
    if (look.customCss !== undefined) for (const e of sanitizeCustomCss(look.customCss).errors) err('appearance.customCss', tk(e));
  }
  const pages = bp.pages ?? [];
  const pageKeys = new Set(pages.map((p) => p.key));
  const dashboardKeys = new Set(bp.dashboards.map((d) => d.key));
  /** Referencia a un módulo desde un bloque, un botón o el menú: `problem` da los mensajes completos. */
  const moduleRef = (path: string, key: string, problem: { missing: string; archived: string }) => {
    const m = findModule(bp, key);
    if (!m) err(path, problem.missing);
    else if (m.archived) warn(path, problem.archived);
    return m;
  };
  dupes(pages.map((p) => p.key), 'pages', (key) => t('Página duplicada: "{key}"', { key }));
  for (const page of pages) {
    const pp = `pages.${page.key}`;
    dupes(page.blocks.flatMap((b) => (b.type === 'widget' ? [b.widget.key] : [])), pp, (key) => t('Widget duplicado: "{key}"', { key }));
    page.blocks.forEach((b, i) => {
      const bpath = `${pp}.blocks[${i}]`;
      if (b.type === 'widget') checkWidget(b.widget, `${bpath}.${b.widget.key}`);
      else if (b.type === 'records') {
        const m = moduleRef(bpath, b.module, {
          missing: t('La lista de registros usa un módulo inexistente "{key}"', { key: b.module }),
          archived: t('La lista de registros usa el módulo archivado "{key}": no se mostrará', { key: b.module }),
        });
        if (!m) return;
        if (b.view && !m.views.some((v) => v.key === b.view)) err(bpath, t('La vista "{view}" no existe en "{module}"', { view: b.view, module: m.key }));
        for (const f of b.filters) if (!queryable(m, f.field)) err(bpath, t('Filtro sobre campo inexistente "{field}"', { field: f.field }));
        for (const c of b.columns ?? []) if (!queryable(m, c)) warn(bpath, t('La columna "{column}" no existe o está archivada', { column: c }));
      } else if (b.type === 'form') {
        if (!bp.forms.some((f) => f.key === b.form)) err(bpath, t('Formulario inexistente "{form}"', { form: b.form }));
      } else if (b.type === 'buttons') {
        b.items.forEach((it, j) => {
          const ip = `${bpath}.items[${j}]`;
          const dest = it.to;
          if (dest.type === 'module' || dest.type === 'new_record') {
            moduleRef(ip, dest.key, {
              missing: t('El botón «{label}» usa un módulo inexistente "{key}"', { label: it.label, key: dest.key }),
              archived: t('El botón «{label}» usa el módulo archivado "{key}": no se mostrará', { label: it.label, key: dest.key }),
            });
          } else if (dest.type === 'page' && !pageKeys.has(dest.key)) err(ip, t('El botón «{label}» enlaza a la página inexistente "{key}"', { label: it.label, key: dest.key }));
          else if (dest.type === 'dashboard' && !dashboardKeys.has(dest.key)) err(ip, t('El botón «{label}» enlaza al panel inexistente "{key}"', { label: it.label, key: dest.key }));
        });
      }
    });
  }
  const nav = bp.navigation;
  if (nav) {
    dupes(nav.groups.map((g) => g.key), 'navigation.groups', (key) => t('Grupo del menú duplicado: "{key}"', { key }));
    const listed = new Set<string>();
    for (const g of nav.groups) {
      g.items.forEach((it, j) => {
        const ip = `navigation.groups.${g.key}.items[${j}]`;
        if (it.type === 'module') {
          listed.add(it.key);
          moduleRef(ip, it.key, {
            missing: t('El menú («{group}») usa un módulo inexistente "{key}"', { group: g.label, key: it.key }),
            archived: t('El menú («{group}») usa el módulo archivado "{key}": no se mostrará', { group: g.label, key: it.key }),
          });
        } else if (it.type === 'page' && !pageKeys.has(it.key)) err(ip, t('El menú («{group}») enlaza a la página inexistente "{key}"', { group: g.label, key: it.key }));
        else if (it.type === 'dashboard' && !dashboardKeys.has(it.key)) err(ip, t('El menú («{group}») enlaza al panel inexistente "{key}"', { group: g.label, key: it.key }));
        else if (it.type === 'link' && !navHrefKind(it.href)) {
          err(ip, t('El menú («{group}»): enlace no permitido "{href}" (usa una ruta de la aplicación que empiece por / o una URL https://)', { group: g.label, href: it.href.slice(0, 80) }));
        }
      });
    }
    const home = nav.home;
    if (home?.type === 'page') {
      const target = pages.find((p) => p.key === home.key);
      if (!target) err('navigation.home', t('La página de inicio "{key}" no existe', { key: home.key }));
      else if (target.minRole !== 'viewer') warn('navigation.home', t('La página de inicio solo la ve el rol {role} o superior: el resto verá el panel', { role: tk(ROLE_LABELS[target.minRole]) }));
    } else if (home?.type === 'dashboard' && !dashboardKeys.has(home.key)) err('navigation.home', t('El panel de inicio "{key}" no existe', { key: home.key }));
    if (nav.groups.length) {
      const unlisted = bp.modules.filter((m) => !m.archived && !listed.has(m.key));
      if (unlisted.length) {
        const names = `${unlisted.slice(0, 5).map((m) => m.labelPlural).join(', ')}${unlisted.length > 5 ? '…' : ''}`;
        warn(
          'navigation',
          tp(
            unlisted.length,
            '{count} módulo no aparece en ningún grupo del menú ({names}): se mostrará al final del menú, en «Otros»',
            '{count} módulos no aparecen en ningún grupo del menú ({names}): se mostrarán al final del menú, en «Otros»',
            { names },
          ),
        );
      }
    }
  }
  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
