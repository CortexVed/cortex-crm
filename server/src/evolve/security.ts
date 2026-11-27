import { z } from 'zod';
import { ROLE_RANK } from '../../../shared/constants';
import { activeModules } from '../../../shared/blueprint';
import type { AppDeps } from '../deps';
import { TENANT_TABLES } from '../db/migrations';
import { loadWorkspace } from '../crm/context';
import { compactBlueprint, advisorSystem, securitySystem } from './prompts';
import { t, tk, tp } from '../i18n';

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'pass';
  title: string;
  description: string;
  recommendation?: string;
  /** link: pantalla de Ajustes donde se hace la acción manual (no depende del idioma del texto). */
  fix?: { kind: 'config' | 'code' | 'manual'; prompt: string; link?: string };
  source: 'automatic' | 'ai';
}

/** Comprobaciones deterministas (no dependen de la IA). */
export async function automaticFindings(deps: AppDeps, ws: string, opts: { platformAdmin: boolean }): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, 'source'>) => out.push({ ...f, source: 'automatic' });

  // Controles de plataforma verificados en la propia base de datos.
  const rls = await deps.db.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
    [[...TENANT_TABLES]],
  );
  const withoutRls = rls.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
  if (withoutRls.length) add({ severity: 'critical', title: t('Tablas sin Row Level Security'), description: t('RLS desactivado en: {tables}', { tables: withoutRls.join(', ') }), recommendation: t('Reaplicar las migraciones de seguridad.'), fix: { kind: 'code', prompt: t('Restaurar las políticas RLS en las tablas indicadas') } });
  else add({ severity: 'pass', title: t('Aislamiento entre organizaciones (RLS)'), description: tp(rls.rows.length, 'Row Level Security activo en {count} tabla de organización, además de los filtros de la aplicación.', 'Row Level Security activo en {count} tablas de organización, además de los filtros de la aplicación.') });
  add({ severity: 'pass', title: t('Contraseñas'), description: t('Hash scrypt con sal individual, bloqueo tras 10 intentos fallidos y rate limiting en login.') });
  add({ severity: 'pass', title: t('Sesiones y CSRF'), description: t('Cookies httpOnly + SameSite=Lax (Secure en producción), token CSRF por sesión y comprobación de origen.') });
  add({ severity: 'pass', title: t('Secretos'), description: t('API keys de proveedores cifradas con AES-256-GCM ligadas a la organización; nunca se envían al navegador ni se registran.') });

  await deps.db.tenant(ws, async (q) => {
    const loaded = await loadWorkspace(q, ws);
    const bp = loaded.blueprint;
    const members = (await q.query<{ role: string }>(`SELECT role FROM memberships WHERE workspace_id = $1`, [ws])).rows;
    const owners = members.filter((m) => m.role === 'owner').length;
    if (owners === 1 && members.length > 1) add({ severity: 'low', title: t('Un único propietario'), description: t('Si esa persona pierde el acceso, nadie podrá aprobar cambios de riesgo alto.'), recommendation: t('Nombra un segundo propietario de confianza.'), fix: { kind: 'manual', prompt: t('Ajustes › Equipo: asigna el rol Propietario a una segunda persona.'), link: '/settings/team' } });
    const admins = members.filter((m) => ROLE_RANK[m.role as keyof typeof ROLE_RANK] >= ROLE_RANK.admin).length;
    if (members.length >= 4 && admins / members.length > 0.5) add({ severity: 'medium', title: t('Demasiados administradores'), description: t('{admins} de {members} miembros tienen rol de administrador o superior.', { admins, members: members.length }), recommendation: t('Aplica el principio de mínimo privilegio.'), fix: { kind: 'manual', prompt: t('Ajustes › Equipo: reduce el rol de quienes no necesitan administrar.'), link: '/settings/team' } });

    const keys = (await q.query(`SELECT name, role, last_used_at, created_at FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL`, [ws])).rows;
    for (const k of keys) {
      const last = k.last_used_at ? new Date(k.last_used_at) : null;
      if (!last && Date.now() - new Date(k.created_at).getTime() > 30 * 86_400_000) add({ severity: 'medium', title: t('API key sin usar: {name}', { name: k.name }), description: t('Lleva más de 30 días creada y nunca se ha usado.'), recommendation: t('Revócala si no es necesaria.'), fix: { kind: 'manual', prompt: t('Ajustes › API keys: revoca «{name}».', { name: k.name }), link: '/settings/api-keys' } });
      else if (last && Date.now() - last.getTime() > 90 * 86_400_000) add({ severity: 'medium', title: t('API key inactiva: {name}', { name: k.name }), description: t('Sin uso en los últimos 90 días.'), recommendation: t('Revócala o rótala.'), fix: { kind: 'manual', prompt: t('Ajustes › API keys: revoca «{name}».', { name: k.name }), link: '/settings/api-keys' } });
      if (k.role === 'admin') add({ severity: 'low', title: t('API key con rol administrador: {name}', { name: k.name }), description: t('Una clave filtrada con este rol permitiría administrar la organización.'), recommendation: t('Usa el rol mínimo necesario.') });
    }

    const pii = new Set(bp.modules.flatMap((m) => m.fields.filter((f) => ['email', 'phone'].includes(f.type)).map((f) => f.key)));
    for (const integ of bp.integrations) {
      if (!integ.includeFields) add({ severity: 'medium', title: t('La integración «{name}» envía todos los campos', { name: integ.name }), description: t('Puede incluir datos personales (RGPD).'), recommendation: t('Limita los campos enviados con includeFields.'), fix: { kind: 'config', prompt: t('Limita la integración "{key}" para que solo envíe los campos imprescindibles, sin email ni teléfono.', { key: integ.key }) } });
      else if (integ.includeFields.some((f) => pii.has(f))) add({ severity: 'low', title: t('«{name}» envía datos personales', { name: integ.name }), description: t('Incluye email o teléfono.'), recommendation: t('Verifica la base legal y el contrato de encargo de tratamiento.') });
    }
    for (const m of activeModules(bp)) {
      if (ROLE_RANK[m.permissions.delete] <= ROLE_RANK.viewer) add({ severity: 'high', title: t('Los lectores pueden eliminar {module}', { module: m.labelPlural }), description: t('El rol de solo lectura tiene permiso de borrado.'), recommendation: t('Restringe el borrado a miembros o administradores.'), fix: { kind: 'config', prompt: t('Restringe el permiso de eliminar del módulo "{key}" al rol member.', { key: m.key }) } });
    }
    for (const f of bp.forms.filter((x) => x.public)) add({ severity: 'info', title: t('Formulario público «{name}»', { name: f.name }), description: t('Acepta envíos desde Internet (con validación y límite de peticiones).') });

    const providers = (await q.query(`SELECT provider, last_error FROM ai_providers WHERE workspace_id = $1 AND api_key_ciphertext IS NOT NULL`, [ws])).rows;
    for (const p of providers.filter((x: any) => x.last_error)) add({ severity: 'low', title: t('Proveedor de IA con errores: {provider}', { provider: p.provider }), description: String(p.last_error).slice(0, 200), recommendation: t('Comprueba o rota la API key.') });
  });

  // Los fallos de login se auditan sin organización (aún no hay sesión): se cuentan los de las cuentas
  // que son miembros de esta organización, con la conexión de plataforma y acotado a sus miembros.
  const logins = await deps.db.query<{ failed: number; locked: number }>(
    `SELECT count(*) FILTER (WHERE action = 'auth.login_failed')::int AS failed, count(*) FILTER (WHERE action = 'auth.account_locked')::int AS locked
     FROM audit_log WHERE action IN ('auth.login_failed','auth.account_locked') AND created_at > now() - interval '24 hours'
       AND actor_id IN (SELECT user_id FROM memberships WHERE workspace_id = $1)`,
    [ws],
  );
  const { failed, locked } = logins.rows[0] ?? { failed: 0, locked: 0 };
  if (locked > 0) add({ severity: 'medium', title: t('Cuentas bloqueadas por intentos fallidos'), description: tp(locked, '{count} bloqueo de cuentas del equipo en las últimas 24 horas.', '{count} bloqueos de cuentas del equipo en las últimas 24 horas.'), recommendation: t('Revisa la auditoría: puede ser un ataque de fuerza bruta o alguien que olvidó su contraseña.') });
  else if (failed > 20) add({ severity: 'medium', title: t('Muchos intentos de inicio de sesión fallidos'), description: t('{count} en las últimas 24 horas en cuentas del equipo.', { count: failed }), recommendation: t('Revisa la auditoría por posibles ataques de fuerza bruta.') });

  if (opts.platformAdmin) {
    const c = deps.config;
    if (c.isProd && !c.appUrl) add({ severity: 'medium', title: t('APP_URL no configurada'), description: t('Los enlaces de correo y la comprobación de origen usan la cabecera Host.'), recommendation: t('Define APP_URL con el dominio público.') });
    if (!c.email) add({ severity: 'medium', title: t('Correo transaccional no configurado'), description: t('La recuperación de contraseña y la verificación de email no envían correos.'), recommendation: t('Configura RESEND_API_KEY y EMAIL_FROM.') });
    if (c.isProd && c.allowSignup) add({ severity: 'info', title: t('Registro público abierto'), description: t('Cualquiera puede crear una organización nueva (aislada).'), recommendation: t('Pon ALLOW_SIGNUP=false si no quieres altas abiertas.') });
  }
  return out;
}

const AiSecuritySchema = z.object({
  score: z.number().min(0).max(100),
  summary: z.string().max(4000),
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        title: z.string().max(200),
        description: z.string().max(2000),
        recommendation: z.string().max(2000),
        fix: z.object({ kind: z.enum(['config', 'code', 'manual']), prompt: z.string().max(3000) }).optional(),
      }),
    )
    .max(30),
});

export async function runSecurityReview(deps: AppDeps, ws: string, opts: { userId: string; platformAdmin: boolean }) {
  const automatic = await automaticFindings(deps, ws, opts);
  const bp = await deps.db.tenant(ws, async (q) => (await loadWorkspace(q, ws)).blueprint);
  let ai: z.infer<typeof AiSecuritySchema> | null = null;
  let aiError: string | null = null;
  let model: string | null = null;
  try {
    const res = await deps.ai.runJson(
      ws,
      {
        task: 'security',
        system: securitySystem(),
        userId: opts.userId,
        ref: 'security_review',
        maxTokens: 12_000,
        messages: [
          {
            role: 'user',
            content: `Controles de plataforma: autenticación por sesión httpOnly con CSRF, scrypt, rate limiting, RLS en PostgreSQL, CSP estricta, cifrado AES-GCM de secretos, auditoría, aprobación humana y sandbox para cambios generados por IA.\n\nHallazgos automáticos:\n${JSON.stringify(automatic.filter((f) => f.severity !== 'pass'))}\n\nConfiguración del CRM (sin datos personales):\n${JSON.stringify(compactBlueprint(bp))}`,
          },
        ],
      },
      AiSecuritySchema,
      1,
    );
    ai = res.value;
    model = `${res.result.provider}/${res.result.model}`;
  } catch (e) {
    aiError = tk((e as Error).message);
  }
  const findings: Finding[] = [...automatic, ...(ai?.findings ?? []).map((f) => ({ ...f, source: 'ai' as const }))];
  const penalty = automatic.reduce((acc, f) => acc + ({ critical: 30, high: 15, medium: 6, low: 2, info: 0, pass: 0 }[f.severity] ?? 0), 0);
  return {
    score: ai ? Math.round((ai.score + Math.max(0, 100 - penalty)) / 2) : Math.max(0, 100 - penalty),
    summary: ai?.summary ?? (aiError ? t('Análisis automático completado. La revisión con IA no está disponible: {error}', { error: aiError }) : ''),
    findings,
    model,
    aiError,
    ranAt: deps.now().toISOString(),
  };
}

const AdviceSchema = z.object({
  summary: z.string().max(3000),
  suggestions: z.array(z.object({ title: z.string().max(200), description: z.string().max(1500), impact: z.enum(['alto', 'medio', 'bajo']), prompt: z.string().max(2000) })).max(10),
});

/** "Proponer mejoras del propio software" a partir de estadísticas agregadas (sin datos personales). */
export async function runAdvisor(deps: AppDeps, ws: string, userId: string) {
  const stats = await deps.db.tenant(ws, async (q) => {
    const loaded = await loadWorkspace(q, ws);
    const perModule = [];
    for (const m of activeModules(loaded.blueprint)) {
      const total = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL`, [ws, m.key])).rows[0].n;
      const fill: Record<string, number> = {};
      if (total > 0) {
        for (const f of m.fields.filter((x) => !x.archived && x.type !== 'formula').slice(0, 40)) {
          const r = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL AND data ? $3 AND data->>$3 <> ''`, [ws, m.key, f.key]);
          fill[f.key] = Math.round((r.rows[0].n / total) * 100);
        }
      }
      const stale = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE workspace_id = $1 AND module_key = $2 AND deleted_at IS NULL AND last_activity_at < now() - interval '30 days'`, [ws, m.key])).rows[0].n;
      perModule.push({ module: m.key, label: m.labelPlural, total, staleOver30Days: stale, fieldFillPercent: fill });
    }
    const runs = (await q.query(`SELECT automation_key, status, count(*)::int AS n FROM automation_runs WHERE workspace_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1,2`, [ws])).rows;
    return { blueprint: compactBlueprint(loaded.blueprint), perModule, automationRuns30d: runs, settings: loaded.settings };
  });
  const res = await deps.ai.runJson(ws, { task: 'crm_analysis', system: advisorSystem(), userId, ref: 'advisor', maxTokens: 8000, messages: [{ role: 'user', content: JSON.stringify(stats) }] }, AdviceSchema, 1);
  return { ...res.value, model: `${res.result.provider}/${res.result.model}`, ranAt: deps.now().toISOString() };
}
