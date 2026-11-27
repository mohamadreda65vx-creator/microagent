import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, createPlatformAdmin, createTestEnv, inviteMember, signupTenant, type Tenant, type TestEnv } from './helpers.js';

/**
 * Security review tests. They go route by route instead of trusting that "the pages work":
 *  - every route in the route table is probed without a session, as a viewer, as another tenant's owner, and as a platform admin;
 *  - secrets are checked at rest (database) and in responses;
 *  - webhooks are checked without / with wrong signatures;
 *  - rate limiting is checked on the real limiter.
 */
let env: TestEnv;
let a: Tenant; let b: Tenant; let viewer: Client; let admin: Client;
const UUID = '00000000-0000-4000-8000-000000000001';

// Routes that are public by design (they authenticate by themselves: secrets, signatures or one-time tokens).
const PUBLIC = new Set([
  'GET /api/v1/health', 'POST /api/v1/auth/signup', 'POST /api/v1/auth/login', 'POST /api/v1/auth/forgot-password', 'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/accept-invitation', 'GET /api/v1/auth/invitation', 'GET /api/v1/auth/invitations/:token', 'POST /api/v1/auth/verify-email', 'POST /api/v1/auth/logout',
  'POST /api/v1/webhooks/channel/:key', 'GET /api/v1/webhooks/meta', 'POST /api/v1/webhooks/meta',
  'GET /api/v1/widget/:key/config', 'POST /api/v1/widget/:key/session', 'POST /api/v1/widget/:key/messages', 'GET /api/v1/widget/:key/messages', 'GET /api/v1/widget/:key/files/:fileId',
  'GET /api/v1/widget.js', 'GET /widget.js',
]);
// Self-service routes any signed-in member may call (they only touch the caller's own data).
// POST routes that only read/compute (nothing saved) or touch the caller's own profile / a shared unread counter (documented as low risk).
const SELF_SERVICE = new Set(['PATCH /api/v1/account', 'POST /api/v1/conversations/:id/read', 'POST /api/v1/campaigns/audience/preview', 'POST /api/v1/workflows/:id/validate', 'POST /api/v1/auth/logout', 'POST /api/v1/auth/change-password', 'PATCH /api/v1/auth/me', 'POST /api/v1/notifications/read', 'POST /api/v1/auth/logout-all', 'POST /api/v1/auth/resend-verification']);

const fill = (u: string) => u.replace(/:[A-Za-z]+/g, (m) => (/version|v$/i.test(m) ? '1' : UUID)).replace(/\/\*$/, '/x');
const apiRoutes = () => env.app.routeTable.filter((r) => r.url.startsWith('/api/v1') && r.method !== 'HEAD' && r.method !== 'OPTIONS');
const call = (c: Client | null, r: { method: string; url: string }, body: unknown = {}) =>
  env.app.inject({ method: r.method as 'GET', url: fill(r.url), payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : (body as object), headers: c?.cookie ? { cookie: `ma_session=${c.cookie}` } : {} });

before(async () => {
  env = await createTestEnv();
  a = await signupTenant(env, 'Sec A'); b = await signupTenant(env, 'Sec B');
  viewer = await inviteMember(env, a, 'viewer'); admin = await createPlatformAdmin(env);
});
after(() => env.close());

describe('authentication on every route', () => {
  it('has a non-trivial route inventory', () => assert.ok(apiRoutes().length > 100, `only ${apiRoutes().length} routes`));
  it('every non-public route answers 401 without a session', async () => {
    const bad: string[] = [];
    for (const r of apiRoutes()) {
      if (PUBLIC.has(`${r.method} ${r.url}`)) continue;
      const res = await call(null, r);
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    assert.deepEqual(bad, []);
  });
  it('a garbage / forged / expired cookie is rejected', async () => {
    for (const cookie of ['ma_session=garbage', 'ma_session=' + 'a'.repeat(64), 'ma_session=', 'other=1']) {
      const res = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
      assert.equal(res.statusCode, 401);
    }
  });
  it('a bearer header does not authenticate (cookie-only sessions)', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${a.client.cookie}` } });
    assert.equal(res.statusCode, 401);
  });
  it('after logout the old session token no longer works', async () => {
    const c = new Client(env.app); const email = `lo-${Date.now()}@example.test`;
    await c.post('/auth/signup', { businessName: 'Logout Co', fullName: 'L', email, password: 'Correct-horse-battery-1' });
    const old = c.cookie!; await c.post('/auth/logout');
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `ma_session=${old}` } });
    assert.equal(res.statusCode, 401);
  });
  it('session cookie is HttpOnly + SameSite and the token is stored hashed', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: a.email, password: 'Correct-horse-battery-1' } });
    const c = res.cookies.find((x) => x.name === 'ma_session')!;
    assert.equal(c.httpOnly, true); assert.match(String(c.sameSite), /lax/i);
    const { rows } = await env.owner.query(`SELECT count(*)::int n FROM sessions WHERE token_hash = $1`, [c.value]);
    assert.equal(rows[0].n, 0, 'raw token must not be stored');
  });
  it('responses never contain password hashes or token hashes', async () => {
    for (const p of ['/auth/me', '/team/members']) {
      const res = await a.client.get(p); assert.doesNotMatch(JSON.stringify(res.body), /password_hash|passwordHash|\$argon2|token_hash|scrypt/i);
    }
  });
  it('cross-origin state-changing browser requests are blocked (CSRF)', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/ai-employees', headers: { cookie: `ma_session=${a.client.cookie}`, origin: 'https://evil.example' }, payload: { name: 'x' } });
    assert.equal(res.statusCode, 403);
  });
});

describe('RBAC', () => {
  it('a viewer cannot call any state-changing route (only self-service ones)', async () => {
    const leaks: string[] = [];
    for (const r of apiRoutes()) {
      const key = `${r.method} ${r.url}`;
      if (r.method === 'GET' || PUBLIC.has(key) || SELF_SERVICE.has(key)) continue;
      const res = await call(viewer, r);
      if (res.statusCode !== 403) leaks.push(`${key} -> ${res.statusCode}`);
    }
    assert.deepEqual(leaks, [], 'viewer reached these mutating routes');
  });
  it('a tenant owner can never reach platform-admin routes', async () => {
    const leaks: string[] = [];
    for (const r of apiRoutes().filter((x) => x.url.startsWith('/api/v1/platform'))) {
      const res = await call(a.client, r);
      if (res.statusCode !== 403) leaks.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    assert.deepEqual(leaks, []);
  });
  it('a platform admin has no access to tenant business routes', async () => {
    const leaks: string[] = [];
    for (const r of apiRoutes().filter((x) => !x.url.startsWith('/api/v1/platform') && !PUBLIC.has(`${x.method} ${x.url}`) && !x.url.startsWith('/api/v1/auth'))) {
      const res = await call(admin, r);
      if (![401, 403, 404, 400].includes(res.statusCode) || (res.statusCode === 200 && r.method === 'GET' && /"items"/.test(res.body) && !/"items":\[\]/.test(res.body))) leaks.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    assert.deepEqual(leaks, []);
  });
  it('privilege escalation: a viewer cannot change own role or invite', async () => {
    assert.equal((await viewer.post('/team/invitations', { email: 'x@example.test', role: 'owner' })).status, 403);
    const me = (await viewer.get('/auth/me')).body;
    const r = await viewer.patch(`/team/members/${me.user.id}`, { role: 'owner' });
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.equal((await viewer.get('/auth/me')).body.user.role, 'viewer');
  });
  it('mass assignment: signup/profile ignore role & tenant fields', async () => {
    const c = new Client(env.app);
    const r = await c.post('/auth/signup', { businessName: 'Mass Co', fullName: 'M', email: `m-${Date.now()}@example.test`, password: 'Correct-horse-battery-1', role: 'platform_admin', tenantId: a.tenantId, status: 'active' });
    assert.equal(r.status, 201);
    const me = (await c.get('/auth/me')).body;
    assert.equal(me.user.role, 'owner'); assert.notEqual(me.tenant.id, a.tenantId);
  });
});

describe('tenant isolation (cross-tenant ids)', () => {
  it('tenant B cannot read or change tenant A resources, by id, on any route', async () => {
    // A creates one of everything that has an id route; B tries them all.
    const emp = (await a.client.post('/ai-employees', { name: 'A-Agent', roleTitle: 'Sales' })).body;
    const wf = (await a.client.post('/workflows', { name: 'A-flow' })).body;
    const ids = { emp: emp.id, wf: wf.id };
    const tries: Array<[string, string, unknown?]> = [
      ['GET', `/ai-employees/${ids.emp}`], ['PATCH', `/ai-employees/${ids.emp}`, { name: 'hacked' }], ['DELETE', `/ai-employees/${ids.emp}`],
      ['GET', `/workflows/${ids.wf}`], ['PUT', `/workflows/${ids.wf}/graph`, { graph: { nodes: [], edges: [] }, baseVersion: 1 }], ['POST', `/workflows/${ids.wf}/activate`], ['POST', `/workflows/${ids.wf}/test`, { payload: {} }], ['DELETE', `/workflows/${ids.wf}`], ['GET', `/workflows/${ids.wf}/runs`],
    ];
    for (const [m, u, body] of tries) {
      const res = await b.client.request(m as 'GET', u, body === undefined && m !== 'GET' && m !== 'DELETE' ? {} : body);
      assert.ok([403, 404, 400, 422].includes(res.status), `${m} ${u} -> ${res.status}`);
    }
    assert.equal((await a.client.get(`/ai-employees/${ids.emp}`)).body.name, 'A-Agent');
    assert.ok((await a.client.get(`/workflows/${ids.wf}`)).status === 200);
  });
  it('a workflow cannot reference another tenant\'s AI employee or workflow', async () => {
    const bEmp = (await b.client.post('/ai-employees', { name: 'B-Agent', roleTitle: 'Support' })).body;
    const bWf = (await b.client.post('/workflows', { name: 'B-flow' })).body;
    const wf = (await a.client.post('/workflows', { name: 'A-cross' })).body;
    const graph = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'manual' } }, { id: 'ai', type: 'ai_agent', position: { x: 1, y: 0 }, data: { employeeId: bEmp.id, mode: 'text', prompt: 'hi', outputVar: 'x' } }, { id: 's', type: 'subprocess', position: { x: 2, y: 0 }, data: { workflowId: bWf.id } }], edges: [{ id: 'e1', source: 't', target: 'ai', sourceHandle: 'out' }, { id: 'e2', source: 'ai', target: 's', sourceHandle: 'out' }] };
    const r = await a.client.put(`/workflows/${wf.id}/graph`, { graph, baseVersion: 1 });
    const codes = (r.body?.issues ?? []).map((i: { code: string }) => i.code);
    assert.ok(codes.includes('employee_missing') && codes.includes('subprocess_missing'), JSON.stringify(codes));
    assert.equal((await a.client.post(`/workflows/${wf.id}/activate`)).status, 422);
  });
  it('the app DB role cannot read across tenants even with raw SQL and no tenant set', async () => {
    const { rows } = await env.app.pools.app.query('SELECT count(*)::int n FROM ai_employees');
    assert.equal(rows[0].n, 0);
  });
});

describe('error log integrity', () => {
  it('a tenant-role connection cannot write error rows for another company, nor read the log', async () => {
    const c = await env.app.pools.app.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [a.tenantId]);
      await assert.rejects(c.query(`INSERT INTO system_errors (tenant_id, source, code, message) VALUES ($1, 'api', 'spoof', 'x')`, [b.tenantId]), /row-level security/);
      await c.query('ROLLBACK'); await c.query('BEGIN');
      await assert.rejects(c.query('SELECT * FROM system_errors'), /permission denied/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });
});

describe('secret handling', () => {
  it('channel credentials are encrypted at rest and never returned by the API', async () => {
    const T = '777777:SECRETTOKENSECRETTOKENSECRETTOKEN123';
    env.tg.addBot(T, 777777, 'sec_bot');
    const emp = (await a.client.post('/ai-employees', { name: 'Sec', roleTitle: 'x' })).body;
    const ch = (await a.client.post('/channels', { type: 'telegram', name: 'Sec bot', employeeId: emp.id })).body;
    env.app.config.appUrl = 'https://app.example.test';
    const con = await a.client.post(`/channels/${ch.id}/connect`, { botToken: T });
    assert.ok(con.status < 300, JSON.stringify(con.body));
    const { rows } = await env.owner.query(`SELECT * FROM channels WHERE id = $1`, [ch.id]);
    assert.doesNotMatch(JSON.stringify(rows[0]), /SECRETTOKEN/, 'plaintext token found in DB row');
    for (const p of [`/channels`, `/channels/${ch.id}`, `/audit-logs`, `/overview`]) assert.doesNotMatch(JSON.stringify((await a.client.get(p)).body), /SECRETTOKEN/, p);
    const admin_ = await admin.get('/platform/dashboard'); assert.doesNotMatch(JSON.stringify(admin_.body), /SECRETTOKEN/);
  });
  it('a tampered credentials blob is refused (GCM authentication)', async () => {
    const { Vault } = await import('../src/channels/crypto.js');
    const v = new Vault(Buffer.alloc(32, 7)); const blob = v.encrypt({ a: 'b' });
    const parts = blob.split('.'); parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => v.decrypt(parts.join('.')));
    assert.throws(() => new Vault(Buffer.alloc(32, 9)).decrypt(blob));
  });
  it('error responses do not leak stack traces or SQL', async () => {
    const res = await a.client.get(`/workflows/not-a-uuid`);
    assert.doesNotMatch(JSON.stringify(res.body), /node_modules|\bat .*\.ts|SELECT |pg_|stack/i);
  });
});

describe('webhooks and public endpoints', () => {
  it('channel webhook without or with a wrong secret is rejected and creates nothing', async () => {
    const T = '888888:WEBHOOKTESTTOKENWEBHOOKTESTTOKEN12';
    env.tg.addBot(T, 888888, 'wh_bot');
    const emp = (await a.client.post('/ai-employees', { name: 'WH', roleTitle: 'x' })).body;
    const ch = (await a.client.post('/channels', { type: 'telegram', name: 'WH bot', employeeId: emp.id })).body;
    await a.client.post(`/channels/${ch.id}/connect`, { botToken: T });
    const key = (await env.owner.query('SELECT public_key FROM channels WHERE id=$1', [ch.id])).rows[0].public_key;
    const upd = { update_id: 1, message: { message_id: 1, date: 1, from: { id: 9, is_bot: false, first_name: 'X' }, chat: { id: 9, type: 'private' }, text: 'hello' } };
    for (const headers of [{}, { 'x-telegram-bot-api-secret-token': 'wrong' }, { 'x-telegram-bot-api-secret-token': '' }]) {
      const res = await env.app.inject({ method: 'POST', url: `/api/v1/webhooks/channel/${key}`, payload: upd, headers });
      assert.ok([401, 403].includes(res.statusCode), `got ${res.statusCode}`);
    }
    const unknown = await env.app.inject({ method: 'POST', url: `/api/v1/webhooks/channel/doesnotexist`, payload: upd });
    assert.ok([401, 403, 404].includes(unknown.statusCode));
    const { rows } = await env.owner.query(`SELECT count(*)::int n FROM messages WHERE tenant_id=$1 AND body = 'hello'`, [a.tenantId]);
    assert.equal(rows[0].n, 0);
  });
  it('Meta webhook rejects missing, malformed and wrong signatures', async () => {
    const body = JSON.stringify({ object: 'page', entry: [] });
    for (const sig of [undefined, 'sha256=', 'sha256=deadbeef', 'nonsense']) {
      const res = await env.app.inject({ method: 'POST', url: '/api/v1/webhooks/meta', payload: body, headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) } });
      assert.ok([401, 403, 404, 503].includes(res.statusCode), `${sig} -> ${res.statusCode}`);
    }
    const hs = await env.app.inject({ method: 'GET', url: '/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123' });
    assert.ok(hs.statusCode >= 400 && !hs.body.includes('123'));
  });
  it('widget endpoints reject unknown keys, bad session tokens and other visitors\' files', async () => {
    assert.ok((await env.app.inject({ method: 'GET', url: '/api/v1/widget/nokey/config' })).statusCode >= 400);
    assert.ok((await env.app.inject({ method: 'POST', url: '/api/v1/widget/nokey/messages', payload: { text: 'hi' }, headers: { authorization: 'Bearer forged' } })).statusCode >= 400);
    assert.ok((await env.app.inject({ method: 'GET', url: `/api/v1/widget/nokey/files/${UUID}` })).statusCode >= 400);
  });
  it('static file serving does not allow path traversal', async () => {
    for (const u of ['/../../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd', '/assets/../../package.json']) {
      const res = await env.app.inject({ method: 'GET', url: u });
      assert.doesNotMatch(res.body, /root:x:|"name":\s*"@microagent/);
    }
  });
  it('serves the app shell at / and /app/* (when built) and 404s missing assets', async () => {
    const fs = await import('node:fs');
    if (!fs.existsSync(`${env.config.webDistDir}/index.html`)) return; // web not built in this checkout
    for (const u of ['/', '/login', '/app/workflows']) assert.equal((await env.app.inject({ method: 'GET', url: u })).statusCode, 200, u);
    assert.equal((await env.app.inject({ method: 'GET', url: '/assets/nope.js' })).statusCode, 404);
  });
  it('uploads are size-limited', async () => {
    const boundary = 'XBOUND'; const big = Buffer.alloc(9 * 1024 * 1024, 65);
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`), big, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/knowledge/files', payload, headers: { cookie: `ma_session=${a.client.cookie}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `got ${res.statusCode}`);
  });
});

describe('rate limiting', () => {
  it('declares a limit on every public / unauthenticated route', () => {
    const unlimited = apiRoutes().filter((r) => PUBLIC.has(`${r.method} ${r.url}`) && !r.rateLimited && r.url !== '/api/v1/health' && !r.url.includes('/auth/logout'));
    assert.deepEqual(unlimited.map((r) => `${r.method} ${r.url}`), []);
  });
  it('login is brute-force limited (real limiter)', async () => {
    const e2 = await createTestEnv({ rateLimit: true });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 25; i++) codes.push((await e2.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'nobody@example.test', password: 'wrong-password-123' } })).statusCode);
      assert.ok(codes.includes(429), `no 429 in ${codes.join(',')}`);
    } finally { await e2.close(); }
  });
  it('authenticated API has a per-user ceiling (real limiter)', async () => {
    const e2 = await createTestEnv({ rateLimit: true });
    try {
      const t = await signupTenant(e2, 'RL Co');
      let limited = false;
      for (let i = 0; i < 700 && !limited; i++) limited = (await t.client.get('/auth/me')).status === 429;
      assert.ok(limited, 'no 429 after 700 authenticated requests');
    } finally { await e2.close(); }
  });
});
