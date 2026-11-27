/**
 * Load / failure-recovery measurements. Run: `node --import tsx test/load.ts [scenario…]` (needs the test database).
 * IMPORTANT: AI and messaging providers are LOCAL FAKES with configurable latency, so these numbers measure MicroAgent itself
 * (HTTP handling, database, queues, workers) on THIS machine — not OpenRouter, WhatsApp, Telegram or Meta. Results are printed, never assumed.
 */
import { performance } from 'node:perf_hooks';
import { createTestEnv, signupTenant } from './helpers.js';
import { buildApp } from '../src/app.js';

const want = new Set(process.argv.slice(2));
const run = (n: string) => want.size === 0 || want.has(n);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!) : 0; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = {};
const report = (name: string, v: Record<string, unknown>) => { out[name] = v; console.log(`\n=== ${name}\n${JSON.stringify(v, null, 1)}`); };

const env = await createTestEnv();
env.app.config.appUrl = 'https://app.example.test';
env.app.campaigns.smooth = false;
const t = await signupTenant(env, 'Load Co');
const emp = (await t.client.post('/ai-employees', { name: 'Nour', tasks: ['sales_assistant', 'customer_support', 'human_handoff'] })).body.id;
await env.owner.query(`UPDATE ai_employees SET status = 'active' WHERE id = $1`, [emp]);
const TOKEN = '999999:LOADTESTTOKENLOADTESTTOKENLOADTEST123';
env.tg.addBot(TOKEN, 999999, 'load_bot');
const ch = (await t.client.post('/channels', { type: 'telegram', name: 'Load bot', employeeId: emp })).body;
await t.client.post(`/channels/${ch.id}/connect`, { botToken: TOKEN });
const key = (await env.owner.query('SELECT public_key FROM channels WHERE id=$1', [ch.id])).rows[0].public_key as string;
const secret = env.tg.webhooks.get(TOKEN)!.secret;
let uid = 0;
const update = (chat: number, text: string) => ({ update_id: ++uid, message: { message_id: uid, date: Math.floor(Date.now() / 1000), from: { id: chat, is_bot: false, first_name: `C${chat}` }, chat: { id: chat, type: 'private', first_name: `C${chat}` }, text } });
const hook = (chat: number, text: string) => env.app.inject({ method: 'POST', url: `/api/v1/webhooks/channel/${key}`, payload: update(chat, text), headers: { 'x-telegram-bot-api-secret-token': secret } });
const sentCount = () => env.tg.callsTo('sendMessage').length;
env.app.workflows.start();

// ───────────────────────── 1. concurrent inbound conversations (with AI replies and a live workflow)
if (run('conversations')) {
  env.fake.defaultDelayMs = 300; env.tg.latencyMs = 30;
  const wf = (await t.client.post('/workflows', { name: 'Tag everyone' })).body;
  await t.client.put(`/workflows/${wf.id}/graph`, { baseVersion: 1, graph: { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'message_received' } }, { id: 'a', type: 'action', position: { x: 1, y: 0 }, data: { kind: 'add_tag', tag: 'load' } }], edges: [{ id: 'e', source: 't', target: 'a', sourceHandle: 'out' }] } });
  const act = await t.client.post(`/workflows/${wf.id}/activate`); if (act.status !== 200) throw new Error('activate ' + JSON.stringify(act.body));
  let base = 5000;
  for (const N of [20, 100, 300]) {
    const before = sentCount(); const lat: number[] = []; let bad = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, async (_, i) => { const s = performance.now(); const r = await hook(base + i, 'Hi, how much is a latte?'); lat.push(performance.now() - s); if (r.statusCode !== 200) bad++; }));
    const tHttp = performance.now() - t0;
    while (sentCount() - before < N && performance.now() - t0 < 120000) await sleep(50);
    const tAll = performance.now() - t0;
    const replied = sentCount() - before;
    // wait for workflow runs of this batch
    let done = 0; const w0 = performance.now();
    while (performance.now() - w0 < 8000) { done = (await env.owner.query(`SELECT count(*)::int n FROM workflow_runs WHERE workflow_id=$1 AND mode='live' AND status='completed'`, [wf.id])).rows[0].n; if (done >= (base - 5000) + N) break; await sleep(200); }
    const runs = (await env.owner.query(`SELECT status, count(*)::int n FROM workflow_runs WHERE workflow_id=$1 GROUP BY status`, [wf.id])).rows;
    const lost = (await env.owner.query(`SELECT count(*)::int n FROM conversations c WHERE c.tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.direction='out')`, [t.tenantId])).rows[0].n;
    report(`conversations N=${N}`, { webhookHttpErrors: bad, webhookP50ms: pct(lat, 50), webhookP95ms: pct(lat, 95), webhookMaxMs: pct(lat, 100), allAcceptedAfterMs: Math.round(tHttp), aiRepliesSent: `${replied}/${N}`, allRepliedAfterMs: Math.round(tAll), conversationsWithoutReply: lost, workflowRuns: runs });
    base += 1000;
  }
  // one customer sending a burst: ordering and no duplicate replies
  const b0 = sentCount(); await Promise.all(Array.from({ length: 15 }, (_, i) => hook(99000, `burst ${i}`))); await sleep(4000);
  const m = (await env.owner.query(`SELECT count(*) FILTER (WHERE direction='in')::int inb, count(*) FILTER (WHERE direction='out')::int outb FROM messages m JOIN conversations cv ON cv.id=m.conversation_id JOIN contacts c ON c.id=cv.contact_id WHERE c.external_id='99000'`)).rows[0];
  report('burst 15 msgs from one customer', { ...m, replySendsToProvider: sentCount() - b0 });
  env.fake.defaultDelayMs = 0; env.tg.latencyMs = 0;
}

// ───────────────────────── 2. campaign queue throughput + retry
async function seedContacts(n: number, prefix: string) {
  await env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id, name, first_seen_at, last_seen_at, last_inbound_at, consent_status, status)
    SELECT $1, $2, $3 || g, 'Seed ' || g, now(), now(), now() - interval '1 hour', 'opted_in', 'lead' FROM generate_series(1, $4) g`, [t.tenantId, ch.id, prefix, n]);
  await env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id) SELECT tenant_id, channel_id, 'telegram', id FROM contacts WHERE external_id LIKE $1 || '%' AND tenant_id=$2`, [prefix, t.tenantId]);
}
async function launch(name: string) {
  const c = (await t.client.post('/campaigns', { name, channelId: ch.id, message: 'Hi {{first_name}}, new offer!', audience: { optedInOnly: true } })).body;
  const pv = (await t.client.get(`/campaigns/${c.id}/preview`)).body; if (!pv.hash) throw new Error('preview ' + JSON.stringify(pv).slice(0, 600));
  const ap = await t.client.post(`/campaigns/${c.id}/approve`, { hash: pv.hash, confirmRecipients: pv.eligible, acknowledgeUnofficialRisk: true });
  if (ap.status !== 200) throw new Error('approve ' + JSON.stringify(ap.body));
  const ln = await t.client.post(`/campaigns/${c.id}/launch`, {}); if (ln.status !== 200) throw new Error('launch ' + JSON.stringify(ln.body));
  return { id: c.id as string, eligible: pv.eligible as number };
}
const recStatus = async (id: string) => Object.fromEntries((await env.owner.query(`SELECT status, count(*)::int n FROM campaign_recipients WHERE campaign_id=$1 GROUP BY status`, [id])).rows.map((r) => [r.status, r.n]));
if (run('campaign')) {
  await env.owner.query(`UPDATE tenants SET plan='scale' WHERE id=$1`, [t.tenantId]);
  // Platform pacing (Telegram 300/min) is a deliberate safety limit. To measure the ENGINE itself we lift it here; production keeps it.
  env.app.campaigns.limits.telegram.perMinute = 1_000_000;
  env.app.channels.retryDelaysSeconds = [1, 1, 1, 1]; // production uses 30s / 2min / 10min / 30min
  for (const [N, fail] of (JSON.parse(process.env.CAMPAIGN_CASES ?? '[[500,0],[2000,0],[1000,0.15]]') as Array<[number, number]>)) {
    env.tg.latencyMs = 20; env.tg.failRate = fail; env.tg.reset();
    const prefix = `cp${N}_${fail}_`; await seedContacts(N, prefix);
    const { id, eligible } = await launch(`load ${N} fail ${fail}`);
    const t0 = performance.now(); let st: Record<string, number> = {};
    while (performance.now() - t0 < 300000) { await env.app.campaigns.tick(); if (fail) await env.app.channels.tick(); st = await recStatus(id); if (!(st.queued || st.sending || st.pending || st.retrying)) break; await sleep(100); }
    const secs = (performance.now() - t0) / 1000;
    const per = new Map<string, number>(); for (const c of env.tg.callsTo('sendMessage')) per.set(String(c.body.chat_id), (per.get(String(c.body.chat_id)) ?? 0) + 1);
    const dupes = [...per.values()].filter((n) => n > 1).length;
    report(`campaign ${N} recipients, provider failure rate ${fail}`, { eligible, finalStatuses: st, seconds: +secs.toFixed(1), sendsPerSecond: +((st.sent ?? 0) / secs).toFixed(1), providerCalls: env.tg.callsTo('sendMessage').length, recipientsWithMoreThanOneProviderCall: dupes });
    env.tg.failRate = 0; env.tg.latencyMs = 0;
    await env.owner.query(`DELETE FROM contacts WHERE external_id LIKE $1 AND tenant_id=$2`, [prefix + '%', t.tenantId]).catch(() => undefined);
  }
}

// ───────────────────────── 3. crash recovery: stop the app mid-campaign, start a new one on the same database
if (run('recovery')) {
  env.tg.latencyMs = 40; env.tg.reset();
  const N = 600; const prefix = 'rc_'; await seedContacts(N, prefix);
  await env.owner.query(`UPDATE tenants SET plan='scale' WHERE id=$1`, [t.tenantId]); env.app.campaigns.limits.telegram.perMinute = 1_000_000;
  const { id } = await launch('crash recovery');
  const t0 = performance.now();
  while (performance.now() - t0 < 60000) { await env.app.campaigns.tick(); const s = await recStatus(id); if ((s.sent ?? 0) >= 150) break; await sleep(50); }
  const mid = await recStatus(id);
  // Simulate a hard crash: no graceful drain; leave in-flight rows exactly as they are.
  env.app.campaigns.stop();
  const app2 = await buildApp({ config: env.config, logger: false, rateLimit: false }); await app2.ready(); app2.campaigns.smooth = false; app2.campaigns.limits.telegram.perMinute = 1_000_000;
  const r0 = performance.now(); let st: Record<string, number> = {};
  while (performance.now() - r0 < 180000) { await app2.campaigns.tick(); st = await recStatus(id); if (!(st.queued || st.sending || st.pending)) break; await sleep(100); }
  const per = new Map<string, number>(); for (const c of env.tg.callsTo('sendMessage')) per.set(String(c.body.chat_id), (per.get(String(c.body.chat_id)) ?? 0) + 1);
  report('crash recovery (campaign)', { statusAtCrash: mid, statusAfterRestart: st, secondsToFinishAfterRestart: +((performance.now() - r0) / 1000).toFixed(1), recipientsSentMoreThanOnce: [...per.values()].filter((n) => n > 1).length, note: 'A send that was in flight at the moment of the crash cannot be known to have reached the provider; see recipientsSentMoreThanOnce.' });
  await app2.close(); env.tg.latencyMs = 0;
}

// ───────────────────────── 4. database query timings on a large tenant
if (run('db')) {
  const M = Number(process.env.LOAD_MESSAGES ?? 200000), C = Math.floor(M / 10);
  await env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id, name, first_seen_at, last_seen_at, last_inbound_at, consent_status, status, tags)
    SELECT $1, $2, 'big' || g, 'Big ' || g, now() - (g % 90 || ' days')::interval, now() - (g % 90 || ' days')::interval, now() - (g % 90 || ' days')::interval, 'opted_in', (ARRAY['new','lead','customer'])[1 + g % 3], ARRAY['t' || (g % 20)] FROM generate_series(1, $3) g`, [t.tenantId, ch.id, C]);
  await env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id, last_message_at, unread_count) SELECT tenant_id, channel_id, 'telegram', id, last_seen_at, 1 FROM contacts WHERE external_id LIKE 'big%' AND tenant_id=$1`, [t.tenantId]);
  await env.owner.query(`INSERT INTO messages (tenant_id, conversation_id, channel_id, direction, sender_type, body, status, created_at)
    SELECT c.tenant_id, c.id, c.channel_id, CASE WHEN g % 2 = 0 THEN 'in' ELSE 'out' END, CASE WHEN g % 2 = 0 THEN 'customer' ELSE 'ai' END, 'msg ' || g, 'sent', c.last_message_at - (g || ' minutes')::interval
    FROM conversations c, generate_series(1, 10) g WHERE c.contact_id IN (SELECT id FROM contacts WHERE external_id LIKE 'big%' AND tenant_id=$1)`, [t.tenantId]).catch((e) => console.log('messages seed:', e.message.slice(0, 200)));
  await env.owner.query('ANALYZE');
  const counts = (await env.owner.query(`SELECT (SELECT count(*) FROM messages)::int m, (SELECT count(*) FROM contacts)::int c, (SELECT count(*) FROM conversations)::int cv`)).rows[0];
  const adm = (await import('./helpers.js')).createPlatformAdmin; const admin = await adm(env);
  const today = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const timings: Record<string, number[]> = {};
  const time = async (label: string, fn: () => Promise<{ status: number }>) => { const xs: number[] = []; for (let i = 0; i < 5; i++) { const s = performance.now(); const r = await fn(); if (r.status !== 200) { console.log(label, r.status); break; } xs.push(performance.now() - s); } timings[label] = xs; };
  await time('GET /conversations', () => t.client.get('/conversations?platform=telegram'));
  await time('GET /conversations (page 20)', () => t.client.get('/conversations?platform=telegram&page=20'));
  await time('GET /customers', () => t.client.get('/customers'));
  await time('GET /customers?status=lead&search=Big 1', () => t.client.get('/customers?status=lead&search=Big%201'));
  await time('GET /overview', () => t.client.get('/overview'));
  await time('GET /performance (30d)', () => t.client.get(`/performance?from=${from}&to=${today}`));
  await time('GET /performance (30d, platform filter)', () => t.client.get(`/performance?from=${from}&to=${today}&platform=telegram`));
  await time('POST /campaigns/audience/preview', () => t.client.post('/campaigns/audience/preview', { channelId: ch.id, audience: { optedInOnly: true, tagsAny: ['t3'] }, message: 'Hi {{first_name}}' }));
  await time('GET /platform/dashboard', () => admin.get('/platform/dashboard?days=30'));
  report(`db queries with ${counts.m} messages / ${counts.c} contacts / ${counts.cv} conversations (ms over 5 runs)`, Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v.length ? { min: Math.round(Math.min(...v)), p50: pct(v, 50), max: Math.round(Math.max(...v)) } : 'FAILED'])));
}

console.log('\nJSON_RESULTS ' + JSON.stringify(out));
await env.close();
process.exit(0);
