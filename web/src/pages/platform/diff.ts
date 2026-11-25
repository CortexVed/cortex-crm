/**
 * Diferencias por líneas para el visor (LCS por programación dinámica tras recortar el principio y el final
 * comunes), sin dependencias. Si el tramo distinto es enorme, se muestra como «todo borrado + todo añadido».
 */

export interface DiffLine {
  type: 'equal' | 'add' | 'del';
  text: string;
  /** Número de línea en la versión anterior / nueva. */
  a?: number;
  b?: number;
}

export type DiffRow = DiffLine | { type: 'gap'; count: number; from: number };

const MAX_CELLS = 2_500_000;

export function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineDiff(before: string | null, after: string | null): { lines: DiffLine[]; approximate: boolean } {
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
  const ops: { type: DiffLine['type']; text: string }[] = [];
  let approximate = false;
  const n = midA.length;
  const m = midB.length;
  if (n && m && (n + 1) * (m + 1) <= MAX_CELLS) {
    // lcs[i][j] = longitud de la subsecuencia común más larga de midA[i:] y midB[j:]
    const w = m + 1;
    const lcs = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'equal', text: midA[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        ops.push({ type: 'del', text: midA[i++] });
      } else {
        ops.push({ type: 'add', text: midB[j++] });
      }
    }
    while (i < n) ops.push({ type: 'del', text: midA[i++] });
    while (j < m) ops.push({ type: 'add', text: midB[j++] });
  } else {
    approximate = n > 0 && m > 0;
    for (const t of midA) ops.push({ type: 'del', text: t });
    for (const t of midB) ops.push({ type: 'add', text: t });
  }
  const all = [...a.slice(0, start).map((text) => ({ type: 'equal' as const, text })), ...ops, ...a.slice(endA).map((text) => ({ type: 'equal' as const, text }))];
  let la = 1;
  let lb = 1;
  const lines = all.map((op) => {
    const line: DiffLine = { ...op };
    if (op.type !== 'add') line.a = la++;
    if (op.type !== 'del') line.b = lb++;
    return line;
  });
  return { lines, approximate };
}

export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** Colapsa los tramos iguales largos, dejando `context` líneas alrededor de cada cambio. */
export function collapse(lines: DiffLine[], context = 3, expanded: ReadonlySet<number> = new Set()): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'equal') {
      rows.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === 'equal') j++;
    const run = j - i;
    const lead = i === 0 ? 0 : context;
    const trail = j === lines.length ? 0 : context;
    if (run > lead + trail + 2 && !expanded.has(i)) {
      for (let k = i; k < i + lead; k++) rows.push(lines[k]);
      rows.push({ type: 'gap', count: run - lead - trail, from: i });
      for (let k = j - trail; k < j; k++) rows.push(lines[k]);
    } else {
      for (let k = i; k < j; k++) rows.push(lines[k]);
    }
    i = j;
  }
  return rows;
}
