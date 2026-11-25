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
  if (bytes > BLUEPRINT_LIMITS.maxBlueprintBytes) err('blueprint', `La configuración ocupa ${Math.round(bytes / 1048576)} MB; el máximo es ${BLUEPRINT_LIMITS.maxBlueprintBytes / 1048576} MB`);
  const dupes = (keys: string[], path: string, what: string) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) err(path, `${what} duplicado: "${k}"`);
      seen.add(k);
    }
  };

  dupes(bp.modules.map((m) => m.key), 'modules', 'Módulo');

  const activeField = (m: Module, k: string) => {
    const f = m.fields.find((x) => x.key === k);
    return f && !f.archived ? f : undefined;
  };
  const queryable = (m: Module, k: string) => (SYSTEM_QUERY_FIELDS as readonly string[]).includes(k) || !!activeField(m, k);
  const isDateLike = (m: Module, k: string) => SYSTEM_DATES.has(k) || ['date', 'datetime'].includes(activeField(m, k)?.type ?? '');

  for (const m of bp.modules) {
    const p = `modules.${m.key}`;
    dupes(m.fields.map((f) => f.key), `${p}.fields`, 'Campo');
    dupes(m.views.map((v) => v.key), `${p}.views`, 'Vista');

    const pf = activeField(m, m.primaryField);
    if (!pf) err(`${p}.primaryField`, `El campo principal "${m.primaryField}" no existe o está archivado`);
    else if (!PRIMARY_TYPES.has(pf.type)) err(`${p}.primaryField`, `El campo principal debe ser de texto, número, fecha o selección`);

    const formulas = m.fields.filter((f) => f.type === 'formula' && !f.archived);
    if (formulas.length > MAX_FORMULAS_PER_MODULE) err(`${p}.fields`, `Demasiados campos calculados (${formulas.length}); el máximo por módulo es ${MAX_FORMULAS_PER_MODULE}`);

    // Campos
    const formulaGraph = new Map<string, Set<string>>();
    for (const f of m.fields) {
      const fp = `${p}.fields.${f.key}`;
      if (f.type === 'relation' && f.relation) {
        const target = findModule(bp, f.relation.module);
        if (!target) err(fp, `Relación con un módulo inexistente "${f.relation.module}"`);
        else if (target.archived && !f.archived) warn(fp, `Relación con un módulo archivado "${target.key}"`);
      }
      if (f.type === 'formula' && f.formula) {
        try {
          const ast = parseFormula(f.formula.expression);
          const refs = collectFieldRefs(ast);
          for (const r of refs) {
            if (SYSTEM_DATES.has(r)) continue;
            if (r === f.key) err(fp, 'La fórmula no puede referenciarse a sí misma');
            else if (!activeField(m, r)) err(fp, `La fórmula usa un campo inexistente {${r}}`);
          }
          formulaGraph.set(
            f.key,
            new Set([...refs].filter((r) => m.fields.find((x) => x.key === r)?.type === 'formula')),
          );
          for (const c of collectRelatedCalls(ast)) {
            const target = findModule(bp, c.module);
            if (!target) {
              err(fp, `${c.fn} usa un módulo inexistente "${c.module}"`);
              continue;
            }
            const rel = activeField(target, c.field);
            if (!rel || rel.type !== 'relation' || rel.relation?.module !== m.key) {
              err(fp, `${c.fn}: "${c.module}.${c.field}" debe ser una relación hacia "${m.key}"`);
            }
            if (c.fn !== 'COUNT_RELATED' && !isNumeric(activeField(target, c.valueField ?? ''))) {
              err(fp, `${c.fn}: "${c.module}.${c.valueField}" debe ser numérico`);
            }
          }
        } catch (e) {
          err(fp, `Fórmula inválida: ${(e as Error).message}`);
        }
      }
      if (f.defaultValue !== undefined && f.defaultValue !== null && !isTemplate(f.defaultValue) && f.type !== 'formula') {
        const r = normalizeValue(f, f.defaultValue);
        if (!r.ok) err(fp, `Valor por defecto inválido: ${r.message}`);
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
    for (const k of formulaGraph.keys()) if (dfs(k)) err(`${p}.fields.${k}`, 'Dependencia circular entre fórmulas');

    // Vistas
    for (const v of m.views) {
      const vp = `${p}.views.${v.key}`;
      for (const c of v.columns ?? []) if (!queryable(m, c)) warn(vp, `La columna "${c}" no existe o está archivada`);
      for (const c of v.cardFields ?? []) if (!queryable(m, c)) warn(vp, `El campo de tarjeta "${c}" no existe o está archivado`);
      if (v.type === 'kanban') {
        const g = v.groupBy ? activeField(m, v.groupBy) : undefined;
        if (!g || g.type !== 'select') err(vp, 'Una vista kanban necesita agrupar por un campo de selección');
      }
      if (v.type === 'calendar' && (!v.dateField || !isDateLike(m, v.dateField))) {
        err(vp, 'Una vista calendario necesita un campo de fecha');
      }
      if (v.colorBy && activeField(m, v.colorBy)?.type !== 'select') warn(vp, `colorBy "${v.colorBy}" debería ser un campo de selección`);
      if (v.sort && !queryable(m, v.sort.field)) err(vp, `No se puede ordenar por "${v.sort.field}"`);
      for (const f of v.filters) if (!queryable(m, f.field)) err(vp, `Filtro sobre campo inexistente "${f.field}"`);
    }
    // Diseño de ficha
    for (const [i, s] of (m.layout ?? []).entries()) {
      for (const k of s.fields) {
        const f = m.fields.find((x) => x.key === k);
        if (!f) err(`${p}.layout[${i}]`, `La sección "${s.title}" incluye un campo inexistente "${k}"`);
        else if (f.archived) warn(`${p}.layout[${i}]`, `La sección "${s.title}" incluye el campo archivado "${k}"`);
      }
    }
  }

  const formulaChars = bp.modules.reduce((n, m) => n + m.fields.reduce((k, f) => k + (f.type === 'formula' && !f.archived ? (f.formula?.expression.length ?? 0) : 0), 0), 0);
  if (formulaChars > MAX_FORMULA_CHARS) err('modules', `Las fórmulas suman ${formulaChars} caracteres; el máximo es ${MAX_FORMULA_CHARS}`);

  // Automatizaciones
  dupes(bp.automations.map((a) => a.key), 'automations', 'Automatización');
  for (const a of bp.automations) {
    const ap = `automations.${a.key}`;
    const m = findModule(bp, a.trigger.module);
    if (!m) {
      err(ap, `El disparador usa un módulo inexistente "${a.trigger.module}"`);
      continue;
    }
    if (m.archived && a.enabled) warn(ap, `El módulo "${m.key}" está archivado`);
    const t = a.trigger;
    if (t.type === 'field_changed' && !activeField(m, t.field)) err(ap, `El disparador usa un campo inexistente "${t.field}"`);
    if (t.type === 'date_reached' && !['date', 'datetime'].includes(activeField(m, t.field)?.type ?? '')) {
      err(ap, `El disparador por fecha necesita un campo de fecha ("${t.field}")`);
    }
    for (const c of a.conditions) if (!queryable(m, c.field)) err(ap, `Condición sobre campo inexistente "${c.field}"`);
    for (const [i, act] of a.actions.entries()) {
      const xp = `${ap}.actions[${i}]`;
      if (act.type === 'update_field') {
        const f = activeField(m, act.field);
        if (!f || WRITABLE_EXCLUDED.has(f.type) || f.type === 'file') err(xp, `No se puede actualizar el campo "${act.field}"`);
        else if (!isTemplate(act.value) && act.value !== null) {
          const r = normalizeValue(f, act.value);
          if (!r.ok) err(xp, `Valor inválido para "${act.field}": ${r.message}`);
        }
        if (t.type === 'record_updated') warn(xp, 'Actualizar el mismo módulo en cada edición puede encadenar ejecuciones (el motor limita la profundidad a 3).');
      } else if (act.type === 'create_record') {
        const target = findModule(bp, act.module);
        if (!target) err(xp, `Módulo inexistente "${act.module}"`);
        else if (target.key === m.key && a.enabled && !a.conditions.length && (t.type === 'record_created' || t.type === 'field_changed')) {
          // Cada registro creado vuelve a disparar la automatización: bucle sin condición que lo corte.
          err(xp, `Bucle: al crearse un registro de "${m.key}" se crearía otro en el mismo módulo, que la volvería a disparar. Añade una condición que lo evite.`);
        } else {
          for (const k of Object.keys(act.values)) {
            const f = activeField(target, k);
            if (!f || WRITABLE_EXCLUDED.has(f.type)) err(xp, `Campo inexistente o no editable "${act.module}.${k}"`);
          }
          if (act.linkField) {
            const lf = activeField(target, act.linkField);
            if (!lf || lf.type !== 'relation' || lf.relation?.module !== m.key) {
              err(xp, `linkField "${act.linkField}" debe ser una relación de "${act.module}" hacia "${m.key}"`);
            }
          }
        }
      } else if (act.type === 'send_webhook') {
        if (!bp.integrations.some((i) => i.key === act.integration)) err(xp, `Integración inexistente "${act.integration}"`);
      } else if (act.type === 'notify' && act.to.type === 'user_field') {
        if (activeField(m, act.to.field)?.type !== 'user') err(xp, `"${act.to.field}" debe ser un campo de usuario`);
      } else if (act.type === 'run_script') {
        const s = (bp.scripts ?? []).find((x) => x.key === act.script);
        if (!s) err(xp, `Script inexistente "${act.script}"`);
        else if (!s.enabled && a.enabled) warn(xp, `El script "${act.script}" está desactivado: la acción no hará nada`);
        if (t.type === 'record_updated') warn(xp, 'Un script en cada edición puede encadenar ejecuciones si actualiza el registro (el motor limita la profundidad a 3).');
      }
    }
  }

  // Scripts de la organización (sandbox)
  dupes((bp.scripts ?? []).map((s) => s.key), 'scripts', 'Script');
  for (const s of bp.scripts ?? []) {
    const sp = `scripts.${s.key}`;
    if (!s.code.trim()) err(sp, `El script "${s.key}" no tiene código`);
    else if (!/function\s+run\s*\(/.test(s.code)) err(sp, `El script "${s.key}" debe definir function run(input)`);
    if (/\b(require|import)\s*\(|^\s*import\s/m.test(s.code)) err(sp, `El script "${s.key}" no puede importar módulos (el sandbox no tiene acceso a ellos)`);
    if (!bp.automations.some((a) => a.actions.some((x) => x.type === 'run_script' && x.script === s.key))) warn(sp, `Ninguna automatización usa el script "${s.key}"`);
  }

  // Paneles (las mismas reglas de widgets se aplican a los widgets de las páginas)
  const checkWidget = (w: Widget, wp: string) => {
    const m = findModule(bp, w.module);
    if (!m) {
      err(wp, `Módulo inexistente "${w.module}"`);
      return;
    }
    if (w.aggregate !== 'count' && !isNumeric(activeField(m, w.field ?? ''))) err(wp, `"${w.field}" debe ser numérico para ${w.aggregate}`);
    if ((w.type === 'bar' || w.type === 'donut') && (!w.groupBy || !queryable(m, w.groupBy))) err(wp, 'El gráfico necesita un campo de agrupación válido');
    if (w.type === 'line' && (!w.dateField || !isDateLike(m, w.dateField))) err(wp, 'El gráfico de evolución necesita un campo de fecha');
    for (const f of w.filters) if (!queryable(m, f.field)) err(wp, `Filtro sobre campo inexistente "${f.field}"`);
  };
  dupes(bp.dashboards.map((d) => d.key), 'dashboards', 'Panel');
  for (const d of bp.dashboards) {
    dupes(d.widgets.map((w) => w.key), `dashboards.${d.key}`, 'Widget');
    for (const w of d.widgets) checkWidget(w, `dashboards.${d.key}.${w.key}`);
  }

  // Integraciones
  dupes(bp.integrations.map((i) => i.key), 'integrations', 'Integración');
  for (const i of bp.integrations) {
    try {
      const u = new URL(i.url);
      if (u.protocol !== 'https:') err(`integrations.${i.key}`, 'Solo se permiten webhooks HTTPS');
      if (u.username || u.password) err(`integrations.${i.key}`, 'La URL no puede incluir credenciales');
      if (isPrivateHostname(u.hostname)) err(`integrations.${i.key}`, 'No se permiten destinos internos o privados (protección SSRF)');
    } catch {
      err(`integrations.${i.key}`, 'URL inválida');
    }
  }

  // Formularios
  dupes(bp.forms.map((f) => f.key), 'forms', 'Formulario');
  for (const form of bp.forms) {
    const fp = `forms.${form.key}`;
    const m = findModule(bp, form.module);
    if (!m) {
      err(fp, `Módulo inexistente "${form.module}"`);
      continue;
    }
    for (const k of form.fields) {
      const f = activeField(m, k);
      if (!f || f.type === 'formula' || f.type === 'file') err(fp, `Campo no válido en formulario "${k}"`);
      if (form.public && f && (f.type === 'user' || f.type === 'relation')) err(fp, `Un formulario público no puede incluir el campo interno "${k}"`);
    }
    for (const f of m.fields) {
      if (f.required && !f.archived && f.defaultValue === undefined && !form.fields.includes(f.key) && form.defaults[f.key] === undefined) {
        warn(fp, `El formulario no incluye el campo obligatorio "${f.key}"`);
      }
    }
  }

  // Capa visual: apariencia, páginas y menú. Las referencias (módulos, vistas, paneles, páginas, formularios)
  // deben existir; un módulo archivado solo avisa (su bloque o su enlace dejan de mostrarse).
  const look = bp.appearance;
  if (look) {
    const ratio = contrastRatio(look.brandColor, '#ffffff');
    if (ratio < 3) warn('appearance.brandColor', `El texto blanco sobre el color principal ${look.brandColor} tiene poco contraste (${ratio.toFixed(1)}:1): los botones principales pueden leerse mal`);
    if (look.accentColor && look.accentColor === look.brandColor) warn('appearance.accentColor', 'El color de acento es igual al principal');
    if (look.customCss !== undefined) for (const e of sanitizeCustomCss(look.customCss).errors) err('appearance.customCss', e);
  }
  const pages = bp.pages ?? [];
  const pageKeys = new Set(pages.map((p) => p.key));
  const dashboardKeys = new Set(bp.dashboards.map((d) => d.key));
  const moduleRef = (path: string, key: string, what: string) => {
    const m = findModule(bp, key);
    if (!m) err(path, `${what} usa un módulo inexistente "${key}"`);
    else if (m.archived) warn(path, `${what} usa el módulo archivado "${key}": no se mostrará`);
    return m;
  };
  dupes(pages.map((p) => p.key), 'pages', 'Página');
  for (const page of pages) {
    const pp = `pages.${page.key}`;
    dupes(page.blocks.flatMap((b) => (b.type === 'widget' ? [b.widget.key] : [])), pp, 'Widget');
    page.blocks.forEach((b, i) => {
      const bpath = `${pp}.blocks[${i}]`;
      if (b.type === 'widget') checkWidget(b.widget, `${bpath}.${b.widget.key}`);
      else if (b.type === 'records') {
        const m = moduleRef(bpath, b.module, 'La lista de registros');
        if (!m) return;
        if (b.view && !m.views.some((v) => v.key === b.view)) err(bpath, `La vista "${b.view}" no existe en "${m.key}"`);
        for (const f of b.filters) if (!queryable(m, f.field)) err(bpath, `Filtro sobre campo inexistente "${f.field}"`);
        for (const c of b.columns ?? []) if (!queryable(m, c)) warn(bpath, `La columna "${c}" no existe o está archivada`);
      } else if (b.type === 'form') {
        if (!bp.forms.some((f) => f.key === b.form)) err(bpath, `Formulario inexistente "${b.form}"`);
      } else if (b.type === 'buttons') {
        b.items.forEach((it, j) => {
          const ip = `${bpath}.items[${j}]`;
          const t = it.to;
          if (t.type === 'module' || t.type === 'new_record') moduleRef(ip, t.key, `El botón «${it.label}»`);
          else if (t.type === 'page' && !pageKeys.has(t.key)) err(ip, `El botón «${it.label}» enlaza a la página inexistente "${t.key}"`);
          else if (t.type === 'dashboard' && !dashboardKeys.has(t.key)) err(ip, `El botón «${it.label}» enlaza al panel inexistente "${t.key}"`);
        });
      }
    });
  }
  const nav = bp.navigation;
  if (nav) {
    dupes(nav.groups.map((g) => g.key), 'navigation.groups', 'Grupo del menú');
    const listed = new Set<string>();
    for (const g of nav.groups) {
      g.items.forEach((it, j) => {
        const ip = `navigation.groups.${g.key}.items[${j}]`;
        const where = `El menú («${g.label}»)`;
        if (it.type === 'module') {
          listed.add(it.key);
          moduleRef(ip, it.key, where);
        } else if (it.type === 'page' && !pageKeys.has(it.key)) err(ip, `${where} enlaza a la página inexistente "${it.key}"`);
        else if (it.type === 'dashboard' && !dashboardKeys.has(it.key)) err(ip, `${where} enlaza al panel inexistente "${it.key}"`);
        else if (it.type === 'link' && !navHrefKind(it.href)) err(ip, `${where}: enlace no permitido "${it.href.slice(0, 80)}" (usa una ruta de la aplicación que empiece por / o una URL https://)`);
      });
    }
    const home = nav.home;
    if (home?.type === 'page') {
      const target = pages.find((p) => p.key === home.key);
      if (!target) err('navigation.home', `La página de inicio "${home.key}" no existe`);
      else if (target.minRole !== 'viewer') warn('navigation.home', `La página de inicio solo la ve el rol ${ROLE_LABELS[target.minRole]} o superior: el resto verá el panel`);
    } else if (home?.type === 'dashboard' && !dashboardKeys.has(home.key)) err('navigation.home', `El panel de inicio "${home.key}" no existe`);
    if (nav.groups.length) {
      const unlisted = bp.modules.filter((m) => !m.archived && !listed.has(m.key));
      if (unlisted.length) {
        const names = unlisted.slice(0, 5).map((m) => m.labelPlural).join(', ');
        warn('navigation', `${unlisted.length} módulo(s) no aparecen en ningún grupo del menú (${names}${unlisted.length > 5 ? '…' : ''}): se mostrarán al final del menú, en «Otros»`);
      }
    }
  }
  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
