#!/usr/bin/env node
// Catálogos de idiomas de Cortex CRM (ver shared/i18n/index.ts).
//
//   node scripts/i18n.mjs check            Falla si falta alguna traducción, sobra alguna clave, una clave no es un
//                                          literal, una variable local tapa t/tp/tk/tx/msg, un mensaje de error lleva
//                                          datos sin t(), o la web muestra texto sin traducir.
//   node scripts/i18n.mjs sync             Añade a cada catálogo las claves nuevas (vacías) y quita las que ya no se usan.
//   node scripts/i18n.mjs status           Cuántas claves hay y cuántas faltan por idioma.
//   node scripts/i18n.mjs keys [salida]    Lista de claves con dónde se usan (JSON), para traducir con contexto.
//   node scripts/i18n.mjs missing <idioma> [salida]   Claves sin traducir de un idioma (JSON con contexto).
//   node scripts/i18n.mjs untranslated [rutas…]       Textos que parecen visibles y no pasan por t() (ayuda al convertir).
//
// Sin dependencias nuevas: usa el parser de rolldown, que ya viene con Vite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'shared/i18n/locales');
const TARGETS = ['en', 'pt-BR', 'fr', 'de', 'it', 'ja'];
const SCAN = ['web/src', 'server/src', 'shared'];
const I18N_NAMES = new Set(['t', 'tp', 'tk', 'tx', 'msg']);
const KEY_FUNCS = new Set(['t', 'tx', 'msg']);
const ERROR_HELPERS = new Set(['badRequest', 'unauthorized', 'forbidden', 'notFound', 'conflict', 'unprocessable', 'tooMany', 'unavailable']);
const LOG_OBJECTS = /^(console|log|logger)$/;
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'fatal']);

// ------------------------------------------------------------------------------------------------ archivos y AST

function listFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'locales') continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
    }
  };
  for (const d of SCAN) walk(path.join(ROOT, d));
  return out.sort();
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function parse(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', astType: 'ts' }, file);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = src.split('\n');
  const ignored = (offset) => {
    const n = lineOf(offset);
    return /i18n-ignore/.test(lines[n - 1] ?? '') || /i18n-ignore/.test(lines[n - 2] ?? '');
  };
  return { src, ast: ast.program ?? ast, lineOf, ignored };
}

/** Recorre el AST con el padre y la propiedad por la que se llegó a cada nodo. */
function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, parent, key);
    return;
  }
  if (typeof node.type !== 'string') return;
  if (visit(node, parent, key) === false) return;
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, visit, node, k);
  }
}

/** Valor de un literal de texto (comillas o plantilla sin ${}); null si no lo es. */
function literalText(n) {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
  if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression') return literalText(n.expression);
  return null;
}

const calleeName = (c) => (c?.type === 'Identifier' ? c.name : null);

function bindingNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier':
      out.push(p);
      break;
    case 'ObjectPattern':
      for (const prop of p.properties) bindingNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      break;
    case 'ArrayPattern':
      for (const el of p.elements) bindingNames(el, out);
      break;
    case 'AssignmentPattern':
      bindingNames(p.left, out);
      break;
    case 'RestElement':
      bindingNames(p.argument, out);
      break;
    case 'TSParameterProperty':
      bindingNames(p.parameter, out);
      break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ heurísticas de texto

// Nombres propios y términos técnicos que se quedan igual en todos los idiomas.
const KEEP = [
  'Cortex CRM', 'EVOLVE AI ENGINE', 'EVOLVE AI', 'EVOLVE', 'Cortex', 'CRM', 'ENGINE', 'API', 'APIs', 'JSON', 'CSV', 'PDF', 'URL', 'URLs', 'HTTP', 'HTTPS',
  'HMAC', 'SQL', 'ID', 'IDs', 'OK', 'CI', 'IP', 'DNS', 'SDK', 'LLM', 'LLMs', 'Multi-LLM', 'Markdown', 'WhatsApp', 'Telegram', 'Slack', 'OpenAI', 'Anthropic',
  'Claude', 'DeepSeek', 'OpenRouter', 'Gemini', 'Mistral', 'Groq', 'Railway', 'GitHub', 'Resend', 'Meta', 'Cloud', 'QuickJS', 'WebAssembly',
  'TypeScript', 'JavaScript', 'Node.js', 'npm', 'PostgreSQL', 'Postgres', 'S3', 'Tigris', 'Webhook', 'Webhooks', 'Bearer', 'Ctrl', 'Cmd', 'Alt',
  'Shift', 'Esc', 'Enter', 'Tab', 'AES-256-GCM', 'SHA-256', 'RLS', 'CSS', 'HTML', 'SVG', 'YAML', 'Inter', 'Kanban', 'Tailwind', 'React', 'Fastify',
  'Vite', 'lucide-react', 'TanStack', 'Query', 'MCP', 'OAuth', 'Bot', 'Token', 'CSRF', 'Cloud API', 'UTC', 'GMT', 'ISO', 'Diff', 'diff', 'Commit', 'commit',
];
const KEEP_RE = new RegExp(`(^|[^\\p{L}])(${KEEP.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})(?=$|[^\\p{L}])`, 'gu');
const hasWords = (s) => /\p{L}{2,}/u.test(s.replace(KEEP_RE, '$1'));

const SPANISH_WORDS = [
  'de', 'la', 'el', 'los', 'las', 'para', 'con', 'una', 'que', 'del', 'al', 'por', 'tu', 'tus', 'sus', 'este', 'esta', 'sin', 'ya', 'se', 'puedes', 'hay',
  'nuevo', 'nueva', 'nuevos', 'nuevas', 'registro', 'registros', 'campo', 'campos', 'usuario', 'usuarios', 'archivo', 'archivos', 'cambio', 'cambios',
  'dias', 'horas', 'minutos', 'segundos', 'semanas', 'meses', 'elementos', 'resultados', 'paso', 'pasos', 'miembros', 'personas', 'claves', 'reglas',
  'tareas', 'contactos', 'empresas', 'oportunidades', 'vistas', 'versiones', 'errores', 'avisos', 'pruebas', 'peticiones', 'mensajes', 'filas',
  'guardar', 'cancelar', 'eliminar', 'editar', 'crear', 'buscar', 'cerrar', 'abrir', 'quitar', 'activar', 'desactivar', 'siguiente', 'anterior', 'todos',
  'todas', 'ninguno', 'ninguna', 'hace', 'desde', 'hasta', 'entre', 'sobre', 'cada', 'otro', 'otra', 'otros', 'otras', 'pero', 'como', 'cuando',
];
const SPANISH_RE = new RegExp(`(^|[^\\p{L}])(${SPANISH_WORDS.join('|')})(?=$|[^\\p{L}])`, 'iu');
const looksSpanish = (s) => /[áéíóúñ¿¡]/i.test(s) || (SPANISH_RE.test(s) && /\p{L}{3,}/u.test(s) && (/\s/.test(s.trim()) || /^\p{Lu}\p{Ll}+$/u.test(s.trim())));
// Propiedades de objetos que suelen ser texto visible (opciones de selectores, columnas, pasos…).
const TEXT_PROPS = /^(label|labelPlural|title|description|placeholder|hint|message|text|emptyText|tooltip|summary|heading|subtitle|caption|help|detail|confirmLabel|cancelLabel|actionLabel)$/;

const CODE_ELEMENTS = new Set(['code', 'kbd', 'pre', 'samp', 'Kbd', 'Code']);
const SKIP_ATTRS = /^(className|class|href|to|type|id|name|key|role|src|rel|target|method|autoComplete|inputMode|d|viewBox|fill|stroke|strokeWidth|variant|size|icon|color|tone|lang|accept|pattern|value|defaultValue|htmlFor|form|style|data-[\w-]+|aria-(controls|labelledby|describedby|haspopup|expanded|selected|current|live|hidden|modal|orientation|sort|valuemin|valuemax|valuenow|autocomplete))$/;
const TEXT_ATTRS = /^(aria-label|aria-description|aria-valuetext|alt|label|text|title|placeholder|description|hint|message|tooltip|caption|heading|subtitle|summary|legend|empty|help|helper)$|(Label|Text|Title|Placeholder|Description|Hint|Message|Tooltip|Caption|Heading|Subtitle)$/;

// ------------------------------------------------------------------------------------------------ análisis

function analyze(files, { leftovers = 'web' } = {}) {
  const keys = new Map(); // clave → { plural, refs:Set }
  const problems = [];
  const suspects = [];
  const addKey = (key, plural, where) => {
    let k = keys.get(key);
    if (!k) keys.set(key, (k = { plural, refs: new Set() }));
    k.refs.add(where);
    if (plural) k.plural = true;
  };
  for (const file of files) {
    const r = rel(file);
    let parsed;
    try {
      parsed = parse(file);
    } catch (e) {
      problems.push(`${r}: no se pudo analizar (${e.message})`);
      continue;
    }
    const { ast, lineOf, ignored } = parsed;
    const at = (n) => `${r}:${lineOf(n.start)}`;
    const isWeb = r.startsWith('web/src/');
    const checkLeftovers = leftovers === 'all' || (leftovers === 'web' && isWeb);

    // Qué nombres de i18n importa este archivo.
    const imported = new Set();
    for (const st of ast.body) {
      if (st.type !== 'ImportDeclaration') continue;
      for (const sp of st.specifiers) if (sp.type === 'ImportSpecifier' && I18N_NAMES.has(sp.imported?.name ?? sp.imported?.value) && /i18n/.test(st.source.value)) imported.add(sp.local.name);
    }

    const visitRest = (nodes, parent) => {
      for (const a of nodes) if (a) walk(a, visit, parent, 'arguments');
    };
    // Tramos que se ejecutan después de cargar el módulo (funciones y clases): una traducción fuera de ellos se
    // calcula una sola vez, con el idioma del arranque.
    const deferred = [];
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassBody') deferred.push([n.start, n.end]);
    });
    const atLoad = (n) => !deferred.some(([s, e]) => n.start >= s && n.end <= e);
    const visit = (n, parent, key) => {
      if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'TSImportType' || n.type === 'TSLiteralType' || n.type === 'TSEnumDeclaration') return false;
      if (n.type === 'ExportNamedDeclaration' && n.source) return false;

      // Variables y parámetros que tapan las funciones de traducción.
      if (imported.size) {
        let ids = [];
        if (n.type === 'VariableDeclarator') ids = bindingNames(n.id);
        else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
          for (const p of n.params) bindingNames(p, ids);
          if (n.type === 'FunctionDeclaration' && n.id) ids.push(n.id);
        } else if (n.type === 'CatchClause' && n.param) ids = bindingNames(n.param);
        for (const id of ids) if (imported.has(id.name)) problems.push(`${at(id)}: «${id.name}» tapa la función de traducción importada; renombra la variable`);
      }

      if (n.type === 'CallExpression') {
        const name = calleeName(n.callee);
        if (name && imported.has(name) && name !== 'msg' && atLoad(n)) problems.push(`${at(n)}: ${name}() se evalúa al cargar el módulo, con el idioma del arranque: usa msg() + tk() o muévelo a una función`);
        if (name && imported.has(name) && name !== 'tk') {
          if (name === 'tp') {
            const one = literalText(n.arguments[1]);
            const other = literalText(n.arguments[2]);
            if (one === null || other === null) problems.push(`${at(n)}: tp() necesita las dos formas como literales`);
            else addKey(`${one}|${other}`, true, at(n));
            visitRest([n.arguments[0], ...n.arguments.slice(3)], n);
          } else if (KEY_FUNCS.has(name)) {
            const k = literalText(n.arguments[0]);
            if (k === null) problems.push(`${at(n)}: ${name}() necesita un literal como primer argumento (para un texto variable usa tk())`);
            else if (k.trim()) addKey(k, false, at(n));
            visitRest(n.arguments.slice(1), n);
          }
          return false; // la clave ya es texto traducible; el resto de argumentos se ha recorrido aparte
        }
        if (name && ERROR_HELPERS.has(name)) {
          const a = n.arguments[0];
          const k = literalText(a);
          if (k !== null && k.trim()) {
            addKey(k, false, at(n));
            visitRest(n.arguments.slice(1), n);
            return false;
          }
          if (a && ((a.type === 'TemplateLiteral' && a.expressions.length) || (a.type === 'BinaryExpression' && a.operator === '+'))) problems.push(`${at(n)}: ${name}() con datos: usa t('… {x} …', { x })`);
        }
        // Registros (logs): texto interno, no se traduce.
        const c = n.callee;
        if (c?.type === 'MemberExpression' && !c.computed && LOG_METHODS.has(c.property?.name) && (LOG_OBJECTS.test(c.object?.name ?? '') || LOG_OBJECTS.test(c.object?.property?.name ?? ''))) return false;
      }
      if (n.type === 'NewExpression' && calleeName(n.callee) === 'AppError') {
        const a = n.arguments[2];
        const k = literalText(a);
        if (k !== null && k.trim()) {
          addKey(k, false, at(n));
          visitRest([...n.arguments.slice(0, 2), ...n.arguments.slice(3)], n);
          return false;
        }
        if (a && ((a.type === 'TemplateLiteral' && a.expressions.length) || (a.type === 'BinaryExpression' && a.operator === '+'))) problems.push(`${at(n)}: new AppError() con datos: usa t('… {x} …', { x })`);
      }

      if (!checkLeftovers) return;
      // Texto visible sin traducir.
      if (n.type === 'JSXText') {
        const text = n.value.replace(/\s+/g, ' ').trim();
        const el = parent?.type === 'JSXElement' ? parent.openingElement?.name?.name : null;
        if (text && hasWords(text) && !CODE_ELEMENTS.has(el) && !ignored(n.start)) suspects.push(`${at(n)}: texto JSX «${text.slice(0, 80)}»`);
        return;
      }
      if (n.type === 'JSXAttribute') {
        const attr = typeof n.name?.name === 'string' ? n.name.name : n.name?.namespace ? `${n.name.namespace.name}:${n.name.name.name}` : '';
        if (SKIP_ATTRS.test(attr)) return false;
        const v = n.value?.type === 'JSXExpressionContainer' ? n.value.expression : n.value;
        const text = literalText(v);
        if (text !== null && TEXT_ATTRS.test(attr) && hasWords(text) && !ignored(n.start)) suspects.push(`${at(n)}: atributo ${attr}="${text.slice(0, 80)}"`);
        if (text !== null) return false;
        return;
      }
      if ((n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral') {
        if (parent?.type === 'Property' && key === 'key' && !parent.computed) return;
        if (parent?.type === 'JSXAttribute') return;
        if (parent?.type === 'SwitchCase' || parent?.type === 'TSEnumMember') return;
        const text = n.type === 'Literal' ? n.value : n.quasis.map((q) => q.value.cooked ?? '').join(' X ');
        const propName = parent?.type === 'Property' && key === 'value' && !parent.computed ? (parent.key?.name ?? parent.key?.value) : null;
        const textProp = propName && TEXT_PROPS.test(String(propName)) && hasWords(text);
        if ((looksSpanish(text) || textProp) && !ignored(n.start)) suspects.push(`${at(n)}: texto «${text.replace(/\s+/g, ' ').slice(0, 80)}»`);
        if (n.type === 'Literal') return;
      }
    };
    walk(ast, visit);
  }
  return { keys, problems, suspects };
}

// ------------------------------------------------------------------------------------------------ catálogos

const PLACE_RE = /\{(\w+)\}|<\/?(\w+)>/g;
function tokens(s) {
  const out = new Set();
  for (const m of String(s).matchAll(PLACE_RE)) out.add(m[1] ? `{${m[1]}}` : `<${m[2]}>`);
  return out;
}
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function readCatalog(locale) {
  const file = path.join(LOCALES_DIR, `${locale}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeCatalog(locale, data) {
  const sorted = Object.fromEntries(Object.keys(data).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, data[k]]));
  fs.writeFileSync(path.join(LOCALES_DIR, `${locale}.json`), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Problemas de una entrada traducida; [] si está bien. Las vacías cuentan como pendientes (aparte). */
function entryProblems(key, info, value, locale) {
  const problems = [];
  if (info.plural) {
    const [one, other] = key.split('|');
    const allowed = new Set([...tokens(one), ...tokens(other), '{count}']);
    const forms = typeof value === 'string' ? { other: value } : value;
    if (!forms || typeof forms !== 'object' || Array.isArray(forms)) return ['el plural debe ser un objeto {"one": "…", "other": "…"}'];
    if (!forms.other) problems.push('falta la forma "other" del plural');
    for (const [cat, form] of Object.entries(forms)) {
      if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(cat)) problems.push(`categoría de plural desconocida «${cat}»`);
      for (const tk of tokens(form)) if (!allowed.has(tk)) problems.push(`la forma «${cat}» usa ${tk}, que no está en el original`);
    }
    void locale;
    return problems;
  }
  if (typeof value !== 'string') return ['debe ser un texto'];
  if (!same(tokens(key), tokens(value))) problems.push(`variables o etiquetas distintas del original (${[...tokens(key)].join(' ') || 'ninguna'} → ${[...tokens(value)].join(' ') || 'ninguna'})`);
  return problems;
}

const isEmpty = (info, value) => (info.plural ? !value || (typeof value === 'object' ? !value.other : !value) : value === undefined || value === '');

// ------------------------------------------------------------------------------------------------ comandos

const [cmd = 'check', ...args] = process.argv.slice(2);
const files = listFiles();

if (cmd === 'untranslated') {
  const only = args.map((a) => path.resolve(ROOT, a));
  const selected = only.length ? files.filter((f) => only.some((o) => f === o || f.startsWith(o + path.sep))) : files;
  const { suspects, problems } = analyze(selected, { leftovers: 'all' });
  for (const p of problems) console.log(`PROBLEMA ${p}`);
  for (const s of suspects) console.log(s);
  console.log(`\n${suspects.length} textos por revisar, ${problems.length} problemas.`);
  process.exit(0);
}

const { keys, problems, suspects } = analyze(files);

if (cmd === 'keys' || cmd === 'missing') {
  const locale = cmd === 'missing' ? args[0] : null;
  if (cmd === 'missing' && !TARGETS.includes(locale)) {
    console.error(`Idioma desconocido: ${locale}. Usa uno de: ${TARGETS.join(', ')}`);
    process.exit(1);
  }
  const catalog = locale ? readCatalog(locale) : {};
  const list = [...keys.entries()]
    .filter(([k, info]) => !locale || isEmpty(info, catalog[k]))
    .map(([key, info]) => ({ key, ...(info.plural ? { plural: true } : {}), refs: [...info.refs].slice(0, 5) }));
  const outFile = args[locale ? 1 : 0];
  const json = `${JSON.stringify(list, null, 1)}\n`;
  if (outFile) {
    fs.writeFileSync(path.resolve(outFile), json);
    console.log(`${list.length} claves → ${outFile}`);
  } else process.stdout.write(json);
  process.exit(0);
}

if (cmd === 'sync') {
  for (const locale of TARGETS) {
    const cat = readCatalog(locale);
    const next = {};
    let added = 0;
    let removed = 0;
    for (const [key, info] of keys) {
      if (Object.hasOwn(cat, key)) next[key] = cat[key];
      else {
        next[key] = info.plural ? (locale === 'ja' ? { other: '' } : { one: '', other: '' }) : '';
        added++;
      }
    }
    for (const key of Object.keys(cat)) if (!keys.has(key)) removed++;
    writeCatalog(locale, next);
    console.log(`${locale}: ${keys.size} claves (${added} nuevas, ${removed} quitadas)`);
  }
  process.exit(0);
}

if (cmd === 'status' || cmd === 'check') {
  const failures = [...problems];
  for (const locale of TARGETS) {
    const cat = readCatalog(locale);
    let missing = 0;
    const examples = [];
    for (const [key, info] of keys) {
      const value = cat[key];
      if (isEmpty(info, value)) {
        missing++;
        if (examples.length < 5) examples.push(key);
        continue;
      }
      for (const p of entryProblems(key, info, value, locale)) failures.push(`${locale}.json «${key.slice(0, 70)}»: ${p}`);
    }
    const orphans = Object.keys(cat).filter((k) => !keys.has(k));
    console.log(`${locale}: ${keys.size - missing}/${keys.size} traducidas${missing ? `, faltan ${missing}` : ''}${orphans.length ? `, ${orphans.length} sobrantes` : ''}`);
    if (cmd === 'check') {
      if (missing) failures.push(`${locale}.json: faltan ${missing} traducciones (p. ej. «${examples.join('», «')}»). Ejecuta «node scripts/i18n.mjs sync» y tradúcelas.`);
      if (orphans.length) failures.push(`${locale}.json: ${orphans.length} claves que ya no se usan (p. ej. «${orphans.slice(0, 3).join('», «')}»). Ejecuta «node scripts/i18n.mjs sync».`);
    }
  }
  if (cmd === 'check') {
    for (const s of suspects) failures.push(`texto sin traducir en la web: ${s}`);
    if (failures.length) {
      for (const f of failures.slice(0, 200)) console.error(`✗ ${f}`);
      if (failures.length > 200) console.error(`… y ${failures.length - 200} más`);
      console.error(`\n${failures.length} problemas. Guía: shared/i18n/README.md`);
      process.exit(1);
    }
    console.log('✓ Catálogos completos y textos de la interfaz traducibles.');
  }
  process.exit(0);
}

console.error(`Comando desconocido: ${cmd}`);
process.exit(1);
