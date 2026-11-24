import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/**
 * IP real del cliente detrás del proxy de entrada.
 *
 * En Railway, el *edge* SOBRESCRIBE `X-Real-IP` (y `X-Forwarded-For`) en cada petición pública con la IP
 * del cliente, así que desde Internet no se puede falsear; en cambio, el número de saltos internos hasta
 * el contenedor no es fijo: «confiar solo en el salto inmediato» devolvía la IP de un nodo del proxy
 * (compartida por muchos usuarios), y los límites por IP y la auditoría dejaban de identificar al cliente.
 *
 * Se normaliza en el propio servidor HTTP, antes de enrutar, registrar o auditar: si la cabecera trae una
 * IP válida, pasa a ser el único valor de `X-Forwarded-For` y `req.ip` (con `trustProxy` del salto
 * inmediato) es esa IP en toda la aplicación. Si falta o no es una IP (p. ej. tráfico interno, que no
 * pasa por el edge), se mantiene el comportamiento anterior.
 */
export function normalizeClientIp(req: IncomingMessage, header: string): void {
  const raw = req.headers[header.toLowerCase()];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value && isIP(value)) req.headers['x-forwarded-for'] = value;
}
