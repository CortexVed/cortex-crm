/**
 * CLI de operación (se ejecuta DENTRO del contenedor, p. ej. con `railway ssh`):
 *   node dist/server/cli.js grant-platform-admin <email>
 *   node dist/server/cli.js revoke-platform-admin <email>
 *   node dist/server/cli.js list-platform-admins
 * El rol de administrador de plataforma (métricas y salud globales) nunca se concede desde la web en
 * producción: solo por esta vía, que queda auditada.
 */
import fs from 'node:fs';
import { loadConfig } from './config';
import { createDb } from './db/db';
import { runMigrations } from './db/migrations';
import { audit } from './lib/audit';

async function main() {
  const [cmd, emailArg] = process.argv.slice(2);
  if (process.env.NODE_ENV !== 'production' && fs.existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const db = await createDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir ?? (config.databaseUrl ? undefined : '.data/pglite'), poolMax: 2 });
  try {
    await runMigrations(db);
    if (cmd === 'list-platform-admins') {
      const r = await db.query(`SELECT email, name, created_at FROM users WHERE is_platform_admin ORDER BY created_at`);
      console.table(r.rows);
      return;
    }
    if ((cmd === 'grant-platform-admin' || cmd === 'revoke-platform-admin') && emailArg) {
      const grant = cmd === 'grant-platform-admin';
      const r = await db.query(`UPDATE users SET is_platform_admin = $1 WHERE lower(email) = lower($2) RETURNING id, email`, [grant, emailArg.trim()]);
      if (!r.rows.length) {
        console.error(`No existe ningún usuario con el email ${emailArg}. Regístrate primero en la aplicación.`);
        process.exitCode = 1;
        return;
      }
      await audit(db, { workspaceId: null, actorId: r.rows[0].id, actorType: 'system', action: grant ? 'platform.admin_granted_by_cli' : 'platform.admin_revoked_by_cli' });
      console.log(`${grant ? 'Concedido' : 'Retirado'} el rol de administrador de plataforma a ${r.rows[0].email}.`);
      return;
    }
    console.log('Uso: node dist/server/cli.js <grant-platform-admin|revoke-platform-admin> <email> | list-platform-admins');
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
