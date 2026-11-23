import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Walk up from the working directory to find the nearest .env (repo root in dev). */
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envFile = findEnvFile();
if (envFile) dotenv.config({ path: envFile, quiet: true });

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  DATABASE_URL_OWNER: z.string().min(1),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  TEST_DATABASE_NAME: z.string().default('microagent_test'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().default(587)),
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PASS: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_FROM: z.string().default('MicroAgent <no-reply@localhost>'),
  WEB_DIST_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  // ── AI (OpenRouter). The key lives ONLY here, on the server. It is never sent to the browser.
  OPENROUTER_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_DEFAULT_MODEL: z.string().default('openai/gpt-4o-mini'),
  OPENROUTER_MODELS: z.preprocess(emptyToUndefined, z.string().optional()),
  AI_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().min(0).default(2_000_000),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(45_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
  AI_RETRY_BASE_MS: z.coerce.number().int().min(0).max(10_000).default(400),
  // ── Channels (Part 3)
  /** 32 random bytes, base64. Encrypts channel credentials at rest and signs widget/OAuth tokens. */
  CHANNEL_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  EVOLUTION_API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  EVOLUTION_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  META_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  META_APP_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  META_VERIFY_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  META_GRAPH_BASE: z.string().url().default('https://graph.facebook.com'),
  META_GRAPH_VERSION: z.string().default('v21.0'),
  // Only for automated tests that fetch from 127.0.0.1. Ignored in production.
  ALLOW_PRIVATE_FETCH: z.string().optional().transform((v) => v === 'true' || v === '1'),
});

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  appUrl: string;
  trustProxy: boolean;
  db: { owner: string; app: string; platform: string };
  testDatabaseName: string;
  sessionTtlDays: number;
  smtp: { host?: string; port: number; user?: string; pass?: string; from: string };
  webDistDir: string;
  ai: {
    apiKey?: string;
    baseUrl: string;
    defaultModel: string;
    /** Allowed models. Empty = any model the provider lists. */
    models: string[];
    monthlyTokenLimit: number;
    timeoutMs: number;
    maxRetries: number;
    retryBaseMs: number;
  };
  allowPrivateFetch: boolean;
  channels: {
    /** Decoded CHANNEL_SECRET_KEY (32 bytes) or undefined when not configured. */
    secretKey?: Buffer;
    evolution: { url?: string; key?: string };
    telegramApiBase: string;
    meta: { appId?: string; appSecret?: string; verifyToken?: string; graphBase: string; version: string };
  };
};

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\nSee .env.example`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    appUrl: e.APP_URL.replace(/\/+$/, ''),
    trustProxy: e.TRUST_PROXY ?? false,
    db: { owner: e.DATABASE_URL_OWNER, app: e.DATABASE_URL_APP, platform: e.DATABASE_URL_PLATFORM },
    testDatabaseName: e.TEST_DATABASE_NAME,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.SMTP_FROM },
    webDistDir: e.WEB_DIST_DIR ?? path.resolve(apiRoot, '..', 'web', 'dist'),
    ai: {
      apiKey: e.OPENROUTER_API_KEY,
      baseUrl: e.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
      defaultModel: e.OPENROUTER_DEFAULT_MODEL,
      models: (e.OPENROUTER_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean),
      monthlyTokenLimit: e.AI_MONTHLY_TOKEN_LIMIT,
      timeoutMs: e.AI_TIMEOUT_MS,
      maxRetries: e.AI_MAX_RETRIES,
      retryBaseMs: e.AI_RETRY_BASE_MS,
    },
    channels: {
      secretKey: e.CHANNEL_SECRET_KEY ? Buffer.from(e.CHANNEL_SECRET_KEY, 'base64') : undefined,
      evolution: { url: e.EVOLUTION_API_URL?.replace(/\/+$/, ''), key: e.EVOLUTION_API_KEY },
      telegramApiBase: e.TELEGRAM_API_BASE.replace(/\/+$/, ''),
      meta: { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, verifyToken: e.META_VERIFY_TOKEN, graphBase: e.META_GRAPH_BASE.replace(/\/+$/, ''), version: e.META_GRAPH_VERSION },
    },
    allowPrivateFetch: e.NODE_ENV !== 'production' && (e.ALLOW_PRIVATE_FETCH ?? false),
  };
}

/** Replace the database name in a postgres:// URL (used by tests to target the test database). */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
