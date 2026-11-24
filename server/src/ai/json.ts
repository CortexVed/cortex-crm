/** Extrae el primer objeto JSON de una respuesta de modelo (tolera bloques ``` y texto alrededor). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) throw new Error('La respuesta no contiene un objeto JSON');
  // Busca el cierre que equilibra llaves (ignorando las que están dentro de cadenas).
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('JSON incompleto en la respuesta (posible truncado)');
}
