import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config';
import { createDb } from '../src/db/db';
import { runMigrations } from '../src/db/migrations';
import { SecretBox } from '../src/lib/crypto';
import type { Mailer, MailMessage } from '../src/lib/mailer';
import { AiManager } from '../src/ai/manager';
import type { ChatRequest, ChatResponse, ProviderAdapter } from '../src/ai/types';
import { buildApp } from '../src/app';
import { createJobHandlers } from '../src/worker';
import { JobRunner } from '../src/lib/jobs';
import type { AppDeps } from '../src/deps';

export type MockHandler = (req: ChatRequest) => Partial<ChatResponse> & { text?: string };

export function mockAdapter(handler: () => MockHandler): ProviderAdapter {
  return {
    async chat(req) {
      const r = handler()(req);
      return {
        text: r.text ?? '',
        toolCalls: r.toolCalls ?? [],
        stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_use' : 'end'),
        usage: r.usage ?? { inputTokens: 100, outputTokens: 50 },
        model: req.model,
        native: r.native,
      };
    },
    async listModels() {
      return [{ id: 'mock-model', name: 'Mock', contextLength: 1000, pricing: { inputPerM: 1, outputPerM: 2 } }];
    },
  };
}

export async function setup(
  opts: {
    env?: Record<string, string>;
    fetchImpl?: typeof fetch;
    /** Sobrescribe campos ya calculados de la configuración (p. ej. isProd para probar reglas de producción). */
    config?: Partial<AppConfig>;
    /** 'ok' = correo entregado (por defecto), 'disabled' = sin correo configurado, 'failing' = el envío falla. */
    mailer?: 'ok' | 'disabled' | 'failing';
  } = {},
) {
  const config: AppConfig = { ...loadConfig({ NODE_ENV: 'test' }, { LLM_ENABLE_MOCK: 'true', ALLOW_SIGNUP: 'true', ...(opts.env ?? {}) }), ...(opts.config ?? {}) };
  const db = await createDb({});
  await runMigrations(db);
  const box = new SecretBox(config.encryptionKey);
  let current: MockHandler = () => ({ text: 'OK' });
  const sent: MailMessage[] = [];
  const mailMode = opts.mailer ?? 'ok';
  const mailer: Mailer = {
    enabled: mailMode !== 'disabled',
    async send(m) {
      if (mailMode === 'failing') throw new Error('El proveedor de correo no responde');
      sent.push(m);
    },
  };
  const fetchImpl = opts.fetchImpl ?? (fetch as typeof fetch);
  const ai = new AiManager({ db, box, config, adapters: { mock: mockAdapter(() => current) }, fetchImpl });
  const deps: AppDeps = { config, db, box, ai, mailer, fetchImpl, now: () => new Date() };
  const app = await buildApp(deps);
  const runner = new JobRunner(db, createJobHandlers(deps), { info: () => {}, error: () => {} }, 10);
  return {
    app,
    deps,
    db,
    sent,
    setMock(h: MockHandler) {
      current = h;
    },
    drain: () => runner.drain(50),
    /** Con el correo activo el servidor ya no devuelve el enlace: se lee del último correo enviado a `email`. */
    inviteToken(email: string): string {
      const mail = [...sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase() && m.text.includes('/invite/'));
      const token = mail?.text.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error(`No se ha enviado ninguna invitación a ${email}`);
      return token;
    },
    verificationToken(email: string): string {
      const mail = [...sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase() && m.text.includes('/verify-email?token='));
      const token = mail?.text.match(/\/verify-email\?token=([^\s&]+)/)?.[1];
      if (!token) throw new Error(`No se ha enviado ningún correo de verificación a ${email}`);
      return decodeURIComponent(token);
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export class Client {
  cookie: string | null = null;
  csrf: string | null = null;
  constructor(private app: FastifyInstance) {}

  async req(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url,
      payload: body === undefined ? undefined : (body as any),
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
    });
    const setCookie = res.headers['set-cookie'];
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const c of list) {
      const [pair] = c.split(';');
      if (pair.startsWith('evolve_session=')) this.cookie = pair.endsWith('=') ? null : pair;
    }
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, body: json, headers: res.headers, raw: res };
  }

  async register(name: string, email: string, workspaceName: string, password = 'Contraseña-Segura-123') {
    const r = await this.req('POST', '/api/auth/register', { name, email, password, workspaceName });
    if (r.status !== 200) throw new Error(`register ${r.status}: ${JSON.stringify(r.body)}`);
    this.csrf = r.body.csrfToken;
    return r.body;
  }

  async login(email: string, password = 'Contraseña-Segura-123') {
    const r = await this.req('POST', '/api/auth/login', { email, password });
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
}

export const CONTRACTS_CHANGESET = {
  title: 'Módulo de contratos con avisos de vencimiento',
  summary: 'Añade un módulo de contratos con fechas de vencimiento, documentos adjuntos y un aviso automático 30 días antes.',
  operations: [
    {
      op: 'create_module',
      module: {
        key: 'contracts',
        label: 'Contrato',
        labelPlural: 'Contratos',
        icon: 'file-signature',
        primaryField: 'name',
        fields: [
          { key: 'name', label: 'Nombre', type: 'text', required: true },
          { key: 'company', label: 'Empresa', type: 'relation', relation: { module: 'companies' } },
          { key: 'end_date', label: 'Vencimiento', type: 'date' },
          { key: 'value', label: 'Importe', type: 'currency', currency: 'EUR' },
          { key: 'owner', label: 'Responsable', type: 'user' },
          { key: 'documents', label: 'Documentos', type: 'file' },
        ],
        views: [
          { key: 'all', label: 'Todos', type: 'table', columns: ['name', 'company', 'end_date', 'value'] },
          { key: 'expiry', label: 'Vencimientos', type: 'calendar', dateField: 'end_date' },
        ],
      },
    },
    {
      op: 'upsert_automation',
      automation: {
        key: 'contract_expiry_notice',
        name: 'Aviso 30 días antes del vencimiento',
        trigger: { type: 'date_reached', module: 'contracts', field: 'end_date', offsetDays: -30 },
        actions: [{ type: 'notify', to: { type: 'user_field', field: 'owner' }, title: 'El contrato {{record.name}} vence pronto' }],
      },
    },
  ],
  tests: [
    {
      name: 'Avisa al responsable 30 días antes del vencimiento',
      steps: [
        { action: 'create', module: 'contracts', values: { name: 'Mantenimiento anual', end_date: '{{today+40d}}', owner: '@member' }, as: 'c' },
        { action: 'advance_days', days: 10 },
        { action: 'run_scheduler' },
        { action: 'expect_notification', min: 1 },
      ],
    },
  ],
};
