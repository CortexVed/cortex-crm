/** Elimina la query y enmascara segmentos con tokens antes de registrar o guardar una URL. */
export function sanitizeUrl(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  return path
    .replace(/\/invite\/[^/]+/g, '/invite/[token]')
    .replace(/\/api\/hooks\/([a-z]+)\/[^/]+/g, '/api/hooks/$1/[token]');
}
