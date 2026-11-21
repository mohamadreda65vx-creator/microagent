import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig, withDatabase, type Config } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';
import { hashPassword } from '../src/shared/security.js';

export const PASSWORD = 'Correct-horse-battery-1';

export interface TestEnv {
  app: FastifyInstance;
  config: Config;
  /** Owner connection: ONLY for test setup/inspection. Bypasses RLS like a DBA would. */
  owner: pg.Pool;
  close(): Promise<void>;
}

export function testConfig(): Config {
  const base = loadConfig();
  const db = base.testDatabaseName;
  return {
    ...base,
    nodeEnv: 'test',
    appUrl: 'http://localhost:5173',
    db: { owner: withDatabase(base.db.owner, db), app: withDatabase(base.db.app, db), platform: withDatabase(base.db.platform, db) },
  };
}

export async function createTestEnv(opts: { rateLimit?: boolean } = {}): Promise<TestEnv> {
  const config = testConfig();
  await runMigrations(config.db.owner, () => {});
  const owner = new pg.Pool({ connectionString: config.db.owner, max: 2 });
  await owner.query('TRUNCATE tenants, users, email_outbox, audit_logs RESTART IDENTITY CASCADE');
  const app = await buildApp({ config, logger: false, rateLimit: opts.rateLimit ?? false });
  await app.ready();
  return {
    app,
    config,
    owner,
    async close() {
      await app.close();
      await owner.end();
    },
  };
}

export const uniqueEmail = (prefix = 'user') => `${prefix}-${randomBytes(4).toString('hex')}@example.test`;

export interface Res<T = any> {
  status: number;
  body: T;
}

/** Tiny HTTP client with a cookie jar, talking to the app through inject (no network port). */
export class Client {
  cookie: string | undefined;
  constructor(private app: FastifyInstance) {}

  async request<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const res = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      payload: body === undefined ? undefined : (body as object),
      headers: { ...(this.cookie ? { cookie: `ma_session=${this.cookie}` } : {}), ...headers },
    });
    const set = res.cookies.find((c) => c.name === 'ma_session');
    if (set) this.cookie = set.value === '' ? undefined : set.value;
    return { status: res.statusCode, body: (res.body ? safeJson(res.body) : undefined) as T };
  }
  get = <T = any>(url: string) => this.request<T>('GET', url);
  post = <T = any>(url: string, body?: unknown, headers?: Record<string, string>) => this.request<T>('POST', url, body ?? {}, headers);
  patch = <T = any>(url: string, body: unknown) => this.request<T>('PATCH', url, body);
  del = <T = any>(url: string) => this.request<T>('DELETE', url);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface Tenant {
  client: Client;
  email: string;
  tenantId: string;
  userId: string;
  businessName: string;
}

/** Sign up a brand-new business through the real endpoint. */
export async function signupTenant(env: TestEnv, businessName: string): Promise<Tenant> {
  const client = new Client(env.app);
  const email = uniqueEmail('owner');
  const res = await client.post('/auth/signup', { businessName, fullName: `Owner of ${businessName}`, email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client, email, tenantId: res.body.tenant.id, userId: res.body.user.id, businessName };
}

export async function createPlatformAdmin(env: TestEnv): Promise<Client> {
  const email = uniqueEmail('admin');
  await env.owner.query(`INSERT INTO users (tenant_id, email, password_hash, full_name, role) VALUES (NULL, $1, $2, 'Platform Admin', 'platform_admin')`, [
    email,
    await hashPassword(PASSWORD),
  ]);
  const client = new Client(env.app);
  const res = await client.post('/auth/login', { email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  return client;
}

/** Wait for an async side effect (email outbox, usage metering) to appear. */
export async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('eventually: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function lastEmailTo(env: TestEnv, to: string): Promise<string> {
  return eventually(async () => {
    const { rows } = await env.owner.query<{ body: string }>('SELECT body FROM email_outbox WHERE to_email = $1 ORDER BY id DESC LIMIT 1', [to]);
    return rows[0]?.body;
  });
}

export function tokenFrom(emailBody: string): string {
  const m = emailBody.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('no token in email');
  return m[1]!;
}
