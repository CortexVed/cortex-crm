import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Ejecuta SQL con múltiples sentencias y sin parámetros (migraciones). */
  exec(sql: string): Promise<void>;
}

/**
 * Acceso a base de datos.
 * - `query` / `tx`: conexión privilegiada (tablas de plataforma: usuarios, sesiones, organizaciones, jobs).
 * - `tenant`: transacción con `SET LOCAL ROLE evolve_tenant` + `app.workspace_id`, de modo que
 *   PostgreSQL Row Level Security garantiza el aislamiento entre organizaciones además de los
 *   filtros explícitos de la aplicación (defensa en profundidad).
 */
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  tenant<T>(workspaceId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pg' | 'pglite';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function enterTenant(q: Queryable, workspaceId: string) {
  if (!UUID_RE.test(workspaceId)) throw new Error('workspaceId inválido');
  await q.query('SET LOCAL ROLE evolve_tenant');
  await q.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
}

function createPgDb(url: string, max: number): Db {
  // Los timestamptz se devuelven como Date; int8 (count) como string -> usamos ::int en SQL.
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', err: err.message }));
  });
  const run = async <T>(fn: (q: Queryable) => Promise<T>, workspaceId?: string): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        query: async (sql, params) => {
          const r = await client.query(sql, params as any[]);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
        exec: async (sql) => {
          await client.query(sql);
        },
      };
      if (workspaceId) await enterTenant(q, workspaceId);
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* conexión rota: se descarta */
      }
      throw err;
    } finally {
      client.release();
    }
  };
  return {
    kind: 'pg',
    async query(sql, params) {
      const r = await pool.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    tx: (fn) => run(fn),
    tenant: (workspaceId, fn) => run(fn, workspaceId),
    close: () => pool.end(),
  };
}

async function createPgliteDb(dir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  const wrap = (x: { query: (s: string, p?: any[]) => Promise<any>; exec: (s: string) => Promise<any> }): Queryable => ({
    query: async (sql, params) => {
      const r = await x.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: async (sql) => {
      await x.exec(sql);
    },
  });
  return {
    kind: 'pglite',
    query: (sql, params) => wrap(db).query(sql, params),
    exec: (sql) => wrap(db).exec(sql),
    tx: (fn) => db.transaction(async (t) => fn(wrap(t))),
    tenant: (workspaceId, fn) =>
      db.transaction(async (t) => {
        const q = wrap(t);
        await enterTenant(q, workspaceId);
        return fn(q);
      }),
    close: () => db.close(),
  };
}

export async function createDb(opts: { url?: string; pgliteDir?: string; poolMax?: number }): Promise<Db> {
  if (opts.url) return createPgDb(opts.url, opts.poolMax ?? 15);
  return createPgliteDb(opts.pgliteDir);
}

/** Construye cláusula IN segura: devuelve "$3,$4,$5" y añade los valores a params. */
export function inList(params: unknown[], values: unknown[]): string {
  return values.map((v) => {
    params.push(v);
    return `$${params.length}`;
  }).join(',');
}
