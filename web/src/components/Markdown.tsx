import type { ReactNode } from 'react';

/**
 * Renderizador Markdown mínimo y SEGURO: construye elementos React (nunca innerHTML),
 * así que el texto generado por la IA no puede inyectar HTML ni scripts.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k} className="rounded bg-zinc-100 px-1 py-0.5 text-[0.85em] dark:bg-zinc-800">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'));
      let host = '';
      try {
        host = new URL(m[2]).hostname;
      } catch {
        /* URL inválida: se muestra solo el texto */
      }
      if (!host) out.push(label);
      else {
        // El texto del enlace lo escribe la IA (y puede venir de datos de terceros): se muestra siempre el
        // dominio real de destino para que un texto engañoso no oculte adónde lleva.
        out.push(
          <span key={k}>
            <a href={m[2]} title={m[2]} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-600 underline underline-offset-2 dark:text-brand-400">{label}</a>
            {label.toLowerCase().includes(host.toLowerCase()) ? null : <span className="ml-1 text-[0.8em] text-zinc-500">({host})</span>}
          </span>,
        );
      }
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '), `p${blocks.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={`l${blocks.length}`} className={list.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}>
        {list.items.map((it, i) => (
          <li key={i}>{inline(it, `li${blocks.length}-${i}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      blocks.push(<p key={`h${blocks.length}`} className="font-semibold">{inline(h[2], `h${blocks.length}`)}</p>);
    } else if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className={className ?? 'space-y-2 text-sm leading-relaxed'}>{blocks}</div>;
}
