import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WINDOW_MS, evaluate, isOptOut, renderMessage, type ContactFacts } from '../src/campaigns/audience.js';
import { inventedNumbers } from '../src/campaigns/builder.js';
import { withTenant } from '../src/db/tx.js';
import { Client, createTestEnv, inviteMember, signupTenant, type TestEnv, type Tenant } from './helpers.js';

/**
 * Part 4 tests. EVERY customer here is synthetic test data and every provider is a local stand-in:
 * no real customer is ever messaged and no real platform is ever called.
 */
let env: TestEnv;
let a: Tenant;
let b: Tenant;
let aManager: Client;
let aViewer: Client;
let n = 500;

const HOUR = 3600_000;
const tgUpdate = (chat: number, mid: number, text: string, name = 'Live') => ({ update_id: ++n, message: { message_id: mid, date: Math.floor(Date.now() / 1000), from: { id: chat, is_bot: false, first_name: name }, chat: { id: chat, type: 'private', first_name: name }, text } });
const hook = (key: string, payload: unknown, secret: string) => env.app.inject({ method: 'POST', url: `/api/v1/webhooks/channel/${key}`, payload: payload as object, headers: { 'x-telegram-bot-api-secret-token': secret } });
const keyOf = async (id: string) => (await env.owner.query('SELECT public_key FROM channels WHERE id = $1', [id])).rows[0].public_key as string;
const reply = (text: string) => JSON.stringify({ reply: text, actions: [] });

async function telegram(t: Tenant, name: string, token: string, id: number, employeeId?: string) {
  env.tg.addBot(token, id, `bot_${id}`);
  const ch = (await t.client.post('/channels', { type: 'telegram', name, ...(employeeId ? { employeeId } : {}) })).body;
  const ok = await t.client.post(`/channels/${ch.id}/connect`, { botToken: token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return { id: ch.id as string, key: await keyOf(ch.id), secret: env.tg.webhooks.get(token)!.secret };
}
/** Channels of other platforms are inserted directly as "connected": eligibility does not depend on the connector, and Part 3 already tests those connectors. */
async function directChannel(t: Tenant, type: string, provider: string, name: string, status = 'connected') {
  const r = await env.owner.query(`INSERT INTO channels (tenant_id, type, provider, name, status, public_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [t.tenantId, type, provider, name, status, `pk_${Math.random().toString(36).slice(2)}${Date.now()}`]);
  return r.rows[0].id as string;
}
interface Spec { name: string; ext: string; ago: number | null; consent?: string; status?: string; tags?: string[]; interests?: string[]; unreachable?: boolean; first?: number }
async function seed(t: Tenant, channelId: string, type: string, specs: Spec[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of specs) {
    const r = await env.owner.query(
      `INSERT INTO contacts (tenant_id, channel_id, external_id, name, first_seen_at, last_seen_at, last_inbound_at, consent_status, status, tags, interests, unreachable_at)
       VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5), now() - make_interval(hours => $6), CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(hours => $7::int) END, $8, $9, $10, $11, CASE WHEN $12 THEN now() END) RETURNING id`,
      [t.tenantId, channelId, s.ext, s.name, s.first ?? s.ago ?? 1, s.ago ?? 1, s.ago, s.consent ?? 'unknown', s.status ?? 'new', s.tags ?? [], s.interests ?? [], !!s.unreachable],
    );
    out[s.name] = r.rows[0].id;
    await env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id) VALUES ($1, $2, $3, $4)`, [t.tenantId, channelId, type, r.rows[0].id]);
  }
  return out;
}
const chatsSent = (token?: string) => env.tg.callsTo('sendMessage').filter((c) => !token || c.path.includes(token)).map((c) => String(c.body.chat_id));
const texts = () => env.tg.callsTo('sendMessage').map((c) => String(c.body.text));
async function newCampaign(t: Tenant, channelId: string, extra: Record<string, unknown> = {}) {
  const r = await t.client.post('/campaigns', { name: 'Test offer', channelId, message: 'Hi {{first_name}}, our new latte offer is here!', audience: {}, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { id: string; status: string };
}
async function approveAndLaunch(t: Tenant, id: string, schedule?: string) {
  const pv = (await t.client.get(`/campaigns/${id}/preview`)).body;
  const ap = await t.client.post(`/campaigns/${id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible, acknowledgeUnofficialRisk: true });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const ln = await t.client.post(`/campaigns/${id}/launch`, schedule ? { scheduleAt: schedule } : {});
  assert.equal(ln.status, 200, JSON.stringify(ln.body));
  return ln.body;
}
const recipients = async (id: string, status?: string) => (await env.owner.query(`SELECT r.*, c.name FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.campaign_id = $1 ${status ? 'AND r.status = $2' : ''} ORDER BY c.name`, status ? [id, status] : [id])).rows;
const statusOf = async (id: string) => (await env.owner.query('SELECT status FROM campaigns WHERE id = $1', [id])).rows[0].status as string;

// ───────────────────────────────────────────── pure rules (no database)
describe('Sending eligibility rules (pure)', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const facts = (o: Partial<ContactFacts> & { hoursAgo?: number | null } = {}): ContactFacts => ({ consentStatus: o.consentStatus ?? 'unknown', unreachableAt: o.unreachableAt ?? null, lastInboundAt: o.hoursAgo === null ? null : new Date(now.getTime() - (o.hoursAgo ?? 1) * HOUR) });
  const msgr = { type: 'messenger', provider: 'meta' } as const;

  it('Messenger / Instagram: only inside the 24h window; Marketing Messages are NOT faked', () => {
    assert.deepEqual(evaluate(facts({ hoursAgo: 2 }), msgr, now), { eligible: true, basis: 'inside_window' });
    assert.deepEqual(evaluate(facts({ hoursAgo: 23.9 }), msgr, now), { eligible: false, reason: 'outside_messaging_window' }, 'a 10 minute safety margin before the 24h limit');
    assert.deepEqual(evaluate(facts({ hoursAgo: 30 }), msgr, now), { eligible: false, reason: 'outside_messaging_window' });
    assert.deepEqual(evaluate(facts({ hoursAgo: 30, consentStatus: 'opted_in' }), msgr, now), { eligible: false, reason: 'marketing_messages_not_supported' });
    assert.deepEqual(evaluate(facts({ hoursAgo: 30 }), { type: 'instagram', provider: 'meta' }, now), { eligible: false, reason: 'outside_messaging_window' });
    assert.ok(WINDOW_MS < 24 * HOUR);
  });
  it('WhatsApp: window, then explicit opt-in (QR); the official API would need an approved template', () => {
    const evo = { type: 'whatsapp', provider: 'evolution' } as const;
    assert.equal(evaluate(facts({ hoursAgo: 5 }), evo, now).eligible, true);
    assert.deepEqual(evaluate(facts({ hoursAgo: 90 }), evo, now), { eligible: false, reason: 'no_marketing_consent' });
    assert.deepEqual(evaluate(facts({ hoursAgo: 90, consentStatus: 'opted_in' }), evo, now), { eligible: true, basis: 'opted_in' });
    assert.deepEqual(evaluate(facts({ hoursAgo: 90, consentStatus: 'opted_in' }), { type: 'whatsapp', provider: 'whatsapp_cloud' }, now), { eligible: false, reason: 'template_required' });
    assert.equal(evaluate(facts({ hoursAgo: 5 }), { type: 'whatsapp', provider: 'whatsapp_cloud' }, now).eligible, true);
  });
  it('Telegram: anyone who started the bot, unless opted out or unreachable', () => {
    const tg = { type: 'telegram', provider: 'telegram_bot' } as const;
    assert.equal(evaluate(facts({ hoursAgo: 24 * 200 }), tg, now).eligible, true);
    assert.deepEqual(evaluate(facts({ consentStatus: 'opted_out' }), tg, now), { eligible: false, reason: 'opted_out' });
    assert.deepEqual(evaluate(facts({ unreachableAt: now }), tg, now), { eligible: false, reason: 'unreachable' });
  });
  it('opt-out beats everything, never-wrote and website/TikTok are refused', () => {
    for (const type of ['messenger', 'instagram', 'whatsapp', 'telegram'] as const) assert.deepEqual(evaluate(facts({ consentStatus: 'opted_out', hoursAgo: 1 }), { type, provider: 'meta' }, now), { eligible: false, reason: 'opted_out' });
    assert.deepEqual(evaluate(facts({ hoursAgo: null }), msgr, now), { eligible: false, reason: 'no_previous_conversation' });
    assert.deepEqual(evaluate(facts(), { type: 'website', provider: 'widget' }, now), { eligible: false, reason: 'platform_not_supported' });
    assert.deepEqual(evaluate(facts(), { type: 'tiktok', provider: 'widget' }, now), { eligible: false, reason: 'platform_not_supported' });
  });
  it('opt-out phrases: exact requests only, in English and Arabic', () => {
    for (const t of ['STOP', 'stop!', ' Unsubscribe ', 'إيقاف', 'ايقاف', 'وقف', 'الغاء الاشتراك', 'وقف الرسائل']) assert.equal(isOptOut(t), true, t);
    for (const t of ['stop the order please', 'please do not stop', 'لا توقف الطلب', 'الغاء', 'how much?', '']) assert.equal(isOptOut(t), false, t);
  });
  it('personalisation never leaves a hole when the name is unknown, and the opt-out line is added', () => {
    assert.equal(renderMessage('Hi {{first_name}}, offer!', 'Sara Ali', false), 'Hi Sara, offer!');
    assert.equal(renderMessage('Hi {{first_name}}, offer!', null, false), 'Hi, offer!');
    assert.ok(renderMessage('Offer', 'X', true).includes('STOP'));
  });
  it('numbers the owner never wrote are detected in an AI draft', () => {
    assert.deepEqual(inventedNumbers('Latte now 30 EGP, 20% off', 'new offer on latte, 30 EGP'), ['20']);
    assert.deepEqual(inventedNumbers('خصم ٣٠ جنيه', 'عرض ٣٠ جنيه'), []);
    assert.deepEqual(inventedNumbers('Hi {{first_name}}!', 'offer'), []);
  });
});

describe('Customers & AI Retargeting (Part 4)', () => {
  let tgA: { id: string; key: string; secret: string };
  let tgLive: { id: string; key: string; secret: string };
  let tgB: { id: string; key: string; secret: string };
  let ids: Record<string, string> = {};
  let aEmp: string;

  before(async () => {
    env = await createTestEnv();
    env.app.config.appUrl = 'https://app.example.test';
    env.app.campaigns.smooth = false;
    a = await signupTenant(env, 'Cafe Nile');
    b = await signupTenant(env, 'Gadget Shop');
    aManager = await inviteMember(env, a, 'manager');
    aViewer = await inviteMember(env, a, 'viewer');
    aEmp = (await a.client.post('/ai-employees', { name: 'Nour', tasks: ['sales_assistant', 'customer_support', 'human_handoff'] })).body.id;
    await env.owner.query(`UPDATE ai_employees SET status = 'active' WHERE id = $1`, [aEmp]);
    env.fake.responder = () => reply('Thanks for writing!');
    tgA = await telegram(a, 'Cafe bot', '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 111111);
    tgLive = await telegram(a, 'Cafe live bot', '333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 333333, aEmp);
    tgB = await telegram(b, 'Gadget bot', '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 222222);
    // Tenant A's Telegram audience (synthetic): 6 wrote to us, 1 never did.
    ids = await seed(a, tgA.id, 'telegram', [
      { name: 'Sara Hassan', ext: '9001', ago: 48, tags: ['vip'], status: 'customer' },
      { name: 'Omar Ali', ext: '9002', ago: 40 * 24, tags: ['vip'], status: 'lead' },
      { name: 'Hana Said', ext: '9003', ago: 100 * 24 },
      { name: 'Ali Optout', ext: '9004', ago: 120, consent: 'opted_out' },
      { name: 'Mona Blocked', ext: '9005', ago: 72, unreachable: true },
      { name: 'Kareem Fathy', ext: '9006', ago: 240, interests: ['coffee'] },
      { name: 'Never Wrote', ext: '9007', ago: null },
    ]);
    await seed(b, tgB.id, 'telegram', [{ name: 'Bob Secret', ext: '9101', ago: 10, tags: ['vip'] }, { name: 'Bea Secret', ext: '9102', ago: 20 }]);
  });
  after(async () => { await env.close(); });

  // ─────────────────────────────────────────── customers database
  describe('Customers', () => {
    it('lists customers with the fields we really have, and never invents the rest', async () => {
      const r = await a.client.get('/customers?platform=telegram&limit=50');
      assert.equal(r.status, 200);
      const sara = r.body.items.find((c: any) => c.name === 'Sara Hassan');
      assert.equal(sara.platform, 'telegram');
      assert.equal(sara.platformUserId, '9001');
      assert.equal(sara.phone, null);
      assert.equal(sara.email, null);
      assert.equal(sara.consentStatus, 'unknown');
      assert.deepEqual(sara.tags, ['vip']);
      assert.ok(sara.firstInteractionAt && sara.lastInteractionAt);
      assert.equal(r.body.total, 7);
      assert.ok(!JSON.stringify(r.body).includes('Secret'), "another company's customers never appear");
    });
    it('filters: search, tag, status, consent, activity', async () => {
      const f = async (q: string) => (await a.client.get(`/customers?platform=telegram&${q}`)).body.items.map((c: any) => c.name).sort();
      assert.deepEqual(await f('search=omar'), ['Omar Ali']);
      assert.deepEqual(await f('tag=vip'), ['Omar Ali', 'Sara Hassan']);
      assert.deepEqual(await f('status=customer'), ['Sara Hassan']);
      assert.deepEqual(await f('consent=opted_out'), ['Ali Optout']);
      assert.deepEqual(await f('inactiveDays=90'), ['Hana Said']);
      assert.equal((await a.client.get('/customers?search=%25')).body.total, 0, 'LIKE wildcards are escaped');
    });
    it('same person id on two platforms stays TWO customers: identities are never merged automatically', async () => {
      const m = await directChannel(a, 'messenger', 'meta', 'Cafe Page');
      await seed(a, m, 'messenger', [{ name: 'Sara Hassan', ext: '9001', ago: 5 }]);
      const all = (await a.client.get('/customers?search=Sara%20Hassan')).body.items;
      assert.equal(all.length, 2);
      assert.deepEqual(all.map((c: any) => c.platform).sort(), ['messenger', 'telegram']);
      assert.notEqual(all[0].id, all[1].id);
    });
    it('edits tags, notes, status, interests, email; every change is recorded in the activity log', async () => {
      const id = ids['Hana Said']!;
      const r = await a.client.patch(`/customers/${id}`, { tags: ['Warm', 'cold-lead'], status: 'lead', notes: 'Asked about delivery', interests: ['tea'], email: 'Hana@Example.com' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.tags, ['cold-lead', 'warm']);
      assert.equal(r.body.email, 'hana@example.com');
      const d = (await a.client.get(`/customers/${id}`)).body;
      const kinds = d.events.map((e: any) => e.kind);
      for (const k of ['tag_added', 'status_changed', 'details_updated']) assert.ok(kinds.includes(k), k);
      assert.deepEqual(d.events.find((e: any) => e.kind === 'status_changed').detail, { from: 'new', to: 'lead' });
      assert.ok(d.stats && d.conversationId);
      assert.equal((await a.client.patch(`/customers/${id}`, { email: 'not-an-email' })).status, 400);
      assert.equal((await a.client.patch(`/customers/${id}`, { platform: 'whatsapp' })).status, 400, 'unknown fields are rejected');
      assert.equal((await a.client.patch(`/customers/${id}`, { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).status, 400);
    });
    it('a phone number that came from the platform cannot be overwritten; a manual one can', async () => {
      const wa = await directChannel(a, 'whatsapp', 'evolution', 'Cafe WA');
      const ph = await seed(a, wa, 'whatsapp', [{ name: 'Phone Platform', ext: '201001@s.whatsapp.net', ago: 2 }, { name: 'Phone Manual', ext: '201002@s.whatsapp.net', ago: 2 }]);
      await env.owner.query(`UPDATE contacts SET phone = '+201001' WHERE id = $1`, [ph['Phone Platform']]);
      assert.equal((await a.client.patch(`/customers/${ph['Phone Platform']}`, { phone: '+20999999' })).status, 409);
      assert.equal((await a.client.patch(`/customers/${ph['Phone Manual']}`, { phone: '+20 100 555 0000' })).status, 200);
      assert.equal((await a.client.patch(`/customers/${ph['Phone Manual']}`, { phone: '+20 100 555 1111' })).status, 200, 'a manual phone stays editable');
    });
    it('consent: recorded with source, audited; re-opting-in someone who asked to stop needs a written reason', async () => {
      const id = ids['Ali Optout']!;
      assert.equal((await a.client.post(`/customers/${id}/consent`, { status: 'opted_in', source: 'verbal' })).status, 400);
      const ok = await a.client.post(`/customers/${id}/consent`, { status: 'opted_in', source: 'verbal', note: 'Said yes on the phone, 2026-05-01' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.consentStatus, 'opted_in');
      assert.equal(ok.body.consentSource, 'verbal');
      assert.ok((await env.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'customer.consent_changed' AND entity_id = $1`, [id])).rowCount);
      await a.client.post(`/customers/${id}/consent`, { status: 'opted_out', source: 'manual' });
    });
    it('bulk tags and the tag list', async () => {
      const r = await a.client.post('/customers/bulk-tags', { ids: [ids['Hana Said'], ids['Kareem Fathy']], add: ['spring'], remove: ['cold-lead'] });
      assert.deepEqual(r.body, { updated: 2 });
      const tags = (await a.client.get('/customers/tags')).body.items;
      assert.equal(tags.find((t: any) => t.tag === 'spring').count, 2);
      assert.ok(!tags.find((t: any) => t.tag === 'cold-lead'));
    });
    it('summary counts per platform', async () => {
      const s = (await a.client.get('/customers/summary')).body.platforms;
      assert.equal(s.telegram.total, 7);
      assert.equal(s.messenger.total, 1);
      assert.equal(s.whatsapp.total, 2);
      assert.equal(s.instagram.total, 0);
    });
    it('permissions: viewer reads, cannot edit; manager edits', async () => {
      assert.equal((await aViewer.get('/customers')).status, 200);
      assert.equal((await aViewer.patch(`/customers/${ids['Hana Said']}`, { notes: 'x' })).status, 403);
      assert.equal((await aViewer.post(`/customers/${ids['Hana Said']}/consent`, { status: 'opted_out', source: 'manual' })).status, 403);
      assert.equal((await aManager.patch(`/customers/${ids['Hana Said']}`, { notes: 'by manager' })).status, 200);
    });
  });

  // ─────────────────────────────────────────── audience & eligibility through the API
  describe('Audience selection and exclusion of ineligible customers', () => {
    const pv = async (channelId: string, audience: object = {}) => {
      const r = await a.client.post('/campaigns/audience/preview', { channelId, audience, message: 'Offer {{first_name}}' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    it('"All previous Telegram contacts" = everyone who wrote at least once (never-wrote is not an audience)', async () => {
      const p = await pv(tgA.id);
      assert.equal(p.total, 6);
      assert.equal(p.eligible, 4); // Sara, Omar, Hana, Kareem
      const reasons = Object.fromEntries(p.excluded.map((e: any) => [e.reason, e.count]));
      assert.deepEqual(reasons, { opted_out: 1, unreachable: 1 });
      assert.ok(p.excluded.every((e: any) => e.label.length > 10), 'every exclusion has a human reason');
      assert.equal(p.sample.length, 4);
      assert.ok(p.sample[0].text.includes('STOP'), 'opt-out line is appended');
    });
    it('filters: last interaction, date range, tags, status, purchases, interests', async () => {
      assert.equal((await pv(tgA.id, { lastInteraction: { withinDays: 90 } })).total, 5);
      assert.equal((await pv(tgA.id, { lastInteraction: { olderThanDays: 90 } })).total, 1);
      assert.equal((await pv(tgA.id, { tagsAny: ['VIP'] })).total, 2, 'tags are case-insensitive');
      assert.equal((await pv(tgA.id, { tagsAny: ['vip'], excludeTags: ['vip'] })).total, 0);
      assert.equal((await pv(tgA.id, { statuses: ['lead'] })).total, 2, 'Omar and Hana (set to lead in an earlier test)');
      assert.equal((await pv(tgA.id, { purchased: true })).total, 1);
      assert.equal((await pv(tgA.id, { purchased: false })).total, 5, '"did not buy" = everybody who is not a customer');
      assert.equal((await pv(tgA.id, { interestsAny: ['coffee'] })).total, 1);
      const today = new Date().toISOString().slice(0, 10);
      assert.equal((await pv(tgA.id, { dateRange: { field: 'last_interaction', from: today, to: today } })).total, 0);
      assert.equal((await pv(tgA.id, { dateRange: { field: 'last_interaction', from: '2000-01-01' } })).total, 6);
      assert.equal((await pv(tgA.id, { optedInOnly: true })).total, 0);
    });
    it('bad filters are refused', async () => {
      assert.equal((await a.client.post('/campaigns/audience/preview', { channelId: tgA.id, audience: { lastInteraction: { withinDays: -3 } } })).status, 400);
      assert.equal((await a.client.post('/campaigns/audience/preview', { channelId: tgA.id, audience: { sql: '1=1' } })).status, 400, 'unknown keys never reach SQL');
      assert.equal((await a.client.post('/campaigns/audience/preview', { channelId: tgA.id, audience: { tagsAny: ["x'); DROP TABLE contacts;--"] } })).status, 200, 'values are parameters, not SQL');
      assert.ok((await env.owner.query('SELECT count(*) FROM contacts')).rows[0].count > 0);
    });
    it('Messenger: 24h window; outside it nobody is messaged, with the reason shown', async () => {
      const m = await directChannel(a, 'messenger', 'meta', 'Window page');
      await seed(a, m, 'messenger', [
        { name: 'In Window', ext: 'p1', ago: 2 }, { name: 'Just Outside', ext: 'p2', ago: 30 }, { name: 'Old Optin', ext: 'p3', ago: 30 * 24, consent: 'opted_in' },
        { name: 'In Optout', ext: 'p4', ago: 1, consent: 'opted_out' }, { name: 'In Window2', ext: 'p5', ago: 22 },
      ]);
      const p = await pv(m);
      assert.equal(p.total, 5);
      assert.equal(p.eligible, 2);
      const r = Object.fromEntries(p.excluded.map((e: any) => [e.reason, e.count]));
      assert.deepEqual(r, { outside_messaging_window: 1, marketing_messages_not_supported: 1, opted_out: 1 });
      assert.equal(p.requiresUnofficialAck, false);
      assert.ok(p.warnings.some((w: string) => w.includes('24 hours')));
    });
    it('Instagram follows the same window rule', async () => {
      const i = await directChannel(a, 'instagram', 'meta', 'Cafe IG');
      await seed(a, i, 'instagram', [{ name: 'IG In', ext: 'i1', ago: 3 }, { name: 'IG Out', ext: 'i2', ago: 100 }]);
      const p = await pv(i);
      assert.equal(p.eligible, 1);
      assert.deepEqual(p.excluded.map((e: any) => e.reason), ['outside_messaging_window']);
    });
    it('WhatsApp (QR): outside the window only explicit opt-in; unofficial risk is flagged and must be acknowledged', async () => {
      const w = await directChannel(a, 'whatsapp', 'evolution', 'WA bulk');
      await seed(a, w, 'whatsapp', [{ name: 'WA In', ext: 'w1', ago: 4 }, { name: 'WA Optin', ext: 'w2', ago: 200, consent: 'opted_in' }, { name: 'WA Unknown', ext: 'w3', ago: 200 }]);
      const p = await pv(w);
      assert.equal(p.eligible, 2);
      assert.deepEqual(Object.fromEntries(p.excluded.map((e: any) => [e.reason, e.count])), { no_marketing_consent: 1 });
      assert.equal(p.requiresUnofficialAck, true);
      assert.ok(p.warnings.some((x: string) => x.includes('unofficial')));
      assert.ok(p.ratePerMinute <= 10, 'slow on purpose');
      const c = await newCampaign(a, w);
      const hash = (await a.client.get(`/campaigns/${c.id}/preview`)).body.hash;
      const no = await a.client.post(`/campaigns/${c.id}/approve`, { hash, confirmRecipients: 2 });
      assert.equal(no.status, 400);
      assert.equal(no.body.error.code, 'unofficial_risk_ack_required');
    });
    it('a disconnected or unverified channel blocks the campaign; website chat cannot be used at all', async () => {
      const d = await directChannel(a, 'messenger', 'meta', 'Dead page', 'disconnected');
      await seed(a, d, 'messenger', [{ name: 'D1', ext: 'd1', ago: 1 }]);
      const p = await pv(d);
      assert.equal(p.eligible, 0);
      assert.ok(p.blockers.some((x: any) => x.code === 'channel_not_connected'));
      const u = await directChannel(a, 'messenger', 'meta', 'Unverified page', 'awaiting_approval');
      assert.ok((await pv(u)).blockers.some((x: any) => x.code === 'channel_not_connected'));
      const web = await directChannel(a, 'website', 'widget', 'Site');
      const r = await a.client.post('/campaigns', { name: 'x', channelId: web, message: 'hi', audience: {} });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'platform_not_supported');
    });
    it('platform rules are listed for the UI', async () => {
      const r = (await a.client.get('/campaigns/platforms')).body;
      assert.deepEqual(r.platforms.map((p: any) => p.platform), ['whatsapp', 'messenger', 'instagram', 'telegram']);
      assert.ok(r.platforms.every((p: any) => p.rules.length >= 2));
      assert.ok(r.notSupported.some((x: any) => x.platform === 'website'));
    });
  });

  // ─────────────────────────────────────────── approval is mandatory
  describe('Approval before anything is sent', () => {
    let id: string;
    it('a campaign starts as a draft and nothing is sent until it is approved', async () => {
      const c = await newCampaign(a, tgA.id);
      id = c.id;
      assert.equal(c.status, 'draft');
      assert.equal((await a.client.post(`/campaigns/${id}/launch`, {})).body.error.code, 'not_approved');
      await env.app.campaigns.tick();
      assert.equal(chatsSent('111111').length, 0);
      assert.equal((await recipients(id)).length, 0, 'no recipient rows exist before launch');
    });
    it('only owner/admin approve; a manager can prepare but not approve; a viewer cannot create', async () => {
      const pv = (await a.client.get(`/campaigns/${id}/preview`)).body;
      assert.equal((await aManager.post(`/campaigns/${id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible })).status, 403);
      assert.equal((await aViewer.post('/campaigns', { name: 'x', channelId: tgA.id, message: 'hi' })).status, 403);
      assert.equal((await aViewer.get(`/campaigns/${id}`)).status, 200);
      assert.equal((await aManager.post('/campaigns', { name: 'Manager draft', channelId: tgA.id, message: 'hello' })).status, 201);
    });
    it('approval needs the exact preview hash and the recipient count typed back', async () => {
      const pv = (await a.client.get(`/campaigns/${id}/preview`)).body;
      const stale = await a.client.post(`/campaigns/${id}/approve`, { hash: 'a'.repeat(64), confirmRecipients: pv.eligible });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'preview_changed');
      const wrong = await a.client.post(`/campaigns/${id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible + 1 });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.error.code, 'confirm_count_mismatch');
      const ok = await a.client.post(`/campaigns/${id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible });
      assert.equal(ok.status, 200);
      assert.equal(await statusOf(id), 'approved');
      const row = (await env.owner.query('SELECT approved_by, approved_at, approved_eligible FROM campaigns WHERE id = $1', [id])).rows[0];
      assert.equal(row.approved_by, a.userId);
      assert.equal(row.approved_eligible, 4);
    });
    it('editing an approved campaign voids the approval', async () => {
      const e = await a.client.patch(`/campaigns/${id}`, { message: 'Hi {{first_name}}, fresh latte offer today!' });
      assert.equal(e.status, 200);
      assert.equal(e.body.status, 'draft');
      assert.equal(e.body.approvedHash, null);
      assert.equal((await a.client.post(`/campaigns/${id}/launch`, {})).body.error.code, 'not_approved');
    });
    it('if the audience changes after approval (someone opts out), launch is refused and the owner must look again', async () => {
      const pv = (await a.client.get(`/campaigns/${id}/preview`)).body;
      await a.client.post(`/campaigns/${id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible });
      await a.client.post(`/customers/${ids['Hana Said']}/consent`, { status: 'opted_out', source: 'manual' });
      const ln = await a.client.post(`/campaigns/${id}/launch`, {});
      assert.equal(ln.status, 409);
      assert.equal(ln.body.error.code, 'audience_changed');
      assert.equal(await statusOf(id), 'draft');
      assert.equal((await recipients(id)).length, 0);
      await a.client.post(`/customers/${ids['Hana Said']}/consent`, { status: 'opted_in', source: 'verbal', note: 'Agreed again, in store' });
    });
  });

  // ─────────────────────────────────────────── real sending to the stand-in Telegram
  describe('Sending, no duplicates, logs and analytics', () => {
    let id: string;
    it('launch sends to exactly the eligible people, personalised, and never to excluded ones', async () => {
      env.tg.reset();
      const c = await newCampaign(a, tgA.id, { name: 'Latte launch' });
      id = c.id;
      const ln = await approveAndLaunch(a, id);
      assert.equal(ln.status, 'running');
      assert.equal(ln.eligible, 4);
      assert.equal(ln.total, 6);
      const all = await recipients(id);
      assert.equal(all.length, 6, 'every matching customer has a row, including the excluded ones with their reason');
      assert.deepEqual(all.filter((r) => r.status === 'excluded').map((r) => [r.name, r.reason]).sort(), [['Ali Optout', 'opted_out'], ['Mona Blocked', 'unreachable']]);
      const t = await env.app.campaigns.tick();
      assert.equal(t.sent, 4);
      assert.deepEqual(chatsSent('111111').sort(), ['9001', '9002', '9003', '9006']);
      assert.ok(!chatsSent().includes('9004') && !chatsSent().includes('9005') && !chatsSent().includes('9007'), 'opted-out, unreachable and never-wrote never receive anything');
      assert.ok(texts().some((x) => x.startsWith('Hi Sara, our new latte offer')));
      assert.ok(texts().every((x) => x.includes('STOP')));
      assert.equal(await statusOf(id), 'completed');
    });
    it('the same customer is never messaged twice by one campaign: not by another tick, not by a re-launch, not by the database', async () => {
      const before = chatsSent().length;
      await env.app.campaigns.tick();
      await env.app.campaigns.tick();
      assert.equal(chatsSent().length, before);
      assert.equal((await a.client.post(`/campaigns/${id}/launch`, {})).status, 409);
      await assert.rejects(env.owner.query(`INSERT INTO campaign_recipients (tenant_id, campaign_id, channel_id, contact_id, status) VALUES ($1, $2, $3, $4, 'queued')`, [a.tenantId, id, tgA.id, ids['Sara Hassan']]), /duplicate key/);
      const m = (await env.owner.query(`SELECT m.* FROM messages m WHERE meta ->> 'campaignRecipientId' IS NOT NULL AND m.channel_id = $1 LIMIT 1`, [tgA.id])).rows[0];
      await assert.rejects(env.owner.query(`INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status, meta) VALUES ($1, $2, $3, 'out', 'system', 'dup', 'queued', $4)`, [a.tenantId, m.channel_id, m.conversation_id, JSON.stringify({ campaignRecipientId: m.meta.campaignRecipientId })]), /duplicate key/);
      const per = (await env.owner.query(`SELECT contact_id, count(*) FROM campaign_recipients WHERE campaign_id = $1 GROUP BY contact_id HAVING count(*) > 1`, [id])).rowCount;
      assert.equal(per, 0);
    });
    it('delivery tracking: Telegram reports "sent" but never "delivered" (nothing is claimed that the channel did not confirm)', async () => {
      const an = (await a.client.get(`/campaigns/${id}/analytics`)).body;
      assert.equal(an.counts.totalAudience, 6);
      assert.equal(an.counts.eligible, 4);
      assert.equal(an.counts.sent, 4);
      assert.equal(an.counts.delivered, 0);
      assert.equal(an.counts.failed, 0);
      assert.equal(an.deliveryReported, false);
      assert.deepEqual(an.excluded.map((e: any) => e.reason).sort(), ['opted_out', 'unreachable']);
      assert.ok(an.definitions.delivered.includes('only counted after the channel reports'));
    });
    it('the campaign message appears in the customer’s own conversation, and the activity log records it', async () => {
      const row = (await env.owner.query(`SELECT m.body, m.sender_type, m.status, m.meta FROM messages m WHERE m.conversation_id = (SELECT id FROM conversations WHERE contact_id = $1) AND m.direction = 'out'`, [ids['Sara Hassan']])).rows;
      assert.equal(row.length, 1);
      assert.equal(row[0].sender_type, 'system');
      assert.equal(row[0].status, 'sent');
      assert.equal(row[0].meta.campaign.name, 'Latte launch');
      const d = (await a.client.get(`/customers/${ids['Sara Hassan']}`)).body;
      assert.ok(d.events.some((e: any) => e.kind === 'campaign_sent'));
      assert.equal(d.campaigns[0].name, 'Latte launch');
      const ev = (await a.client.get(`/campaigns/${id}/events`)).body.items.map((e: any) => e.kind);
      for (const k of ['created', 'approved', 'launched', 'completed']) assert.ok(ev.includes(k), k);
      const list = (await a.client.get(`/campaigns/${id}/recipients?status=sent`)).body;
      assert.equal(list.total, 4);
    });
    it('channel-reported delivery is what counts: a "delivered" receipt moves the number, nothing else does', async () => {
      const w = await directChannel(a, 'whatsapp', 'evolution', 'WA receipts');
      const ct = await seed(a, w, 'whatsapp', [{ name: 'Rcpt One', ext: 'r1@s.whatsapp.net', ago: 1 }, { name: 'Rcpt Two', ext: 'r2@s.whatsapp.net', ago: 1 }]);
      const c = await newCampaign(a, w);
      await approveAndLaunch(a, c.id);
      const rs = await recipients(c.id, 'queued');
      assert.equal(rs.length, 2);
      // simulate what the channel would have answered: messages exist with provider ids
      for (const [i, r] of rs.entries()) {
        const cv = (await env.owner.query('SELECT id FROM conversations WHERE contact_id = $1', [r.contact_id])).rows[0].id;
        const m = (await env.owner.query(`INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status, external_id, sent_at, meta) VALUES ($1, $2, $3, 'out', 'system', 'x', $4, $5, now(), $6) RETURNING id`, [a.tenantId, w, cv, i === 0 ? 'delivered' : 'sent', `ext${i}`, JSON.stringify({ campaignRecipientId: r.id })])).rows[0].id;
        await env.owner.query(`UPDATE campaign_recipients SET message_id = $2, status = 'sent', sent_at = now() WHERE id = $1`, [r.id, m]);
      }
      const an = (await a.client.get(`/campaigns/${c.id}/analytics`)).body.counts;
      assert.deepEqual([an.sent, an.delivered], [2, 1]);
      assert.equal(ct['Rcpt One'] !== undefined, true);
    });
  });

  // ─────────────────────────────────────────── replies, opt-outs, leads, conversions
  describe('Replies, opt-outs, leads and conversions (real webhooks)', () => {
    let id: string; let sara: string; let omar: string;
    it('customers who write to the live bot are stored with first interaction and last message', async () => {
      await hook(tgLive.key, tgUpdate(7001, 1, 'Hello, do you deliver?', 'Sara Live'), tgLive.secret);
      await hook(tgLive.key, tgUpdate(7002, 1, 'Price of latte?', 'Omar Live'), tgLive.secret);
      await env.app.channels.idle();
      const r = (await a.client.get(`/customers?channelId=${tgLive.id}`)).body;
      assert.equal(r.total, 2);
      sara = r.items.find((c: any) => c.name === 'Sara Live').id;
      omar = r.items.find((c: any) => c.name === 'Omar Live').id;
      const d = (await a.client.get(`/customers/${sara}`)).body;
      assert.equal(d.lastMessage, 'Thanks for writing!');
      assert.ok(d.events.some((e: any) => e.kind === 'first_contact'));
      assert.equal(d.stats.inbound, 1);
    });
    it('campaign to the live bot, then one customer replies and one writes STOP', async () => {
      env.tg.reset();
      const c = await newCampaign(a, tgLive.id, { name: 'Live offer' });
      id = c.id;
      await approveAndLaunch(a, id);
      await env.app.campaigns.tick();
      assert.deepEqual(chatsSent('333333').sort(), ['7001', '7002'].filter((x) => chatsSent('333333').includes(x)).sort());
      const sentTo = (await recipients(id, 'sent')).length;
      assert.equal(sentTo, 2);
      const aiCallsBefore = env.fake.chatCalls.length;
      await new Promise((r) => setTimeout(r, 30));
      await hook(tgLive.key, tgUpdate(7001, 2, 'How much is the offer?', 'Sara Live'), tgLive.secret);
      await hook(tgLive.key, tgUpdate(7002, 2, 'STOP', 'Omar Live'), tgLive.secret);
      await env.app.channels.idle();
      assert.equal(env.fake.chatCalls.length, aiCallsBefore + 1, 'the AI answers the question but never answers a STOP request');
      const o = (await a.client.get(`/customers/${omar}`)).body;
      assert.equal(o.consentStatus, 'opted_out');
      assert.equal(o.consentSource, 'customer_message');
      assert.ok(o.events.some((e: any) => e.kind === 'consent_changed' && e.detail.to === 'opted_out'));
    });
    it('analytics count the reply and the opt-out separately (STOP is not a "reply")', async () => {
      const an = (await a.client.get(`/campaigns/${id}/analytics`)).body.counts;
      assert.equal(an.sent, 2);
      assert.equal(an.replies, 1);
      assert.equal(an.optOuts, 1);
      assert.equal(an.leads, 0);
      assert.equal(an.conversions, 0);
    });
    it('leads and conversions come from statuses your team sets after the message', async () => {
      await a.client.patch(`/customers/${sara}`, { status: 'lead' });
      await a.client.patch(`/customers/${sara}`, { status: 'customer' });
      const an = (await a.client.get(`/campaigns/${id}/analytics`)).body.counts;
      assert.equal(an.leads, 1);
      assert.equal(an.conversions, 1);
    });
    it('opted-out customers are excluded from every later campaign; a STOP replay does not double-log', async () => {
      await hook(tgLive.key, tgUpdate(7002, 2, 'STOP', 'Omar Live'), tgLive.secret); // same update ids are not reused by Telegram; message id 2 replays => duplicate
      await env.app.channels.idle();
      assert.equal((await env.owner.query(`SELECT count(*)::int AS n FROM customer_events WHERE contact_id = $1 AND kind = 'consent_changed'`, [omar])).rows[0].n, 1);
      const p = (await a.client.post('/campaigns/audience/preview', { channelId: tgLive.id, audience: {}, message: 'x' })).body;
      assert.equal(p.eligible, 1);
      assert.deepEqual(p.excluded.map((e: any) => e.reason), ['opted_out']);
    });
    it('previous campaign interaction can be used as an audience (replied / did not reply)', async () => {
      const r = async (replied: boolean) => (await a.client.post('/campaigns/audience/preview', { channelId: tgLive.id, audience: { previousCampaign: { campaignId: id, replied } }, message: 'x' })).body;
      assert.equal((await r(true)).total, 1);
      assert.equal((await r(false)).total, 1, 'Omar was sent the campaign but his only reply was STOP');
      assert.equal((await a.client.post('/campaigns/audience/preview', { channelId: tgLive.id, audience: { previousCampaign: { campaignId: '00000000-0000-4000-8000-000000000000', replied: true } }, message: 'x' })).status, 400);
    });
  });

  // ─────────────────────────────────────────── pause / resume / cancel / rate limits / failures / schedule
  describe('Controlling a running campaign', () => {
    const fresh = async (name: string, count: number) => {
      const ch = await telegram(a, name, `${Math.floor(Math.random() * 800000 + 100000)}:${'D'.repeat(35)}`, Math.floor(Math.random() * 1e6));
      const specs: Spec[] = Array.from({ length: count }, (_, i) => ({ name: `P${i + 1} ${name}`, ext: String(60000 + i), ago: 5 }));
      const cts = await seed(a, ch.id, 'telegram', specs);
      return { ch, cts };
    };
    const tokenOf = async (channelId: string) => { const cred = (await env.owner.query('SELECT external_account_id FROM channels WHERE id = $1', [channelId])).rows[0]; return cred.external_account_id as string; };

    it('rate limit: sends no more than the per-minute allowance, the rest waits', async () => {
      const { ch } = await fresh('RateBot', 5);
      env.app.campaigns.limits.telegram = { perMinute: 2, perDay: null };
      env.tg.reset();
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      assert.equal((await env.app.campaigns.tick()).sent, 2);
      assert.equal((await env.app.campaigns.tick()).sent, 0, 'allowance used up for this minute');
      assert.equal(await statusOf(c.id), 'running');
      assert.equal((await recipients(c.id, 'queued')).length, 3);
      assert.ok((await a.client.get(`/campaigns/${c.id}`)).body.effectiveRatePerMinute === 2);
      env.app.campaigns.limits.telegram = { perMinute: 100, perDay: null };
      await env.app.campaigns.tick();
      assert.equal(await statusOf(c.id), 'completed');
    });
    it('the campaign cannot exceed its own lower rate, and a daily cap holds the rest back', async () => {
      const { ch } = await fresh('DayBot', 4);
      env.app.campaigns.limits.telegram = { perMinute: 100, perDay: 3 };
      const c = await newCampaign(a, ch.id, { ratePerMinute: 1 });
      await approveAndLaunch(a, c.id);
      assert.equal((await env.app.campaigns.tick()).sent, 1);
      assert.equal((await env.app.campaigns.tick()).sent, 0);
      await env.owner.query(`UPDATE campaign_recipients SET sent_at = now() - interval '2 minutes' WHERE campaign_id = $1 AND sent_at IS NOT NULL`, [c.id]);
      await a.client.patch(`/campaigns/${c.id}`, {}).catch(() => undefined);
      await env.app.campaigns.tick(); // minute window is free again but the campaign is capped to 1/min: one more
      assert.equal((await recipients(c.id, 'sent')).length, 2);
      env.app.campaigns.limits.telegram = { perMinute: 300, perDay: null };
      await a.client.post(`/campaigns/${c.id}/cancel`, {});
    });
    it('pause stops sending immediately; resume continues; nobody is sent twice', async () => {
      const { ch } = await fresh('PauseBot', 5);
      env.app.campaigns.limits.telegram = { perMinute: 2, perDay: null };
      env.tg.reset();
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      await env.app.campaigns.tick();
      const p = await a.client.post(`/campaigns/${c.id}/pause`, {});
      assert.equal(p.body.status, 'paused');
      env.app.campaigns.limits.telegram = { perMinute: 100, perDay: null };
      assert.equal((await env.app.campaigns.tick()).sent, 0);
      assert.equal(chatsSent().length, 2);
      assert.equal((await a.client.post(`/campaigns/${c.id}/pause`, {})).status, 409, 'cannot pause twice');
      assert.equal((await a.client.post(`/campaigns/${c.id}/resume`, {})).body.status, 'running');
      await env.app.campaigns.tick();
      assert.equal(chatsSent().length, 5);
      assert.equal(new Set(chatsSent()).size, 5, 'five different people, once each');
      assert.equal(await statusOf(c.id), 'completed');
      assert.equal((await a.client.post(`/campaigns/${c.id}/cancel`, {})).status, 409, 'a completed campaign cannot be cancelled');
    });
    it('cancel stops the rest for good and records what was not sent', async () => {
      const { ch } = await fresh('CancelBot', 5);
      env.app.campaigns.limits.telegram = { perMinute: 1, perDay: null };
      env.tg.reset();
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      await env.app.campaigns.tick();
      const x = await a.client.post(`/campaigns/${c.id}/cancel`, {});
      assert.deepEqual(x.body, { status: 'cancelled', cancelledRecipients: 4 });
      env.app.campaigns.limits.telegram = { perMinute: 300, perDay: null };
      assert.equal((await env.app.campaigns.tick()).sent, 0);
      assert.equal(chatsSent().length, 1);
      const an = (await a.client.get(`/campaigns/${c.id}/analytics`)).body.counts;
      assert.deepEqual([an.sent, an.cancelled, an.queued], [1, 4, 0]);
      assert.equal((await a.client.post(`/campaigns/${c.id}/resume`, {})).status, 409);
    });
    it('failures are recorded per customer and never stop the campaign; a blocked bot marks the person unreachable', async () => {
      const { ch, cts } = await fresh('FailBot', 3);
      env.tg.reset();
      env.tg.failNext('sendMessage', 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      const t = await env.app.campaigns.tick();
      assert.deepEqual([t.sent, t.failed], [2, 1]);
      assert.equal(await statusOf(c.id), 'completed');
      const failed = (await recipients(c.id, 'failed'))[0];
      assert.equal(failed.reason, 'recipient_blocked');
      assert.match(failed.detail, /blocked/i);
      const first = cts[Object.keys(cts)[0]!]!;
      const ct = (await env.owner.query('SELECT unreachable_at, unreachable_reason FROM contacts WHERE id = $1', [failed.contact_id])).rows[0];
      assert.ok(ct.unreachable_at);
      assert.equal(ct.unreachable_reason, 'recipient_blocked');
      assert.ok(first);
      const next = (await a.client.post('/campaigns/audience/preview', { channelId: ch.id, audience: {}, message: 'x' })).body;
      assert.equal(next.eligible, 2, 'the blocked person is skipped from now on');
      assert.deepEqual(next.excluded.map((e: any) => e.reason), ['unreachable']);
      const an = (await a.client.get(`/campaigns/${c.id}/analytics`)).body;
      assert.equal(an.counts.failed, 1);
      assert.ok(an.skippedOrFailed.some((x: any) => x.reason === 'recipient_blocked'));
    });
    it('temporary errors are retried automatically and the campaign waits for the final answer', async () => {
      const { ch } = await fresh('RetryBot', 2);
      env.tg.reset();
      env.tg.failNext('sendMessage', 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
      env.app.channels.retryDelaysSeconds = [0, 0, 0, 0];
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      const t = await env.app.campaigns.tick();
      assert.equal(t.sent, 1);
      assert.equal(await statusOf(c.id), 'running', 'one message is still being retried');
      assert.equal((await recipients(c.id, 'retrying')).length, 1);
      await env.app.channels.tick({ health: false });
      await env.app.campaigns.tick();
      assert.equal(await statusOf(c.id), 'completed');
      assert.equal((await recipients(c.id, 'sent')).length, 2);
      assert.equal(chatsSent().length, 3, 'two people, three attempts: the retry never created a second message');
      assert.equal((await env.owner.query(`SELECT count(*)::int AS n FROM messages WHERE meta ->> 'campaignRecipientId' IS NOT NULL AND channel_id = $1`, [ch.id])).rows[0].n, 2);
      env.app.channels.retryDelaysSeconds = [30, 120, 600, 1800];
    });
    it('eligibility is checked AGAIN at send time: someone who opts out after launch gets nothing', async () => {
      const { ch, cts } = await fresh('RecheckBot', 3);
      env.tg.reset();
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      await a.client.post(`/customers/${Object.values(cts)[1]}/consent`, { status: 'opted_out', source: 'manual' });
      const t = await env.app.campaigns.tick();
      assert.deepEqual([t.sent, t.skipped], [2, 1]);
      assert.equal(chatsSent().length, 2);
      assert.deepEqual((await recipients(c.id, 'skipped')).map((r) => r.reason), ['opted_out']);
    });
    it('a channel that disconnects mid-campaign pauses it automatically and nothing is lost', async () => {
      const { ch } = await fresh('DropBot', 3);
      env.tg.reset();
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      await env.owner.query(`UPDATE channels SET status = 'disconnected' WHERE id = $1`, [ch.id]);
      await env.app.campaigns.tick();
      assert.equal(await statusOf(c.id), 'paused');
      assert.equal(chatsSent().length, 0);
      assert.equal((await recipients(c.id, 'queued')).length, 3);
      assert.ok((await a.client.get(`/campaigns/${c.id}/events`)).body.items.some((e: any) => e.kind === 'auto_paused'));
      await a.client.post(`/campaigns/${c.id}/cancel`, {});
    });
    it('scheduling: nothing is sent before the time; at the time the campaign starts by itself', async () => {
      const { ch } = await fresh('SchedBot', 2);
      env.tg.reset();
      const c = await newCampaign(a, ch.id);
      const when = new Date(Date.now() + 3600_000).toISOString();
      const ln = await approveAndLaunch(a, c.id, when);
      assert.equal(ln.status, 'scheduled');
      assert.equal((await env.app.campaigns.tick()).campaigns, 0);
      assert.equal(chatsSent().length, 0);
      assert.equal((await a.client.post(`/campaigns/${c.id}/launch`, { scheduleAt: new Date(Date.now() - 1000).toISOString() })).status, 409, 'already launched');
      await env.owner.query(`UPDATE campaigns SET scheduled_at = now() - interval '1 second' WHERE id = $1`, [c.id]);
      await env.app.campaigns.tick();
      assert.equal(chatsSent().length, 2);
      assert.equal(await statusOf(c.id), 'completed');
      const bad = await newCampaign(a, ch.id);
      const pv = (await a.client.get(`/campaigns/${bad.id}/preview`)).body;
      await a.client.post(`/campaigns/${bad.id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible });
      assert.equal((await a.client.post(`/campaigns/${bad.id}/launch`, { scheduleAt: new Date(Date.now() - 60_000).toISOString() })).body.error.code, 'invalid_schedule');
    });
    it('a campaign with an empty or too-long message, or nobody eligible, cannot be approved', async () => {
      const { ch } = await fresh('GuardBot', 1);
      const empty = await newCampaign(a, ch.id, { message: '' });
      const pv = (await a.client.get(`/campaigns/${empty.id}/preview`)).body;
      assert.ok(pv.blockers.some((x: any) => x.code === 'empty_message'));
      assert.equal((await a.client.post(`/campaigns/${empty.id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible })).status, 409);
      assert.equal((await a.client.post('/campaigns', { name: 'big', channelId: ch.id, message: 'x'.repeat(1501) })).status, 400);
      const none = await newCampaign(a, ch.id, { audience: { tagsAny: ['nobody-has-this'] } });
      assert.ok((await a.client.get(`/campaigns/${none.id}/preview`)).body.blockers.some((x: any) => x.code === 'no_eligible_recipients'));
    });
    it('a launched campaign cannot be edited or deleted; a draft can', async () => {
      const { ch } = await fresh('EditBot', 1);
      const c = await newCampaign(a, ch.id);
      await approveAndLaunch(a, c.id);
      assert.equal((await a.client.patch(`/campaigns/${c.id}`, { message: 'changed' })).status, 409);
      assert.equal((await a.client.del(`/campaigns/${c.id}`)).status, 409);
      const d = await newCampaign(a, ch.id);
      assert.equal((await a.client.del(`/campaigns/${d.id}`)).status, 204);
      assert.equal((await a.client.get(`/campaigns/${d.id}`)).status, 404);
      await a.client.post(`/campaigns/${c.id}/cancel`, {});
      env.app.campaigns.limits.telegram = { perMinute: 300, perDay: null };
    });
    it('templates: save, list, no duplicate names, delete', async () => {
      const t = await a.client.post('/campaign-templates', { name: 'Weekend offer', body: 'Hi {{first_name}}, weekend offer!' });
      assert.equal(t.status, 201);
      assert.equal((await a.client.post('/campaign-templates', { name: 'Weekend offer', body: 'again' })).status, 409);
      assert.equal((await a.client.get('/campaign-templates')).body.items.length, 1);
      assert.equal((await b.client.get('/campaign-templates')).body.items.length, 0);
      assert.equal((await b.client.del(`/campaign-templates/${t.body.id}`)).status, 404);
      assert.equal((await a.client.del(`/campaign-templates/${t.body.id}`)).status, 204);
    });
  });

  // ─────────────────────────────────────────── the AI campaign builder
  describe('AI Campaign Builder', () => {
    const spec = (o: Record<string, unknown>) => JSON.stringify({ name: 'Latte offer', platform: 'telegram', audience: {}, message: 'Hi {{first_name}}! New latte offer for 45 EGP. Come by today.', improvements: ['Add an end date'], questions: [], ...o });
    it('"send my offer to everyone who contacted us before on Telegram" becomes a DRAFT with audience, count and preview', async () => {
      env.fake.responder = () => spec({ platform: 'telegram' });
      const r = await a.client.post('/campaigns/ai/draft', { prompt: 'عندي عرض جديد على اللاتيه بـ 45 جنيه، ابعته لكل الناس اللي كلمونا قبل كده على Telegram', channelId: tgA.id });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.campaign.status, 'draft', 'the AI can never launch');
      assert.equal(r.body.campaign.createdByAi, true);
      assert.equal(r.body.campaign.platform, 'telegram');
      assert.deepEqual(r.body.campaign.audience, {}, '"all previous contacts" = no filters');
      assert.equal(r.body.preview.total, 6);
      assert.equal(r.body.preview.eligible, 4);
      assert.equal(r.body.preview.excluded.length, 2);
      assert.deepEqual(r.body.draft.improvements, ['Add an end date']);
      assert.equal(r.body.draft.warnings.length, 0, '45 was written by the owner');
      assert.equal((await recipients(r.body.campaign.id)).length, 0);
      assert.equal(env.app.campaigns.limits.telegram.perDay, null);
    });
    it('uses the owner’s words for the audience: "Instagram, last 90 days" and "WhatsApp, did not buy"', async () => {
      const ig = (await env.owner.query(`SELECT id FROM channels WHERE tenant_id = $1 AND type = 'instagram' LIMIT 1`, [a.tenantId])).rows[0].id;
      env.fake.responder = () => spec({ platform: 'instagram', audience: { lastInteraction: { withinDays: 90 } } });
      const r = await a.client.post('/campaigns/ai/draft', { prompt: 'استهدف كل العملاء اللي بعتوا لنا على Instagram خلال آخر 90 يوم. العرض لاتيه بـ 45' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.campaign.audience, { lastInteraction: { withinDays: 90 } });
      assert.equal(r.body.campaign.channelId, ig);
      const wa = (await env.owner.query(`SELECT id FROM channels WHERE tenant_id = $1 AND name = 'WA bulk'`, [a.tenantId])).rows[0].id;
      env.fake.responder = () => spec({ platform: 'whatsapp', audience: { purchased: false, bogusKey: 1, tagsAny: ['made-up-tag'] } });
      const w = await a.client.post('/campaigns/ai/draft', { prompt: 'ابعت العرض للعملاء اللي تواصلوا معانا على WhatsApp ومشتروش. لاتيه 45', channelId: wa });
      assert.equal(w.status, 201, JSON.stringify(w.body));
      assert.deepEqual(w.body.campaign.audience, { purchased: false }, 'unknown keys and non-existent tags never reach the audience');
      assert.ok(w.body.draft.warnings.some((x: string) => x.includes('made-up-tag')));
      assert.equal(w.body.preview.requiresUnofficialAck, true);
    });
    it('invented prices/discounts are flagged; the owner has to remove them before approving', async () => {
      env.fake.responder = () => spec({ message: 'Latte now 30 EGP, 20% off today only!' });
      const r = await a.client.post('/campaigns/ai/draft', { prompt: 'new latte offer for 45 EGP for everyone on Telegram', channelId: tgA.id });
      assert.equal(r.status, 201);
      assert.ok(r.body.draft.warnings.some((w: string) => w.includes('30') && w.includes('20')), JSON.stringify(r.body.draft.warnings));
      assert.ok(r.body.campaign.aiNotes.warnings.length >= 1, 'warnings are saved with the draft');
    });
    it('asks when something is missing instead of guessing: no platform, several channels, no channel', async () => {
      env.fake.responder = () => spec({ platform: null, questions: ['Which platform?'] });
      const r1 = await a.client.post('/campaigns/ai/draft', { prompt: 'I have a new offer, send it to everybody' });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.needs, 'platform');
      assert.equal(r1.body.campaign, undefined);
      env.fake.responder = () => spec({ platform: 'telegram' });
      const r2 = await a.client.post('/campaigns/ai/draft', { prompt: 'send the offer to Telegram people please, latte 45' });
      assert.equal(r2.body.needs, 'channel', 'two Telegram bots are connected: the owner picks');
      assert.ok(r2.body.channels.length >= 2);
      env.fake.responder = () => spec({ platform: 'instagram' });
      const r4 = await b.client.post('/campaigns/ai/draft', { prompt: 'send the offer to Instagram people please, latte 45' });
      assert.equal(r4.body.needs, 'channel_missing');
    });
    it('a channel from another platform or another company is refused', async () => {
      env.fake.responder = () => spec({ platform: 'telegram' });
      const wa = (await env.owner.query(`SELECT id FROM channels WHERE tenant_id = $1 AND type = 'whatsapp' LIMIT 1`, [a.tenantId])).rows[0].id;
      assert.equal((await a.client.post('/campaigns/ai/draft', { prompt: 'send the offer to Telegram people, latte 45', channelId: wa })).status, 400);
      assert.equal((await a.client.post('/campaigns/ai/draft', { prompt: 'send the offer to Telegram people, latte 45', channelId: tgB.id })).status, 400);
    });
    it('garbage from the model never becomes a campaign', async () => {
      env.fake.responder = () => 'Sure! Here is a great campaign for you.';
      const r = await a.client.post('/campaigns/ai/draft', { prompt: 'send the offer to all Telegram contacts, latte 45', channelId: tgA.id });
      assert.equal(r.status, 502);
      assert.equal(r.body.error.code, 'ai_bad_response');
      env.fake.responder = () => JSON.stringify({ name: 123, platform: 'myspace', audience: 'all', message: 5 });
      const r2 = await a.client.post('/campaigns/ai/draft', { prompt: 'send the offer to all Telegram contacts, latte 45', channelId: tgA.id });
      assert.equal(r2.body.needs, 'platform', 'an unknown platform is treated as "not said"');
    });
    it('manage the campaign by chatting: revise the draft, approval is reset, preview is recomputed', async () => {
      env.fake.responder = () => spec({});
      const d = await a.client.post('/campaigns/ai/draft', { prompt: 'latte offer 45 EGP to my Telegram people', channelId: tgA.id });
      const id = d.body.campaign.id;
      const pv = (await a.client.get(`/campaigns/${id}/preview`)).body;
      await a.client.post(`/campaigns/${id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible });
      assert.equal(await statusOf(id), 'approved');
      env.fake.responder = (body: any) => {
        assert.ok(JSON.stringify(body.messages).includes('Current draft'), 'the model sees the current draft');
        return spec({ audience: { tagsAny: ['vip'] }, message: 'Hi {{first_name}}! VIP latte offer: 45 EGP.' });
      };
      const r = await a.client.post(`/campaigns/${id}/ai/revise`, { instruction: 'only my VIP customers, mention VIP' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.campaign.status, 'draft', 'a change needs a new approval');
      assert.deepEqual(r.body.campaign.audience, { tagsAny: ['vip'] });
      assert.ok(r.body.campaign.message.includes('VIP'));
      assert.equal(r.body.preview.total, 2);
      assert.equal((await a.client.post(`/campaigns/${id}/launch`, {})).body.error.code, 'not_approved');
      await a.client.del(`/campaigns/${id}`);
    });
    it('a launched campaign cannot be revised by the AI; viewers cannot use the builder', async () => {
      const c = await newCampaign(a, tgLive.id);
      env.fake.responder = () => spec({});
      await approveAndLaunch(a, c.id);
      assert.equal((await a.client.post(`/campaigns/${c.id}/ai/revise`, { instruction: 'change the text please' })).status, 409);
      assert.equal((await aViewer.post('/campaigns/ai/draft', { prompt: 'latte offer 45 to telegram' })).status, 403);
      await a.client.post(`/campaigns/${c.id}/cancel`, {});
    });
    it('the builder is metered like every other AI call', async () => {
      const u = (await env.owner.query(`SELECT count(*)::int AS n FROM ai_usage WHERE tenant_id = $1 AND purpose = 'campaign_builder'`, [a.tenantId])).rows[0].n;
      assert.ok(u >= 5);
    });
  });

  // ─────────────────────────────────────────── isolation between companies
  describe('Company isolation', () => {
    it("company B sees none of A's customers, campaigns, recipients or events", async () => {
      const bc = (await b.client.get('/customers')).body;
      assert.deepEqual(bc.items.map((c: any) => c.name).sort(), ['Bea Secret', 'Bob Secret']);
      assert.equal((await b.client.get(`/customers/${ids['Sara Hassan']}`)).status, 404);
      assert.equal((await b.client.patch(`/customers/${ids['Sara Hassan']}`, { notes: 'hack' })).status, 404);
      assert.equal((await b.client.post(`/customers/${ids['Sara Hassan']}/consent`, { status: 'opted_out', source: 'manual' })).status, 404);
      assert.deepEqual((await b.client.post('/customers/bulk-tags', { ids: [ids['Sara Hassan']], add: ['pwned'] })).body, { updated: 0 });
      assert.ok(!(await env.owner.query(`SELECT 1 FROM contacts WHERE id = $1 AND 'pwned' = ANY(tags)`, [ids['Sara Hassan']])).rowCount);
      assert.deepEqual((await b.client.get('/campaigns')).body.items, []);
      const aCamp = (await env.owner.query(`SELECT id FROM campaigns WHERE tenant_id = $1 LIMIT 1`, [a.tenantId])).rows[0].id;
      for (const p of ['', '/preview', '/analytics', '/events', '/recipients']) assert.equal((await b.client.get(`/campaigns/${aCamp}${p}`)).status, 404, p || 'detail');
      for (const act of ['approve', 'launch', 'pause', 'resume', 'cancel']) assert.equal((await b.client.post(`/campaigns/${aCamp}/${act}`, act === 'approve' ? { hash: 'a'.repeat(64), confirmRecipients: 0 } : {})).status, 404, act);
      assert.equal((await b.client.patch(`/campaigns/${aCamp}`, { name: 'hijack' })).status, 404);
      assert.equal((await b.client.del(`/campaigns/${aCamp}`)).status, 404);
    });
    it("B cannot point a campaign or a preview at A's channel, nor use A's campaign as an audience", async () => {
      assert.equal((await b.client.post('/campaigns', { name: 'x', channelId: tgA.id, message: 'hi' })).status, 404);
      assert.equal((await b.client.post('/campaigns/audience/preview', { channelId: tgA.id, audience: {}, message: 'x' })).status, 404);
      const aCamp = (await env.owner.query(`SELECT id FROM campaigns WHERE tenant_id = $1 LIMIT 1`, [a.tenantId])).rows[0].id;
      assert.equal((await b.client.post('/campaigns/audience/preview', { channelId: tgB.id, audience: { previousCampaign: { campaignId: aCamp, replied: true } }, message: 'x' })).status, 400);
    });
    it('B can run its own campaign, and A’s customers are not touched', async () => {
      env.tg.reset();
      env.app.campaigns.limits.telegram = { perMinute: 300, perDay: null };
      const c = await newCampaign(b, tgB.id, { name: 'B offer' });
      await approveAndLaunch(b, c.id);
      await env.app.campaigns.tick();
      assert.deepEqual(chatsSent().sort(), ['9101', '9102']);
      assert.ok(chatsSent().every((x) => !['9001', '9002', '9003', '9006'].includes(x)));
      const adBefore = (await env.owner.query(`SELECT count(*)::int AS n FROM campaign_recipients WHERE tenant_id = $1`, [a.tenantId])).rows[0].n;
      assert.ok(adBefore > 0);
    });
    it('the database enforces it too: another tenant context sees nothing, even without the API; platform admins have no grants', async () => {
      for (const table of ['contacts', 'customer_events', 'campaigns', 'campaign_recipients', 'campaign_events', 'campaign_templates']) {
        const n = await withTenant(env.app.pools.app, b.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [a.tenantId])).rows[0].n);
        assert.equal(n, 0, table);
      }
      await assert.rejects(withTenant(env.app.pools.app, b.tenantId, (c) => c.query(`INSERT INTO campaigns (tenant_id, name, channel_id, platform, message) VALUES ($1, 'x', $2, 'telegram', 'x')`, [a.tenantId, tgA.id])), /row-level security|violates/);
      await assert.rejects(withTenant(env.app.pools.app, b.tenantId, (c) => c.query(`INSERT INTO campaign_recipients (tenant_id, campaign_id, channel_id, contact_id, status) SELECT $1, id, channel_id, $2, 'queued' FROM campaigns LIMIT 1`, [b.tenantId, ids['Sara Hassan']])));
      for (const table of ['contacts', 'campaigns', 'campaign_recipients', 'customer_events', 'campaign_events']) {
        await assert.rejects(env.app.pools.platform.query(`SELECT 1 FROM ${table} LIMIT 1`), /permission denied/, `platform role must not read ${table}`);
      }
    });
    it('a recipient can only point at a contact of the SAME channel as the campaign (composite foreign key)', async () => {
      const aCamp = (await env.owner.query(`SELECT id, channel_id FROM campaigns WHERE tenant_id = $1 AND channel_id = $2 LIMIT 1`, [a.tenantId, tgA.id])).rows[0];
      const other = (await env.owner.query(`SELECT id FROM contacts WHERE tenant_id = $1 AND channel_id <> $2 LIMIT 1`, [a.tenantId, tgA.id])).rows[0].id;
      await assert.rejects(env.owner.query(`INSERT INTO campaign_recipients (tenant_id, campaign_id, channel_id, contact_id, status) VALUES ($1, $2, $3, $4, 'queued')`, [a.tenantId, aCamp.id, aCamp.channel_id, other]), /foreign key/);
    });
    it('privacy: credentials and customer data are not in campaign responses', async () => {
      const dump = JSON.stringify((await a.client.get('/campaigns')).body) + JSON.stringify((await a.client.get('/campaigns/platforms')).body);
      assert.ok(!dump.includes('AAAAAAAAAAAA') && !dump.includes('CCCCCCCCCC') && !dump.includes(tgA.secret));
    });
  });
});
