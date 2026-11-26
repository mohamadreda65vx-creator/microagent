import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, createTestEnv, inviteMember, signupTenant, type TestEnv, type Tenant } from './helpers.js';

/** Performance dashboard: known synthetic data in, exact numbers out. Nothing is estimated. */
let env: TestEnv;
let a: Tenant;
let b: Tenant;
let aViewer: Client;
let emp1: string;
let emp2: string;
let tgCh: string;
let fbCh: string;
let campaign: string;
const ids: Record<string, string> = {};
const DAY = 86400_000;
const iso = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const ymd = (d: number) => iso(d).slice(0, 10);

async function chan(t: Tenant, type: string, provider: string, key: string) {
  return (await env.owner.query(`INSERT INTO channels (tenant_id, type, provider, name, status, public_key) VALUES ($1, $2, $3, $4, 'connected', $5) RETURNING id`, [t.tenantId, type, provider, type, key])).rows[0].id as string;
}
async function person(t: Tenant, ch: string, type: string, ext: string, name: string, o: { emp?: string; phone?: string; status?: string; email?: string } = {}) {
  const ct = (await env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id, name, phone, email, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [t.tenantId, ch, ext, name, o.phone ?? null, o.email ?? null, o.status ?? 'new'])).rows[0].id;
  const cv = (await env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id, employee_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [t.tenantId, ch, type, ct, o.emp ?? null])).rows[0].id;
  ids[name] = ct; ids[`cv:${name}`] = cv;
}
async function msg(t: Tenant, ch: string, name: string, dir: 'in' | 'out', sender: string, daysAgo: number, minsAgo = 0) {
  await env.owner.query(`INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status, created_at) VALUES ($1, $2, $3, $4, $5, 'x', $6, now() - make_interval(days => $7, mins => $8))`,
    [t.tenantId, ch, ids[`cv:${name}`], dir, sender, dir === 'in' ? 'received' : 'sent', daysAgo, minsAgo]);
}
const event = (ct: string, ch: string, to: string, daysAgo: number) => env.owner.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail, created_at) VALUES ($1, $2, $3, 'status_changed', $4, $5)`, [a.tenantId, ch, ct, JSON.stringify({ from: 'new', to }), iso(daysAgo)]);
const action = (emp: string, type: string, decision: string, cv: string | null, daysAgo: number, mode = 'live', approval: string | null = null) =>
  env.owner.query(`INSERT INTO agent_actions (tenant_id, employee_id, mode, type, params, decision, approval_status, conversation_id, created_at) VALUES ($1, $2, $3, $4, '{}', $5, $6, $7, $8)`, [a.tenantId, emp, mode, type, decision, approval, cv, iso(daysAgo)]);
const usage = (emp: string | null, tokens: number, cost: number | null, status = 'ok', daysAgo = 1, purpose = 'agent_reply') =>
  env.owner.query(`INSERT INTO ai_usage (tenant_id, employee_id, purpose, model, total_tokens, cost_usd, cost_source, status, created_at) VALUES ($1, $2, $3, 'test-model', $4, $5, $6, $7, $8)`, [a.tenantId, emp, purpose, tokens, cost, cost === null ? 'unknown' : 'provider', status, iso(daysAgo)]);
const audit = (action: string, cv: string, daysAgo: number) => env.owner.query(`INSERT INTO audit_logs (tenant_id, action, entity_type, entity_id, meta, created_at) VALUES ($1, $2, 'conversation', $3, '{}', $4)`, [a.tenantId, action, cv, iso(daysAgo)]);
const perf = async (t: Tenant, qs = '') => { const r = await t.client.get(`/performance${qs}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

describe('Performance dashboard', () => {
  before(async () => {
    env = await createTestEnv();
    a = await signupTenant(env, 'Perf Cafe'); b = await signupTenant(env, 'Other Shop');
    aViewer = await inviteMember(env, a, 'viewer');
    emp1 = (await a.client.post('/ai-employees', { name: 'Nour', tasks: ['sales_assistant'] })).body.id;
    emp2 = (await a.client.post('/ai-employees', { name: 'Sami', tasks: ['customer_support'] })).body.id;
    tgCh = await chan(a, 'telegram', 'telegram_bot', 'pk_perf_tg'); fbCh = await chan(a, 'messenger', 'meta', 'pk_perf_fb');
    // Telegram, employee 1: Ana (today), Bo (3 days ago), Cy (40 days ago: outside the default window)
    await person(a, tgCh, 'telegram', '1', 'Ana', { emp: emp1, phone: '+201001110001' });
    await person(a, tgCh, 'telegram', '2', 'Bo', { emp: emp1 });
    await person(a, tgCh, 'telegram', '3', 'Cy', { emp: emp1, email: 'cy@example.test' });
    // Messenger, employee 2: Di (today)
    await person(a, fbCh, 'messenger', '4', 'Di', { emp: emp2, phone: '+201001110004' });
    await msg(a, tgCh, 'Ana', 'in', 'customer', 0, 30); await msg(a, tgCh, 'Ana', 'in', 'customer', 0, 20); await msg(a, tgCh, 'Ana', 'out', 'ai', 0, 10);
    await msg(a, tgCh, 'Bo', 'in', 'customer', 3); await msg(a, tgCh, 'Bo', 'out', 'human', 3);
    await msg(a, tgCh, 'Cy', 'in', 'customer', 40);
    await msg(a, fbCh, 'Di', 'in', 'customer', 0, 200); // last message is the customer's, 200 min old: unanswered
    // status events
    await event(ids.Ana!, tgCh, 'lead', 1); await event(ids.Bo!, tgCh, 'lead', 2); await event(ids.Cy!, tgCh, 'lead', 40);
    await event(ids.Ana!, tgCh, 'customer', 0); await event(ids.Di!, fbCh, 'lead', 0);
    // AI actions: counted = live AND (allowed OR approved)
    await action(emp1, 'collect_lead', 'allowed', ids['cv:Ana']!, 1);
    await action(emp1, 'collect_lead', 'denied', ids['cv:Ana']!, 1);
    await action(emp1, 'collect_lead', 'allowed', ids['cv:Bo']!, 1, 'simulation');
    await action(emp1, 'create_order', 'allowed', ids['cv:Ana']!, 1);
    await action(emp1, 'create_order', 'pending_approval', ids['cv:Bo']!, 1, 'live', 'approved');
    await action(emp1, 'create_order', 'pending_approval', ids['cv:Bo']!, 1, 'live', 'pending');
    await action(emp1, 'create_order', 'pending_approval', ids['cv:Bo']!, 1, 'live', 'rejected');
    await action(emp2, 'create_order', 'allowed', null, 1); // no conversation recorded
    // handoffs / takeovers
    await audit('conversation.handoff', ids['cv:Ana']!, 1); await audit('conversation.handoff', ids['cv:Di']!, 1); await audit('conversation.takeover', ids['cv:Bo']!, 3); await audit('conversation.handoff', ids['cv:Cy']!, 40);
    // AI usage
    await usage(emp1, 1000, 0.01); await usage(emp1, 500, 0.005, 'ok', 2, 'simulation'); await usage(emp2, 200, null, 'error'); await usage(null, 100, 0.001, 'ok', 60);
    // a campaign that was sent to Ana only
    campaign = (await env.owner.query(`INSERT INTO campaigns (tenant_id, name, channel_id, platform, message, status, started_at, launched_at) VALUES ($1, 'Latte offer', $2, 'telegram', 'Hi', 'completed', now() - interval '1 day', now() - interval '1 day') RETURNING id`, [a.tenantId, tgCh])).rows[0].id;
    await env.owner.query(`INSERT INTO campaign_recipients (tenant_id, campaign_id, channel_id, contact_id, status, sent_at) VALUES ($1, $2, $3, $4, 'sent', now())`, [a.tenantId, campaign, tgCh, ids.Ana]);
    // another company's data must never leak in
    const bch = await chan(b, 'telegram', 'telegram_bot', 'pk_perf_btg');
    const bct = (await env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id, name) VALUES ($1, $2, '9', 'Zed') RETURNING id`, [b.tenantId, bch])).rows[0].id;
    const bcv = (await env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id) VALUES ($1, $2, 'telegram', $3) RETURNING id`, [b.tenantId, bch, bct])).rows[0].id;
    await env.owner.query(`INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status) VALUES ($1, $2, $3, 'in', 'customer', 'x', 'received')`, [b.tenantId, bch, bcv]);
  });
  after(async () => { await env.close(); });

  it('default period (30 days): every KPI matches the recorded rows exactly', async () => {
    const k = (await perf(a)).kpis;
    assert.equal(k.conversations, 3, 'Ana, Bo, Di wrote in the last 30 days; Cy did not');
    assert.equal(k.inboundMessages, 4);
    assert.equal(k.aiReplies, 1); assert.equal(k.staffReplies, 1);
    assert.equal(k.leadsMarked, 3, 'Ana, Bo, Di (Cy was 40 days ago)');
    assert.equal(k.leadsCollectedByAi, 1, 'only the allowed LIVE collect_lead counts; the denied one and the simulation do not');
    assert.equal(k.conversions, 1);
    assert.equal(k.orders, 3, 'allowed + approved + the allowed one with no conversation; pending / rejected are not orders');
    assert.equal(k.handoffs, 2); assert.equal(k.staffTakeovers, 1);
    assert.equal(k.qualifiedLeads, 2, 'Ana (phone) and Di (phone); Bo has neither phone nor email');
  });

  it('qualified leads need a phone or email; AI leads without a recorded conversation are not guessed', async () => {
    const k = (await perf(a)).kpis;
    assert.equal(k.qualifiedLeads, 2);
  });

  it('unanswered messages: a live snapshot, with the oldest waiting time', async () => {
    const u = (await perf(a, '?unansweredMinutes=60')).kpis.unanswered;
    assert.equal(u.count, 2, 'Di (200 min) and Cy (40 days): a snapshot of right now, whatever the period'); assert.ok(u.oldestAt); assert.equal(u.afterMinutes, 60);
    assert.equal((await perf(a, '?unansweredMinutes=600')).kpis.unanswered.count, 1, 'Di waited 200 minutes, not 600; Cy did');
    await env.owner.query(`UPDATE conversations SET status = 'resolved' WHERE id = ANY($1)`, [[ids['cv:Di'], ids['cv:Cy']]]);
    assert.equal((await perf(a, '?unansweredMinutes=60')).kpis.unanswered.count, 0, 'resolved conversations are not unanswered');
    await env.owner.query(`UPDATE conversations SET status = 'open' WHERE id = $1`, [ids['cv:Cy']]);
    await env.owner.query(`UPDATE conversations SET status = 'open' WHERE id = $1`, [ids['cv:Di']]);
  });

  it('date filter includes older data only when asked', async () => {
    const k = (await perf(a, `?from=${ymd(45)}&to=${ymd(0)}`)).kpis;
    assert.equal(k.conversations, 4); assert.equal(k.leadsMarked, 4); assert.equal(k.handoffs, 3);
    const none = (await perf(a, `?from=${ymd(300)}&to=${ymd(200)}`)).kpis;
    assert.deepEqual([none.conversations, none.leadsMarked, none.orders, none.ai.tokens], [0, 0, 0, 0]);
  });

  it('platform filter', async () => {
    const r = await perf(a, '?platform=messenger');
    assert.equal(r.kpis.conversations, 1); assert.equal(r.kpis.leadsMarked, 1); assert.equal(r.kpis.aiReplies, 0);
    assert.equal(r.kpis.orders, 0, 'AI orders only count under a platform filter when the conversation is known');
    assert.ok(r.notes.some((n: string) => /AI usage and cost cannot be split by platform/.test(n)));
    assert.equal((await perf(a, '?platform=telegram')).kpis.conversations, 2);
  });

  it('agent filter', async () => {
    const e1 = (await perf(a, `?employeeId=${emp1}`)).kpis;
    assert.equal(e1.conversations, 2); assert.equal(e1.ai.tokens, 1500, "AI usage is the employee's own");
    const e2 = (await perf(a, `?employeeId=${emp2}`)).kpis;
    assert.equal(e2.conversations, 1); assert.equal(e2.orders, 1); assert.equal(e2.ai.tokens, 200);
  });

  it('campaign filter = customers who actually received that campaign', async () => {
    const r = await perf(a, `?campaignId=${campaign}`);
    assert.equal(r.kpis.conversations, 1); assert.equal(r.kpis.conversions, 1); assert.equal(r.kpis.leadsMarked, 1);
    assert.equal(r.campaigns.length, 1); assert.equal(r.campaigns[0].counts.totalAudience, 1);
  });

  it('AI usage and cost: only provider-reported costs are summed; unknown costs are counted, never estimated', async () => {
    const ai = (await perf(a)).kpis.ai;
    assert.equal(ai.calls, 3); assert.equal(ai.errors, 1); assert.equal(ai.tokens, 1700);
    assert.ok(Math.abs(ai.costUsd - 0.015) < 1e-9); assert.equal(ai.callsWithoutReportedCost, 1);
    assert.deepEqual(ai.byPurpose.map((p: any) => p.purpose).sort(), ['agent_reply', 'simulation']);
  });

  it('daily series covers every day of the period, with zeros where nothing happened', async () => {
    const r = await perf(a, `?from=${ymd(4)}&to=${ymd(0)}`);
    assert.equal(r.series.length, 5);
    assert.equal(r.series.at(-1).conversations, 2, 'Ana and Di today');
    assert.equal(r.series.find((s: any) => s.day === ymd(3)).conversations, 1);
    assert.equal(r.series.find((s: any) => s.day === ymd(4)).conversations, 0);
  });

  it('every KPI ships with its definition, and orders are not presented as sales', async () => {
    const r = await perf(a);
    for (const key of ['conversations', 'leadsMarked', 'qualifiedLeads', 'orders', 'conversions', 'handoffs', 'unanswered', 'aiCost']) assert.ok(r.definitions[key], key);
    assert.match(r.definitions.orders, /not confirmed, paid or fulfilled/);
    assert.ok(r.notes.some((n: string) => /no order or payment system/.test(n)));
  });

  it('another company sees only its own numbers; invalid input is rejected', async () => {
    const k = (await perf(b)).kpis;
    assert.equal(k.conversations, 1); assert.deepEqual([k.leadsMarked, k.orders, k.ai.tokens, k.aiReplies], [0, 0, 0, 0]);
    assert.equal((await b.client.get(`/performance?employeeId=${emp1}`)).body.kpis.conversations, 0, "another company's employee id matches nothing");
    assert.equal((await b.client.get(`/performance?campaignId=${campaign}`)).body.kpis.conversations, 0);
    assert.equal((await a.client.get('/performance?from=2026-02-01&to=2026-01-01')).status, 400);
    assert.equal((await a.client.get('/performance?from=2020-01-01&to=2026-01-01')).status, 400);
    assert.equal((await a.client.get('/performance?platform=sms')).status, 400);
    assert.equal((await aViewer.get('/performance')).status, 200, 'read-only role may look');
    assert.equal((await new Client(env.app).get('/performance')).status, 401);
  });
});
