import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { effectiveLimits, PLAN_LIMITS } from '../src/shared/plans.js';
import { Client, createPlatformAdmin, createTestEnv, signupTenant, type TestEnv, type Tenant } from './helpers.js';

let env: TestEnv;
let admin: Client;
let a: Tenant;
let b: Tenant;

describe('Plan limits (pure)', () => {
  it('plan defaults, per-company overrides, bad overrides ignored', () => {
    assert.deepEqual(effectiveLimits('trial', {}), PLAN_LIMITS.trial);
    assert.equal(effectiveLimits('growth', { maxChannels: 3 }).maxChannels, 3);
    assert.equal(effectiveLimits('growth', { maxChannels: 3 }).maxAiEmployees, PLAN_LIMITS.growth.maxAiEmployees);
    assert.equal(effectiveLimits('growth', { maxChannels: -1, maxAiEmployees: 'lots' }).maxChannels, PLAN_LIMITS.growth.maxChannels);
    assert.equal(effectiveLimits('unknown-plan', null).maxChannels, PLAN_LIMITS.trial.maxChannels);
    assert.equal(effectiveLimits('scale', { maxAiEmployees: 0 }).maxAiEmployees, 0, 'zero is a valid limit');
  });
});

describe('Super Admin dashboard, subscriptions and limits', () => {
  before(async () => {
    env = await createTestEnv();
    admin = await createPlatformAdmin(env);
    a = await signupTenant(env, 'Alpha Cafe'); b = await signupTenant(env, 'Beta Shop');
  });
  after(async () => { await env.close(); });

  it('only platform admins can open it; company users cannot', async () => {
    assert.equal((await a.client.get('/platform/dashboard')).status, 403);
    assert.equal((await new Client(env.app).get('/platform/dashboard')).status, 401);
    assert.equal((await a.client.patch(`/platform/tenants/${b.tenantId}/subscription`, { plan: 'scale' })).status, 403);
    assert.equal((await admin.get('/platform/dashboard')).status, 200);
  });

  it('numbers are counted from real rows (companies, employees, channels, messages, AI usage)', async () => {
    const emp = (await a.client.post('/ai-employees', { name: 'Nour', tasks: ['sales_assistant'] })).body.id;
    await env.owner.query(`UPDATE ai_employees SET status = 'active' WHERE id = $1`, [emp]);
    await b.client.post('/ai-employees', { name: 'Sami', tasks: ['customer_support'] });
    const chA = (await env.owner.query(`INSERT INTO channels (tenant_id, type, provider, name, status, public_key) VALUES ($1, 'telegram', 'telegram_bot', 'tg', 'connected', 'pk_sa1') RETURNING id`, [a.tenantId])).rows[0].id;
    await env.owner.query(`INSERT INTO channels (tenant_id, type, provider, name, status, public_key) VALUES ($1, 'messenger', 'meta', 'fb', 'error', 'pk_sa2')`, [b.tenantId]);
    const ct = (await env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id, name) VALUES ($1, $2, '1', 'Zed') RETURNING id`, [a.tenantId, chA])).rows[0].id;
    const cv = (await env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id) VALUES ($1, $2, 'telegram', $3) RETURNING id`, [a.tenantId, chA, ct])).rows[0].id;
    for (const [dir, who, st] of [['in', 'customer', 'received'], ['in', 'customer', 'received'], ['out', 'ai', 'sent'], ['out', 'human', 'failed']] as const)
      await env.owner.query(`INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status) VALUES ($1, $2, $3, $4, $5, 'SECRET TEXT', $6)`, [a.tenantId, chA, cv, dir, who, st]);
    await env.owner.query(`INSERT INTO ai_usage (tenant_id, employee_id, purpose, model, total_tokens, cost_usd, cost_source, status) VALUES ($1, $2, 'agent_reply', 'm', 700, 0.007, 'provider', 'ok'), ($1, $2, 'agent_reply', 'm', 300, NULL, 'unknown', 'error')`, [a.tenantId, emp]);
    const d = (await admin.get('/platform/dashboard')).body;
    assert.equal(d.tenants.total, 2); assert.equal(d.tenants.active, 2); assert.equal(d.tenants.suspended, 0);
    assert.equal(d.aiEmployees.total, 2); assert.equal(d.aiEmployees.active, 1);
    assert.equal(d.channels.total, 2); assert.equal(d.channels.connected, 1);
    assert.deepEqual(d.messageVolume.totals, { inbound: 2, aiOut: 1, humanOut: 1, systemOut: 0, failed: 1 });
    assert.equal(d.aiConsumption.tokens, 1000); assert.equal(d.aiConsumption.calls, 2); assert.equal(d.aiConsumption.errors, 1);
    assert.ok(Math.abs(d.aiConsumption.costUsd - 0.007) < 1e-9); assert.equal(d.aiConsumption.callsWithoutReportedCost, 1);
    assert.equal(d.aiConsumption.topCompanies[0].name, 'Alpha Cafe');
    assert.equal(d.errors.last24h.failedMessages, 1); assert.equal(d.errors.channelsInError, 0, 'only channels with a recorded error text count');
    assert.ok(!JSON.stringify(d).includes('SECRET TEXT'), 'message text never reaches the platform dashboard');
    assert.ok(!JSON.stringify(d).includes('Zed'), 'customer names never reach the platform dashboard');
  });

  it('the platform role cannot read channels, messages or customers directly', async () => {
    for (const t of ['channels', 'messages', 'contacts', 'conversations', 'campaigns', 'workflows']) await assert.rejects(env.app.pools.platform.query(`SELECT 1 FROM ${t} LIMIT 1`), /permission denied/, t);
    await assert.rejects(env.app.pools.platform.query(`SELECT public_key FROM channels`), /permission denied/);
  });

  it('subscription management: plan, status, trial and limit overrides are changed, validated and audited', async () => {
    const r = await admin.patch(`/platform/tenants/${a.tenantId}/subscription`, { plan: 'starter', subscriptionStatus: 'active', limits: { maxChannels: 3 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.effective, { ...PLAN_LIMITS.starter, maxChannels: 3 });
    const row = (await env.owner.query(`SELECT plan, subscription_status, limits, plan_changed_at FROM tenants WHERE id = $1`, [a.tenantId])).rows[0];
    assert.deepEqual([row.plan, row.subscription_status, row.limits], ['starter', 'active', { maxChannels: 3 }]); assert.ok(row.plan_changed_at);
    assert.equal((await env.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'tenant.subscription_changed'`, [a.tenantId])).rows[0].n, 1);
    // clearing an override with null
    assert.deepEqual((await admin.patch(`/platform/tenants/${a.tenantId}/subscription`, { limits: { maxChannels: null } })).body.limits, {});
    assert.equal((await admin.patch(`/platform/tenants/${a.tenantId}/subscription`, { plan: 'platinum' })).status, 400);
    assert.equal((await admin.patch(`/platform/tenants/${a.tenantId}/subscription`, { limits: { maxChannels: -1 } })).status, 400);
    assert.equal((await admin.patch(`/platform/tenants/${a.tenantId}/subscription`, { limits: { hacked: 1 } })).status, 400);
    assert.equal((await admin.patch(`/platform/tenants/${a.tenantId}/subscription`, {})).status, 400);
    assert.equal((await admin.patch(`/platform/tenants/00000000-0000-4000-8000-000000000000/subscription`, { plan: 'scale' })).status, 404);
  });

  it('limits are ENFORCED: AI employees and channels cannot pass the plan limit; other companies are unaffected', async () => {
    await admin.patch(`/platform/tenants/${b.tenantId}/subscription`, { limits: { maxAiEmployees: 2, maxChannels: 1 } });
    assert.equal((await b.client.post('/ai-employees', { name: 'Two', tasks: ['faq'] })).status, 201, 'second employee fits (limit 2)');
    const over = await b.client.post('/ai-employees', { name: 'Three', tasks: ['faq'] });
    assert.equal(over.status, 402); assert.equal(over.body.error.code, 'plan_limit'); assert.match(over.body.error.message, /allows 2 AI employees/);
    assert.equal((await b.client.post('/channels', { type: 'website', name: 'Site' })).status, 402, 'Beta already has 1 channel (limit 1)');
    // Alpha (starter, 5 employees) is not affected by Beta's limits
    assert.equal((await a.client.post('/ai-employees', { name: 'More', tasks: ['faq'] })).status, 201);
    // raising the limit takes effect immediately
    await admin.patch(`/platform/tenants/${b.tenantId}/subscription`, { limits: { maxAiEmployees: 3 } });
    assert.equal((await b.client.post('/ai-employees', { name: 'Three', tasks: ['faq'] })).status, 201);
    // the platform dashboard shows the meter at 100%
    const row = (await admin.get('/platform/dashboard')).body.usageLimits.companies.find((c: any) => c.id === b.tenantId);
    const m = row.meters.find((x: any) => x.key === 'maxAiEmployees');
    assert.deepEqual([m.used, m.limit, m.percent], [3, 3, 100]); assert.equal(row.nearLimit, true); assert.equal(row.overridden, true);
  });

  it('suspending a company still works and is reflected in the dashboard', async () => {
    assert.equal((await admin.patch(`/platform/tenants/${b.tenantId}`, { status: 'suspended' })).status, 200);
    const d = (await admin.get('/platform/dashboard')).body;
    assert.equal(d.tenants.suspended, 1); assert.equal(d.tenants.active, 1);
    await admin.patch(`/platform/tenants/${b.tenantId}`, { status: 'active' });
  });

  it('server errors are recorded in the platform error log without request data', async () => {
    await env.owner.query(`INSERT INTO system_errors (tenant_id, source, code, message) VALUES ($1, 'api', 'boom', 'GET /x')`, [a.tenantId]);
    const d = (await admin.get('/platform/dashboard')).body;
    assert.ok(d.errors.byCode.some((e: any) => e.code === 'boom'));
    assert.ok(d.errors.recent.some((e: any) => e.code === 'boom' && e.tenantName === 'Alpha Cafe'));
    await assert.rejects(env.app.pools.app.query(`SELECT * FROM system_errors`), /permission denied/, 'companies cannot read the platform error log');
  });
});
