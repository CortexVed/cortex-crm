/**
 * Regla de migraciones del motor de código: las migraciones son inmutables y aditivas.
 *
 * Cómo se añade una migración de forma segura:
 * - `server/src/db/migrations.ts` debe quedar IDÉNTICO a la base salvo por entradas nuevas añadidas al final
 *   de la lista `MIGRATIONS` (justo antes de su `];`). Nada de lo anterior (M001, la RLS de 002,
 *   TENANT_TABLES, runMigrations…) puede cambiar.
 * - Cada entrada nueva tiene exactamente la forma `{ id: 'NNN_nombre', sql: () => `…` },` con un id mayor que
 *   todos los existentes y SQL estático (sin `${}`, barras invertidas ni `$`).
 * - El SQL solo puede crear tablas nuevas, índices y columnas, y dar RLS + política `tenant_isolation` +
 *   GRANT a `evolve_tenant` a las tablas nuevas de organización (las que tienen `workspace_id`, para las
 *   que es obligatorio). Nunca DROP, TRUNCATE, DELETE, UPDATE, INSERT, RENAME, roles, funciones, triggers,
 *   bloques DO, `CREATE TABLE … AS SELECT`, políticas o permisos sobre tablas existentes, ni llamadas a
 *   funciones fuera de una lista corta (un DEFAULT se evalúa como superusuario al migrar).
 * - Una columna nueva `NOT NULL` necesita `DEFAULT` (si no, fallaría en producción con datos y pasaría el CI,
 *   que usa una base vacía).
 */

import { t } from '../i18n';

export const MIGRATIONS_PATH = 'server/src/db/migrations.ts';

export interface MigrationIssue {
  message: string;
  migration?: string;
}

export interface MigrationReport {
  violations: MigrationIssue[];
  warnings: MigrationIssue[];
  added: { id: string; sql: string }[];
}

const ENTRY = /^\{\s*id:\s*'(\d{3}_[a-z0-9_]{1,60})'\s*,\s*sql:\s*\(\)\s*=>\s*`([^`\\$]*)`\s*,?\s*\}\s*,/;
const IDENT = '[A-Z_][A-Z0-9_]*';

/** Funciones (y palabras seguidas de paréntesis) que pueden aparecer en el SQL de una migración. */
const ALLOWED_CALLS = new Set([
  'CHECK', 'KEY', 'UNIQUE', 'USING', 'IN', 'DEFAULT', 'INCLUDE', 'WHERE', 'AND', 'OR', 'NOT', 'ON',
  'VARCHAR', 'CHAR', 'CHARACTER', 'VARYING', 'NUMERIC', 'DECIMAL', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'TIMETZ', 'BIT', 'VARBIT', 'INTERVAL',
  'NOW', 'GEN_RANDOM_UUID', 'APP_CURRENT_WORKSPACE', 'LOWER', 'UPPER', 'COALESCE', 'LENGTH', 'CHAR_LENGTH', 'BTRIM', 'NULLIF', 'GREATEST', 'LEAST', 'ABS',
  'JSONB_TYPEOF', 'JSONB_ARRAY_LENGTH', 'BTREE', 'GIN', 'GIST', 'BRIN', 'HASH',
]);

/**
 * Cláusulas peligrosas dentro de las sentencias permitidas (las sentencias en sí ya se filtran con una
 * lista blanca: CREATE ROLE, CREATE FUNCTION, DO… nunca llegan aquí). Sin palabras que también son nombres
 * de columna habituales (type, role, trigger, owner…).
 */
const DENY = /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|SELECT|RENAME|DISABLE|BYPASSRLS|DEFINER|EXECUTE|GRANT|REVOKE|INHERITS|PARTITION|ALTER COLUMN)\b/;

/** Contenido del paréntesis que abre en `open` si su cierre es el último carácter; si no, null. */
function wholeParenBody(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i === text.length - 1 ? text.slice(open + 1, i) : null;
    }
  }
  return null;
}

/** Separa sentencias (respeta cadenas '…', quita comentarios) o devuelve el motivo por el que no se puede. */
function splitStatements(sql: string): string[] | { error: string } {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i++;
        } else inStr = false;
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
    } else if (c === '"') {
      return { error: t('no se admiten identificadores entre comillas dobles') };
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return { error: t('comentario /* sin cerrar') };
      i = end + 1;
      cur += ' ';
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (inStr) return { error: t('cadena sin cerrar') };
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Comas al nivel superior (fuera de paréntesis y cadenas). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Tablas que crea la base (cualquier `CREATE TABLE [IF NOT EXISTS] x` del archivo de migraciones). */
export function existingTables(migrationsSource: string): Set<string> {
  const out = new Set<string>(['schema_migrations']);
  for (const m of migrationsSource.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) out.add(m[1].toLowerCase());
  return out;
}

interface Statement {
  kind: 'create_table' | 'create_index' | 'add_column' | 'rls' | 'policy' | 'grant' | 'comment';
  table: string;
  text: string;
}

function analyzeSql(id: string, sql: string, existing: Set<string>, report: MigrationReport) {
  const fail = (message: string) => report.violations.push({ migration: id, message: `${id}: ${message}` });
  const warn = (message: string) => report.warnings.push({ migration: id, message: `${id}: ${message}` });
  const split = splitStatements(sql);
  if (!Array.isArray(split)) return fail(t('SQL no válido ({error})', { error: split.error }));
  if (!split.length) return fail(t('la migración está vacía'));

  const statements: Statement[] = [];
  const created = new Map<string, boolean>(); // tabla nueva → ¿tiene workspace_id?
  for (const raw of split) {
    const text = raw.replace(/\s+/g, ' ').trim();
    const upper = text.toUpperCase();
    const noStrings = upper.replace(/'(?:[^']|'')*'/g, "''");
    const short = text.slice(0, 120);
    let m: RegExpMatchArray | null;
    let st: Statement | null = null;
    if ((m = noStrings.match(new RegExp(`^CREATE TABLE IF NOT EXISTS (${IDENT}) \\(`)))) {
      const table = m[1].toLowerCase();
      if (existing.has(table) || created.has(table)) {
        fail(t('la tabla {table} ya existe: no se puede redefinir', { table }));
        continue;
      }
      const body = wholeParenBody(noStrings, m[0].length - 1);
      if (body === null) {
        fail(t('solo se admite CREATE TABLE IF NOT EXISTS {table} (columnas…), sin nada detrás (sin INHERITS, PARTITION ni AS)', { table }));
        continue;
      }
      const columns = splitTopLevel(body);
      created.set(table, columns.some((c) => /^WORKSPACE_ID\s/.test(c)));
      st = { kind: 'create_table', table, text: noStrings };
    } else if ((m = noStrings.match(new RegExp(`^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?${IDENT} ON (${IDENT}) (?:USING ${IDENT} ?)?\\(`)))) {
      const table = m[2].toLowerCase();
      if (m[1] && !created.has(table)) warn(t('índice único sobre la tabla existente {table}: fallará si los datos reales tienen duplicados (el CI usa una base vacía)', { table }));
      if (!created.has(table) && ['records', 'record_history', 'audit_log', 'llm_usage', 'files'].includes(table)) warn(t('crear un índice sobre {table} bloquea sus escrituras mientras se construye', { table }));
      st = { kind: 'create_index', table, text: noStrings };
    } else if ((m = noStrings.match(new RegExp(`^ALTER TABLE (?:IF EXISTS )?(${IDENT}) (ADD COLUMN .*)$`)))) {
      const table = m[1].toLowerCase();
      for (const clause of splitTopLevel(m[2])) {
        if (!/^ADD COLUMN /.test(clause)) fail(t('ALTER TABLE solo puede añadir columnas ({clause})', { clause: clause.slice(0, 60) }));
        else if (/\bNOT NULL\b/.test(clause) && !/\bDEFAULT\b/.test(clause) && !created.has(table)) fail(t('la columna nueva «{column}» es NOT NULL sin DEFAULT: fallaría con los datos existentes', { column: clause.slice(11, 60) }));
      }
      st = { kind: 'add_column', table, text: noStrings };
    } else if ((m = noStrings.match(new RegExp(`^ALTER TABLE (${IDENT}) (?:ENABLE|FORCE) ROW LEVEL SECURITY$`)))) {
      st = { kind: 'rls', table: m[1].toLowerCase(), text: noStrings };
    } else if ((m = noStrings.match(new RegExp(`^CREATE POLICY TENANT_ISOLATION ON (${IDENT}) USING \\(WORKSPACE_ID = APP_CURRENT_WORKSPACE\\(\\)\\) WITH CHECK \\(WORKSPACE_ID = APP_CURRENT_WORKSPACE\\(\\)\\)$`)))) {
      st = { kind: 'policy', table: m[1].toLowerCase(), text: '' };
    } else if ((m = noStrings.match(new RegExp(`^GRANT (?:SELECT|INSERT|UPDATE|DELETE)(?: ?, ?(?:SELECT|INSERT|UPDATE|DELETE))* ON (?:TABLE )?(${IDENT}) TO EVOLVE_TENANT$`)))) {
      st = { kind: 'grant', table: m[1].toLowerCase(), text: '' };
    } else if ((m = noStrings.match(new RegExp(`^COMMENT ON (?:TABLE|COLUMN) (${IDENT})(?:\\.${IDENT})? IS ''$`)))) {
      st = { kind: 'comment', table: m[1].toLowerCase(), text: '' };
    } else {
      fail(t('sentencia no permitida en una migración: «{statement}»', { statement: short }));
      continue;
    }
    if (st.table.startsWith('pg_') || st.table === 'schema_migrations') {
      fail(t('no se puede tocar {table}', { table: st.table }));
      continue;
    }
    // Palabras prohibidas (fuera de cadenas), tras quitar las acciones de las claves foráneas.
    const scan = st.text.replace(/\bON (?:DELETE|UPDATE) (?:CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)\b/g, ' ');
    const deny = scan.match(DENY);
    if (deny) {
      fail(t('{keyword} no está permitido («{statement}»)', { keyword: deny[1], statement: short }));
      continue;
    }
    // Solo funciones de una lista corta (o el nombre de una tabla seguido de su lista de columnas).
    for (const call of scan.matchAll(new RegExp(`(${IDENT})\\s*\\(`, 'g'))) {
      const name = call[1];
      if (ALLOWED_CALLS.has(name) || name.toLowerCase() === st.table || existing.has(name.toLowerCase()) || created.has(name.toLowerCase())) continue;
      fail(t('función no permitida en una migración: {name}()', { name: name.toLowerCase() }));
    }
    statements.push(st);
  }

  // RLS, políticas y permisos: solo para tablas nuevas de esta misma migración, y obligatorios en las que
  // tienen workspace_id (tablas de organización).
  for (const st of statements) {
    if ((st.kind === 'rls' || st.kind === 'policy' || st.kind === 'grant') && !created.has(st.table)) {
      fail(t('{statement} solo se permite sobre tablas creadas en la misma migración ({table})', { statement: st.kind === 'grant' ? 'GRANT' : st.kind === 'policy' ? 'CREATE POLICY' : 'Row Level Security', table: st.table }));
    }
    if (st.kind === 'grant' && created.get(st.table) === false) fail(t('la tabla de plataforma {table} no puede dar permisos a evolve_tenant (solo las que tienen workspace_id)', { table: st.table }));
  }
  for (const [table, tenant] of created) {
    if (!tenant) continue;
    const has = (kind: Statement['kind']) => statements.some((s) => s.kind === kind && s.table === table);
    if (!has('rls') || !has('policy') || !has('grant')) {
      fail(t('la tabla de organización {table} (con workspace_id) necesita en la misma migración: ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON {table} USING (workspace_id = app_current_workspace()) WITH CHECK (workspace_id = app_current_workspace()); GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO evolve_tenant', { table }));
    }
  }
}

/** Compara migrations.ts antes y después y aplica la regla de migraciones inmutables y aditivas. */
export function checkMigrationsChange(before: string, after: string): MigrationReport {
  const report: MigrationReport = { violations: [], warnings: [], added: [] };
  const marker = before.indexOf('export const MIGRATIONS');
  const close = marker < 0 ? -1 : before.indexOf('\n];', marker);
  if (close < 0) {
    report.violations.push({ message: t('No se encuentra la lista MIGRATIONS en la base: migrations.ts no se puede modificar') });
    return report;
  }
  const head = before.slice(0, close + 1);
  const tail = before.slice(close + 1);
  if (after.length < head.length + tail.length || !after.startsWith(head) || !after.endsWith(tail)) {
    report.violations.push({ message: t('Las migraciones existentes son inmutables: solo se pueden añadir entradas nuevas al final de MIGRATIONS (nada antes ni después puede cambiar, tampoco TENANT_TABLES)') });
    return report;
  }
  const inserted = after.slice(head.length, after.length - tail.length);
  const ids = [...before.slice(marker, close).matchAll(/id:\s*'(\d{3})_[a-z0-9_]+'/g)].map((m) => Number(m[1]));
  let last = ids.length ? Math.max(...ids) : 0;
  const existing = existingTables(before);
  let i = 0;
  const seen = new Set<string>();
  while (i < inserted.length) {
    const ws = inserted.slice(i).match(/^(?:\s+|\/\/[^\n]*(?:\n|$))+/);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const m = inserted.slice(i).match(ENTRY);
    if (!m) {
      report.violations.push({ message: t(`Formato de migración no válido cerca de «{near}»: usa { id: 'NNN_nombre', sql: () => \`…\` }, con SQL estático (sin \${}, barras invertidas ni $)`, { near: inserted.slice(i, i + 80).trim() }) });
      return report;
    }
    i += m[0].length;
    const [, id, sql] = m;
    const n = Number(id.slice(0, 3));
    if (seen.has(id) || n <= last) report.violations.push({ migration: id, message: t('{id}: el id debe ser único y mayor que el de la última migración ({last})', { id, last: String(last).padStart(3, '0') }) });
    last = Math.max(last, n);
    seen.add(id);
    report.added.push({ id, sql });
    analyzeSql(id, sql, existing, report);
    for (const tbl of sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/gi)) existing.add(tbl[1].toLowerCase());
  }
  return report;
}
