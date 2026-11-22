import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPlatformAdmin, createTestEnv, signupTenant, type Client, type TestEnv, type Tenant } from './helpers.js';

describe('platform admin: AI usage and per-company token budget', () => {
  let env: TestEnv, t: Tenant, admin: Client;
  before(async () => {
    env = await createTestEnv();
    t = await signupTenant(env, 'Usage Co');
    admin = await createPlatformAdmin(env);
  });
  after(async () => { await env.close(); });

  it('shows AI tokens per company, lets the admin set a limit, and enforces it; a company cannot change its own limit', async () => {
    const emp = (await t.client.post('/ai-employees', { name: 'E', tasks: ['faq'] })).body.id;
    env.fake.responder = () => '{"reply":"hello there my friend","actions":[]}';
    assert.equal((await t.client.post(`/ai-employees/${emp}/simulate`, { message: 'hi' })).body.usedModel, true);
    const row = ((await admin.get('/platform/tenants')).body.items as any[]).find((x) => x.id === t.tenantId);
    assert.ok(Number(row.aiTokensMonth) > 0);
    assert.equal(row.aiMonthlyTokenLimit, null);

    assert.equal((await t.client.patch(`/platform/tenants/${t.tenantId}/ai-limit`, { aiMonthlyTokenLimit: 5 })).status, 403);
    const set = await admin.patch(`/platform/tenants/${t.tenantId}/ai-limit`, { aiMonthlyTokenLimit: 0 });
    assert.equal(set.status, 200);
    assert.equal(set.body.aiMonthlyTokenLimit, 0);
    const blocked = await t.client.post(`/ai-employees/${emp}/simulate`, { message: 'hi' });
    assert.equal(blocked.body.error.code, 'ai_budget_exceeded');
    assert.equal((await admin.patch(`/platform/tenants/${t.tenantId}/ai-limit`, { aiMonthlyTokenLimit: -1 })).status, 400);
    assert.equal((await admin.patch(`/platform/tenants/${t.tenantId}/ai-limit`, { aiMonthlyTokenLimit: null })).status, 200);
    assert.equal((await t.client.post(`/ai-employees/${emp}/simulate`, { message: 'hi' })).body.usedModel, true);
    const log = await env.owner.query(`SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND action = 'tenant.ai_limit_changed'`, [t.tenantId]);
    assert.ok(log.rowCount! >= 2);
  });
});
