/**
 * Diferencias por líneas (algoritmo de Myers tras recortar el principio y el final comunes), sin
 * dependencias. Se usa para las estadísticas del cambio y para el diff que recibe la revisión con IA; la
 * interfaz tiene su propia versión (LCS) para el visor.
 */

export type DiffOp = { type: 'equal' | 'add' | 'del'; line: string };

/** Con más ediciones que esto se renuncia al diff mínimo (todo borrado + todo añadido). */
const MAX_EDITS = 2000;

export function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function myers(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3).fill(-1);
  v[off + 1] = 0;
  // trace[d]: estado de v antes del paso d, solo las diagonales que puede consultar (−d−1 … d+1).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'add', line: b[y - 1] });
        y--;
      } else {
        ops.push({ type: 'del', line: a[x - 1] });
        x--;
      }
    }
  }
  return ops.reverse();
}

export function diffLines(before: string | null, after: string | null): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid =
    (midA.length + midB.length <= 40_000 ? myers(midA, midB) : null) ??
    [...midA.map((line) => ({ type: 'del' as const, line })), ...midB.map((line) => ({ type: 'add' as const, line }))];
  return [...a.slice(0, start).map((line) => ({ type: 'equal' as const, line })), ...mid, ...a.slice(endA).map((line) => ({ type: 'equal' as const, line }))];
}

export function diffStats(before: string | null, after: string | null): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(before, after)) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}

/** Diff unificado (formato de `git diff`) con `context` líneas alrededor de cada cambio. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const ops = diffLines(before, after);
  const header = `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}\n`;
  const out: string[] = [];
  let i = 0;
  let lineA = 1;
  let lineB = 1;
  const positions = ops.map((op) => {
    const pos = { a: lineA, b: lineB };
    if (op.type !== 'add') lineA++;
    if (op.type !== 'del') lineB++;
    return pos;
  });
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // Extiende el bloque mientras los cambios estén a menos de 2·context líneas iguales.
    for (;;) {
      while (end < ops.length && ops[end].type !== 'equal') end++;
      let gap = 0;
      while (end + gap < ops.length && ops[end + gap].type === 'equal') gap++;
      if (end + gap >= ops.length || gap > context * 2) {
        end = Math.min(ops.length, end + Math.min(gap, context));
        break;
      }
      end += gap;
    }
    const slice = ops.slice(start, end);
    const countA = slice.filter((o) => o.type !== 'add').length;
    const countB = slice.filter((o) => o.type !== 'del').length;
    const posA = positions[start]?.a ?? 1;
    const posB = positions[start]?.b ?? 1;
    out.push(`@@ -${countA ? posA : posA - 1},${countA} +${countB ? posB : posB - 1},${countB} @@`);
    for (const o of slice) out.push(`${o.type === 'add' ? '+' : o.type === 'del' ? '-' : ' '}${o.line}`);
    i = end;
  }
  return out.length ? header + out.join('\n') + '\n' : '';
}
