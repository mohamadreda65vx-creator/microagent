import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, PASSWORD, createPlatformAdmin, createTestEnv, eventually, lastEmailTo, signupTenant, tokenFrom, uniqueEmail, type Tenant, type TestEnv } from './helpers.js';

/**
 * Tenant isolation through the real HTTP API.
 * Two independent businesses (A and B); every attempt by A to touch B's data must fail,
 * and B's data must be unchanged afterwards.
 */
describe('tenant isolation (API level)', () => {
  let env: TestEnv;
  let a: Tenant;
  let b: Tenant;
  let bEmployeeId: string;
  let bInviteId: string;
  let bMemberId: string;

  before(async () => {
    env = await createTestEnv();
    a = await signupTenant(env, 'Company A');
    b = await signupTenant(env, 'Company B');

    assert.equal((await a.client.post('/ai-employees', { name: 'A-Support', jobTitle: 'Support agent' })).status, 201);
    assert.equal((await a.client.post('/ai-employees', { name: 'A-Sales' })).status, 201);
    const created = await b.client.post('/ai-employees', { name: 'B-Secret', description: 'confidential to B' });
    bEmployeeId = created.body.id;

    const inv = await b.client.post('/team/invitations', { email: uniqueEmail('b-invite'), role: 'viewer' });
    bInviteId = inv.body.id;

    const memberEmail = uniqueEmail('b-member');
    await b.client.post('/team/invitations', { email: memberEmail, role: 'manager' });
    const accepted = await new Client(env.app).post('/auth/accept-invitation', {
      token: tokenFrom(await lastEmailTo(env, memberEmail)),
      fullName: 'B Member',
      password: PASSWORD,
    });
    bMemberId = accepted.body.user.id;
  });
  after(async () => {
    await env.close();
  });

  it('lists only the caller’s own AI employees', async () => {
    const listA = (await a.client.get('/ai-employees')).body.items as Array<{ name: string }>;
    const listB = (await b.client.get('/ai-employees')).body.items as Array<{ name: string }>;
    assert.deepEqual(listA.map((e) => e.name).sort(), ['A-Sales', 'A-Support']);
    assert.deepEqual(listB.map((e) => e.name), ['B-Secret']);
  });

  it('A cannot read, update or delete B’s AI employee (404, data unchanged)', async () => {
    assert.equal((await a.client.get(`/ai-employees/${bEmployeeId}`)).status, 404);
    assert.equal((await a.client.patch(`/ai-employees/${bEmployeeId}`, { name: 'HACKED', status: 'active' })).status, 404);
    assert.equal((await a.client.del(`/ai-employees/${bEmployeeId}`)).status, 404);
    const still = await b.client.get(`/ai-employees/${bEmployeeId}`);
    assert.equal(still.status, 200);
    assert.equal(still.body.name, 'B-Secret');
    assert.equal(still.body.status, 'draft');
  });

  it('team: A sees only its own members and invitations, and cannot touch B’s', async () => {
    const membersA = (await a.client.get('/team/members')).body.items as Array<{ id: string }>;
    assert.equal(membersA.length, 1);
    assert.ok(!membersA.some((m) => m.id === bMemberId));
    assert.equal((await a.client.get('/team/invitations')).body.items.length, 0);

    assert.equal((await a.client.patch(`/team/members/${bMemberId}`, { status: 'disabled' })).status, 404);
    assert.equal((await a.client.patch(`/team/members/${bMemberId}`, { role: 'admin' })).status, 404);
    assert.equal((await a.client.del(`/team/invitations/${bInviteId}`)).status, 404);

    const stillActive = await env.owner.query('SELECT status, role FROM users WHERE id = $1', [bMemberId]);
    assert.equal(stillActive.rows[0].status, 'active');
    assert.equal(stillActive.rows[0].role, 'manager');
    const memberLogin = await new Client(env.app).post('/auth/login', { email: (await env.owner.query('SELECT email FROM users WHERE id = $1', [bMemberId])).rows[0].email, password: PASSWORD });
    assert.equal(memberLogin.status, 200, 'B’s member can still log in');
  });

  it('workspace settings and overview are per tenant', async () => {
    assert.equal((await a.client.get('/tenant')).body.name, 'Company A');
    assert.equal((await b.client.get('/tenant')).body.name, 'Company B');
    assert.equal((await a.client.patch('/tenant', { name: 'Company A Renamed' })).status, 200);
    assert.equal((await b.client.get('/tenant')).body.name, 'Company B', 'renaming A does not affect B');
    await a.client.patch('/tenant', { name: 'Company A' });

    const ovA = (await a.client.get('/overview')).body;
    const ovB = (await b.client.get('/overview')).body;
    assert.equal(ovA.aiEmployees.total, 2);
    assert.equal(ovB.aiEmployees.total, 1);
    assert.equal(ovA.team.members, 1);
    assert.equal(ovB.team.members, 2);
  });

  it('a body that tries to smuggle another tenant id is ignored', async () => {
    const res = await a.client.post('/ai-employees', { name: 'Smuggler', tenantId: b.tenantId, tenant_id: b.tenantId });
    assert.equal(res.status, 201);
    const { rows } = await env.owner.query('SELECT tenant_id FROM ai_employees WHERE id = $1', [res.body.id]);
    assert.equal(rows[0].tenant_id, a.tenantId);
  });

  it('IDs from a different tenant never leak through error messages', async () => {
    const res = await a.client.get(`/ai-employees/${bEmployeeId}`);
    assert.ok(!JSON.stringify(res.body).includes('B-Secret'));
    assert.ok(!JSON.stringify(res.body).includes(b.tenantId));
  });

  it('tenant users cannot reach platform admin routes', async () => {
    for (const url of ['/platform/summary', '/platform/tenants', `/platform/tenants/${b.tenantId}`]) {
      assert.equal((await a.client.get(url)).status, 403, url);
    }
    assert.equal((await a.client.patch(`/platform/tenants/${b.tenantId}`, { status: 'suspended' })).status, 403);
    const stillActive = await env.owner.query('SELECT status FROM tenants WHERE id = $1', [b.tenantId]);
    assert.equal(stillActive.rows[0].status, 'active');
  });
});

describe('platform admin', () => {
  let env: TestEnv;
  let admin: Client;
  let a: Tenant;
  let b: Tenant;

  before(async () => {
    env = await createTestEnv();
    admin = await createPlatformAdmin(env);
    a = await signupTenant(env, 'Alpha Ltd');
    b = await signupTenant(env, 'Beta Inc');
    await a.client.post('/ai-employees', { name: 'Alpha Bot 1' });
    await a.client.post('/ai-employees', { name: 'Alpha Bot 2' });
    await b.client.post('/ai-employees', { name: 'Beta Bot' });
  });
  after(async () => {
    await env.close();
  });

  it('sees every company with its users, AI employees and usage', async () => {
    const summary = (await admin.get('/platform/summary')).body;
    assert.equal(summary.companies, 2);
    assert.equal(summary.users, 2);
    assert.equal(summary.aiEmployees, 3);

    const list = await admin.get('/platform/tenants');
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 2);
    const alpha = list.body.items.find((t: { name: string }) => t.name === 'Alpha Ltd');
    assert.equal(alpha.aiEmployeesCount, 2);
    assert.equal(alpha.usersCount, 1);
    await eventually(async () => {
      const again = (await admin.get('/platform/tenants')).body.items.find((t: { name: string }) => t.name === 'Alpha Ltd');
      return again.apiRequestsMonth >= 2;
    });
    assert.equal((await admin.get('/platform/tenants?search=beta')).body.total, 1);
    assert.equal((await admin.get('/platform/tenants?status=suspended')).body.total, 0);
  });

  it('platform admin has no access to tenant business data routes', async () => {
    assert.equal((await admin.get('/ai-employees')).status, 403);
    assert.equal((await admin.get('/team/members')).status, 403);
    assert.equal((await admin.get('/overview')).status, 403);
    assert.equal((await admin.post('/ai-employees', { name: 'x' })).status, 403);
  });

  it('suspending a company blocks it immediately (sessions + login); others are unaffected; reactivation restores', async () => {
    assert.equal((await a.client.get('/ai-employees')).status, 200);
    const suspended = await admin.patch(`/platform/tenants/${a.tenantId}`, { status: 'suspended' });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.status, 'suspended');

    const blocked = await a.client.get('/ai-employees');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'tenant_suspended');
    const login = await new Client(env.app).post('/auth/login', { email: a.email, password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'tenant_suspended');
    assert.equal((await b.client.get('/ai-employees')).status, 200, 'Beta is unaffected');

    assert.equal((await admin.patch(`/platform/tenants/${a.tenantId}`, { status: 'active' })).status, 200);
    assert.equal((await a.client.get('/ai-employees')).status, 200);

    const audit = await env.owner.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'tenant.%' ORDER BY id`, [a.tenantId]);
    assert.deepEqual(audit.rows.map((r) => r.action), ['tenant.created', 'tenant.suspended', 'tenant.activated']);
  });

  it('404 for an unknown company id and validation for bad ids', async () => {
    assert.equal((await admin.patch('/platform/tenants/00000000-0000-4000-8000-000000000000', { status: 'suspended' })).status, 404);
    assert.equal((await admin.get('/platform/tenants/not-a-uuid')).status, 400);
  });
});
