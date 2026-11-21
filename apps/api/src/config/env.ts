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
  };
}

/** Replace the database name in a postgres:// URL (used by tests to target the test database). */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
