import type { AppConfig } from '../config';
import { currentLocale } from '../i18n';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  enabled: boolean;
  send(msg: MailMessage): Promise<void>;
}

/**
 * Correo transaccional vía API HTTP de Resend (Railway restringe SMTP saliente en algunos planes).
 * Sin credenciales: en desarrollo se registra en consola; en producción las funciones que dependen
 * del correo lo indican y los administradores pueden generar enlaces manualmente.
 */
export function createMailer(config: AppConfig, log: { info: (o: object, m: string) => void }, fetchImpl: typeof fetch = fetch): Mailer {
  if (!config.email) {
    return {
      enabled: false,
      async send(msg) {
        if (!config.isProd) log.info({ to: msg.to, subject: msg.subject, text: msg.text }, 'Correo NO enviado (email no configurado; solo visible en desarrollo)');
      },
    };
  }
  const { resendApiKey, from } = config.email;
  return {
    enabled: true,
    async send(msg) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`El proveedor de correo respondió ${res.status}`);
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plantilla de los correos: recibe los textos ya traducidos (se redactan con t() en el idioma de la petición). */
export function emailTemplate(title: string, intro: string, cta: { label: string; url: string }, outro = ''): { html: string; text: string } {
  const html = `<!doctype html><html lang="${currentLocale()}"><body style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f6f6f9;padding:32px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e7e7ee">
<div style="font-weight:700;font-size:18px;color:#5b3df5;margin-bottom:24px">Cortex CRM</div>
<h1 style="font-size:20px;color:#111;margin:0 0 12px">${esc(title)}</h1>
<p style="color:#444;line-height:1.6">${esc(intro)}</p>
<p style="margin:28px 0"><a href="${esc(cta.url)}" style="background:#5b3df5;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>
<p style="color:#777;font-size:13px;line-height:1.6">${esc(outro)}</p></div></body></html>`;
  return { html, text: `${title}\n\n${intro}\n\n${cta.label}: ${cta.url}\n\n${outro}` };
}
