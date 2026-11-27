import { AppError } from '../lib/errors';
import { t } from '../i18n';

export const GRAPH_API_VERSION = 'v23.0';

export interface ConnectorType {
  type: string;
  label: string;
  status: 'available' | 'planned';
  description: string;
  fields: { key: string; label: string; secret: boolean; help?: string }[];
  plannedReason?: string;
  docsUrl: string;
}

/**
 * Arquitectura de canales: cada conector traduce eventos de un proveedor a mensajes del CRM
 * vinculados a la ficha del contacto. Solo se activan con credenciales reales (no hay simulación).
 * Es una función para que los textos salgan en el idioma de cada petición (los nombres de producto no se traducen).
 */
export const connectorTypes = (): ConnectorType[] => [
  {
    type: 'whatsapp',
    label: t('WhatsApp Business (Cloud API de Meta)'),
    status: 'available',
    description: t('Recibe los mensajes de clientes en su ficha (por número de teléfono) y responde desde el CRM dentro de la ventana de 24 h.'),
    fields: [
      { key: 'phoneNumberId', label: t('Phone number ID'), secret: false, help: 'Meta Developers › WhatsApp › API Setup' },
      { key: 'accessToken', label: t('Access token permanente'), secret: true },
      { key: 'appSecret', label: t('App secret (para verificar firmas)'), secret: true },
    ],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  },
  {
    type: 'apiwass',
    label: t('WhatsApp con ApiWass'),
    status: 'available',
    description: t('Conecta un número de WhatsApp vinculado en ApiWass escaneando un código QR, sin la API oficial de Meta. Los mensajes llegan a la ficha del contacto por su teléfono y respondes desde el CRM.'),
    fields: [
      { key: 'apiKey', label: t('API key de ApiWass'), secret: true, help: t('ApiWass › Perfil (empieza por sk_)') },
      { key: 'sessionId', label: t('ID de la sesión'), secret: false, help: t('El alias de la sesión en ApiWass, p. ej. «ventas»') },
    ],
    docsUrl: 'https://apiwass.com/api-docs',
  },
  {
    type: 'telegram',
    label: 'Telegram Bot',
    status: 'available',
    description: t('Mensajes de Telegram vinculados al contacto por su usuario de Telegram; respuesta desde la ficha.'),
    fields: [{ key: 'botToken', label: t('Token del bot (@BotFather)'), secret: true }],
    docsUrl: 'https://core.telegram.org/bots/api',
  },
  {
    type: 'gmail',
    label: 'Gmail',
    status: 'planned',
    description: t('Sincronización de correos con la ficha del contacto.'),
    fields: [],
    plannedReason: t('Requiere registrar un cliente OAuth de Google Cloud verificado por Google para la plataforma (scopes de Gmail restringidos).'),
    docsUrl: 'https://developers.google.com/gmail/api',
  },
  {
    type: 'outlook',
    label: 'Outlook / Microsoft 365',
    status: 'planned',
    description: t('Sincronización de correos y calendario.'),
    fields: [],
    plannedReason: t('Requiere registrar una aplicación en Microsoft Entra ID con permisos de Graph (Mail.Read, Mail.Send).'),
    docsUrl: 'https://learn.microsoft.com/graph/outlook-mail-concept-overview',
  },
  {
    type: 'slack',
    label: 'Slack',
    status: 'planned',
    description: t('Avisos del CRM en canales y comandos.'),
    fields: [],
    plannedReason: t('Requiere crear una Slack App de la plataforma con OAuth y Events API.'),
    docsUrl: 'https://api.slack.com/apis',
  },
];

async function jsonOrThrow(res: Response, label: string) {
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    const msg = body?.error?.message ?? body?.description ?? res.statusText;
    throw new AppError(400, 'connector_error', t('{name}: {message}', { name: label, message: msg }));
  }
  return body;
}

export async function telegramVerify(fetchImpl: typeof fetch, botToken: string) {
  const r = await jsonOrThrow(await fetchImpl(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(15_000) }), 'Telegram');
  return { username: r.result?.username as string };
}

export async function telegramSetWebhook(fetchImpl: typeof fetch, botToken: string, url: string, secret: string) {
  await jsonOrThrow(
    await fetchImpl(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }),
      signal: AbortSignal.timeout(15_000),
    }),
    'Telegram setWebhook',
  );
}

export async function telegramDeleteWebhook(fetchImpl: typeof fetch, botToken: string) {
  await fetchImpl(`https://api.telegram.org/bot${botToken}/deleteWebhook`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => {});
}

export async function telegramSend(fetchImpl: typeof fetch, botToken: string, chatId: string | number, text: string) {
  const r = await jsonOrThrow(
    await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(15_000) }),
    'Telegram',
  );
  return String(r.result?.message_id ?? '');
}

export async function whatsappVerify(fetchImpl: typeof fetch, phoneNumberId: string, accessToken: string) {
  const r = await jsonOrThrow(
    await fetchImpl(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) }),
    'WhatsApp',
  );
  return { displayPhone: r.display_phone_number as string, name: r.verified_name as string };
}

export async function whatsappSend(fetchImpl: typeof fetch, phoneNumberId: string, accessToken: string, to: string, text: string) {
  const r = await jsonOrThrow(
    await fetchImpl(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(15_000),
    }),
    'WhatsApp',
  );
  return String(r.messages?.[0]?.id ?? '');
}

// ---------------------------------------------------------------- ApiWass (WhatsApp vinculado por QR)
//
// API REST de https://apiwass.com/api-docs: clave en la cabecera x-api-key; cada número de WhatsApp es una «sesión»
// identificada por el alias que se le dio en ApiWass. Los mensajes entrantes llegan por un webhook que se configura en
// su panel (sesión › Credenciales › Integraciones & Webhooks). ApiWass no firma esos envíos: la autenticidad la da el
// token secreto de la URL del webhook de cada canal.

export const APIWASS_API = 'https://apiwass.com/api';

/** Alias de sesión aceptado (va en la ruta de la API). */
export const APIWASS_SESSION_RE = /^[\w.@-]{1,100}$/;

async function apiwassError(res: Response, sessionId: string): Promise<AppError> {
  const body: any = await res.json().catch(() => ({}));
  const detail = String(body?.error ?? body?.message ?? res.statusText ?? '').slice(0, 300);
  if (res.status === 401) return new AppError(400, 'connector_error', t('ApiWass: la API key no es válida.'));
  if (res.status === 403) return new AppError(400, 'connector_error', t('ApiWass: la sesión «{session}» pertenece a otra cuenta o la suscripción no está activa.', { session: sessionId }));
  if (res.status === 404) return new AppError(400, 'connector_error', t('ApiWass: no existe la sesión «{session}».', { session: sessionId }));
  if (res.status === 429) return new AppError(429, 'connector_rate_limited', t('ApiWass: demasiados mensajes seguidos. Reintenta en {seconds} s.', { seconds: Number(res.headers.get('retry-after')) || 60 }));
  if (res.status === 400) return new AppError(400, 'connector_error', t('ApiWass no ha aceptado la petición (¿la sesión está conectada?): {message}', { message: detail }));
  return new AppError(502, 'connector_error', t('{name}: {message}', { name: 'ApiWass', message: detail || String(res.status) }));
}

/** Estado de una sesión en la respuesta de ApiWass (READY, QR_READY, DISCONNECTED…), esté donde esté. */
export function apiwassStatusOf(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, any>;
  for (const v of [b.status, b.state, b.data?.status, b.data?.state, b.session?.status, b.session?.state]) {
    if (typeof v === 'string' && v.trim()) return v.trim().toUpperCase().slice(0, 40);
  }
  if (typeof b.connected === 'boolean') return b.connected ? 'READY' : 'DISCONNECTED';
  return null;
}

/** Comprueba la API key y la sesión; devuelve su estado (null si ApiWass no lo indica). */
export async function apiwassVerify(fetchImpl: typeof fetch, apiKey: string, sessionId: string) {
  const res = await fetchImpl(`${APIWASS_API}/sessions/${encodeURIComponent(sessionId)}/status`, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw await apiwassError(res, sessionId);
  return { status: apiwassStatusOf(await res.json().catch(() => null)) };
}

/** Envía un texto; devuelve el id del mensaje si ApiWass lo devuelve (su documentación no lo garantiza). */
export async function apiwassSend(fetchImpl: typeof fetch, apiKey: string, sessionId: string, phone: string, text: string) {
  const res = await fetchImpl(`${APIWASS_API}/sessions/${encodeURIComponent(sessionId)}/messages/text`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message: text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await apiwassError(res, sessionId);
  const body: any = await res.json().catch(() => null);
  const id = body?.id ?? body?.messageId ?? body?.key?.id ?? body?.data?.id ?? body?.data?.key?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id).slice(0, 200) : '';
}

/** ¿El evento de ApiWass es de la sesión de este canal? (ApiWass puede anteponer el id de la cuenta: «1_ventas»). */
export function apiwassSameSession(eventSession: unknown, configured: string): boolean {
  const s = String(eventSession ?? '');
  return !s || s === configured || s.endsWith(`_${configured}`);
}

export function phoneDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}
