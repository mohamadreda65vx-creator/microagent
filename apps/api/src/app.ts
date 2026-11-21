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
import { authRoutes } from './modules/auth/routes.js';
import { overviewRoutes } from './modules/overview/routes.js';
import { platformRoutes } from './modules/platform/routes.js';
import { teamRoutes } from './modules/team/routes.js';
import { tenantRoutes } from './modules/tenants/routes.js';
import { registerAuth } from './plugins/auth.js';
import { registerUsageMetering } from './plugins/usage.js';
import { AppError, forbidden } from './shared/errors.js';
import { createMailer } from './shared/mailer.js';

export interface BuildOptions {
  config: Config;
  pools?: Pools;
  logger?: boolean;
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
  await app.register(cookie);
  // Routes declare `config.rateLimit`; without the plugin registered those settings are simply inert.
  if (opts.rateLimit !== false) await app.register(rateLimit, { global: false });

  // CSRF defence in depth (cookie is SameSite=Lax): reject state-changing requests from other origins.
  const allowedOrigin = new URL(config.appUrl).origin;
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
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
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
    }
    if (hasWeb && req.method === 'GET') {
      return reply.header('Cache-Control', 'no-cache').type('text/html').send(fs.readFileSync(indexHtml));
    }
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}
