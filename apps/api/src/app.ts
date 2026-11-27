import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config/env.js';
import { createPools, type Pools } from './db/pool.js';
import { aiEmployeeRoutes } from './modules/ai-employees/routes.js';
import { simulationRoutes } from './modules/simulation/routes.js';
import { teachRoutes } from './modules/teach/routes.js';
import { knowledgeRoutes } from './modules/knowledge/routes.js';
import { governanceRoutes } from './modules/governance/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { overviewRoutes } from './modules/overview/routes.js';
import { platformRoutes } from './modules/platform/routes.js';
import { teamRoutes } from './modules/team/routes.js';
import { tenantRoutes } from './modules/tenants/routes.js';
import { registerAuth, SESSION_COOKIE } from './plugins/auth.js';
import { registerUsageMetering } from './plugins/usage.js';
import { AppError, forbidden } from './shared/errors.js';
import { createMailer } from './shared/mailer.js';
import { AiService } from './ai/service.js';
import type { LlmProvider } from './ai/types.js';
import { ChannelManager } from './channels/manager.js';
import { CampaignEngine } from './campaigns/engine.js';
import { WorkflowEngine } from './workflows/engine.js';
import { workflowRoutes } from './modules/workflows/routes.js';
import { performanceRoutes } from './modules/performance/routes.js';
import { platformDashboardRoutes } from './modules/platform/dashboard.js';
import { campaignRoutes } from './modules/campaigns/routes.js';
import { customerRoutes } from './modules/customers/routes.js';
import { channelRoutes } from './modules/channels/routes.js';
import { publicChannelRoutes } from './modules/channels/public.js';
import { conversationRoutes } from './modules/conversations/routes.js';

export interface BuildOptions {
  config: Config;
  pools?: Pools;
  logger?: boolean;
  /** Test hook: replace the AI provider (default: OpenRouter when OPENROUTER_API_KEY is set). */
  aiProvider?: LlmProvider | null;
  /** Per-IP throttling on auth endpoints. Disabled in most tests. */
  rateLimit?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.nodeEnv === 'production' ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  const pools = opts.pools ?? createPools(config);
  app.decorate('pools', pools);
  app.decorate('config', config);
  app.decorate('mailer', createMailer(config, pools, app.log));
  app.decorate('ai', new AiService(config, pools, app.log, opts.aiProvider));
  app.decorate('channels', new ChannelManager(app));
  app.decorate('campaigns', new CampaignEngine(app));
  app.decorate('workflows', new WorkflowEngine(app));
  app.addHook('onClose', async () => { app.campaigns.stop(); app.workflows.stop(); app.channels.stop(); await app.channels.idle(); await app.workflows.idle(); });
  if (!opts.pools) app.addHook('onClose', async () => pools.close());

  await app.register(helmet, {
    hsts: config.nodeEnv === 'production',
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  // Route inventory (method + URL + whether a rate limit is declared) — used by the security tests to prove every route is protected.
  const routeTable: Array<{ method: string; url: string; rateLimited: boolean }> = [];
  app.addHook('onRoute', (r) => { for (const m of [r.method].flat()) routeTable.push({ method: String(m), url: r.url, rateLimited: Boolean((r.config as { rateLimit?: unknown } | undefined)?.rateLimit) }); });
  app.decorate('routeTable', routeTable);
  await app.register(cookie);
  // Routes declare `config.rateLimit`; without the plugin registered those settings are simply inert.
  if (opts.rateLimit !== false) {
    // Global ceiling for the signed-in API (600 requests/min per session, or per IP when there is no session). Routes that declare their own
    // limit (login, webhooks, widget…) use that instead. Static files and the health check are not limited.
    await app.register(rateLimit, {
      global: true, max: 600, timeWindow: '1 minute',
      allowList: (req) => !req.url.startsWith('/api/') || req.url === '/api/v1/health',
      keyGenerator: (req) => { const c = req.cookies?.[SESSION_COOKIE]; return c ? `s:${c.slice(0, 16)}` : `ip:${req.ip}`; },
    });
  }

  // CSRF defence in depth (cookie is SameSite=Lax): reject state-changing requests from other origins.
  const allowedOrigin = new URL(config.appUrl).origin;
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    // Provider webhooks and the website widget are called from other origins by design; they authenticate with secrets/signed tokens instead.
    if (req.url.startsWith('/api/v1/webhooks/') || req.url.startsWith('/api/v1/widget/')) return;
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) throw forbidden('Cross-origin request blocked', 'bad_origin');
  });

  registerAuth(app);
  registerUsageMetering(app);

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: err.issues[0]?.message ?? 'Invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: (err as FastifyError).code ?? 'bad_request', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    if (process.env.DEBUG_ERRORS) console.error(err);
    // Platform error log: route + error type only (no request data, no secrets), best effort.
    void app.pools.platform.query(`INSERT INTO system_errors (tenant_id, source, code, message) VALUES ($1, 'api', $2, $3)`,
      [req.auth?.tenantId ?? null, String((err as { code?: string }).code ?? err.name ?? 'error').slice(0, 80), `${req.method} ${(req.routeOptions?.url ?? 'unknown').slice(0, 200)}`]).catch(() => undefined);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.get('/api/v1/health', async (_req, reply) => {
    try {
      await pools.app.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(tenantRoutes);
      await api.register(teamRoutes);
      await api.register(aiEmployeeRoutes);
      await api.register(governanceRoutes);
      await api.register(knowledgeRoutes);
      await api.register(teachRoutes);
      await api.register(simulationRoutes);
      await api.register(channelRoutes);
      await api.register(conversationRoutes);
      await api.register(customerRoutes);
      await api.register(campaignRoutes);
      await api.register(workflowRoutes);
      await api.register(performanceRoutes);
      await api.register(platformDashboardRoutes);
      await api.register(publicChannelRoutes);
      await api.register(overviewRoutes);
      await api.register(platformRoutes);
    },
    { prefix: '/api/v1' },
  );

  // ───────────── serve the built web app (production) ─────────────
  const indexHtml = path.join(config.webDistDir, 'index.html');
  const hasWeb = fs.existsSync(indexHtml);
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: true,
      index: false,
      setHeaders(res, filePath) {
        res.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  // "/" is a directory for the static plugin (it answers 403), so the app shell is served explicitly.
  if (hasWeb) app.get('/', async (_req, reply) => reply.header('Cache-Control', 'no-cache').type('text/html').send(fs.readFileSync(indexHtml)));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
    }
    if (hasWeb && req.method === 'GET') {
      return reply.header('Cache-Control', 'no-cache').type('text/html').send(fs.readFileSync(indexHtml));
    }
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}
