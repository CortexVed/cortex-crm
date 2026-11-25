/**
 * CI aislado en Railway: el árbol del cambio se sube al servicio CI con este railway.json, que construye
 * Dockerfile.ci (npm ci, typecheck, vitest, build). La imagen solo arranca un servidor de salud fijo, escrito en Dockerfile.ci, que no carga el código probado, así
 * que «despliegue SUCCESS» = CI superado y «FAILED» = algo falló; los logs del build dicen qué.
 */

export const CI_RAILWAY_JSON = `${JSON.stringify(
  {
    $schema: 'https://railway.com/railway.schema.json',
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.ci' },
    deploy: { healthcheckPath: '/api/health', healthcheckTimeout: 120, restartPolicyType: 'NEVER' },
  },
  null,
  2,
)}\n`;

/** Rutas que no cuentan para la huella del árbol (el railway.json cambia entre el CI y el despliegue). */
export const TREE_HASH_EXCLUDE: ReadonlySet<string> = new Set(['railway.json']);

export interface CiAnalysis {
  tsErrors: string[];
  failedTests: string[];
  failureDetails: string;
  otherErrors: string[];
  testSummary: string[];
  excerpt: string;
  /** Lista de problemas para la auto-corrección del agente. */
  problems: string[];
}

const ANSI =/\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Quita colores, prefijos de BuildKit y líneas vacías. */
export function cleanLogLines(lines: string[]): string[] {
  return lines
    .flatMap((l) => String(l).split(/\r?\n/))
    .map((l) => l.replace(ANSI, '').replace(/^#\d+ \d+(?:\.\d+)? /, '').replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);
}

const unique = (xs: string[]) => [...new Set(xs)];

export function analyzeCiLogs(raw: string[]): CiAnalysis {
  const lines = cleanLogLines(raw);
  const tsRe = /((?:server|web|shared)\/[\w@()+./-]+\.tsx?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
  const tsErrors = unique(lines.flatMap((l) => {
    const m = l.match(tsRe);
    return m ? [`${m[1]}:${m[2]}:${m[3]} ${m[4]} ${m[5].slice(0, 400)}`] : [];
  })).slice(0, 40);
  const failedTests = unique(lines.flatMap((l) => {
    const m = l.match(/\bFAIL\s+(\S+\.test\.tsx?(?:\s+>\s+.+)?)$/);
    return m ? [m[1].slice(0, 300)] : [];
  })).slice(0, 30);
  let failureDetails = '';
  const start = lines.findIndex((l) => /Failed Tests? \d+/.test(l));
  if (start >= 0) {
    const block: string[] = [];
    for (let i = start + 1; i < lines.length && block.length < 150; i++) {
      if (/^\s*Test Files\s/.test(lines[i])) break;
      block.push(lines[i]);
    }
    failureDetails = block.join('\n').slice(0, 8000);
  }
  const testSummary = lines.filter((l) => /^\s*(?:Test Files|Tests)\s+\d/.test(l)).slice(-2);
  const otherErrors = unique(
    lines.filter((l) => !tsRe.test(l) && /(?:npm error|npm ERR!|error during build|✘ \[ERROR\]|ERROR: failed to solve|did not complete successfully|SyntaxError|Cannot find module|Error \[ERR_|exit code: [1-9])/.test(l)),
  )
    .map((l) => l.slice(0, 400))
    .slice(0, 20);
  const tail = lines.slice(-120);
  const excerpt = tail.join('\n').slice(-12_000);
  const problems: string[] = [
    ...tsErrors.map((e) => `TypeScript: ${e}`),
    ...failedTests.map((t) => `Prueba fallida: ${t}`),
    ...(failureDetails ? [`Detalle de las pruebas fallidas:\n${failureDetails}`] : []),
    ...otherErrors.map((e) => `Error del build: ${e}`),
  ];
  if (!problems.length) problems.push(`El CI falló sin un error reconocible. Últimas líneas del log:\n${lines.slice(-60).join('\n').slice(-6000)}`);
  return { tsErrors, failedTests, failureDetails, otherErrors, testSummary, excerpt, problems: problems.slice(0, 60) };
}
