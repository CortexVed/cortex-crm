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

export function phoneDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}
