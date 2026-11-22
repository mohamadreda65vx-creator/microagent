import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { Client, createTestEnv, inviteMember, signupTenant, type TestEnv, type Tenant } from './helpers.js';

let env: TestEnv;
let a: Tenant;
let b: Tenant;
let aManager: Client;
let aViewer: Client;
let aEmp: string;
let bEmp: string;

const PRICES: Record<string, number> = { latte: 45, cappuccino: 60, 'mocha charger': 99, croissant: 25, baguette: 15 };
/** A well-behaved model: states the confirmed price of whatever product is asked about, otherwise defers to the team. */
const goodModel = (body: any) => {
  const q = lastUser(body).toLowerCase();
  const hit = Object.keys(PRICES).find((k) => q.includes(k));
  return /how much/.test(q) && hit ? reply(`The ${hit} costs ${PRICES[hit]} EGP.`) : reply('Sorry, I will check with the team.');
};
const reply = (text: string, actions: unknown[] = []) => JSON.stringify({ reply: text, actions });
const lastUser = (body: any): string => [...body.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
const sim = (t: Tenant, emp: string, message: string, history: unknown[] = []) => t.client.post(`/ai-employees/${emp}/simulate`, { message, history });
const teach = async (t: Tenant, instruction: string, employeeId: string | null) => {
  const p = await t.client.post('/teach/preview', { instruction, employeeId });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return t.client.post('/teach/rules', { instruction, employeeId, effects: p.body.proposals.map((x: any) => x.effect) });
};

describe('AI employees: profile, permissions, agent runtime, versions, isolation', () => {
  before(async () => {
    env = await createTestEnv();
    a = await signupTenant(env, 'Cafe Nile');
    b = await signupTenant(env, 'Gadget Shop');
    aManager = await inviteMember(env, a, 'manager');
    aViewer = await inviteMember(env, a, 'viewer');
    const mk = async (t: Tenant, name: string, extra: object = {}) => (await t.client.post('/ai-employees', { name, tasks: ['sales_assistant', 'order_assistance', 'customer_support', 'human_handoff'], ...extra })).body.id as string;
    aEmp = await mk(a, 'Nour');
    bEmp = await mk(b, 'Omar');
    await a.client.post('/knowledge/items', { kind: 'product', name: 'Latte', data: { price: 45, currency: 'EGP' } });
    await a.client.post('/knowledge/items', { kind: 'offer', name: 'Weekend 10% off drinks', data: { percent: 10 } });
    await b.client.post('/knowledge/items', { kind: 'product', name: 'Mocha Charger', data: { price: 99, currency: 'EGP' } });
    env.fake.responder = () => reply('Sorry, I will check with the team.');
  });
  after(async () => { await env.close(); });

  describe('profile & versions', () => {
    it('creates an employee with the full profile; tasks/channels/dialect validated; starts as draft', async () => {
      const r = await a.client.post('/ai-employees', { name: 'Layla', jobTitle: 'Support', description: 'd', personality: 'warm', avatar: 'bot-3', language: 'ar', dialect: 'egyptian', tasks: ['customer_support', 'faq'], channels: ['whatsapp', 'website_chat'], knowledgeMode: 'all' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.status, 'draft');
      assert.deepEqual(r.body.tasks.sort(), ['customer_support', 'faq']);
      assert.equal(r.body.dialect, 'egyptian');
      assert.equal(r.body.version, 1);
      assert.equal((await a.client.post('/ai-employees', { name: 'X', tasks: ['hack'] })).status, 400);
      assert.equal((await a.client.post('/ai-employees', { name: 'X', channels: ['sms'] })).status, 400);
      assert.equal((await a.client.post('/ai-employees', { name: 'X', dialect: 'klingon' })).status, 400);
      assert.equal((await a.client.post('/ai-employees', { name: 'X', avatar: '../etc' })).status, 400);
    });

    it('keeps version history and can roll back; rollback is a new version, never a rewrite', async () => {
      const id = (await a.client.post('/ai-employees', { name: 'V1 name', tasks: ['faq'] })).body.id;
      await a.client.patch(`/ai-employees/${id}`, { name: 'V2 name' });
      await a.client.patch(`/ai-employees/${id}`, { name: 'V3 name', personality: 'strict' });
      const vs = (await a.client.get(`/ai-employees/${id}/versions`)).body.items as any[];
      assert.deepEqual(vs.map((v) => v.version), [3, 2, 1]);
      assert.equal((await aManager.post(`/ai-employees/${id}/rollback`, { version: 1 })).status, 403, 'manager cannot roll back');
      const rb = await a.client.post(`/ai-employees/${id}/rollback`, { version: 1 });
      assert.equal(rb.status, 200, JSON.stringify(rb.body));
      const now = (await a.client.get(`/ai-employees/${id}`)).body;
      assert.equal(now.name, 'V1 name');
      assert.equal(now.personality, '');
      assert.equal(now.version, 4);
      assert.equal(((await a.client.get(`/ai-employees/${id}/versions`)).body.items as any[]).length, 4);
      assert.equal((await a.client.get(`/ai-employees/${id}/versions/2`)).body.snapshot.name, 'V2 name', 'old versions are untouched');
      assert.equal((await a.client.post(`/ai-employees/${id}/rollback`, { version: 99 })).status, 404);
    });

    it('roles: viewer cannot edit; manager can edit text but NOT permissions', async () => {
      assert.equal((await aViewer.patch(`/ai-employees/${aEmp}`, { name: 'x' })).status, 403);
      assert.equal((await aViewer.get(`/ai-employees/${aEmp}`)).status, 200);
      assert.equal((await aManager.patch(`/ai-employees/${aEmp}`, { personality: 'kind' })).status, 200);
      assert.equal((await aManager.patch(`/ai-employees/${aEmp}`, { permissions: { give_discount: { mode: 'allow', maxPercent: 90 } } })).status, 403);
      assert.equal((await aManager.post('/ai-employees', { name: 'M', permissions: { give_discount: { mode: 'allow', maxPercent: 90 } } })).status, 403);
      assert.equal((await aManager.post(`/ai-employees/${aEmp}/status`, { status: 'active' })).status, 403);
    });

    it('permissions are validated: hand-off cannot be denied, limits are bounded', async () => {
      assert.equal((await a.client.patch(`/ai-employees/${aEmp}`, { permissions: { handoff_to_human: { mode: 'deny' } } })).status, 400);
      assert.equal((await a.client.patch(`/ai-employees/${aEmp}`, { permissions: { give_discount: { mode: 'allow', maxPercent: 500 } } })).status, 400);
      assert.equal((await a.client.patch(`/ai-employees/${aEmp}`, { permissions: { launch_missiles: { mode: 'allow' } } })).status, 400);
    });

    it('permission changes are audited with before/after', async () => {
      const r = await a.client.patch(`/ai-employees/${aEmp}`, { permissions: { give_discount: { mode: 'allow', maxPercent: 10 } } });
      assert.equal(r.status, 200);
      const log = (await a.client.get('/audit-logs?action=ai_employee.permissions_changed')).body.items[0];
      assert.equal(log.entityId, aEmp);
      assert.equal(log.meta.from.give_discount.mode, 'deny');
      assert.equal(log.meta.to.give_discount.maxPercent, 10);
      assert.equal((await aViewer.get('/audit-logs')).status, 403, 'only owner/admin read audit logs');
    });
  });

  describe('agent runtime (the backend, not the prompt, decides)', () => {
    it('answers with a confirmed price; the prompt contains only this company’s confirmed facts', async () => {
      env.fake.reset();
      env.fake.responder = () => reply('The Latte costs 45 EGP.');
      const r = await sim(a, aEmp, 'How much is the Latte?');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.reply, 'The Latte costs 45 EGP.');
      assert.deepEqual(r.body.findings, []);
      assert.ok(r.body.facts.some((f: any) => f.name === 'Latte'));
      const sent = JSON.stringify(env.fake.chatCalls.at(-1)!.body);
      assert.ok(sent.includes('Latte') && !sent.includes('Mocha Charger'), 'company B’s facts never reach company A’s prompt');
    });

    it('an invented price is blocked and replaced by a safe answer', async () => {
      env.fake.responder = () => reply('The Latte costs 52 EGP.');
      const r = await sim(a, aEmp, 'How much is the Latte?');
      assert.equal(r.body.modelReply, 'The Latte costs 52 EGP.');
      assert.notEqual(r.body.reply, r.body.modelReply);
      assert.ok(r.body.findings.some((f: any) => f.code === 'price_not_in_knowledge'));
      assert.ok(!/52/.test(r.body.reply));
    });

    it('a stock claim is blocked (no inventory source is connected)', async () => {
      env.fake.responder = () => reply('Yes, the Latte is in stock, only 3 left!');
      const r = await sim(a, aEmp, 'Is the latte available?');
      assert.ok(r.body.findings.some((f: any) => f.code === 'stock_claim'));
      assert.ok(!/stock|left/i.test(r.body.reply.replace(/check with the team/i, '')));
    });

    it('discounts: allowed up to the limit, denied above it, recorded in agent_actions', async () => {
      env.fake.responder = () => reply('Sure, here is 5% off.', [{ type: 'give_discount', params: { percent: 5, item: 'Latte' } }]);
      const ok = await sim(a, aEmp, 'discount please');
      assert.equal(ok.body.decisions[0].decision, 'allowed');
      env.fake.responder = () => reply('Sure, here is 20% off!', [{ type: 'give_discount', params: { percent: 20 } }]);
      const no = await sim(a, aEmp, 'bigger discount please');
      assert.equal(no.body.decisions[0].decision, 'denied');
      assert.equal(no.body.decisions[0].reasons[0].code, 'exceeds_limit');
      assert.ok(!/20%/.test(no.body.reply));
      const rows = (await env.owner.query(`SELECT decision FROM agent_actions WHERE tenant_id = $1 AND type = 'give_discount' ORDER BY created_at`, [a.tenantId])).rows.map((r) => r.decision);
      assert.deepEqual(rows, ['allowed', 'denied']);
    });

    it('a quoted REAL offer is fine; an unapproved percentage in text (no action) is still blocked', async () => {
      env.fake.responder = () => reply('This weekend we have 10% off drinks.');
      assert.deepEqual((await sim(a, aEmp, 'any offers?')).body.findings, []);
      env.fake.responder = () => reply('I can do 40% off just for you.');
      const r = await sim(a, aEmp, 'any offers?');
      assert.ok(r.body.findings.some((f: any) => f.code === 'unapproved_discount'));
    });

    it('Teach rule "no discounts" overrides the employee’s own permission (company-wide rule, API → backend)', async () => {
      const t = await teach(a, 'ممنوع تقدم أي خصومات للعملاء', null);
      assert.equal(t.status, 201, JSON.stringify(t.body));
      env.fake.responder = () => reply('Here is 5% off.', [{ type: 'give_discount', params: { percent: 5 } }]);
      const r = await sim(a, aEmp, 'discount?');
      assert.equal(r.body.decisions[0].decision, 'denied');
      assert.equal(r.body.decisions[0].reasons[0].code, 'blocked_by_rule');
      // …and it is a company-wide rule, but ONLY for company A:
      env.fake.responder = () => reply('ok');
    });

    it('rule "collect phone before order": order is invalid without a phone; with a phone it needs approval; approval is final', async () => {
      await a.client.patch(`/ai-employees/${aEmp}`, { permissions: { give_discount: { mode: 'allow', maxPercent: 10 }, create_order: { mode: 'require_approval' } } });
      assert.equal((await teach(a, 'Collect the customer phone number before creating an order', aEmp)).status, 201);
      env.fake.responder = () => reply('Your order is placed!', [{ type: 'create_order', params: { items: [{ name: 'Latte', quantity: 2 }] } }]);
      const noPhone = await sim(a, aEmp, 'I want 2 lattes');
      assert.equal(noPhone.body.decisions[0].decision, 'invalid');
      assert.ok(!/placed/i.test(noPhone.body.reply), 'does not claim the order is placed');
      assert.match(noPhone.body.reply, /phone/i);

      const withPhone = await sim(a, aEmp, 'I want 2 lattes, my number is 01001234567');
      assert.equal(withPhone.body.decisions[0].decision, 'pending_approval');
      assert.ok(!/placed/i.test(withPhone.body.reply));

      assert.equal(((await a.client.get('/approvals')).body.items as any[]).length, 0, 'simulation actions do not appear in the live approval queue');
      const list = (await a.client.get('/approvals?mode=simulation')).body.items as any[];
      assert.equal(list.length, 1);
      assert.equal((await aViewer.post(`/approvals/${list[0].id}/decision`, { decision: 'approved' })).status, 403);
      assert.equal((await aManager.post(`/approvals/${list[0].id}/decision`, { decision: 'approved', note: 'ok' })).status, 200);
      assert.equal((await a.client.post(`/approvals/${list[0].id}/decision`, { decision: 'rejected' })).status, 409, 'a decision is final');
      assert.equal((await b.client.post(`/approvals/${list[0].id}/decision`, { decision: 'rejected' })).status, 404, 'other company cannot decide it');
      await assert.rejects(env.owner.query(`UPDATE agent_actions SET approval_status = 'rejected' WHERE id = $1`, [list[0].id]), /approval_already_decided/, 'the database refuses too');
    });

    it('hand-off rule for angry customers triggers WITHOUT calling the model', async () => {
      assert.equal((await teach(a, 'If the customer is angry, hand them to a human', aEmp)).status, 201);
      env.fake.reset();
      const r = await sim(a, aEmp, 'This is unacceptable! You are all useless!');
      assert.ok(r.body.handoff);
      assert.equal(r.body.usedModel, false);
      assert.equal(env.fake.chatCalls.length, 0);
      assert.equal(r.body.decisions[0].type, 'handoff_to_human');
      // Egyptian Arabic customer → Arabic safe reply
      const ar = await sim(a, aEmp, 'ده نصب وأنا زهقت منكم');
      assert.ok(ar.body.handoff && /[؀-ۿ]/.test(ar.body.reply));
    });

    it('a customer asking for a person is handed over (Human Handoff task)', async () => {
      env.fake.reset();
      const r = await sim(a, aEmp, 'Can I talk to a real person?');
      assert.ok(r.body.handoff);
      assert.equal(env.fake.chatCalls.length, 0);
    });

    it('rules about the dialect change the prompt (Egyptian dialect)', async () => {
      assert.equal((await teach(a, 'اتكلم بالمصري مع العملاء', aEmp)).status, 201);
      env.fake.reset();
      env.fake.responder = () => reply('أهلا بيك!');
      await sim(a, aEmp, 'hello');
      assert.match(JSON.stringify(env.fake.chatCalls.at(-1)!.body), /Egyptian Arabic/);
    });

    it('when the AI is down the employee never improvises: safe reply + hand-off, no key leaked, usage recorded', async () => {
      env.fake.reset();
      env.fake.enqueue({ status: 401, body: { error: { message: 'No auth credentials found' } } });
      const r = await sim(a, aEmp, 'How much is the Latte?');
      assert.equal(r.status, 200);
      assert.equal(r.body.error.code, 'ai_auth');
      assert.ok(r.body.handoff);
      assert.ok(!JSON.stringify(r.body).includes('test-key-SECRET'));
      const u = await env.owner.query(`SELECT status, error_code FROM ai_usage WHERE tenant_id = $1 AND status = 'error' ORDER BY id DESC LIMIT 1`, [a.tenantId]);
      assert.equal(u.rows[0].error_code, 'ai_auth');
    });

    it('token usage is tracked per company and visible only to its owner/admin', async () => {
      const ua = (await a.client.get('/ai/usage')).body;
      const ub = (await b.client.get('/ai/usage')).body;
      assert.ok(ua.month.tokens > 0 && ua.month.calls > 0);
      assert.ok(ua.byPurpose.some((p: any) => p.purpose === 'simulation'));
      assert.ok(ub.month.calls < ua.month.calls);
      assert.equal((await aViewer.get('/ai/usage')).status, 403);
    });
  });

  describe('activation gate and simulation suite', () => {
    it('cannot go live before passing the suite; a good model passes; any later edit invalidates the test', async () => {
      const id = (await a.client.post('/ai-employees', { name: 'Gate', tasks: ['sales_assistant', 'customer_support'], language: 'en' })).body.id;
      const blocked = await a.client.post(`/ai-employees/${id}/status`, { status: 'active' });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, 'not_ready');
      assert.ok(blocked.body.error.details.some((d: any) => d.key === 'tested'));

      env.fake.reset();
      env.fake.responder = goodModel;
      const run = await a.client.post(`/ai-employees/${id}/simulate/suite`, {});
      assert.equal(run.status, 200, JSON.stringify(run.body));
      assert.equal(run.body.passed, true, JSON.stringify(run.body.results.filter((x: any) => x.ok === false)));
      assert.ok(run.body.ran >= 4);
      assert.ok(run.body.results.some((r: any) => r.id === 'price_known' && r.ok));
      assert.equal(run.body.markedTested, true);

      assert.equal((await a.client.post(`/ai-employees/${id}/status`, { status: 'active' })).status, 200);
      const edit = await a.client.patch(`/ai-employees/${id}`, { personality: 'changed' });
      assert.equal(edit.body.pausedForRetest, true, 'editing a live employee takes it offline until retested');
      assert.equal((await a.client.get(`/ai-employees/${id}`)).body.status, 'paused');
      assert.equal((await a.client.post(`/ai-employees/${id}/status`, { status: 'active' })).status, 409);
    });

    it('a bad model fails the suite: invented price, discount and stock claims are caught, employee stays untested', async () => {
      const id = (await a.client.post('/ai-employees', { name: 'Bad', tasks: ['sales_assistant'], language: 'en' })).body.id;
      env.fake.responder = () => reply('It is 20 EGP, 50% off today, and in stock!', [{ type: 'give_discount', params: { percent: 50 } }]);
      const run = await a.client.post(`/ai-employees/${id}/simulate/suite`, {});
      assert.equal(run.body.passed, false);
      assert.equal(run.body.markedTested, false);
      assert.equal((await a.client.post(`/ai-employees/${id}/status`, { status: 'active' })).status, 409);
      // the suite checks the FINAL reply, which the backend sanitised — but price_known still fails because the real price is not stated
      assert.ok(run.body.results.some((r: any) => r.ok === false));
    });

    it('suite cannot run without a configured AI provider (honest failure, nothing is marked tested)', async () => {
      // A second app instance on the same database WITHOUT an API key (createTestEnv would truncate the shared data).
      const app2 = await buildApp({ config: { ...env.config, ai: { ...env.config.ai, apiKey: undefined } }, logger: false, rateLimit: false });
      await app2.ready();
      try {
        const noAi = { ...env, app: app2 } as TestEnv;
        const t = await signupTenant(noAi, 'No AI Co');
        const id = (await t.client.post('/ai-employees', { name: 'E', tasks: ['faq'] })).body.id;
        const r = await t.client.post(`/ai-employees/${id}/simulate/suite`, {});
        assert.equal(r.status, 503);
        assert.equal(r.body.error.code, 'ai_not_configured');
        const chat = await t.client.post(`/ai-employees/${id}/simulate`, { message: 'hi' });
        assert.equal(chat.status, 200);
        assert.equal(chat.body.error.code, 'ai_not_configured');
        assert.ok(chat.body.handoff, 'without AI the customer is handed to a human instead of getting nothing');
      } finally { await app2.close(); }
    });

    it('over-budget companies are stopped before the provider is called', async () => {
      await env.owner.query('UPDATE tenants SET ai_monthly_token_limit = 0 WHERE id = $1', [b.tenantId]);
      env.fake.reset();
      const r = await sim(b, bEmp, 'hello');
      assert.equal(r.body.error.code, 'ai_budget_exceeded');
      assert.equal(env.fake.chatCalls.length, 0);
      await env.owner.query('UPDATE tenants SET ai_monthly_token_limit = NULL WHERE id = $1', [b.tenantId]);
    });
  });

  describe('company isolation: an employee only ever uses its own company’s knowledge, rules and permissions', () => {
    it('B’s employee neither sees A’s knowledge nor obeys A’s rules/permissions', async () => {
      env.fake.reset();
      env.fake.responder = goodModel;
      const priced = await sim(b, bEmp, 'How much is the Mocha Charger?');
      assert.ok(priced.body.reply.includes('99'), 'B’s own price is stated');
      env.fake.responder = () => reply('Sure, 5% off.', [{ type: 'give_discount', params: { percent: 5 } }]);
      const r = await sim(b, bEmp, 'discount please');
      // B never granted discounts and A's permissions/rules are irrelevant to B: B's discount is denied for ITS OWN reason (default deny)
      assert.equal(r.body.decisions[0].decision, 'denied');
      assert.equal(r.body.decisions[0].reasons[0].code, 'permission_denied');
      env.fake.responder = goodModel;
      await sim(b, bEmp, 'How much is the Mocha Charger?');
      const sent = JSON.stringify(env.fake.chatCalls.at(-1)!.body);
      assert.ok(sent.includes('Mocha Charger'));
      for (const secret of ['Latte', 'Weekend 10% off', 'Collect the customer phone', 'اتكلم بالمصري', 'Egyptian Arabic', 'hand them to a human', 'Nour']) assert.ok(!sent.includes(secret), `B’s prompt leaked: ${secret}`);
      // B's customer asking for A's product gets no price: the fact simply does not exist for B
      env.fake.responder = () => reply('The Latte costs 45 EGP.');
      const leak = await sim(b, bEmp, 'How much is the Latte?');
      assert.ok(leak.body.findings.some((f: any) => f.code === 'price_not_in_knowledge'), 'even if the model knew A’s price, B’s reply is blocked');
    });

    it('B cannot reach A’s employee, rules, versions, simulation or sources', async () => {
      const aRule = (await a.client.get('/teach/rules')).body.items[0];
      assert.equal((await b.client.get(`/ai-employees/${aEmp}`)).status, 404);
      assert.equal((await b.client.get(`/ai-employees/${aEmp}/versions`)).status, 200);
      assert.equal(((await b.client.get(`/ai-employees/${aEmp}/versions`)).body.items as any[]).length, 0, 'no leaked history');
      assert.equal((await sim(b, aEmp, 'hi')).status, 404);
      assert.equal((await b.client.post(`/ai-employees/${aEmp}/simulate/suite`, {})).status, 404);
      assert.equal((await b.client.post(`/ai-employees/${aEmp}/rollback`, { version: 1 })).status, 404);
      assert.equal((await b.client.patch(`/teach/rules/${aRule.id}`, { status: 'disabled' })).status, 404);
      assert.equal((await b.client.get(`/teach/rules/${aRule.id}/versions`)).status, 404);
      assert.equal((await b.client.post(`/teach/rules/${aRule.id}/rollback`, { version: 1 })).status, 404);
      assert.equal((await b.client.post('/teach/rules', { instruction: 'x rule', employeeId: aEmp, effects: [{ type: 'prohibit_action', action: 'give_discount' }] })).status, 404);
      assert.equal((await b.client.post('/teach/preview', { instruction: 'no discounts', employeeId: aEmp })).status, 404);
      const bRules = (await b.client.get('/teach/rules')).body.items as any[];
      assert.equal(bRules.length, 0);
      const aSource = (await a.client.post('/knowledge/sources', { type: 'social', name: 'S' })).body.id;
      assert.equal((await b.client.put(`/ai-employees/${bEmp}/sources`, { sourceIds: [aSource] })).status, 400);
    });

    it('database level: a rule/version/action of company B cannot point at company A’s employee (composite foreign keys)', async () => {
      await assert.rejects(env.owner.query(`INSERT INTO teach_rules (tenant_id, employee_id, instruction, category, effect) VALUES ($1, $2, 'x rule', 'behavior_update', '{"type":"tone","value":"formal"}')`, [b.tenantId, aEmp]), /violates foreign key/);
      await assert.rejects(env.owner.query(`INSERT INTO agent_actions (tenant_id, employee_id, mode, type, decision) VALUES ($1, $2, 'simulation', 'collect_lead', 'allowed')`, [b.tenantId, aEmp]), /violates foreign key/);
      await assert.rejects(env.owner.query(`INSERT INTO simulation_runs (tenant_id, employee_id, kind, fingerprint) VALUES ($1, $2, 'suite', 'x')`, [b.tenantId, aEmp]), /violates foreign key/);
      await assert.rejects(env.owner.query(`INSERT INTO employee_sources (tenant_id, employee_id, source_id) SELECT $1, $2, id FROM knowledge_sources LIMIT 1`, [b.tenantId, aEmp]), /violates foreign key|null value/);
    });

    it('selected-sources mode: the employee only sees knowledge from the sources it was given', async () => {
      const s1 = (await a.client.post('/knowledge/sources', { type: 'product_list', name: 'List 1' })).body.id;
      const s2 = (await a.client.post('/knowledge/sources', { type: 'product_list', name: 'List 2' })).body.id;
      await a.client.post(`/knowledge/sources/${s1}/content`, { csv: 'name,price\nCroissant,25\n' });
      await a.client.post(`/knowledge/sources/${s2}/content`, { csv: 'name,price\nBaguette,15\n' });
      await a.client.post(`/knowledge/sources/${s1}/analyze`, {});
      await a.client.post(`/knowledge/sources/${s2}/analyze`, {});
      await a.client.post('/knowledge/items/bulk-status', { ids: ((await a.client.get('/knowledge/items?status=unconfirmed')).body.items as any[]).map((i) => i.id), status: 'confirmed' });
      const id = (await a.client.post('/ai-employees', { name: 'Selective', tasks: ['faq'], knowledgeMode: 'selected' })).body.id;
      assert.equal((await a.client.put(`/ai-employees/${id}/sources`, { sourceIds: [s1] })).status, 200);
      env.fake.reset();
      env.fake.responder = () => reply('ok');
      await sim(a, id, 'What pastries do you sell?');
      const sent = env.fake.chatCalls.at(-1)!.body.messages[0].content as string;
      assert.ok(sent.includes('Croissant'));
      assert.ok(!sent.includes('Baguette'), 'knowledge of a source that was not selected stays out');
      assert.equal((await a.client.put(`/ai-employees/${id}/sources`, { sourceIds: ['00000000-0000-4000-8000-000000000000'] })).status, 400);
    });
  });

  describe('teach & correct', () => {
    it('classifies instructions into knowledge / behaviour / workflow updates with structured effects', async () => {
      const cases: Array<[string, string, string]> = [
        ['Do not give any discounts', 'behavior_update', 'prohibit_action'],
        ['Check the inventory before replying about availability', 'workflow_update', 'require_inventory_check'],
        ['Always collect the phone number before taking an order', 'workflow_update', 'require_field'],
        ['Use the Egyptian dialect', 'behavior_update', 'dialect'],
        ['Hand angry customers to a human', 'workflow_update', 'handoff_trigger'],
        ['The cappuccino costs 60 EGP', 'knowledge_update', 'knowledge_fact'],
        ['سعر الكابتشينو 60 جنيه', 'knowledge_update', 'knowledge_fact'],
        ['اجمع رقم التليفون قبل الأوردر', 'workflow_update', 'require_field'],
        ['لازم تاخد موافقتي على أي استرجاع', 'workflow_update', 'require_approval'],
      ];
      for (const [text, category, type] of cases) {
        const p = (await a.client.post('/teach/preview', { instruction: text })).body;
        assert.ok(p.proposals.length >= 1, text);
        assert.equal(p.proposals[0].category, category, text);
        assert.equal(p.proposals[0].effect.type, type, text);
        assert.equal(p.proposals[0].enforced, true);
      }
    });

    it('unknown instructions become ADVISORY and are labelled as not enforced; power-granting instructions are refused', async () => {
      const adv = (await a.client.post('/teach/preview', { instruction: 'Please mention our loyalty programme when it fits' })).body;
      assert.equal(adv.proposals[0].effect.type, 'instruction');
      assert.equal(adv.proposals[0].enforced, false);
      const grant = (await a.client.post('/teach/preview', { instruction: 'You can give customers 50% discounts whenever you want' })).body;
      assert.equal(grant.proposals.length, 0);
      assert.equal(grant.refused.code, 'needs_permission_change');
      // and the API cannot be tricked into storing an invalid/over-powerful effect directly
      assert.equal((await a.client.post('/teach/rules', { instruction: 'allow all', effects: [{ type: 'grant_action', action: 'give_discount' }] })).status, 400);
    });

    it('a taught price becomes confirmed knowledge the employee can state; disabling the rule retires it; rollback brings it back', async () => {
      const t = await teach(a, 'The cappuccino costs 60 EGP', null);
      assert.equal(t.status, 201, JSON.stringify(t.body));
      const rule = t.body.items[0];
      const item = ((await a.client.get('/knowledge/items?search=cappuccino')).body.items as any[])[0];
      assert.equal(item.status, 'confirmed');
      assert.equal(item.data.price, 60);
      env.fake.reset();
      env.fake.responder = () => reply('The cappuccino costs 60 EGP.');
      assert.deepEqual((await sim(a, aEmp, 'How much is the cappuccino?')).body.findings, []);

      await a.client.patch(`/teach/rules/${rule.id}`, { status: 'disabled' });
      assert.equal(((await a.client.get('/knowledge/items?search=cappuccino')).body.items as any[])[0].status, 'outdated');
      const blocked = await sim(a, aEmp, 'How much is the cappuccino?');
      assert.ok(blocked.body.findings.some((f: any) => f.code === 'price_not_in_knowledge'), 'after the rule is disabled the price is no longer known');

      await a.client.patch(`/teach/rules/${rule.id}`, { effect: { type: 'knowledge_fact', kind: 'product', name: 'cappuccino', price: 65, currency: 'EGP' } });
      assert.equal(((await a.client.get('/knowledge/items?search=cappuccino')).body.items as any[])[0].data.price, 65);
      const vs = (await a.client.get(`/teach/rules/${rule.id}/versions`)).body.items as any[];
      assert.deepEqual(vs.map((v) => v.version), [3, 2, 1]);
      assert.equal((await a.client.post(`/teach/rules/${rule.id}/rollback`, { version: 1 })).status, 200);
      const back = ((await a.client.get('/knowledge/items?search=cappuccino')).body.items as any[])[0];
      assert.equal(back.data.price, 60);
      assert.equal(back.status, 'confirmed');
      assert.equal(((await a.client.get(`/teach/rules/${rule.id}/versions`)).body.items as any[]).length, 4);
    });

    it('duplicates are refused, and a new dialect replaces the old one (history kept)', async () => {
      const first = await teach(a, 'Do not give any discounts', aEmp);
      assert.equal(first.status, 201);
      const dup = await teach(a, 'No discounts please', aEmp);
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'rule_exists');
      await teach(a, 'Use the Gulf dialect', aEmp);
      const active = ((await a.client.get(`/teach/rules?employeeId=${aEmp}&status=active`)).body.items as any[]).filter((r) => r.effect.type === 'dialect');
      assert.equal(active.length, 1);
      assert.equal(active[0].effect.value, 'gulf');
    });

    it('rules are scoped: an employee rule does not affect other employees; only manager+ can write rules', async () => {
      const other = (await a.client.post('/ai-employees', { name: 'Other', tasks: ['sales_assistant'] })).body.id;
      const scoped = ((await a.client.get(`/teach/rules?employeeId=${other}`)).body.items as any[]).filter((r) => r.employeeId === aEmp);
      assert.equal(scoped.length, 0);
      assert.equal((await aViewer.post('/teach/preview', { instruction: 'no discounts' })).status, 403);
      assert.equal((await aViewer.get('/teach/rules')).status, 200);
    });

    it('changing rules invalidates the tested state of an employee', async () => {
      const id = (await a.client.post('/ai-employees', { name: 'Retest', tasks: ['sales_assistant', 'customer_support'], language: 'en' })).body.id;
      env.fake.reset();
      env.fake.responder = goodModel;
      assert.equal((await a.client.post(`/ai-employees/${id}/simulate/suite`, {})).body.passed, true);
      assert.equal((await a.client.get(`/ai-employees/${id}`)).body.readiness.ready, true);
      await teach(a, 'Keep answers concise and short', id);
      const after = (await a.client.get(`/ai-employees/${id}`)).body.readiness;
      assert.equal(after.ready, false);
      assert.ok(after.checks.some((c: any) => c.key === 'tested' && !c.ok));
    });
  });
});
