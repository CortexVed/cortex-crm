import type { Db } from './db';

/**
 * Migraciones versionadas. Son aditivas (nunca destructivas) y se ejecutan al arrancar
 * bajo un advisory lock, de forma que web y worker pueden arrancar a la vez.
 */

// Tablas propiedad de una organización: RLS obligatorio.
export const TENANT_TABLES = [
  'blueprint_versions',
  'records',
  'record_history',
  'notes',
  'files',
  'evolution_requests',
  'evolution_approvals',
  'releases',
  'backups',
  'automation_runs',
  'notifications',
  'api_keys',
  'audit_log',
  'ai_providers',
  'ai_settings',
  'llm_usage',
  'ai_conversations',
  'ai_messages',
  'ai_memory',
  'connectors',
  'channel_messages',
  'code_changes',
] as const;

const M001 = `
CREATE OR REPLACE FUNCTION app_current_workspace() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  is_platform_admin boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'trial',
  blueprint_version int NOT NULL DEFAULT 0,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','builder','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  csrf_token text NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('password_reset','email_verification','invite')),
  token_hash text NOT NULL UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  email text,
  role text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS error_events (
  id uuid PRIMARY KEY,
  workspace_id uuid,
  user_id uuid,
  source text NOT NULL,
  message text NOT NULL,
  stack text,
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Tablas de organización (RLS) =====================

CREATE TABLE IF NOT EXISTS blueprint_versions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version int NOT NULL,
  definition jsonb NOT NULL,
  release_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, version)
);

CREATE TABLE IF NOT EXISTS records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS records_list_idx ON records (workspace_id, module_key, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS records_data_gin ON records USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS record_history (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  module_key text NOT NULL,
  action text NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}',
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_history_record_idx ON record_history (record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  body text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS notes_record_idx ON notes (record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_id uuid,
  module_key text,
  field_key text,
  name text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  sha256 text NOT NULL,
  content bytea NOT NULL,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS files_record_idx ON files (record_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS evolution_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'config',
  source text NOT NULL DEFAULT 'ai',
  prompt text NOT NULL,
  status text NOT NULL,
  base_version int NOT NULL,
  change_set jsonb,
  validation jsonb,
  test_report jsonb,
  impact jsonb,
  cross_review jsonb,
  risk text,
  llm jsonb NOT NULL DEFAULT '[]',
  conversation jsonb NOT NULL DEFAULT '[]',
  progress jsonb NOT NULL DEFAULT '[]',
  error text,
  release_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evolution_requests_ws_idx ON evolution_requests (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evolution_approvals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES evolution_requests(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid REFERENCES evolution_requests(id) ON DELETE SET NULL,
  kind text NOT NULL,
  status text NOT NULL,
  from_version int NOT NULL,
  to_version int NOT NULL,
  title text NOT NULL,
  summary text,
  artifacts jsonb NOT NULL DEFAULT '[]',
  tests jsonb NOT NULL DEFAULT '{}',
  validation jsonb NOT NULL DEFAULT '{}',
  data_changes jsonb NOT NULL DEFAULT '[]',
  verification jsonb NOT NULL DEFAULT '{}',
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  applied_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS releases_ws_idx ON releases (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  release_id uuid,
  reason text NOT NULL,
  size int NOT NULL,
  content bytea NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_key text NOT NULL,
  record_id uuid,
  trigger text NOT NULL,
  status text NOT NULL,
  dedupe_key text,
  log jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_runs_ws_idx ON automation_runs (workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_dedupe_uq ON automation_runs (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (workspace_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'member',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user',
  action text NOT NULL,
  target_type text,
  target_id text,
  meta jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_ws_idx ON audit_log (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_providers (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  api_key_ciphertext text,
  api_key_hint text,
  base_url text,
  default_model text,
  models_cache jsonb,
  models_cached_at timestamptz,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS ai_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  default_provider text,
  default_model text,
  routing jsonb NOT NULL DEFAULT '{}',
  limits jsonb NOT NULL DEFAULT '{}',
  pricing jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  task text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(14,6),
  latency_ms int NOT NULL DEFAULT 0,
  ok boolean NOT NULL,
  error_code text,
  error_message text,
  is_fallback boolean NOT NULL DEFAULT false,
  ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_usage_ws_idx ON llm_usage (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_conversations_user_idx ON ai_conversations (workspace_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  tool_calls jsonb NOT NULL DEFAULT '[]',
  provider text,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_conv_idx ON ai_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS ai_memory (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('org','user')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  source_ref text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_memory_ws_idx ON ai_memory (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connectors (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  config jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext text,
  webhook_token text NOT NULL UNIQUE,
  last_error text,
  last_event_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  channel text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  external_id text,
  from_address text,
  to_address text,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  record_id uuid,
  status text NOT NULL DEFAULT 'received',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_messages_record_idx ON channel_messages (record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS code_changes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid REFERENCES evolution_requests(id) ON DELETE SET NULL,
  status text NOT NULL,
  branch text,
  base_sha text,
  head_sha text,
  pr_number int,
  pr_url text,
  files jsonb NOT NULL DEFAULT '[]',
  summary text,
  test_plan text,
  scan jsonb NOT NULL DEFAULT '[]',
  review jsonb,
  checks jsonb,
  merged_sha text,
  merged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  deploy jsonb,
  revert_pr_number int,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

function rlsSql(): string {
  const parts: string[] = [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evolve_tenant') THEN
         CREATE ROLE evolve_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS;
       END IF;
     END $$;`,
    `GRANT USAGE ON SCHEMA public TO evolve_tenant;`,
    `GRANT EXECUTE ON FUNCTION app_current_workspace() TO evolve_tenant;`,
  ];
  for (const t of TENANT_TABLES) {
    parts.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO evolve_tenant;`);
    parts.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
    parts.push(`DROP POLICY IF EXISTS tenant_isolation ON ${t};`);
    parts.push(
      `CREATE POLICY tenant_isolation ON ${t} USING (workspace_id = app_current_workspace()) WITH CHECK (workspace_id = app_current_workspace());`,
    );
  }
  // Lectura acotada de tablas de plataforma desde el contexto de organización.
  parts.push(`GRANT SELECT, UPDATE ON workspaces TO evolve_tenant;`);
  parts.push(`ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;`);
  parts.push(`DROP POLICY IF EXISTS tenant_isolation ON workspaces;`);
  parts.push(
    `CREATE POLICY tenant_isolation ON workspaces USING (id = app_current_workspace()) WITH CHECK (id = app_current_workspace());`,
  );
  parts.push(`GRANT SELECT ON memberships TO evolve_tenant;`);
  parts.push(`ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;`);
  parts.push(`DROP POLICY IF EXISTS tenant_isolation ON memberships;`);
  parts.push(`CREATE POLICY tenant_isolation ON memberships USING (workspace_id = app_current_workspace());`);
  // Cola de trabajos: desde el contexto de organización solo se puede ENCOLAR trabajo propio.
  parts.push(`GRANT INSERT ON jobs TO evolve_tenant;`);
  parts.push(`ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;`);
  parts.push(`DROP POLICY IF EXISTS tenant_enqueue ON jobs;`);
  parts.push(
    `CREATE POLICY tenant_enqueue ON jobs FOR INSERT TO evolve_tenant WITH CHECK (workspace_id = app_current_workspace());`,
  );
  // Usuarios: solo columnas no sensibles y solo miembros de la organización actual.
  parts.push(`GRANT SELECT (id, name, email) ON users TO evolve_tenant;`);
  parts.push(`ALTER TABLE users ENABLE ROW LEVEL SECURITY;`);
  parts.push(`DROP POLICY IF EXISTS tenant_members ON users;`);
  parts.push(
    `CREATE POLICY tenant_members ON users FOR SELECT USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.workspace_id = app_current_workspace()));`,
  );
  return parts.join('\n');
}

export const MIGRATIONS: { id: string; sql: () => string }[] = [
  { id: '001_core_schema', sql: () => M001 },
  { id: '002_row_level_security', sql: rlsSql },
  // Aditiva: marca si la invitación llegó por correo (solo entonces el email se da por verificado al aceptarla).
  { id: '003_invite_delivery', sql: () => `ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS delivered boolean NOT NULL DEFAULT false;` },
  // Aditiva (solo un índice): el planificador de trabajos busca los listos por organización para repartir
  // turnos de forma equitativa entre organizaciones.
  { id: '004_jobs_workspace_ready_idx', sql: () => `CREATE INDEX IF NOT EXISTS jobs_ws_ready_idx ON jobs (workspace_id, run_at) WHERE status = 'queued';` },
  // Aditiva: motor de código fuente de la instalación (docs/CODE_ENGINE.md). Son tablas de PLATAFORMA: sin
  // RLS y sin ningún permiso para evolve_tenant; solo las usan las rutas de administración de la plataforma
  // y el worker con la conexión privilegiada. El token de Railway se guarda cifrado (SecretBox, AAD
  // platform:railway-token). Como mucho un cambio en preparación o despliegue a la vez (el servicio de CI es
  // único) y como mucho un despliegue o rollback a la vez; un rollback urgente no espera a que termine de
  // prepararse otro cambio.
  {
    id: '005_source_code_engine',
    sql: () => `
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext text,
  secret_hint text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_changes (
  id uuid PRIMARY KEY,
  ai_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  origin jsonb,
  prompt text NOT NULL,
  title text,
  summary text,
  status text NOT NULL,
  base_version text,
  base_tree_hash text,
  patch jsonb NOT NULL DEFAULT '{"files":[]}',
  stats jsonb NOT NULL DEFAULT '{}',
  guards jsonb,
  flags jsonb NOT NULL DEFAULT '[]',
  problems jsonb NOT NULL DEFAULT '[]',
  ci jsonb NOT NULL DEFAULT '{"attempts":[]}',
  review jsonb,
  risk text NOT NULL DEFAULT 'high',
  approvals jsonb NOT NULL DEFAULT '[]',
  deploy jsonb NOT NULL DEFAULT '{}',
  conversation jsonb NOT NULL DEFAULT '[]',
  progress jsonb NOT NULL DEFAULT '[]',
  llm jsonb NOT NULL DEFAULT '[]',
  lease_token text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deployed_at timestamptz,
  rolled_back_at timestamptz
);
CREATE INDEX IF NOT EXISTS source_changes_created_idx ON source_changes (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS source_changes_single_active_uq ON source_changes ((true)) WHERE status IN ('queued','planning','testing','deploying');
CREATE UNIQUE INDEX IF NOT EXISTS source_changes_single_release_uq ON source_changes ((true)) WHERE status IN ('deploying','rolling_back');
`,
  },
  // Aditiva: archivos adjuntos en un bucket compatible con S3 (el de la plantilla de Railway). `storage` dice
  // dónde está el contenido: 'db' (columna content, como hasta ahora) o 's3' (objeto `object_key` del bucket; content
  // queda vacío). Los archivos ya guardados siguen en la base de datos y se pueden descargar igual.
  {
    id: '006_file_object_storage',
    sql: () => `ALTER TABLE files ADD COLUMN IF NOT EXISTS storage text NOT NULL DEFAULT 'db';
ALTER TABLE files ADD COLUMN IF NOT EXISTS object_key text;`,
  },
  // Idiomas: users.locale es el idioma de la interfaz que eligió cada persona (NULL = el de su organización,
  // que sale de settings.locale, «Idioma y región»); jobs.locale, el idioma de quien encoló el trabajo, para que
  // los textos que genera (planes de EVOLVE, avisos) salgan en ese idioma. Aditiva: no cambia nada existente.
  {
    id: '007_locales',
    sql: () => `ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locale text;`,
  },
];

export async function runMigrations(db: Db, log: (msg: string) => void = () => {}) {
  // Una sola transacción con advisory lock transaccional: si web y worker arrancan a la vez,
  // el segundo espera y después ve las migraciones ya aplicadas. DDL transaccional = todo o nada.
  await db.tx(async (q) => {
    if (db.kind === 'pg') await q.query('SELECT pg_advisory_xact_lock($1)', [7_270_427]);
    await q.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set((await q.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      log(`Aplicando migración ${m.id}`);
      await q.exec(m.sql());
      await q.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    }
  });
}
