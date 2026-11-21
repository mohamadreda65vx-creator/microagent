import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, PASSWORD, createTestEnv, eventually, lastEmailTo, signupTenant, tokenFrom, uniqueEmail, type TestEnv } from './helpers.js';

describe('authentication', () => {
  let env: TestEnv;
  before(async () => {
    env = await createTestEnv();
  });
  after(async () => {
    await env.close();
  });

  it('signup creates a business + owner, sets an httpOnly session cookie and logs in', async () => {
    const client = new Client(env.app);
    const email = uniqueEmail();
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { businessName: 'Pixology Agency', fullName: 'Reda', email, password: PASSWORD },
    });
    assert.equal(res.statusCode, 201);
    const cookie = res.cookies.find((c) => c.name === 'ma_session');
    assert.ok(cookie, 'session cookie is set');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Lax');
    const body = res.json();
    assert.equal(body.user.role, 'owner');
    assert.equal(body.tenant.name, 'Pixology Agency');
    assert.ok(!('passwordHash' in body.user) && !JSON.stringify(body).includes('scrypt'), 'no password data in response');
    client.cookie = cookie.value;
    const me = await client.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, email);
  });

  it('works with a business name that has no latin letters (Arabic)', async () => {
    const t = await signupTenant(env, 'بيكسولوجي');
    const { rows } = await env.owner.query('SELECT slug FROM tenants WHERE id = $1', [t.tenantId]);
    assert.match(rows[0].slug, /^workspace-[0-9a-f]{6}$/);
  });

  it('rejects duplicate emails (409) and weak passwords (400)', async () => {
    const t = await signupTenant(env, 'Dup Co');
    const dup = await new Client(env.app).post('/auth/signup', { businessName: 'Other', fullName: 'X', email: t.email.toUpperCase(), password: PASSWORD });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'email_taken');
    const weak = await new Client(env.app).post('/auth/signup', { businessName: 'Weak', fullName: 'X', email: uniqueEmail(), password: 'short' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'validation_error');
  });

  it('login: correct password works, wrong password and unknown email give the same generic error', async () => {
    const t = await signupTenant(env, 'Login Co');
    const ok = await new Client(env.app).post('/auth/login', { email: t.email, password: PASSWORD });
    assert.equal(ok.status, 200);
    const wrong = await new Client(env.app).post('/auth/login', { email: t.email, password: 'Wrong-password-123' });
    const unknown = await new Client(env.app).post('/auth/login', { email: uniqueEmail('nobody'), password: 'Wrong-password-123' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  it('protected routes require a session', async () => {
    const anon = new Client(env.app);
    for (const url of ['/auth/me', '/overview', '/ai-employees', '/team/members', '/tenant', '/platform/summary']) {
      const r = await anon.get(url);
      assert.equal(r.status, 401, `${url} must be 401 without a session`);
    }
    anon.cookie = 'not-a-real-token';
    assert.equal((await anon.get('/auth/me')).status, 401);
  });

  it('logout revokes the session on the server (the old cookie stops working)', async () => {
    const t = await signupTenant(env, 'Logout Co');
    const stolen = t.client.cookie!;
    assert.equal((await t.client.get('/auth/me')).status, 200);
    assert.equal((await t.client.post('/auth/logout')).status, 204);
    assert.equal(t.client.cookie, undefined);
    const replay = new Client(env.app);
    replay.cookie = stolen;
    assert.equal((await replay.get('/auth/me')).status, 401);
  });

  it('password reset: generic response, one-time token, signs out other sessions', async () => {
    const t = await signupTenant(env, 'Reset Co');
    const other = new Client(env.app);
    assert.equal((await other.post('/auth/login', { email: t.email, password: PASSWORD })).status, 200);

    // Unknown email: identical response, and no email is queued.
    const unknownEmail = uniqueEmail('ghost');
    const ghost = await new Client(env.app).post('/auth/forgot-password', { email: unknownEmail });
    const real = await new Client(env.app).post('/auth/forgot-password', { email: t.email });
    assert.equal(ghost.status, 200);
    assert.deepEqual(ghost.body, real.body);
    await new Promise((r) => setTimeout(r, 200));
    const ghostMail = await env.owner.query('SELECT 1 FROM email_outbox WHERE to_email = $1', [unknownEmail]);
    assert.equal(ghostMail.rowCount, 0);

    const token = tokenFrom(await lastEmailTo(env, t.email));
    const newPassword = 'Brand-new-password-9';
    const reset = await new Client(env.app).post('/auth/reset-password', { token, password: newPassword });
    assert.equal(reset.status, 200);

    assert.equal((await new Client(env.app).post('/auth/reset-password', { token, password: 'Another-password-77' })).status, 400, 'token is single-use');
    assert.equal((await new Client(env.app).post('/auth/login', { email: t.email, password: PASSWORD })).status, 401, 'old password no longer works');
    assert.equal((await new Client(env.app).post('/auth/login', { email: t.email, password: newPassword })).status, 200);
    assert.equal((await other.get('/auth/me')).status, 401, 'existing sessions were revoked');
    assert.equal((await new Client(env.app).post('/auth/reset-password', { token: 'x'.repeat(43), password: newPassword })).status, 400);
  });

  it('blocks state-changing requests coming from another origin', async () => {
    const t = await signupTenant(env, 'Origin Co');
    const evil = await t.client.post('/ai-employees', { name: 'Evil' }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'bad_origin');
    const good = await t.client.post('/ai-employees', { name: 'Good' }, { origin: 'http://localhost:5173' });
    assert.equal(good.status, 201);
  });

  it('team invitation flow + RBAC inside a tenant', async () => {
    const owner = await signupTenant(env, 'Team Co');
    const viewerEmail = uniqueEmail('viewer');
    const inv = await owner.client.post('/team/invitations', { email: viewerEmail, role: 'viewer' });
    assert.equal(inv.status, 201);
    assert.equal((await owner.client.post('/team/invitations', { email: viewerEmail, role: 'viewer' })).status, 409, 'duplicate pending invite');

    const token = tokenFrom(await lastEmailTo(env, viewerEmail));
    const peek = await new Client(env.app).get(`/auth/invitations/${token}`);
    assert.equal(peek.status, 200);
    assert.equal(peek.body.businessName, 'Team Co');

    const viewer = new Client(env.app);
    const accepted = await viewer.post('/auth/accept-invitation', { token, fullName: 'View Er', password: PASSWORD });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.user.role, 'viewer');
    assert.equal((await new Client(env.app).post('/auth/accept-invitation', { token, fullName: 'Again', password: PASSWORD })).status, 400, 'invite is single-use');

    // Viewer: can read, cannot write or manage.
    assert.equal((await viewer.get('/ai-employees')).status, 200);
    assert.equal((await viewer.post('/ai-employees', { name: 'Nope' })).status, 403);
    assert.equal((await viewer.post('/team/invitations', { email: uniqueEmail(), role: 'viewer' })).status, 403);
    assert.equal((await viewer.patch('/tenant', { name: 'Hijacked' })).status, 403);

    // Owner cannot be demoted/disabled, nobody can self-change, admin cannot manage admin.
    const members = (await owner.client.get('/team/members')).body.items as Array<{ id: string; role: string }>;
    assert.equal(members.length, 2);
    assert.equal((await owner.client.patch(`/team/members/${owner.userId}`, { role: 'viewer' })).status, 403);
    const viewerId = members.find((m) => m.role === 'viewer')!.id;
    const promote = await owner.client.patch(`/team/members/${viewerId}`, { role: 'manager' });
    assert.equal(promote.status, 200);
    assert.equal((await viewer.post('/ai-employees', { name: 'Now allowed' })).status, 201, 'manager can create AI employees');

    // A privilege-escalation attempt: manager tries to make themselves admin.
    assert.equal((await viewer.patch(`/team/members/${viewerId}`, { role: 'admin' })).status, 403);
  });

  it('disabling a member kills their sessions and blocks login', async () => {
    const owner = await signupTenant(env, 'Disable Co');
    const email = uniqueEmail('member');
    await owner.client.post('/team/invitations', { email, role: 'manager' });
    const token = tokenFrom(await lastEmailTo(env, email));
    const member = new Client(env.app);
    const res = await member.post('/auth/accept-invitation', { token, fullName: 'Mem Ber', password: PASSWORD });
    assert.equal((await member.get('/auth/me')).status, 200);

    assert.equal((await owner.client.patch(`/team/members/${res.body.user.id}`, { status: 'disabled' })).status, 200);
    assert.equal((await member.get('/auth/me')).status, 401);
    const login = await new Client(env.app).post('/auth/login', { email, password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'account_disabled');
  });

  it('records API usage per tenant', async () => {
    const t = await signupTenant(env, 'Usage Co');
    for (let i = 0; i < 3; i++) await t.client.get('/ai-employees');
    const total = await eventually(async () => {
      const { rows } = await env.owner.query(`SELECT quantity FROM usage_daily WHERE tenant_id = $1 AND metric = 'api_requests'`, [t.tenantId]);
      return rows[0] && rows[0].quantity >= 3 ? rows[0].quantity : false;
    });
    assert.ok(total >= 3);
  });
});

describe('rate limiting', () => {
  let env: TestEnv;
  before(async () => {
    env = await createTestEnv({ rateLimit: true });
  });
  after(async () => {
    await env.close();
  });

  it('throttles repeated login attempts', async () => {
    const client = new Client(env.app);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await client.post('/auth/login', { email: uniqueEmail('brute'), password: 'Wrong-password-123' })).status);
    assert.ok(statuses.slice(0, 10).every((s) => s === 401));
    assert.ok(statuses.slice(10).every((s) => s === 429), `expected 429 after 10 attempts, got ${statuses.join(',')}`);
  });
});
