import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { withTenant } from '../src/db/tx.js';
import { MAX_LIVE_PER_MINUTE } from '../src/workflows/engine.js';
import { evalCondition, nextNode, render, validateGraph, type Graph } from '../src/workflows/graph.js';
import { Client, createTestEnv, inviteMember, signupTenant, type TestEnv, type Tenant } from './helpers.js';

/** Part 5 workflow tests. All customers are synthetic; all providers are local stand-ins; no real customer is ever messaged. */
let env: TestEnv;
let a: Tenant;
let b: Tenant;
let aManager: Client;
let aViewer: Client;
let aEmp: string;
let n = 9000;
let tg: { id: string; key: string; secret: string };
const TOKEN = '777777:WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';

type NodeSpec = [string, string, Record<string, unknown>];
const G = (nodes: NodeSpec[], edges: Array<[string, string, string?]>): Graph => ({
  nodes: nodes.map(([id, type, data], i) => ({ id, type, position: { x: i * 200, y: 100 }, data })) as Graph['nodes'],
  edges: edges.map(([s, t, h], i) => ({ id: `e${i}`, source: s, target: t, ...(h ? { sourceHandle: h } : {}) })),
});
const TRIG: NodeSpec = ['t', 'trigger', { kind: 'message_received' }];
const env0 = { employees: new Map<string, string>(), workflows: new Map<string, { active: boolean }>() };
const issues = (g: Graph, e = env0) => validateGraph(g, e);
const errs = (g: Graph, e = env0) => issues(g, e).filter((i) => i.level === 'error').map((i) => i.code);

const hook = (payload: unknown) => env.app.inject({ method: 'POST', url: `/api/v1/webhooks/channel/${tg.key}`, payload: payload as object, headers: { 'x-telegram-bot-api-secret-token': tg.secret } });
const update = (chat: number, mid: number, text: string, name = 'Layla') => ({ update_id: ++n, message: { message_id: mid, date: Math.floor(Date.now() / 1000), from: { id: chat, is_bot: false, first_name: name }, chat: { id: chat, type: 'private' }, text } });
const settle = async () => { for (let i = 0; i < 3; i++) { await env.app.channels.idle(); await env.app.workflows.idle(); } };
const sent = () => env.tg.callsTo('sendMessage').map((c) => String(c.body.text));
const contact = async (ext: string) => (await env.owner.query(`SELECT * FROM contacts WHERE external_id = $1 AND tenant_id = $2`, [ext, a.tenantId])).rows[0];
const runsOf = async (wf: string) => (await env.owner.query(`SELECT * FROM workflow_runs WHERE workflow_id = $1 AND mode = 'live' ORDER BY created_at`, [wf])).rows;
const stepsOf = async (run: string) => (await env.owner.query(`SELECT node_id, status, error, output FROM workflow_steps WHERE run_id = $1 ORDER BY seq`, [run])).rows;

async function make(t: Tenant, name: string, graph: Graph, activate = false) {
  const w = (await t.client.post('/workflows', { name })).body;
  const s = await t.client.put(`/workflows/${w.id}/graph`, { graph, baseVersion: 1 });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  if (activate) {
    const r = await t.client.post(`/workflows/${w.id}/activate`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return w.id as string;
}
const test = (t: Tenant, id: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => t.client.post(`/workflows/${id}/test`, { payload, ...extra });
const reply = (text: string) => JSON.stringify({ reply: text, actions: [] });
async function pauseAll(t: Tenant) { await env.owner.query(`UPDATE workflows SET status = 'paused' WHERE tenant_id = $1 AND status = 'active'`, [t.tenantId]); }

// ───────────────────────────────────── pure graph rules
describe('Workflow graph validation (pure)', () => {
  it('needs exactly one trigger', () => {
    assert.ok(errs(G([['x', 'delay', { amount: 1, unit: 'hours' }]], [])).includes('no_trigger'));
    assert.ok(errs(G([TRIG, ['t2', 'trigger', { kind: 'manual' }]], [])).includes('many_triggers'));
  });
  it('flags nodes that are not connected to the trigger', () => {
    const g = G([TRIG, ['d', 'delay', { amount: 1, unit: 'hours' }]], []);
    assert.ok(errs(g).includes('unreachable'));
    assert.ok(!errs(G([TRIG, ['d', 'delay', { amount: 1, unit: 'hours' }]], [['t', 'd']])).includes('unreachable'));
  });
  it('refuses circles without a Loop node, allows them through one', () => {
    const d = { amount: 1, unit: 'hours' };
    assert.ok(errs(G([TRIG, ['a', 'delay', d], ['b', 'delay', d]], [['t', 'a'], ['a', 'b'], ['b', 'a']])).includes('cycle'));
    const ok = G([TRIG, ['l', 'loop', { source: 'count', count: 3 }], ['b', 'delay', d]], [['t', 'l'], ['l', 'b', 'body'], ['b', 'l']]);
    assert.deepEqual(errs(ok), []);
  });
  it('a loop needs a body that returns to it', () => {
    const d = { amount: 1, unit: 'hours' };
    assert.ok(errs(G([TRIG, ['l', 'loop', { source: 'count', count: 3 }]], [['t', 'l']])).includes('loop_no_body'));
    assert.ok(errs(G([TRIG, ['l', 'loop', { source: 'count', count: 3 }], ['b', 'delay', d]], [['t', 'l'], ['l', 'b', 'body']])).includes('loop_no_return'));
  });
  it('outputs: valid handles only, one path per output, nothing into the trigger', () => {
    const d = { amount: 1, unit: 'hours' };
    assert.ok(errs(G([TRIG, ['a', 'delay', d]], [['t', 'a', 'nope']])).includes('bad_handle'));
    assert.ok(errs(G([TRIG, ['a', 'delay', d], ['b', 'delay', d]], [['t', 'a'], ['t', 'b']])).includes('two_edges'));
    assert.ok(errs(G([TRIG, ['a', 'delay', d]], [['t', 'a'], ['a', 't']])).includes('into_trigger'));
    assert.ok(errs(G([TRIG], [['t', 'ghost']])).includes('dangling_edge'));
  });
  it('node settings are validated per type', () => {
    assert.ok(errs(G([TRIG, ['d', 'delay', { amount: 0, unit: 'hours' }]], [['t', 'd']])).includes('bad_config'));
    assert.ok(errs(G([TRIG, ['d', 'delay', { amount: 31, unit: 'days' }]], [['t', 'd']])).includes('delay_too_long') || errs(G([TRIG, ['d', 'delay', { amount: 31, unit: 'days' }]], [['t', 'd']])).includes('bad_config'));
    assert.ok(errs(G([TRIG, ['c', 'condition', { match: 'all', rules: [{ left: 'customer.name', op: 'equals' }] }]], [['t', 'c']])).includes('rule_incomplete'));
    assert.ok(errs(G([TRIG, ['x', 'action', { kind: 'add_tag' }]], [['t', 'x']])).includes('action_incomplete'));
    assert.ok(errs(G([TRIG, ['x', 'action', { kind: 'set_customer_status', status: 'vip' }]], [['t', 'x']])).includes('bad_status'));
    assert.ok(errs(G([TRIG, ['x', 'ai_agent', { employeeId: '8d3f3c52-1b5b-4a5d-9c1a-1d4f9f3e0a11', mode: 'text', prompt: 'hi', outputVar: 'r' }]], [['t', 'x']])).includes('employee_missing'));
    assert.ok(errs(G([TRIG, ['x', 'action', { kind: 'send_message', text: 'hi', run: 'rm -rf' }]], [['t', 'x']])).includes('bad_config'), 'unknown settings are rejected, not ignored');
  });
  it('templates never invent data and conditions use no code execution', () => {
    const ctx = { customer: { first_name: 'Sara', tags: 'vip,new' }, trigger: { message: { text: 'What is the PRICE?' } } };
    assert.deepEqual(render('Hi {{customer.first_name}}', ctx), { text: 'Hi Sara', missing: [] });
    assert.deepEqual(render('Hi {{customer.phone}} {{ nope.x }}', ctx), { text: 'Hi  ', missing: ['customer.phone', 'nope.x'] });
    assert.equal(render('{{constructor.prototype}}', ctx).missing.length, 1, 'prototype properties are not reachable');
    const rule = (left: string, op: any, right?: string) => evalCondition({ match: 'all', rules: [{ left, op, ...(right !== undefined ? { right } : {}) }] }, ctx).result;
    assert.equal(rule('{{trigger.message.text}}', 'contains', 'price'), true);
    assert.equal(rule('{{customer.tags}}', 'contains', 'vip'), true);
    assert.equal(rule('10', 'gt', '9'), true);
    assert.equal(rule('abc', 'gt', '1'), false);
    assert.equal(rule('{{customer.phone}}', 'exists'), false);
    assert.equal(rule('x', 'equals', 'X'), true);
    assert.equal(evalCondition({ match: 'any', rules: [{ left: '1', op: 'equals', right: '2' }, { left: 'a', op: 'equals', right: 'a' }] }, ctx).result, true);
  });
  it('nextNode follows the named output', () => {
    const g = G([TRIG, ['c', 'condition', { match: 'all', rules: [{ left: 'a', op: 'exists' }] }], ['x', 'delay', { amount: 1, unit: 'hours' }]], [['t', 'c'], ['c', 'x', 'false']]);
    assert.equal(nextNode(g, 'c', 'false'), 'x');
    assert.equal(nextNode(g, 'c', 'true'), null);
    assert.equal(nextNode(g, 't', 'out'), 'c');
  });
});

// ───────────────────────────────────── integration
describe('Workflows (database, API, engine)', () => {
  before(async () => {
    env = await createTestEnv();
    env.app.config.appUrl = 'https://app.example.test';
    a = await signupTenant(env, 'Cafe Nile');
    b = await signupTenant(env, 'Gadget Shop');
    aManager = await inviteMember(env, a, 'manager');
    aViewer = await inviteMember(env, a, 'viewer');
    aEmp = (await a.client.post('/ai-employees', { name: 'Nour', tasks: ['sales_assistant', 'customer_support', 'human_handoff'] })).body.id;
    await env.owner.query(`UPDATE ai_employees SET status = 'active' WHERE id = $1`, [aEmp]);
    env.tg.addBot(TOKEN, 777777, 'bot_777');
    const ch = (await a.client.post('/channels', { type: 'telegram', name: 'Cafe bot' })).body;
    assert.equal((await a.client.post(`/channels/${ch.id}/connect`, { botToken: TOKEN })).status, 200);
    tg = { id: ch.id, key: (await env.owner.query('SELECT public_key FROM channels WHERE id = $1', [ch.id])).rows[0].public_key, secret: env.tg.webhooks.get(TOKEN)!.secret };
  });
  after(async () => { await env.close(); });

  it('creating, saving, versions, conflicts and restore', async () => {
    const w = (await a.client.post('/workflows', { name: 'Welcome' })).body;
    assert.equal(w.status, 'draft'); assert.equal(w.latestVersion, 1);
    const g = G([TRIG, ['d', 'delay', { amount: 5, unit: 'minutes' }]], [['t', 'd']]);
    const s1 = (await a.client.put(`/workflows/${w.id}/graph`, { graph: g, baseVersion: 1 })).body;
    assert.deepEqual([s1.version, s1.changed], [2, true]);
    const same = (await a.client.put(`/workflows/${w.id}/graph`, { graph: g, baseVersion: 2 })).body;
    assert.deepEqual([same.version, same.changed], [2, false], 'saving without changes creates no new version');
    const stale = await a.client.put(`/workflows/${w.id}/graph`, { graph: G([TRIG], []), baseVersion: 1 });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'version_conflict');
    const restored = (await a.client.post(`/workflows/${w.id}/versions/1/restore`)).body;
    assert.equal(restored.version, 3);
    const cur = (await a.client.get(`/workflows/${w.id}`)).body;
    assert.equal(cur.graph.nodes.length, 1, 'version 3 is a copy of version 1');
    assert.deepEqual(cur.versions.map((v: any) => v.version), [3, 2, 1]);
    assert.equal((await a.client.get(`/workflows/${w.id}/versions/2`)).body.graph.nodes.length, 2, 'old versions are kept intact');
    // versions are immutable at the database level
    const app = env.app.pools.app;
    await assert.rejects(withTenant(app, a.tenantId, (c) => c.query(`UPDATE workflow_versions SET graph = '{}'`)), /permission denied/);
    await assert.rejects(withTenant(app, a.tenantId, (c) => c.query(`DELETE FROM workflow_versions`)), /permission denied/);
  });

  it('permissions: viewer reads, manager edits and tests, only owner/admin activate', async () => {
    const id = await make(a, 'Perm', G([TRIG], []));
    assert.equal((await aViewer.get('/workflows')).status, 200);
    assert.equal((await aViewer.post('/workflows', { name: 'x' })).status, 403);
    assert.equal((await aViewer.post(`/workflows/${id}/test`, {})).status, 403);
    assert.equal((await aManager.post(`/workflows/${id}/test`, {})).status, 200);
    assert.equal((await aManager.put(`/workflows/${id}/graph`, { graph: G([TRIG, ['d', 'delay', { amount: 1, unit: 'hours' }]], [['t', 'd']]), baseVersion: 2 })).status, 200);
    assert.equal((await aManager.post(`/workflows/${id}/activate`, {})).status, 403);
    assert.equal((await aManager.del(`/workflows/${id}`)).status, 403);
    assert.equal((await a.client.post(`/workflows/${id}/activate`, {})).status, 200);
  });

  it('an invalid workflow can be saved as a draft but can be neither tested nor activated', async () => {
    const bad = G([TRIG, ['x', 'delay', { amount: 1, unit: 'hours' }]], []); // x unreachable
    const id = await make(a, 'Broken', bad);
    assert.ok((await a.client.get(`/workflows/${id}`)).body.issues.some((i: any) => i.code === 'unreachable'));
    const t = await test(a, id);
    assert.equal(t.status, 422); assert.equal(t.body.error.code, 'workflow_invalid');
    const act = await a.client.post(`/workflows/${id}/activate`, {});
    assert.equal(act.status, 422);
    assert.equal((await env.owner.query(`SELECT status FROM workflows WHERE id = $1`, [id])).rows[0].status, 'draft');
  });

  it('TEST run is dry: describes every action, changes nothing, sends nothing', async () => {
    env.tg.reset();
    const g = G([TRIG, ['c', 'condition', { match: 'all', rules: [{ left: '{{trigger.message.text}}', op: 'contains', right: 'price' }] }],
      ['m', 'action', { kind: 'send_message', text: 'Hi {{customer.first_name}}, the price list is on its way.' }],
      ['tag', 'action', { kind: 'add_tag', tag: 'asked-price' }],
      ['nt', 'notification', { roles: ['owner'], title: 'Price question from {{customer.name}}', body: '' }],
      ['dl', 'delay', { amount: 2, unit: 'days' }],
      ['other', 'action', { kind: 'add_tag', tag: 'other' }]],
      [['t', 'c'], ['c', 'm', 'true'], ['m', 'tag'], ['tag', 'nt'], ['nt', 'dl'], ['c', 'other', 'false']]);
    const id = await make(a, 'Dry', g);
    const r = (await test(a, id, { message: { text: 'What is the PRICE?' }, customer: { name: 'Sara Hassan', status: 'new', tags: '', phone: '' } })).body;
    assert.equal(r.run.status, 'completed'); assert.equal(r.run.mode, 'test');
    assert.deepEqual(r.steps.map((s: any) => s.nodeId), ['t', 'c', 'm', 'tag', 'nt', 'dl']);
    assert.ok(r.steps.every((s: any) => s.dryRun));
    assert.match(r.steps[2].output.wouldDo, /Hi Sara, the price list/);
    assert.equal(r.steps[5].status, 'skipped', 'delays are skipped in tests');
    assert.equal(env.tg.callsTo('sendMessage').length, 0, 'nothing was sent');
    assert.equal((await env.owner.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1`, [a.tenantId])).rows[0].n, 0, 'no notification created');
    const f = (await test(a, id, { message: { text: 'hello' } })).body;
    assert.deepEqual(f.steps.map((s: any) => s.nodeId), ['t', 'c', 'other'], 'false branch');
    assert.equal(f.steps[1].output.result, false);
  });

  it('a test refuses to send a message with missing data instead of inventing it', async () => {
    const id = await make(a, 'Blank', G([TRIG, ['m', 'action', { kind: 'send_message', text: 'Hi {{customer.first_name}}, call {{customer.phone}}' }]], [['t', 'm']]));
    const r = (await test(a, id, { customer: { name: 'Sara', status: 'new', tags: '', phone: '' } })).body;
    assert.equal(r.run.status, 'failed');
    assert.match(r.steps[1].error, /no value for \{\{customer\.phone\}\}/);
  });

  it('test: human task is answered automatically; loop runs once per item; subprocess runs inline', async () => {
    const child = await make(a, 'Child', G([['t', 'trigger', { kind: 'manual' }], ['x', 'action', { kind: 'add_tag', tag: 'from-child' }]], [['t', 'x']]));
    const g = G([['t', 'trigger', { kind: 'manual' }],
      ['h', 'human_task', { title: 'Approve refund', instructions: '', assigneeRole: 'manager' }],
      ['ok', 'action', { kind: 'add_tag', tag: 'approved' }], ['no', 'action', { kind: 'add_note', note: 'rejected' }], ['sp', 'subprocess', { workflowId: child }]],
      [['t', 'h'], ['h', 'ok', 'approved'], ['h', 'no', 'rejected'], ['ok', 'sp']]);
    const id = await make(a, 'Task', g);
    const yes = (await test(a, id)).body;
    assert.deepEqual(yes.steps.map((s: any) => s.nodeId), ['t', 'h', 'ok', 'sp']);
    const sub = (await env.owner.query(`SELECT mode, status, depth FROM workflow_runs WHERE parent_run_id = $1`, [yes.run.id])).rows[0];
    assert.deepEqual(sub, { mode: 'test', status: 'completed', depth: 1 });
    const no = (await test(a, id, {}, { taskOutcome: 'rejected' })).body;
    assert.deepEqual(no.steps.map((s: any) => s.nodeId), ['t', 'h', 'no']);
    assert.equal((await env.owner.query(`SELECT count(*)::int AS n FROM workflow_tasks WHERE tenant_id = $1`, [a.tenantId])).rows[0].n, 0, 'no real task in a test');

    const loop = G([['t', 'trigger', { kind: 'manual' }], ['l', 'loop', { source: 'list', listVar: 'trigger.items' }], ['x', 'action', { kind: 'add_note', note: 'Item {{loop.number}} of {{loop.total}}: {{loop.item}}' }]],
      [['t', 'l'], ['l', 'x', 'body'], ['x', 'l']]);
    const lid = await make(a, 'Loop', loop);
    const lr = (await test(a, lid, { items: ['milk', 'tea', 'cake'] })).body;
    assert.equal(lr.run.status, 'completed');
    assert.equal(lr.steps.filter((s: any) => s.nodeId === 'x').length, 3);
    assert.match(lr.steps.filter((s: any) => s.nodeId === 'x')[1].output.wouldDo, /Item 2 of 3: tea/);
    assert.equal(lr.steps.at(-1).output.handle, 'done');
  });

  it('endless loops are stopped by the step limit; huge loops are refused', async () => {
    const mk = (count: number) => G([['t', 'trigger', { kind: 'manual' }], ['l', 'loop', { source: 'count', count }], ['x', 'action', { kind: 'add_note', note: 'n' }]], [['t', 'l'], ['l', 'x', 'body'], ['x', 'l']]);
    const id = await make(a, 'Long', mk(100));
    const r = (await test(a, id)).body;
    assert.equal(r.run.status, 'failed'); assert.match(r.run.error, /more than 200 steps/);
    assert.equal(r.run.stepCount, 200);
    assert.equal((await a.client.put(`/workflows/${id}/graph`, { graph: mk(101), baseVersion: 2 })).status, 200);
    const big = await test(a, id);
    assert.equal(big.status, 422, 'a loop of 101 is refused before it can run');
  });

  it('AI node: choice and text modes use the employee, and the choice drives a condition', async () => {
    env.fake.responder = (body: any) => {
      const sys = String(body.messages?.[0]?.content ?? '');
      if (/Pick exactly ONE option/.test(sys)) return JSON.stringify({ choice: 'refund' });
      return reply('Our opening hours are 9 to 5.');
    };
    const g = G([['t', 'trigger', { kind: 'manual' }],
      ['ai', 'ai_agent', { employeeId: aEmp, mode: 'choice', prompt: 'Classify: {{trigger.message.text}}', outputVar: 'intent', choices: ['refund', 'question', 'other'] }],
      ['c', 'condition', { match: 'all', rules: [{ left: '{{vars.intent}}', op: 'equals', right: 'refund' }] }],
      ['yes', 'action', { kind: 'add_tag', tag: 'refund' }], ['no', 'action', { kind: 'add_tag', tag: 'other' }]],
      [['t', 'ai'], ['ai', 'c'], ['c', 'yes', 'true'], ['c', 'no', 'false']]);
    const id = await make(a, 'AI choice', g);
    const r = (await test(a, id, { message: { text: 'I want my money back' } })).body;
    assert.equal(r.run.status, 'completed', JSON.stringify(r.steps));
    assert.equal(r.steps[1].output.choice, 'refund');
    assert.deepEqual(r.steps.map((s: any) => s.nodeId), ['t', 'ai', 'c', 'yes']);
    // an answer outside the allowed options is never trusted
    env.fake.responder = () => JSON.stringify({ choice: 'delete everything' });
    const bad = (await test(a, id, { message: { text: 'x' } })).body;
    assert.equal(bad.steps[1].output.choice, 'unknown');
    assert.deepEqual(bad.steps.map((s: any) => s.nodeId), ['t', 'ai', 'c', 'no']);
    env.fake.responder = () => reply('Our opening hours are 9 to 5.');
    const tid = await make(a, 'AI text', G([['t', 'trigger', { kind: 'manual' }], ['ai', 'ai_agent', { employeeId: aEmp, mode: 'text', prompt: 'When are you open?', outputVar: 'answer' }]], [['t', 'ai']]));
    const tr = (await test(a, tid)).body;
    assert.equal(tr.run.status, 'completed');
    assert.match(tr.run.vars.answer, /9 to 5/);
    assert.ok((await env.owner.query(`SELECT count(*)::int AS n FROM ai_usage WHERE tenant_id = $1 AND purpose = 'workflow'`, [a.tenantId])).rows[0].n >= 2, 'AI calls are metered');
    await env.owner.query(`UPDATE ai_employees SET status = 'paused' WHERE id = $1`, [aEmp]);
    const off = (await test(a, tid)).body;
    assert.equal(off.run.status, 'failed'); assert.match(off.steps[1].error, /not active/);
    await env.owner.query(`UPDATE ai_employees SET status = 'active' WHERE id = $1`, [aEmp]);
  });

  describe('LIVE runs (stand-in Telegram, synthetic customers)', () => {
    it('a customer message starts the workflow once: message sent, tag added, run logged; replays do nothing', async () => {
      await pauseAll(a); env.tg.reset();
      const g = G([['t', 'trigger', { kind: 'message_received', containsAny: ['price'] }],
        ['m', 'action', { kind: 'send_message', text: 'Hi {{customer.first_name}}, we will send you the price list.' }],
        ['tag', 'action', { kind: 'add_tag', tag: 'Asked Price' }], ['st', 'action', { kind: 'set_customer_status', status: 'lead' }],
        ['nt', 'notification', { roles: ['owner'], title: 'Price question', body: 'From {{customer.name}}' }]],
        [['t', 'm'], ['m', 'tag'], ['tag', 'st'], ['st', 'nt']]);
      const id = await make(a, 'Price replies', g, true);
      await hook(update(5001, 1, 'hello there', 'Layla')); await settle();
      assert.equal((await runsOf(id)).length, 0, 'the keyword filter did not match');
      const u = update(5001, 2, 'What is the price of a latte?', 'Layla');
      await hook(u); await settle();
      const runs = await runsOf(id);
      assert.equal(runs.length, 1); assert.equal(runs[0].status, 'completed', JSON.stringify(await stepsOf(runs[0].id)));
      assert.deepEqual(sent(), ['Hi Layla, we will send you the price list.']);
      const ct = await contact('5001');
      assert.deepEqual([ct.tags, ct.status], [['asked price'], 'lead']);
      const msg = (await env.owner.query(`SELECT sender_type, status, meta FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = $1) AND direction = 'out'`, [ct.id])).rows;
      assert.equal(msg.length, 1); assert.equal(msg[0].sender_type, 'system'); assert.ok(msg[0].meta.workflowStepKey);
      assert.equal((await env.owner.query(`SELECT count(*)::int AS n FROM customer_events WHERE contact_id = $1 AND detail->>'source' = 'workflow'`, [ct.id])).rows[0].n, 2, 'tag + status are in the customer history');
      const notes = (await a.client.get('/notifications')).body;
      assert.equal(notes.unread, 1); assert.equal(notes.items[0].title, 'Price question');
      assert.equal((await aManager.get('/notifications')).body.items.length, 0, 'notifications are per person');
      assert.equal((await b.client.get('/notifications')).body.items.length, 0);
      await hook(u); await settle(); // webhook replay
      assert.equal((await runsOf(id)).length, 1); assert.equal(sent().length, 1, 'no second message');
      assert.equal((await a.client.post('/notifications/read', {})).body.updated, 1);
      assert.equal((await a.client.get('/notifications')).body.unread, 0);
    });

    it('the same event can never start the same workflow twice (dedupe key), a paused workflow does not run', async () => {
      await pauseAll(a);
      const id = await make(a, 'Dedupe', G([['t', 'trigger', { kind: 'conversation_handoff' }]], []), true);
      const p = { platform: 'telegram', conversationId: null, contactId: null, dedupe: 'same-event' };
      assert.equal(await env.app.workflows.emit(a.tenantId, 'conversation_handoff', p), 1);
      assert.equal(await env.app.workflows.emit(a.tenantId, 'conversation_handoff', p), 0);
      await settle();
      assert.equal((await runsOf(id)).length, 1);
      assert.equal((await a.client.post(`/workflows/${id}/pause`)).status, 200);
      assert.equal(await env.app.workflows.emit(a.tenantId, 'conversation_handoff', { ...p, dedupe: 'another' }), 0, 'paused workflows ignore events');
    });

    it('live runs use the ACTIVE version, not later drafts', async () => {
      await pauseAll(a);
      const id = await make(a, 'Versioned', G([['t', 'trigger', { kind: 'customer_status_changed', toStatus: 'customer' }], ['x', 'action', { kind: 'add_tag', tag: 'v-two' }]], [['t', 'x']]), true);
      const draft = (await a.client.get(`/workflows/${id}`)).body;
      await a.client.put(`/workflows/${id}/graph`, { graph: G([['t', 'trigger', { kind: 'customer_status_changed', toStatus: 'customer' }], ['x', 'action', { kind: 'add_tag', tag: 'v-three' }]], [['t', 'x']]), baseVersion: draft.latestVersion });
      await hook(update(5002, 1, 'hi', 'Omar')); await settle();
      const ct = await contact('5002');
      assert.equal((await a.client.patch(`/customers/${ct.id}`, { status: 'customer' })).status, 200); await settle();
      assert.deepEqual((await contact('5002')).tags, ['v-two'], 'the published version ran, not the newer draft');
      assert.equal((await a.client.post(`/workflows/${id}/activate`, {})).status, 200);
      await a.client.patch(`/customers/${ct.id}`, { status: 'lead' }); await a.client.patch(`/customers/${ct.id}`, { status: 'customer' }); await settle();
      assert.deepEqual((await contact('5002')).tags.sort(), ['v-three', 'v-two']);
    });

    it('delay: the run waits, is not touched early, resumes when due, and can be cancelled', async () => {
      await pauseAll(a);
      const id = await make(a, 'Follow-up', G([['t', 'trigger', { kind: 'message_received', containsAny: ['later'] }], ['d', 'delay', { amount: 1, unit: 'days' }], ['x', 'action', { kind: 'add_tag', tag: 'followed-up' }]], [['t', 'd'], ['d', 'x']]), true);
      await hook(update(5003, 1, 'maybe later', 'Hana')); await settle();
      let [run] = await runsOf(id);
      assert.equal(run.status, 'waiting'); assert.equal(run.wait_kind, 'delay');
      assert.ok(new Date(run.resume_at).getTime() > Date.now() + 23 * 3600_000);
      await env.app.workflows.tick(); await settle();
      assert.equal((await runsOf(id))[0].status, 'waiting', 'not due yet');
      assert.deepEqual((await contact('5003')).tags, []);
      await env.owner.query(`UPDATE workflow_runs SET resume_at = now() - interval '1 minute' WHERE id = $1`, [run.id]);
      assert.equal(await env.app.workflows.tick(), 1); await settle();
      [run] = await runsOf(id);
      assert.equal(run.status, 'completed'); assert.deepEqual((await contact('5003')).tags, ['followed-up']);
      // cancel path
      await hook(update(5004, 1, 'later please', 'Ziad')); await settle();
      const waiting = (await runsOf(id)).find((r) => r.status === 'waiting')!;
      assert.equal((await aViewer.post(`/workflow-runs/${waiting.id}/cancel`)).status, 403);
      assert.equal((await a.client.post(`/workflow-runs/${waiting.id}/cancel`)).status, 200);
      await env.owner.query(`UPDATE workflow_runs SET resume_at = now() - interval '1 minute' WHERE id = $1`, [waiting.id]);
      assert.equal(await env.app.workflows.tick(), 0, 'cancelled runs are never resumed'); await settle();
      assert.deepEqual((await contact('5004')).tags, []);
      assert.equal((await a.client.post(`/workflow-runs/${waiting.id}/cancel`)).status, 409);
    });

    it('human task: waits for a person, role is enforced, the answer picks the branch', async () => {
      await pauseAll(a);
      const g = G([['t', 'trigger', { kind: 'message_received', containsAny: ['refund'] }],
        ['h', 'human_task', { title: 'Refund for {{customer.name}}?', instructions: 'Check the order first.', assigneeRole: 'admin', dueHours: 2 }],
        ['ok', 'action', { kind: 'add_tag', tag: 'refund-ok' }], ['no', 'action', { kind: 'add_tag', tag: 'refund-no' }], ['to', 'action', { kind: 'add_tag', tag: 'refund-timeout' }]],
        [['t', 'h'], ['h', 'ok', 'approved'], ['h', 'no', 'rejected'], ['h', 'to', 'timeout']]);
      const id = await make(a, 'Refund approval', g, true);
      await hook(update(5005, 1, 'I need a refund', 'Dina')); await settle();
      const run = (await runsOf(id))[0];
      assert.equal(run.status, 'waiting'); assert.equal(run.wait_kind, 'task');
      const tasks = (await a.client.get('/workflow-tasks')).body.items;
      assert.equal(tasks.length, 1); assert.equal(tasks[0].title, 'Refund for Dina?'); assert.equal(tasks[0].workflowName, 'Refund approval');
      assert.equal((await b.client.get('/workflow-tasks')).body.items.length, 0, 'other companies never see it');
      assert.equal((await aViewer.post(`/workflow-tasks/${tasks[0].id}/complete`, { outcome: 'approved' })).status, 403, 'viewer has no permission');
      const low = await aManager.post(`/workflow-tasks/${tasks[0].id}/complete`, { outcome: 'approved' });
      assert.equal(low.status, 403, 'an admin-level task cannot be answered by a manager'); assert.equal(low.body.error.code, 'forbidden');
      assert.equal((await a.client.post(`/workflow-tasks/${tasks[0].id}/complete`, { outcome: 'rejected', note: 'Not eligible' })).status, 200); await settle();
      assert.equal((await runsOf(id))[0].status, 'completed');
      assert.deepEqual((await contact('5005')).tags, ['refund-no']);
      assert.equal((await a.client.post(`/workflow-tasks/${tasks[0].id}/complete`, { outcome: 'approved' })).status, 409, 'answered once only');
      const detail = (await a.client.get(`/workflow-runs/${run.id}`)).body;
      assert.deepEqual(detail.steps.map((s: any) => `${s.nodeId}:${s.status}`), ['t:ok', 'h:waiting', 'h:ok', 'no:ok']);
      assert.equal(detail.tasks[0].outcome, 'rejected');
      // deadline passes without an answer: the timeout branch runs
      await hook(update(5006, 1, 'refund please', 'Ola')); await settle();
      const r2 = (await runsOf(id)).find((r) => r.status === 'waiting')!;
      await env.owner.query(`UPDATE workflow_tasks SET due_at = now() - interval '1 minute' WHERE run_id = $1`, [r2.id]);
      await env.owner.query(`UPDATE workflow_runs SET resume_at = now() - interval '1 minute' WHERE id = $1`, [r2.id]);
      await env.app.workflows.tick(); await settle();
      assert.deepEqual((await contact('5006')).tags, ['refund-timeout']);
      assert.equal((await env.owner.query(`SELECT status FROM workflow_tasks WHERE run_id = $1`, [r2.id])).rows[0].status, 'expired');
      // the manager is told about open tasks; an approval task for a manager can be answered by a manager
      const mt = await make(a, 'Mgr task', G([['t', 'trigger', { kind: 'message_received', containsAny: ['mgrtask'] }], ['h', 'human_task', { title: 'Check', instructions: '', assigneeRole: 'manager' }], ['ok', 'action', { kind: 'add_tag', tag: 'mgr-ok' }]], [['t', 'h'], ['h', 'ok', 'approved']]), true);
      await hook(update(5007, 1, 'mgrtask', 'Sami')); await settle();
      const mtask = (await a.client.get('/workflow-tasks')).body.items.find((x: any) => x.title === 'Check');
      assert.equal((await aManager.post(`/workflow-tasks/${mtask.id}/complete`, { outcome: 'approved' })).status, 200); await settle();
      assert.deepEqual((await contact('5007')).tags, ['mgr-ok']);
      assert.ok((await aManager.get('/notifications')).body.items.some((x: any) => x.title === 'Task: Check'), 'staff are notified of the task');
      assert.equal((await runsOf(mt)).length, 1);
    });

    it('subprocess: the parent waits for a live child run; circles are refused', async () => {
      await pauseAll(a);
      const child = await make(a, 'Tag child', G([['t', 'trigger', { kind: 'manual' }], ['d', 'delay', { amount: 1, unit: 'minutes' }], ['x', 'action', { kind: 'add_tag', tag: 'child-done' }]], [['t', 'd'], ['d', 'x']]), true);
      const parent = await make(a, 'Parent', G([['t', 'trigger', { kind: 'message_received', containsAny: ['sub'] }], ['s', 'subprocess', { workflowId: child }], ['y', 'action', { kind: 'add_tag', tag: 'parent-done' }]], [['t', 's'], ['s', 'y']]), true);
      await hook(update(5008, 1, 'sub please', 'Nadia')); await settle();
      const p = (await runsOf(parent))[0];
      assert.equal(p.status, 'waiting'); assert.equal(p.wait_kind, 'child');
      const kid = (await env.owner.query(`SELECT * FROM workflow_runs WHERE parent_run_id = $1`, [p.id])).rows[0];
      assert.equal(kid.status, 'waiting'); assert.equal(kid.depth, 1);
      assert.deepEqual((await contact('5008')).tags, []);
      await env.owner.query(`UPDATE workflow_runs SET resume_at = now() - interval '1 minute' WHERE id = $1`, [kid.id]);
      await env.app.workflows.tick(); await settle();
      assert.deepEqual((await contact('5008')).tags.sort(), ['child-done', 'parent-done']);
      assert.equal((await runsOf(parent))[0].status, 'completed');
      // a calls b, b calls a
      const x = (await a.client.post('/workflows', { name: 'Circle A' })).body.id, y = (await a.client.post('/workflows', { name: 'Circle B' })).body.id;
      await a.client.put(`/workflows/${x}/graph`, { graph: G([['t', 'trigger', { kind: 'manual' }], ['s', 'subprocess', { workflowId: y }]], [['t', 's']]), baseVersion: 1 });
      await a.client.put(`/workflows/${y}/graph`, { graph: G([['t', 'trigger', { kind: 'manual' }], ['s', 'subprocess', { workflowId: x }]], [['t', 's']]), baseVersion: 1 });
      const r = await a.client.get(`/workflows/${y}`);
      assert.ok(r.body.issues.some((i: any) => i.code === 'subprocess_cycle'), JSON.stringify(r.body.issues));
      assert.equal((await a.client.post(`/workflows/${y}/activate`, {})).status, 422);
      // a workflow used as a subprocess cannot be deleted
      assert.equal((await a.client.del(`/workflows/${child}`)).status, 409);
      // an inactive child makes the parent fail at that step, loudly
      await env.owner.query(`UPDATE workflows SET status = 'paused' WHERE id = $1`, [child]);
      await hook(update(5009, 1, 'sub again', 'Rami')); await settle();
      const f = (await runsOf(parent)).find((r) => r.status === 'failed')!;
      assert.match(f.error, /not active/);
      assert.deepEqual((await contact('5009')).tags, [], 'the step after a failed step never runs');
    });

    it('messages respect opt-out, unreachable customers, channel state and the reply window', async () => {
      await pauseAll(a); env.tg.reset();
      const id = await make(a, 'Guarded send', G([['t', 'trigger', { kind: 'message_received', containsAny: ['guard'] }], ['m', 'action', { kind: 'send_message', text: 'Hello again' }]], [['t', 'm']]), true);
      await hook(update(5010, 1, 'guard test', 'Tarek')); await settle();
      assert.deepEqual(sent(), ['Hello again']);
      env.tg.reset();
      await env.owner.query(`UPDATE contacts SET consent_status = 'opted_out' WHERE external_id = '5010' AND tenant_id = $1`, [a.tenantId]);
      await hook(update(5010, 2, 'guard test 2', 'Tarek')); await settle();
      const r1 = (await runsOf(id)).at(-1)!;
      assert.equal(r1.status, 'failed'); assert.match(r1.error, /opted out/); assert.equal(sent().length, 0);
      await env.owner.query(`UPDATE contacts SET consent_status = 'unknown' WHERE external_id = '5010' AND tenant_id = $1`, [a.tenantId]);
      await env.owner.query(`UPDATE channels SET status = 'disconnected' WHERE id = $1`, [tg.id]);
      await env.app.workflows.emit(a.tenantId, 'message_received', { platform: 'telegram', conversationId: (await env.owner.query(`SELECT id FROM conversations WHERE contact_id = $1`, [(await contact('5010')).id])).rows[0].id, contactId: (await contact('5010')).id, channelId: tg.id, text: 'guard', dedupe: 'x1' }); await settle();
      assert.match((await runsOf(id)).at(-1)!.error, /disconnected/);
      await env.owner.query(`UPDATE channels SET status = 'connected' WHERE id = $1`, [tg.id]);
      // Messenger: outside 24h is refused
      const ch = (await env.owner.query(`INSERT INTO channels (tenant_id, type, provider, name, status, public_key) VALUES ($1, 'messenger', 'meta', 'FB', 'connected', 'pk_wf_fb') RETURNING id`, [a.tenantId])).rows[0].id;
      const ct = (await env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id, name, last_inbound_at) VALUES ($1, $2, 'fb1', 'Old Friend', now() - interval '3 days') RETURNING id`, [a.tenantId, ch])).rows[0].id;
      const cv = (await env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id, last_inbound_at) VALUES ($1, $2, 'messenger', $3, now() - interval '3 days') RETURNING id`, [a.tenantId, ch, ct])).rows[0].id;
      await env.app.workflows.emit(a.tenantId, 'message_received', { platform: 'messenger', conversationId: cv, contactId: ct, channelId: ch, text: 'guard', dedupe: 'x2' }); await settle();
      assert.match((await runsOf(id)).at(-1)!.error, /reply window/);
    });

    it('step side effects are idempotent at the database level', async () => {
      const cv = (await env.owner.query(`SELECT id, channel_id FROM conversations WHERE tenant_id = $1 LIMIT 1`, [a.tenantId])).rows[0];
      const ins = () => env.owner.query(`INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status, meta) VALUES ($1, $2, $3, 'out', 'system', 'x', 'queued', '{"workflowStepKey": "run:node:1"}')`, [a.tenantId, cv.channel_id, cv.id]);
      await ins();
      await assert.rejects(ins(), /messages_workflow_step_uq/);
    });

    it('a crashed run (stale lock) is recovered by the worker and finishes without repeating finished steps', async () => {
      await pauseAll(a); env.tg.reset();
      const id = await make(a, 'Recover', G([['t', 'trigger', { kind: 'message_received', containsAny: ['recover'] }], ['m', 'action', { kind: 'send_message', text: 'Once only' }], ['x', 'action', { kind: 'add_tag', tag: 'recovered' }]], [['t', 'm'], ['m', 'x']]), true);
      await hook(update(5011, 1, 'recover me', 'Lina')); await settle();
      const run = (await runsOf(id))[0];
      assert.equal(run.status, 'completed'); assert.equal(sent().length, 1);
      // Simulate a crash right after step 2 (the message): the run was "running" with an old lock, pointing at step 3.
      await env.owner.query(`UPDATE workflow_runs SET status = 'running', locked_at = now() - interval '10 minutes', current_node = 'x', step_count = 2, finished_at = NULL WHERE id = $1`, [run.id]);
      await env.owner.query(`DELETE FROM workflow_steps WHERE run_id = $1 AND seq = 3`, [run.id]);
      await env.owner.query(`UPDATE contacts SET tags = '{}' WHERE external_id = '5011' AND tenant_id = $1`, [a.tenantId]);
      assert.equal(await env.app.workflows.tick(), 1); await settle();
      assert.equal((await runsOf(id))[0].status, 'completed');
      assert.equal(sent().length, 1, 'the message was not sent a second time');
      assert.deepEqual((await contact('5011')).tags, ['recovered']);
    });

    it('at most 60 live runs per workflow per minute; the rest are skipped and logged', async () => {
      await pauseAll(a);
      const id = await make(a, 'Burst', G([['t', 'trigger', { kind: 'conversation_handoff' }]], []), true);
      let started = 0;
      for (let i = 0; i < MAX_LIVE_PER_MINUTE + 5; i++) started += await env.app.workflows.emit(a.tenantId, 'conversation_handoff', { platform: 'telegram', dedupe: `burst-${i}` });
      await settle();
      assert.equal(started, MAX_LIVE_PER_MINUTE); assert.equal((await runsOf(id)).length, MAX_LIVE_PER_MINUTE);
      assert.equal((await env.owner.query(`SELECT count(*)::int AS n FROM system_errors WHERE tenant_id = $1 AND code = 'rate_limited'`, [a.tenantId])).rows[0].n, 5);
    });

    it('hand-off action moves the conversation to a person and workflow messages never trigger workflows', async () => {
      await pauseAll(a); env.tg.reset();
      const id = await make(a, 'Escalate', G([['t', 'trigger', { kind: 'message_received', containsAny: ['manager'] }], ['h', 'action', { kind: 'handoff_to_human', reason: 'Customer asked for the manager' }], ['m', 'action', { kind: 'send_message', text: 'A person will reply soon.' }]], [['t', 'h'], ['h', 'm']]), true);
      await hook(update(5012, 1, 'I want the manager', 'Karim')); await settle();
      const cv = (await env.owner.query(`SELECT handler, status, handoff_reason FROM conversations WHERE contact_id = $1`, [(await contact('5012')).id])).rows[0];
      assert.deepEqual(cv, { handler: 'human', status: 'pending', handoff_reason: 'Customer asked for the manager' });
      assert.deepEqual(sent(), ['A person will reply soon.']);
      assert.equal((await runsOf(id)).length, 1, 'the outgoing message did not start another run');
    });
  });

  describe('Company isolation and database permissions', () => {
    it('another company cannot see, test, activate or run a workflow', async () => {
      const id = await make(a, 'Private', G([['t', 'trigger', { kind: 'manual' }]], []));
      assert.equal((await b.client.get(`/workflows/${id}`)).status, 404);
      assert.equal((await b.client.post(`/workflows/${id}/test`, {})).status, 404);
      assert.equal((await b.client.post(`/workflows/${id}/activate`, {})).status, 404);
      assert.equal((await b.client.put(`/workflows/${id}/graph`, { graph: G([['t', 'trigger', { kind: 'manual' }]], []), baseVersion: 1 })).status, 404);
      assert.equal((await b.client.del(`/workflows/${id}`)).status, 404);
      assert.equal((await b.client.get('/workflows')).body.items.length, 0);
      const run = (await test(a, id)).body.run.id;
      assert.equal((await b.client.get(`/workflow-runs/${run}`)).status, 404);
      assert.ok([404, 409].includes((await b.client.post(`/workflow-runs/${run}/cancel`)).status));
      // B's workflow cannot call A's workflow as a subprocess
      const bw = (await b.client.post('/workflows', { name: 'Spy' })).body.id;
      await b.client.put(`/workflows/${bw}/graph`, { graph: G([['t', 'trigger', { kind: 'manual' }], ['s', 'subprocess', { workflowId: id }]], [['t', 's']]), baseVersion: 1 });
      assert.ok((await b.client.get(`/workflows/${bw}`)).body.issues.some((i: any) => i.code === 'subprocess_missing'));
      // ... nor use A's AI employee
      await b.client.put(`/workflows/${bw}/graph`, { graph: G([['t', 'trigger', { kind: 'manual' }], ['x', 'ai_agent', { employeeId: aEmp, mode: 'text', prompt: 'hi', outputVar: 'r' }]], [['t', 'x']]), baseVersion: 2 });
      assert.ok((await b.client.get(`/workflows/${bw}`)).body.issues.some((i: any) => i.code === 'employee_missing'));
    });
    it('row-level security: a tenant context sees only its own workflow data; platform admins see none', async () => {
      for (const t of ['workflows', 'workflow_versions', 'workflow_runs', 'workflow_steps', 'workflow_tasks', 'notifications']) {
        const mine = await withTenant(env.app.pools.app, b.tenantId, (c) => c.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_id <> $1)::int AS foreign FROM ${t}`, [b.tenantId]));
        assert.equal(mine.rows[0].foreign, 0, `${t}: no foreign rows visible`);
        await assert.rejects(env.app.pools.platform.query(`SELECT 1 FROM ${t} LIMIT 1`), /permission denied/, `${t}: platform role has no access`);
      }
      await assert.rejects(withTenant(env.app.pools.app, b.tenantId, (c) => c.query(`INSERT INTO workflows (tenant_id, name) VALUES ($1, 'x')`, [a.tenantId])), /row-level security/);
    });
  });
});
