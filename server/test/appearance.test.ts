import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, CONTRACTS_CHANGESET, setup } from './helpers';
import { BlueprintSchema, type Blueprint } from '../../shared/blueprint';
import { ChangeSetSchema } from '../../shared/changeset';
import { DEFAULT_BLUEPRINT_INPUT, defaultBlueprint } from '../../shared/default-blueprint';
import { contrastRatio, navHrefKind, sanitizeCustomCss } from '../../shared/appearance';
import { applyOperations } from '../src/evolve/apply';
import { validateBlueprint } from '../src/evolve/validate';
import { assessRisk } from '../src/evolve/risk';
import { buildImpact, describeOperation } from '../src/evolve/impact';
import { compactBlueprint, PLANNER_SYSTEM } from '../src/evolve/prompts';
import { simulateChangeSet } from '../src/evolve/simulator';
import { blueprintForRole } from '../src/crm/visibility';

/**
 * Capa visual de cada organización: apariencia, menú y páginas propias. Se gestiona con change sets como el resto
 * del blueprint (sandbox → aprobación → versión → rollback), el CSS personalizado solo puede ser CSS plano y las
 * páginas nunca muestran datos de módulos que el rol no puede leer.
 */

type Env = Awaited<ReturnType<typeof setup>>;
const PASSWORD = 'Contraseña-Segura-123';

const ops = (list: unknown[]) => ChangeSetSchema.parse({ title: 'Cambio visual', summary: 'Prueba de la capa visual', operations: list }).operations;
const errorsOf = (bp: Blueprint) => validateBlueprint(bp).filter((i) => i.level === 'error');
const warningsOf = (bp: Blueprint) => validateBlueprint(bp).filter((i) => i.level === 'warning');
const applied = (list: unknown[], base = defaultBlueprint()) => {
  const r = applyOperations(base, ops(list));
  expect(r.errors).toEqual([]);
  return r.blueprint;
};

const SALARIES = {
  op: 'create_module',
  module: {
    key: 'salaries',
    label: 'Nómina',
    labelPlural: 'Nóminas',
    icon: 'wallet',
    primaryField: 'name',
    permissions: { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' },
    fields: [
      { key: 'name', label: 'Empleado', type: 'text', required: true },
      { key: 'amount', label: 'Importe', type: 'currency', currency: 'EUR' },
    ],
    views: [{ key: 'all', label: 'Todas', type: 'table', columns: ['name', 'amount'] }],
  },
};
const SALARIES_FORM = { op: 'upsert_form', form: { key: 'alta_nomina', name: 'Alta de nómina', module: 'salaries', fields: ['name', 'amount'] } };
const HOME_PAGE = {
  op: 'upsert_page',
  page: {
    key: 'inicio',
    label: 'Inicio de ventas',
    icon: 'home',
    description: 'Lo más importante del día',
    blocks: [
      { type: 'heading', text: 'Resumen', level: 1 },
      { type: 'widget', width: 'half', widget: { key: 'contacts_total', title: 'Contactos', type: 'metric', module: 'contacts' } },
      { type: 'widget', width: 'half', widget: { key: 'payroll_total', title: 'Masa salarial', type: 'metric', module: 'salaries', aggregate: 'sum', field: 'amount' } },
      { type: 'records', module: 'deals', view: 'all', title: 'Oportunidades abiertas', filters: [{ field: 'stage', operator: 'in', value: ['nuevo', 'cualificado', 'propuesta', 'negociacion'] }], limit: 5, width: 'two_thirds' },
      { type: 'records', module: 'salaries', limit: 5, width: 'third' },
      { type: 'form', form: 'alta_nomina' },
      { type: 'buttons', items: [{ label: 'Nuevo contacto', to: { type: 'new_record', key: 'contacts' } }, { label: 'Nóminas', to: { type: 'module', key: 'salaries' } }, { label: 'Administración', to: { type: 'page', key: 'admin_page' } }, { label: 'Panel', to: { type: 'dashboard', key: 'main' } }] },
      { type: 'text', markdown: 'Bienvenido al **CRM de ventas**.' },
      { type: 'divider' },
    ],
  },
};
const ADMIN_PAGE = { op: 'upsert_page', page: { key: 'admin_page', label: 'Administración', minRole: 'admin', blocks: [{ type: 'records', module: 'salaries' }] } };
const NAVIGATION = {
  op: 'update_navigation',
  navigation: {
    home: { type: 'page', key: 'inicio' },
    groups: [
      { key: 'comercial', label: 'Comercial', items: [{ type: 'page', key: 'inicio' }, { type: 'module', key: 'companies' }, { type: 'module', key: 'contacts' }, { type: 'module', key: 'deals' }, { type: 'dashboard', key: 'main', label: 'Panel comercial' }] },
      { key: 'operaciones', label: 'Operaciones', items: [{ type: 'module', key: 'tasks' }, { type: 'module', key: 'activities' }, { type: 'link', href: '/reports', label: 'Informes' }] },
      { key: 'admin', label: 'Administración', items: [{ type: 'module', key: 'salaries' }, { type: 'page', key: 'admin_page' }, { type: 'link', href: 'https://intranet.example.com/rrhh', label: 'Intranet' }] },
    ],
  },
};

describe('compatibilidad: blueprints y change sets anteriores', () => {
  it('un blueprint guardado sin apariencia, menú ni páginas sigue siendo válido tal cual', () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_BLUEPRINT_INPUT));
    expect(stored.pages).toBeUndefined();
    const bp = BlueprintSchema.parse(stored);
    expect(bp.pages).toEqual([]);
    expect(bp.appearance).toBeUndefined();
    expect(bp.navigation).toBeUndefined();
    expect(errorsOf(bp)).toEqual([]);
    // La versión que se guarda al publicar (con pages: []) también se vuelve a leer igual.
    expect(BlueprintSchema.parse(JSON.parse(JSON.stringify(bp)))).toEqual(bp);
  });

  it('los change sets anteriores se siguen validando y una apariencia vacía recibe los valores por defecto', () => {
    expect(ChangeSetSchema.safeParse(CONTRACTS_CHANGESET).success).toBe(true);
    const bp = BlueprintSchema.parse({ ...DEFAULT_BLUEPRINT_INPUT, appearance: {} });
    expect(bp.appearance).toEqual({ brandColor: '#6938ef', font: 'inter', radius: 'md', density: 'comfortable', sidebar: 'light', defaultTheme: 'system' });
  });
});

describe('operaciones de la capa visual', () => {
  it('update_appearance es un parche: solo cambia lo indicado y null quita los campos opcionales', () => {
    const first = applied([{ op: 'update_appearance', changes: { brandColor: '#0A7F6B', sidebar: 'dark', appName: 'Acme CRM', accentColor: '#F97316', customCss: '.x { color: red; }' } }]);
    expect(first.appearance).toEqual({ brandColor: '#0a7f6b', accentColor: '#f97316', appName: 'Acme CRM', font: 'inter', radius: 'md', density: 'comfortable', sidebar: 'dark', defaultTheme: 'system', customCss: '.x { color: red; }' });
    const second = applied([{ op: 'update_appearance', changes: { font: 'serif', customCss: null, accentColor: null } }], first);
    expect(second.appearance).toEqual({ brandColor: '#0a7f6b', appName: 'Acme CRM', font: 'serif', radius: 'md', density: 'comfortable', sidebar: 'dark', defaultTheme: 'system' });
    // El resto del blueprint no cambia.
    expect(second.modules).toEqual(defaultBlueprint().modules);
  });

  it('rechaza colores inválidos, parches vacíos y quitar páginas que no existen', () => {
    expect(ChangeSetSchema.safeParse({ title: 'Color', summary: 'x', operations: [{ op: 'update_appearance', changes: { brandColor: 'verde' } }] }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ title: 'Color', summary: 'x', operations: [{ op: 'update_appearance', changes: { brandColor: '#12345' } }] }).success).toBe(false);
    expect(applyOperations(defaultBlueprint(), ops([{ op: 'update_appearance', changes: {} }])).errors[0].message).toMatch(/ningún cambio/);
    expect(applyOperations(defaultBlueprint(), ops([{ op: 'remove_page', page: 'nada' }])).errors[0].message).toMatch(/No existe la página/);
  });

  it('update_navigation sustituye el menú (null vuelve al de siempre) y upsert_page / remove_page gestionan las páginas', () => {
    const bp = applied([SALARIES, SALARIES_FORM, HOME_PAGE, ADMIN_PAGE, NAVIGATION]);
    expect(bp.navigation?.groups.map((g) => g.key)).toEqual(['comercial', 'operaciones', 'admin']);
    expect(bp.navigation?.home).toEqual({ type: 'page', key: 'inicio' });
    expect(bp.pages.map((p) => p.key)).toEqual(['inicio', 'admin_page']);
    // Valores por defecto de las páginas y sus bloques.
    const inicio = bp.pages[0];
    expect(inicio.minRole).toBe('viewer');
    expect(inicio.blocks[0]).toEqual({ type: 'heading', text: 'Resumen', level: 1, width: 'full' });
    expect(bp.pages[1].icon).toBe('layers');
    const replaced = applied([{ op: 'upsert_page', page: { key: 'inicio', label: 'Inicio', blocks: [] } }, { op: 'update_navigation', navigation: null }], bp);
    expect(replaced.pages.find((p) => p.key === 'inicio')?.label).toBe('Inicio');
    expect(replaced.navigation).toBeUndefined();
    const removed = applied([{ op: 'remove_page', page: 'admin_page' }], replaced);
    expect(removed.pages.map((p) => p.key)).toEqual(['inicio']);
  });
});

describe('validación de referencias', () => {
  it('un cambio visual completo y coherente no tiene errores', () => {
    const bp = applied([SALARIES, SALARIES_FORM, HOME_PAGE, ADMIN_PAGE, NAVIGATION, { op: 'update_appearance', changes: { brandColor: '#0a7f6b', sidebar: 'brand' } }]);
    expect(errorsOf(bp)).toEqual([]);
  });

  it('detecta módulos, vistas, campos, paneles, páginas y formularios inexistentes', () => {
    const base = applied([
      {
        op: 'upsert_page',
        page: {
          key: 'rota',
          label: 'Rota',
          blocks: [
            { type: 'widget', widget: { key: 'w1', title: 'Suma de nombres', type: 'metric', module: 'contacts', aggregate: 'sum', field: 'name' } },
            { type: 'widget', widget: { key: 'w1', title: 'Duplicado', type: 'metric', module: 'nope' } },
            { type: 'records', module: 'deals', view: 'nope', filters: [{ field: 'nope', operator: 'eq', value: 1 }] },
            { type: 'records', module: 'ghost' },
            { type: 'form', form: 'nope' },
            { type: 'buttons', items: [{ label: 'A', to: { type: 'page', key: 'nope' } }, { label: 'B', to: { type: 'dashboard', key: 'nope' } }, { label: 'C', to: { type: 'new_record', key: 'nope' } }] },
          ],
        },
      },
      {
        op: 'update_navigation',
        navigation: {
          home: { type: 'page', key: 'nope' },
          groups: [
            { key: 'g', label: 'G', items: [{ type: 'module', key: 'nope' }, { type: 'page', key: 'nope' }, { type: 'dashboard', key: 'nope' }, { type: 'link', href: 'javascript:alert(1)', label: 'X' }, { type: 'link', href: '//evil.example', label: 'Y' }, { type: 'link', href: 'http://inseguro.example', label: 'Z' }] },
            { key: 'g', label: 'Repetido', items: [] },
          ],
        },
      },
    ]);
    // upsert_page sustituye por clave, así que la clave duplicada se construye a mano.
    const bp: Blueprint = { ...base, pages: [...base.pages, { ...base.pages[0], label: 'Copia' }] };
    const messages = errorsOf(bp).map((e) => `${e.path}: ${e.message}`).join(' | ');
    expect(messages).toMatch(/"name" debe ser numérico para sum/);
    expect(messages).toMatch(/Widget duplicado: "w1"/);
    expect(messages).toMatch(/Módulo inexistente "nope"/);
    expect(messages).toMatch(/La vista "nope" no existe en "deals"/);
    expect(messages).toMatch(/Filtro sobre campo inexistente "nope"/);
    expect(messages).toMatch(/La lista de registros usa un módulo inexistente "ghost"/);
    expect(messages).toMatch(/Formulario inexistente "nope"/);
    expect(messages).toMatch(/El botón «A» enlaza a la página inexistente "nope"/);
    expect(messages).toMatch(/El botón «B» enlaza al panel inexistente "nope"/);
    expect(messages).toMatch(/El botón «C» usa un módulo inexistente "nope"/);
    expect(messages).toMatch(/Página duplicada: "rota"/);
    expect(messages).toMatch(/La página de inicio "nope" no existe/);
    expect(messages).toMatch(/Grupo del menú duplicado: "g"/);
    expect(messages).toMatch(/El menú \(«G»\) usa un módulo inexistente "nope"/);
    expect(messages).toMatch(/El menú \(«G»\) enlaza a la página inexistente "nope"/);
    expect(messages).toMatch(/El menú \(«G»\) enlaza al panel inexistente "nope"/);
    expect(messages).toMatch(/enlace no permitido "javascript:alert\(1\)"/);
    expect(messages).toMatch(/enlace no permitido "\/\/evil\.example"/);
    expect(messages).toMatch(/enlace no permitido "http:\/\/inseguro\.example"/);
  });

  it('un módulo archivado o fuera del menú solo avisa; poco contraste también avisa', () => {
    const bp = applied([{ op: 'update_navigation', navigation: { groups: [{ key: 'comercial', label: 'Comercial', items: [{ type: 'module', key: 'contacts' }, { type: 'module', key: 'deals' }] }] } }, { op: 'archive_module', module: 'deals' }, { op: 'update_appearance', changes: { brandColor: '#fde047' } }]);
    expect(errorsOf(bp)).toEqual([]);
    const warnings = warningsOf(bp).map((w) => w.message).join('\n');
    expect(warnings).toMatch(/módulo archivado "deals"/);
    expect(warnings).toMatch(/no aparecen en ningún grupo del menú.*«Otros»/);
    expect(warnings).toMatch(/poco contraste/);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
  });

  it('los enlaces del menú solo pueden ser rutas de la aplicación o https', () => {
    expect(navHrefKind('/m/deals?view=pipeline')).toBe('internal');
    expect(navHrefKind('https://intranet.example.com/a')).toBe('external');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '//evil.example', '/\\evil', 'http://a.example', 'https://user:pw@a.example', '/api/workspace/export', ' /m/deals', 'vbscript:x']) {
      expect(navHrefKind(bad), bad).toBeNull();
    }
  });
});

describe('CSS personalizado: solo CSS plano', () => {
  it('acepta CSS normal (reglas, @media, @supports, @keyframes, comentarios, cadenas y combinadores)', () => {
    const css = `/* Ajustes de marca */
.sidebar a > span { font-weight: 600 !important; letter-spacing: .01em; }
@media (min-width: 640px) and (width < 1280px) { .card { box-shadow: 0 1px 2px rgb(0 0 0 / .1); } }
@supports (display: grid) { .grid { gap: 1rem; } }
@keyframes latido { from { opacity: .6 } to { opacity: 1 } }
.badge::after { content: "★"; background-image: linear-gradient(90deg, #fff, var(--color-brand-500)); }`;
    const r = sanitizeCustomCss(css);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.css).not.toContain('Ajustes de marca'); // sin comentarios
  });

  it('rechaza todo lo que carga recursos, ejecuta código o no es CSS plano', () => {
    const malicious: [string, RegExp][] = [
      ['@import url("https://evil.example/x.css");', /@import/],
      ['@import "https://evil.example/x.css";', /@import/],
      ['body { background: url(https://evil.example/p.png) }', /url\(\)/],
      ['body { background: URL ( "//evil.example/p.png" ) }', /url\(\)/],
      ['input[value^="a"] { background: url(/api/public/leak?c=a) }', /url\(\)/],
      ['div { width: expression(alert(1)) }', /expression/],
      ['a { background: javascript:alert(1) }', /javascript/],
      ['body { behavior: url(x.htc) }', /behavior/],
      ['div { -moz-binding: url("x.xml#xss") }', /-moz-binding/],
      ['</style><script>alert(1)</script>', /<style>|HTML/],
      ['a{color:red}</style>', /<style>/],
      ['<!-- a { color: red } -->', /HTML/],
      ['@charset "utf-8";', /@charset/],
      ['body { background: u\\72 l(https://evil.example) }', /escape/],
      ['@font-face { font-family: x; src: local(Arial) }', /@font-face no está permitida/],
      ['@namespace svg "http://www.w3.org/2000/svg";', /@namespace no está permitida/],
      ['@page { margin: 0 }', /@page no está permitida/],
      ['div { background-image: image-set("a.png" 1x) }', /funciones de imagen/],
      ['div { background: -moz-element(#secreto) }', /funciones de imagen/],
      ['div { background: paint(worklet) }', /funciones de imagen/],
      ['a { color: red', /sin cerrar/],
      ['a { color: red } }', /sin abrir/],
      ['/* a { color: red }', /comentario/],
      ['a::after { content: "sin cerrar }', /cadena/],
      ['a { color: red }\u0000', /control/],
      ['a { color: red } @', /«@»/],
      [`a { color: red } ${'x'.repeat(20_001)}`, /20000/],
    ];
    for (const [css, why] of malicious) {
      const r = sanitizeCustomCss(css);
      expect(r.ok, css.slice(0, 60)).toBe(false);
      expect(r.css).toBe('');
      expect(r.errors.join(' | '), css.slice(0, 60)).toMatch(why);
    }
  });

  it('validateBlueprint lo marca como error (no se puede aprobar) y el esquema limita su tamaño', () => {
    const bp = applied([{ op: 'update_appearance', changes: { customCss: 'body { background: url(https://evil.example/x.png) }' } }]);
    expect(errorsOf(bp)).toEqual([expect.objectContaining({ path: 'appearance.customCss', message: expect.stringContaining('url()') })]);
    expect(ChangeSetSchema.safeParse({ title: 'CSS', summary: 'x', operations: [{ op: 'update_appearance', changes: { customCss: 'a{}'.repeat(7000) } }] }).success).toBe(false);
  });
});

describe('riesgo, impacto y planificador', () => {
  it('apariencia, menú y páginas son de riesgo bajo; el CSS personalizado, medio', () => {
    const base = defaultBlueprint();
    expect(assessRisk(base, ops([{ op: 'update_appearance', changes: { brandColor: '#0a7f6b', sidebar: 'dark', font: 'rounded' } }])).level).toBe('low');
    expect(assessRisk(applied([SALARIES, SALARIES_FORM]), ops([HOME_PAGE, ADMIN_PAGE, NAVIGATION])).level).toBe('low');
    const css = assessRisk(base, ops([{ op: 'update_appearance', changes: { customCss: '.x { display: none }' } }]));
    expect(css.level).toBe('medium');
    expect(css.requiresOwner).toBe(false);
    expect(css.items[0].message).toMatch(/ocultar o imitar/);
    const withCss = applied([{ op: 'update_appearance', changes: { customCss: '.x { display: none }' } }]);
    expect(assessRisk(withCss, ops([{ op: 'update_appearance', changes: { customCss: null } }])).level).toBe('low');
    expect(assessRisk(withCss, ops([{ op: 'update_appearance', changes: { customCss: '.x { display: none }', font: 'serif' } }])).level).toBe('low');
    expect(assessRisk(applied([{ op: 'upsert_page', page: { key: 'p', label: 'P', blocks: [] } }]), ops([{ op: 'remove_page', page: 'p' }])).level).toBe('low');
  });

  it('el impacto describe los cambios en lenguaje llano', () => {
    const base = applied([SALARIES, SALARIES_FORM]);
    const cs = ChangeSetSchema.parse({ title: 'Marca', summary: 'x', operations: [{ op: 'update_appearance', changes: { brandColor: '#0A7F6B', sidebar: 'dark', customCss: '.x{}' } }, HOME_PAGE, NAVIGATION] });
    expect(describeOperation(cs.operations[0], base).detail).toBe('color principal #0a7f6b · menú lateral oscuro · CSS personalizado (4 caracteres)');
    expect(describeOperation(cs.operations[1], base)).toMatchObject({ kind: 'add', title: 'Página «Inicio de ventas»', detail: expect.stringContaining('2 widgets, 2 listas de registros') });
    expect(describeOperation(cs.operations[2], base).detail).toMatch(/Grupos: Comercial \(5\), Operaciones \(3\), Administración \(3\) · inicio: página «inicio»/);
    const after = applyOperations(base, cs.operations).blueprint;
    const impact = buildImpact(base, after, cs, assessRisk(base, cs.operations));
    expect(impact.artifacts.map((a) => a.path)).toEqual(expect.arrayContaining(['blueprint/appearance.json', 'blueprint/appearance/custom.css', 'blueprint/pages/inicio.json', 'blueprint/navigation.json']));
    expect(impact.permissions.join(' ')).toMatch(/salvo EVOLVE, Ajustes y Plataforma/);
  });

  it('el planificador conoce las operaciones visuales y ve la apariencia, el menú y las páginas', () => {
    expect(PLANNER_SYSTEM).toContain("op: 'update_appearance'");
    expect(PLANNER_SYSTEM).toContain("op: 'upsert_page'");
    expect(PLANNER_SYSTEM).toMatch(/14\. Cambios VISUALES/);
    const bp = applied([SALARIES, SALARIES_FORM, HOME_PAGE, NAVIGATION, { op: 'update_appearance', changes: { brandColor: '#0a7f6b' } }]);
    const compact = JSON.stringify(compactBlueprint(bp));
    expect(compact).toContain('"brandColor":"#0a7f6b"');
    expect(compact).toContain('"key":"inicio"');
    expect(compact).toContain('"groups"');
    // Sin los valores por defecto de la capa visual.
    expect(compact).not.toContain('"width":"full"');
    expect(compact).not.toContain('"minRole":"viewer"');
    expect(compact).not.toContain('"font":"inter"');
  });
});

describe('visibilidad por rol', () => {
  const bp = applied([SALARIES, SALARIES_FORM, HOME_PAGE, ADMIN_PAGE, NAVIGATION, { op: 'update_appearance', changes: { brandColor: '#0a7f6b', customCss: '.x { color: red }' } }]);

  it('un miembro no ve páginas de administración ni bloques o enlaces de módulos que no puede leer', () => {
    for (const role of ['viewer', 'member', 'builder'] as const) {
      const visible = blueprintForRole(bp, role);
      expect(visible.pages.map((p) => p.key)).toEqual(['inicio']);
      const inicio = visible.pages[0];
      expect(JSON.stringify(inicio)).not.toContain('salaries');
      expect(JSON.stringify(inicio)).not.toContain('admin_page');
      expect(inicio.blocks.map((b) => b.type)).toEqual(['heading', 'widget', 'records', 'buttons', 'text', 'divider']);
      const buttons = inicio.blocks.find((b) => b.type === 'buttons');
      expect(buttons && buttons.type === 'buttons' ? buttons.items.map((i) => i.label) : []).toEqual(['Nuevo contacto', 'Panel']);
      expect(visible.navigation?.groups.map((g) => g.key)).toEqual(['comercial', 'operaciones', 'admin']);
      expect(visible.navigation?.groups[2].items).toEqual([{ type: 'link', href: 'https://intranet.example.com/rrhh', label: 'Intranet' }]);
      expect(visible.navigation?.home).toEqual({ type: 'page', key: 'inicio' });
      // La apariencia la ven todos los roles.
      expect(visible.appearance).toEqual(bp.appearance);
    }
  });

  it('un administrador lo ve todo; si la página de inicio no es visible para el rol, se quita del menú', () => {
    const admin = blueprintForRole(bp, 'admin');
    expect(admin.pages.map((p) => p.key)).toEqual(['inicio', 'admin_page']);
    expect(admin.pages[0].blocks).toHaveLength(bp.pages[0].blocks.length);
    const adminHome = applied([{ op: 'update_navigation', navigation: { home: { type: 'page', key: 'admin_page' }, groups: [{ key: 'solo', label: 'Solo admin', items: [{ type: 'module', key: 'salaries' }] }] } }], bp);
    const member = blueprintForRole(adminHome, 'member');
    expect(member.navigation).toEqual({ groups: [] });
    // Sin menú propio, la clave no aparece en la respuesta de la API.
    expect(JSON.parse(JSON.stringify(blueprintForRole(defaultBlueprint(), 'member'))).navigation).toBeUndefined();
  });
});

describe('sandbox: suites con la capa visual', () => {
  it('prueba las listas de las páginas, que cada rol solo vea lo que puede leer y el CSS', async () => {
    const base = applied([SALARIES, SALARIES_FORM]);
    const changeSet = ChangeSetSchema.parse({ title: 'Inicio', summary: 'Página de inicio', operations: [HOME_PAGE, ADMIN_PAGE, NAVIGATION, { op: 'update_appearance', changes: { customCss: '.x { color: red }' } }] });
    const sim = await simulateChangeSet({ before: base, changeSet, samples: {}, members: [{ id: '00000000-0000-0000-0000-000000000001', role: 'owner' }] });
    expect(sim.report.passed).toBe(true);
    const cases = sim.report.suites.flatMap((s) => s.cases.map((c) => `${s.key}: ${c.name}`));
    expect(cases).toEqual(expect.arrayContaining([
      'integration: Página «Inicio de ventas» › lista de "Oportunidades" se puede consultar',
      'integration: Página «Inicio de ventas» › lista de "Nóminas" se puede consultar',
      'security: Página «Inicio de ventas»: cada rol solo ve los bloques de los módulos que puede leer',
      'security: Página «Administración»: cada rol solo ve los bloques de los módulos que puede leer',
      'security: CSS personalizado: solo CSS plano, sin recursos externos ni código',
    ]));
    const cssCase = sim.report.suites.find((s) => s.key === 'security')!.cases.find((c) => c.name.startsWith('CSS'))!;
    expect(cssCase).toMatchObject({ passed: true, warning: true });
  });

  it('un CSS con url() hace fallar la validación y la seguridad', async () => {
    const changeSet = ChangeSetSchema.parse({ title: 'CSS', summary: 'x', operations: [{ op: 'update_appearance', changes: { customCss: 'body{background:url(https://evil.example/a.png)}' } }] });
    const sim = await simulateChangeSet({ before: defaultBlueprint(), changeSet, samples: {}, members: [] });
    expect(sim.report.passed).toBe(false);
    expect(sim.issues.some((i) => i.level === 'error' && i.path === 'appearance.customCss')).toBe(true);
  });
});

async function join(env: Env, inviter: Client, email: string, role: string, name: string) {
  const inv = await inviter.req('POST', '/api/workspace/invites', { email, role });
  if (inv.status !== 200) throw new Error(`invite ${inv.status}: ${JSON.stringify(inv.body)}`);
  const client = new Client(env.app);
  const acc = await client.req('POST', '/api/auth/invite/accept', { token: env.inviteToken(email), name, password: PASSWORD });
  if (acc.status !== 200) throw new Error(`accept ${acc.status}: ${JSON.stringify(acc.body)}`);
  client.csrf = acc.body.csrfToken;
  return client;
}

describe('API: publicación y datos de las páginas', () => {
  let env: Env;
  let owner: Client;
  let member: Client;

  async function publishManual(changeSet: unknown, confirmation?: string) {
    const r = await owner.req('POST', '/api/evolve/requests/manual', { changeSet });
    expect(r.status).toBe(200);
    await env.drain();
    const req = (await owner.req('GET', `/api/evolve/requests/${r.body.id}`)).body;
    return { req, approve: () => owner.req('POST', `/api/evolve/requests/${r.body.id}/approve`, confirmation ? { confirmation } : {}), deploy: () => owner.req('POST', `/api/evolve/requests/${r.body.id}/deploy`) };
  }

  beforeAll(async () => {
    env = await setup();
    owner = new Client(env.app);
    await owner.register('Paula', 'paula@example.com', 'Apariencia SL');
    const { req, approve, deploy } = await publishManual({ title: 'Inicio de ventas', summary: 'Nóminas, página de inicio y menú agrupado', operations: [SALARIES, SALARIES_FORM, HOME_PAGE, ADMIN_PAGE, NAVIGATION] });
    expect(req.status).toBe('ready_for_review');
    expect(req.risk).toBe('low');
    expect((await approve()).status).toBe(200);
    const dep = await deploy();
    expect(dep.status).toBe(200);
    expect(dep.body.verification.ok).toBe(true);
    expect((await owner.req('POST', '/api/records/salaries', { values: { name: 'Ana', amount: 5000 } })).status).toBe(200);
    expect((await owner.req('POST', '/api/records/contacts', { values: { name: 'Carlos', email: 'carlos@example.com' } })).status).toBe(200);
    member = await join(env, owner, 'miembro@example.com', 'member', 'Miembro');
  });
  afterAll(async () => env.close());

  it('un miembro nunca recibe datos de bloques de un módulo restringido a administradores', async () => {
    const r = await member.req('GET', '/api/pages/inicio/data');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data)).toEqual(['contacts_total']);
    expect(r.body.data.contacts_total).toMatchObject({ type: 'metric', value: 1 });
    expect(JSON.stringify(r.body)).not.toContain('salaries');
    expect(JSON.stringify(r.body)).not.toContain('5000');
    expect((await member.req('GET', '/api/records/salaries')).status).toBe(403);
    const own = await owner.req('GET', '/api/pages/inicio/data');
    expect(own.body.data.payroll_total).toMatchObject({ type: 'metric', value: 5000 });
    expect(own.body.page.blocks.some((b: any) => b.type === 'records' && b.module === 'salaries')).toBe(true);
  });

  it('las páginas por encima del rol y las inexistentes responden 404', async () => {
    expect((await member.req('GET', '/api/pages/admin_page/data')).status).toBe(404);
    expect((await member.req('GET', '/api/pages/nada/data')).status).toBe(404);
    expect((await owner.req('GET', '/api/pages/admin_page/data')).status).toBe(200);
    const bp = (await member.req('GET', '/api/blueprint')).body.blueprint;
    expect(bp.pages.map((p: any) => p.key)).toEqual(['inicio']);
    expect(bp.navigation.home).toEqual({ type: 'page', key: 'inicio' });
    expect(JSON.stringify(bp.navigation)).not.toContain('salaries');
  });

  it('el CSS malicioso no supera las pruebas y no se puede aprobar', async () => {
    const { req, approve } = await publishManual({ title: 'CSS malicioso', summary: 'x', operations: [{ op: 'update_appearance', changes: { customCss: '@import url("https://evil.example/x.css"); body { background: url(https://evil.example/p.png) }' } }] });
    expect(req.status).toBe('failed');
    expect(req.validation.some((i: any) => i.path === 'appearance.customCss' && i.level === 'error')).toBe(true);
    expect((await approve()).status).toBe(409);
  });

  it('apariencia con CSS: riesgo medio, se publica como versión y se revierte', async () => {
    const before = (await owner.req('GET', '/api/blueprint')).body;
    const { req, approve, deploy } = await publishManual({ title: 'Marca', summary: 'Color corporativo, menú oscuro y CSS', operations: [{ op: 'update_appearance', changes: { brandColor: '#0A7F6B', sidebar: 'dark', defaultTheme: 'dark', customCss: '.x { letter-spacing: .01em }' } }] });
    expect(req.status).toBe('ready_for_review');
    expect(req.risk).toBe('medium');
    expect(req.policy.needsConfirmation).toBe(false);
    expect(req.impact.changes[0]).toMatchObject({ title: 'Apariencia del CRM' });
    // Un miembro no puede aprobar.
    expect((await member.req('POST', `/api/evolve/requests/${req.id}/approve`, {})).status).toBe(403);
    expect((await approve()).status).toBe(200);
    const dep = await deploy();
    expect(dep.status).toBe(200);
    const after = (await member.req('GET', '/api/blueprint')).body;
    expect(after.version).toBe(before.version + 1);
    expect(after.blueprint.appearance).toMatchObject({ brandColor: '#0a7f6b', sidebar: 'dark', defaultTheme: 'dark', customCss: '.x { letter-spacing: .01em }' });
    const rb = await owner.req('POST', `/api/evolve/releases/${dep.body.releaseId}/rollback`, { confirmation: 'REVERTIR' });
    expect(rb.status).toBe(200);
    expect((await owner.req('GET', '/api/blueprint')).body.blueprint.appearance).toBeUndefined();
  });

  it('EVOLVE planifica peticiones visuales con las nuevas operaciones (riesgo bajo, sin pruebas de aceptación)', async () => {
    let system = '';
    env.setMock((r) => {
      system = r.system ?? '';
      return {
        text: JSON.stringify({
          title: 'Menú lateral oscuro y color corporativo',
          summary: 'Aplica el color corporativo #0A7F6B y el menú lateral oscuro.',
          operations: [{ op: 'update_appearance', changes: { brandColor: '#0A7F6B', sidebar: 'dark' } }],
          tests: [],
        }),
      };
    });
    const created = await owner.req('POST', '/api/evolve/requests', { prompt: 'Pon el menú lateral oscuro y usa nuestro color corporativo #0A7F6B' });
    expect(created.status).toBe(200);
    await env.drain();
    const req = (await owner.req('GET', `/api/evolve/requests/${created.body.id}`)).body;
    expect(system).toContain('update_appearance');
    expect(req.status).toBe('ready_for_review');
    expect(req.risk).toBe('low');
    expect(req.kind).toBe('config');
    expect(req.change_set.operations[0].changes.brandColor).toBe('#0a7f6b');
  });
});
