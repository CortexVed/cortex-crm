import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { AppDeps } from './deps';
import { normalizeClientIp } from './lib/client-ip';
import { newId } from './lib/crypto';
import { AppError, badRequest, redact } from './lib/errors';
import { recordRequest } from './lib/metrics';
import { ipBucket, WindowCounter } from './lib/request-limit';
import { sanitizeUrl } from './lib/urls';
import { registerAuth } from './auth/plugin';
import { authRoutes } from './auth/routes';
import { workspaceRoutes } from './workspace/routes';
import { crmRoutes } from './crm/routes';
import { evolveRoutes } from './evolve/routes';
import { aiRoutes } from './ai/routes';
import { assistantRoutes } from './assistant/routes';
import { commsRoutes } from './comms/routes';
import { adminRoutes, publicRoutes } from './admin/routes';
import { codeEngineRoutes } from './code-engine/routes';
import { ProviderError } from './ai/types';

export function buildVersion() {
  let sha = process.env.RAILWAY_GIT_COMMIT_SHA ?? null;
  try {
    sha ??= fs.readFileSync(path.resolve(process.cwd(), '.build-sha'), 'utf8').trim() || null;
  } catch {
    /* sin archivo */
  }
  // Versión del código fuente que desplegó el motor de código de la instalación (source-version.json, que
  // el Dockerfile copia junto al bundle). Con ella se verifica cada despliegue; null en una imagen
  // construida desde el repositorio.
  let sourceVersion: { id: string; base: string | null; createdAt: string | null } | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'source-version.json'), 'utf8')) as Record<string, unknown> | null;
    if (raw && typeof raw.id === 'string' && raw.id) {
      sourceVersion = {
        id: raw.id.slice(0, 100),
        base: typeof raw.base === 'string' ? raw.base.slice(0, 100) : null,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : null,
      };
    }
  } catch {
    /* sin archivo o no válido */
  }
  return { sha, name: 'cortex-crm', version: '0.1.0', sourceVersion };
}

export { sanitizeUrl };

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'], remove: true },
            serializers: {
              req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: sanitizeUrl(req.url), ip: req.ip }),
            },
          },
    // Solo se confía en el proxy inmediato: req.ip es la última IP que añadió, así un cliente no puede
    // falsificar X-Forwarded-For para saltarse los límites. Detrás de Railway, además, el servidor HTTP
    // normaliza antes de nada la IP real del cliente desde X-Real-IP (que el edge sobrescribe siempre):
    // ver lib/client-ip.ts.
    trustProxy: (_address: string, hop: number) => hop === 0,
    ...(config.clientIpHeader
      ? {
          serverFactory: (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) =>
            http.createServer((req, res) => {
              normalizeClientIp(req, config.clientIpHeader!);
              handler(req, res);
            }),
        }
      : {}),
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => newId(),
  });

  // JSON conservando el cuerpo original (necesario para verificar firmas HMAC de webhooks entrantes).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(badRequest('JSON inválido'), undefined);
    }
  });
  // Sin límite propio: se aplica el general (2 MB) y solo la ruta de subida de archivos amplía el suyo.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' },
  });
  // La aplicación no usa cámara, micrófono, ubicación, pagos ni USB: se deniegan explícitamente.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  });
  await app.register(rateLimit, {
    // Los límites estrictos se declaran por ruta (config.rateLimit); el general se aplica abajo como hook.
    global: false,
    max: config.isTest ? 10_000 : 600, // valor por defecto de los límites por ruta que no indican otro
    timeWindow: '1 minute',
    // Clave por defecto de la librería: req.ip (ya resuelta con trustProxy) agrupando IPv6 por /64, para
    // que un mismo cliente no obtenga claves infinitas rotando direcciones de su bloque.
    ipv6Subnet: 64,
    // En tests todas las peticiones salen de la misma IP: se omite salvo que se pida explícitamente.
    allowList: config.isTest ? (req) => req.headers['x-test-rate-limit'] !== 'on' : undefined,
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, code: 'rate_limited', message: `Demasiadas peticiones. Reintenta en ${Math.max(1, Math.ceil(ctx.ttl / 1000))} s.` }),
  });
  // Límite general ANTES de autenticar: también cuentan las peticiones que la autenticación rechaza (401/403)
  // y las rutas inexistentes, así nadie puede forzar consultas a la base de datos sin límite.
  // Los webhooks entrantes llegan desde pocas IPs de Telegram/Meta compartidas por todas las organizaciones:
  // margen mayor por IP (cada conector tiene además su propio límite por token).
  // Es un contador propio (no app.rateLimit): el del plugin desactivaría los límites estrictos de cada ruta.
  const generalMax = config.isTest ? 10_000 : 600;
  const general = new WindowCounter(60_000);
  app.addHook('onRequest', async (req, reply) => {
    // Los archivos estáticos de la web no tocan la base de datos: no cuentan (una oficina entera puede salir
    // por la misma IP y cada carga de página pide varios).
    if (!req.url.startsWith('/api/')) return;
    if (config.isTest && req.headers['x-test-rate-limit'] !== 'on') return;
    const max = req.url.startsWith('/api/hooks/') ? generalMax * 5 : generalMax;
    const { allowed, retryAfter } = general.hit(ipBucket(req.ip), max);
    if (allowed) return;
    reply.header('retry-after', String(retryAfter));
    return reply.status(429).send({ error: { code: 'rate_limited', message: `Demasiadas peticiones. Reintenta en ${retryAfter} s.` } });
  });

  registerAuth(app, deps);

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/')) recordRequest(`${req.method} ${req.routeOptions?.url ?? 'unknown'}`, reply.statusCode, reply.elapsedTime);
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'validation_failed', message: 'Datos no válidos', details: err.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ProviderError) {
      const status = err.code === 'not_configured' ? 409 : err.code === 'limit_exceeded' ? 429 : 502;
      return reply.status(status).send({ error: { code: `ai_${err.code}`, message: err.message, details: (err as any).attempts } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; stack?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.statusCode === 413 ? 'El cuerpo de la petición es demasiado grande' : e.message } });
    }
    req.log.error({ err }, 'Error no controlado');
    try {
      await deps.db.query(`INSERT INTO error_events (id, workspace_id, user_id, source, message, stack, context) VALUES ($1,$2,$3,'api',$4,$5,$6)`, [
        newId(),
        req.auth?.workspaceId ?? null,
        req.auth?.userId ?? null,
        String(e.message).slice(0, 2000),
        e.stack?.slice(0, 8000) ?? null,
        JSON.stringify(redact({ method: req.method, url: sanitizeUrl(req.url), requestId: req.id })),
      ]);
    } catch {
      /* no bloquear la respuesta si falla el registro */
    }
    return reply.status(500).send({ error: { code: 'internal', message: config.isProd ? 'Error interno. Se ha registrado para su revisión.' : e.message, requestId: req.id } });
  });

  app.get('/api/health', async (_req, reply) => {
    let db = 'ok';
    try {
      await deps.db.query('SELECT 1');
    } catch {
      db = 'error';
    }
    reply.header('Cache-Control', 'no-store');
    return reply.status(db === 'ok' ? 200 : 503).send({ status: db === 'ok' ? 'ok' : 'degraded', role: config.role, db, version: buildVersion(), time: new Date().toISOString() });
  });

  await app.register(async (r) => authRoutes(r, deps), { prefix: '/api/auth' });
  await app.register(
    async (r) => {
      await workspaceRoutes(r, deps);
      await crmRoutes(r, deps);
      await evolveRoutes(r, deps);
      await aiRoutes(r, deps);
      await assistantRoutes(r, deps);
      await commsRoutes(r, deps);
      await adminRoutes(r, deps);
      await codeEngineRoutes(r, deps);
      await publicRoutes(r, deps);
    },
    { prefix: '/api' },
  );

  // Interfaz web (SPA compilada por Vite) servida por el mismo servicio: mismo origen para cookies y CSRF.
  const webRoot = path.resolve(process.cwd(), 'dist/web');
  const hasWeb = fs.existsSync(path.join(webRoot, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      index: false,
      setHeaders: (reply, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || !hasWeb || req.method !== 'GET') {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } });
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });

  return app;
}
