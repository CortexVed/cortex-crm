/**
 * Espera a que la base de datos acepte conexiones: reintenta `SELECT 1` con espera creciente (hasta 5 s)
 * durante como mucho `maxMs`. En una instalación nueva (plantilla de Railway) los servicios de la aplicación
 * arrancan a la vez que Postgres; sin esto, el primer arranque fallaría y dependería de los reinicios.
 */
export async function waitForDatabase(
  db: { query: (sql: string) => Promise<unknown> },
  opts: { maxMs?: number; log?: (attempt: number, err: string) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const maxMs = opts.maxMs ?? 90_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      return attempt;
    } catch (e) {
      if (Date.now() - started >= maxMs) throw e;
      opts.log?.(attempt, (e as Error).message);
      await sleep(Math.min(5_000, 500 * attempt));
    }
  }
}
