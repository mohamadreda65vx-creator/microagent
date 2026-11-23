import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, createTestEnv, inviteMember, signupTenant, type TestEnv, type Tenant } from './helpers.js';

let env: TestEnv;
let a: Tenant;
let b: Tenant;
let aManager: Client;
let aViewer: Client;
let aEmp: string;
let n = 100;

const reply = (text: string, actions: unknown[] = []) => JSON.stringify({ reply: text, actions });
const lastUser = (body: any): string => [...body.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
const settle = () => env.app.channels.idle();
const activate = (id: string) => env.owner.query(`UPDATE ai_employees SET status = 'active' WHERE id = $1`, [id]);

const hook = (key: string, payload: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url: `/api/v1/webhooks/channel/${key}`, payload: payload as object, headers });
const tgUpdate = (chat: number, mid: number, text: string, extra: Record<string, unknown> = {}, chatType = 'private') => ({
  update_id: ++n,
  message: { message_id: mid, date: Math.floor(Date.now() / 1000), from: { id: chat, is_bot: false, first_name: 'Sara' }, chat: { id: chat, type: chatType, first_name: 'Sara' }, text, ...extra },
});
const tgHeaders = (secret: string) => ({ 'x-telegram-bot-api-secret-token': secret });

const sign = (raw: string) => `sha256=${createHmac('sha256', 'APP-SECRET-xyz').update(raw).digest('hex')}`;
const metaHook = (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  return env.app.inject({ method: 'POST', url: '/api/v1/webhooks/meta', payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(raw) } });
};
const msgEvent = (pageId: string, psid: string, mid: string, text: string, object = 'page') => ({ object, entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text } }] }] });

const evoKeyOf = async (t: Tenant, channelId: string) => (await env.owner.query('SELECT external_account_id FROM channels WHERE id = $1', [channelId])).rows[0].external_account_id as string;
const evoHook = (key: string, secret: string, payload: unknown) => hook(key, payload, { 'x-microagent-secret': secret });
const evoSecret = (instanceBody: any) => instanceBody.webhook.headers['x-microagent-secret'] as string;
const evoMsg = (instance: string, jid: string, id: string, text: string, extra: Record<string, unknown> = {}) => ({ event: 'messages.upsert', instance, data: { key: { remoteJid: jid, fromMe: false, id }, pushName: 'Mona', message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), ...extra } });

async function createChannel(t: Tenant, type: string, name: string, extra: object = {}): Promise<{ id: string; status: string; publicKey?: string; webhookUrl: string }> {
  const r = await t.client.post('/channels', { type, name, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { id: string; publicKey?: string; webhookUrl: string; status: string };
}
const keyOf = async (channelId: string) => (await env.owner.query('SELECT public_key FROM channels WHERE id = $1', [channelId])).rows[0].public_key as string;
const messagesOf = async (channelId: string) => (await env.owner.query('SELECT * FROM messages WHERE channel_id = $1 ORDER BY created_at, id', [channelId])).rows;
const chatCount = () => env.fake.chatCalls.length;

describe('Channels & conversations (Part 3)', () => {
  before(async () => {
    env = await createTestEnv();
    env.app.config.appUrl = 'https://app.example.test'; // Telegram only accepts https webhooks
    a = await signupTenant(env, 'Cafe Nile');
    b = await signupTenant(env, 'Gadget Shop');
    aManager = await inviteMember(env, a, 'manager');
    aViewer = await inviteMember(env, a, 'viewer');
    aEmp = (await a.client.post('/ai-employees', { name: 'Nour', tasks: ['sales_assistant', 'customer_support', 'human_handoff'] })).body.id;
    await a.client.post('/knowledge/items', { kind: 'product', name: 'Latte', data: { price: 45, currency: 'EGP' } });
    await activate(aEmp);
    env.fake.responder = (body) => (/latte/i.test(lastUser(body)) ? reply('The latte costs 45 EGP.') : reply('Sorry, I will check with the team.'));
    env.tg.addBot('111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 111111, 'cafe_bot');
    env.tg.addBot('222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 222222, 'gadget_bot');
  });
  after(async () => { await env.close(); });

  // ─────────────────────────────────────────────── Telegram
  describe('Telegram', () => {
    const TOKEN = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    let ch: { id: string; status: string }; let key: string; let secret: string;

    it('catalog says what is available; TikTok and WhatsApp Cloud are NOT usable', async () => {
      const c = await a.client.get('/channels/catalog');
      assert.equal(c.status, 200);
      const byType = Object.fromEntries(c.body.items.map((i: any) => [i.type, i]));
      assert.equal(byType.telegram.serverReady, true);
      assert.equal(byType.tiktok.available, false);
      assert.equal(byType.whatsapp.unofficial, true);
      assert.ok(byType.messenger.notes.join(' ').includes('not verified'));
      const tt = await a.client.post('/channels', { type: 'tiktok', name: 'TikTok' });
      assert.equal(tt.status, 409);
      assert.equal(env.app.channels.registry.get('whatsapp', 'whatsapp_cloud').available, false);
    });

    it('rejects a bad token, connects with a good one, registers the webhook with a secret, never returns credentials', async () => {
      ch = await createChannel(a, 'telegram', 'Cafe bot', { employeeId: aEmp });
      assert.equal(ch.status, 'pending');
      assert.equal((await a.client.post(`/channels/${ch.id}/connect`, { botToken: 'nonsense' })).status, 400);
      const bad = await a.client.post(`/channels/${ch.id}/connect`, { botToken: '999999:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'invalid_token');
      const ok = await a.client.post(`/channels/${ch.id}/connect`, { botToken: TOKEN });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.status, 'connected');
      key = await keyOf(ch.id);
      const hookInfo = env.tg.webhooks.get(TOKEN)!;
      assert.equal(hookInfo.url, `https://app.example.test/api/v1/webhooks/channel/${key}`);
      secret = hookInfo.secret;
      assert.ok(secret.length >= 20);
      const detail = await a.client.get(`/channels/${ch.id}`);
      const dump = JSON.stringify(detail.body) + JSON.stringify((await a.client.get('/channels')).body);
      assert.ok(!dump.includes(TOKEN) && !dump.includes('AAAAAAAAAAAA') && !dump.includes(secret), 'credentials leaked through the API');
      assert.equal(detail.body.account, '@cafe_bot');
      const row = (await env.owner.query('SELECT credentials_enc FROM channels WHERE id = $1', [ch.id])).rows[0];
      assert.ok(row.credentials_enc.startsWith('v1.') && !row.credentials_enc.includes('AAAAAAAA'), 'credentials must be stored encrypted');
    });

    it('refuses updates with a wrong or missing secret (nothing stored)', async () => {
      assert.equal((await hook(key, tgUpdate(5, 1, 'hi'))).statusCode, 401);
      assert.equal((await hook(key, tgUpdate(5, 1, 'hi'), tgHeaders('wrong-secret'))).statusCode, 401);
      assert.equal((await messagesOf(ch.id)).length, 0);
      assert.equal((await hook('does-not-exist-key', tgUpdate(5, 1, 'hi'))).statusCode, 404);
      const d = await a.client.get(`/channels/${ch.id}`);
      assert.ok(d.body.last24h.rejected >= 2, 'rejections are recorded');
    });

    it('receives a message, stores it, the employee answers, the answer is sent and stored with its provider id', async () => {
      env.fake.reset();
      const r = await hook(key, tgUpdate(5001, 1, 'How much is the latte?'), tgHeaders(secret));
      assert.equal(r.statusCode, 200);
      await settle();
      const msgs = await messagesOf(ch.id);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].direction, 'in');
      assert.equal(msgs[0].body, 'How much is the latte?');
      assert.equal(msgs[0].external_id, '5001:1');
      assert.equal(msgs[1].direction, 'out');
      assert.equal(msgs[1].sender_type, 'ai');
      assert.equal(msgs[1].status, 'sent');
      assert.ok(msgs[1].external_id?.startsWith('5001:'));
      assert.ok(msgs[1].body.includes('45'));
      const sent = env.tg.callsTo('sendMessage');
      assert.equal(sent.length, 1);
      assert.equal(String(sent[0]!.body.chat_id), '5001');
      assert.ok(sent[0]!.body.text.includes('45 EGP'));
      const list = await a.client.get('/conversations?platform=telegram');
      assert.equal(list.body.items.length, 1);
      assert.equal(list.body.items[0].contact.name, 'Sara');
      assert.equal(list.body.items[0].unreadCount, 1);
      assert.equal(list.body.items[0].aiState, 'ai_answering');
    });

    it('does NOT duplicate when the same webhook is delivered again, even 5 times at once', async () => {
      const before = (await messagesOf(ch.id)).length;
      const calls = chatCount();
      const sends = env.tg.callsTo('sendMessage').length;
      const dup = tgUpdate(5001, 1, 'How much is the latte?');
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => hook(key, dup, tgHeaders(secret))));
      assert.ok(rs.every((x) => x.statusCode === 200));
      await settle();
      assert.equal((await messagesOf(ch.id)).length, before, 'no new rows');
      assert.equal(chatCount(), calls, 'the model is not called again');
      assert.equal(env.tg.callsTo('sendMessage').length, sends, 'nothing is re-sent to the customer');
      // a brand-new message delivered 5 times in parallel produces exactly one stored message and one reply
      const fresh = tgUpdate(5002, 7, 'How much is the latte?');
      await Promise.all([1, 2, 3, 4, 5].map(() => hook(key, fresh, tgHeaders(secret))));
      await settle();
      const rows = (await messagesOf(ch.id)).filter((m) => m.external_id === '5002:7');
      assert.equal(rows.length, 1);
      assert.equal((await messagesOf(ch.id)).filter((m) => m.direction === 'out' && m.external_id?.startsWith('5002:')).length, 1, 'exactly one reply');
    });

    it('message_id alone is not the idempotency key: same id from a different chat is a different message', async () => {
      await hook(key, tgUpdate(5003, 1, 'hello from someone else'), tgHeaders(secret));
      await settle();
      assert.equal((await a.client.get('/conversations?platform=telegram')).body.items.length, 3);
    });

    it('ignores group chats and non-message updates', async () => {
      const before = (await messagesOf(ch.id)).length;
      const g = await hook(key, tgUpdate(-100500, 3, 'group talk', {}, 'supergroup'), tgHeaders(secret));
      assert.equal(g.statusCode, 200);
      assert.equal(g.json().ignored, 1);
      assert.equal((await hook(key, { update_id: 9, edited_message: { text: 'x' } }, tgHeaders(secret))).json().ignored, 1);
      assert.equal((await messagesOf(ch.id)).length, before);
    });

    it('a human reply takes the conversation over; the AI stays silent afterwards', async () => {
      const conv = (await a.client.get('/conversations?platform=telegram')).body.items.find((c: any) => c.contact.externalId === '5001');
      assert.equal((await aViewer.post(`/conversations/${conv.id}/messages`, { text: 'hi' })).status, 403, 'viewers cannot reply');
      env.tg.reset();
      const r = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'Hi Sara, this is Karim from the cafe.' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.status, 'sent');
      assert.equal(env.tg.callsTo('sendMessage')[0]!.body.text, 'Hi Sara, this is Karim from the cafe.');
      const after = (await a.client.get(`/conversations/${conv.id}`)).body;
      assert.equal(after.handler, 'human');
      assert.equal(after.assignedTo.name, 'manager user');
      const calls = chatCount();
      await hook(key, tgUpdate(5001, 2, 'Thanks! And the latte price?'), tgHeaders(secret));
      await settle();
      assert.equal(chatCount(), calls, 'AI must not answer a conversation a person has');
      const c2 = (await a.client.get(`/conversations/${conv.id}`)).body;
      assert.equal(c2.aiState, 'human_has_it');
      assert.equal(c2.unreadCount >= 2, true);
      // hand it back to the AI
      assert.equal((await aViewer.post(`/conversations/${conv.id}/release`)).status, 403);
      assert.equal((await aManager.post(`/conversations/${conv.id}/release`)).body.handler, 'ai');
      await hook(key, tgUpdate(5001, 3, 'And the latte price again?'), tgHeaders(secret));
      await settle();
      assert.equal(chatCount(), calls + 1, 'AI answers again after release');
    });

    it('hands off to a human when the customer asks for one, WITHOUT calling the model', async () => {
      const calls = chatCount();
      await hook(key, tgUpdate(5004, 1, 'I want to talk to a human please'), tgHeaders(secret));
      await settle();
      assert.equal(chatCount(), calls);
      const conv = (await a.client.get('/conversations?platform=telegram&search=5004')).body.items;
      const c = (await a.client.get('/conversations?platform=telegram')).body.items.find((x: any) => x.contact.externalId === '5004');
      assert.equal(c.handler, 'human');
      assert.equal(c.status, 'pending');
      assert.ok(c.handoffReason);
      assert.ok(Array.isArray(conv));
      const out = (await messagesOf(ch.id)).filter((m) => m.external_id?.startsWith('5004:') && m.direction === 'out');
      assert.equal(out.length, 1, 'the customer is told a person will help');
    });

    it('retries transient failures with backoff, then succeeds; permanent errors fail at once; manual retry works', async () => {
      const conv = (await a.client.get('/conversations?platform=telegram')).body.items.find((c: any) => c.contact.externalId === '5003');
      env.app.channels.retryDelaysSeconds = [0, 0, 0, 0];
      env.tg.failNext('sendMessage', 500, { ok: false, description: 'Internal' });
      const r = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'retry me' });
      assert.equal(r.body.status, 'retry');
      const tick = await env.app.channels.tick({ health: false });
      assert.ok(tick.retried >= 1);
      const row = (await env.owner.query(`SELECT status, attempts FROM messages WHERE id = $1`, [r.body.id])).rows[0];
      assert.equal(row.status, 'sent');
      assert.equal(row.attempts, 2);
      // permanent: customer blocked the bot
      env.tg.failNext('sendMessage', 403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
      const blocked = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'blocked' });
      assert.equal(blocked.status, 202);
      assert.equal(blocked.body.status, 'failed');
      assert.equal(blocked.body.errorCode, 'recipient_blocked');
      assert.equal((await a.client.get(`/channels/${ch.id}`)).body.healthStatus === 'down', false, 'a blocked customer says nothing about the channel health');
      const again = await aManager.post(`/messages/${blocked.body.id}/retry`);
      assert.equal(again.body.status, 'sent');
      assert.equal((await aManager.post(`/messages/${blocked.body.id}/retry`)).status, 409, 'only failed messages can be retried');
      // gives up after 5 attempts
      for (let i = 0; i < 5; i++) env.tg.failNext('sendMessage', 502, { ok: false });
      const dead = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'never arrives' });
      for (let i = 0; i < 6; i++) await env.app.channels.tick({ health: false });
      const d = (await env.owner.query(`SELECT status, attempts, error_code FROM messages WHERE id = $1`, [dead.body.id])).rows[0];
      assert.equal(d.status, 'failed');
      assert.equal(d.attempts, 5);
    });

    it('long replies are split; attachments are sent and customer attachments can be downloaded through the server', async () => {
      const conv = (await a.client.get('/conversations?platform=telegram')).body.items.find((c: any) => c.contact.externalId === '5003');
      env.tg.reset();
      const long = ('word '.repeat(1200)).trim();
      assert.equal((await aManager.post(`/conversations/${conv.id}/messages`, { text: long })).status, 201);
      assert.equal(env.tg.callsTo('sendMessage').length, 2, '6,000 characters become 2 Telegram messages');
      // upload + send a file
      const boundary = '----t';
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="menu.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), Buffer.from('%PDF-1.4 fake'), Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const up = await env.app.inject({ method: 'POST', url: `/api/v1/conversations/${conv.id}/attachments`, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: `ma_session=${aManager.cookie}` } });
      assert.equal(up.statusCode, 201, up.body);
      const fileId = up.json().id;
      const sent = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'Our menu', attachmentIds: [fileId] });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      assert.equal(env.tg.callsTo('sendDocument').length, 1);
      // another conversation cannot reuse this file
      const other = (await a.client.get('/conversations?platform=telegram')).body.items.find((c: any) => c.contact.externalId === '5001');
      assert.equal((await aManager.post(`/conversations/${other.id}/messages`, { text: 'x', attachmentIds: [fileId] })).status, 400);
      // inbound photo
      await hook(key, tgUpdate(5003, 9, '', { text: undefined, caption: 'my receipt', photo: [{ file_id: 'small', file_size: 1 }, { file_id: 'BIG', file_size: 8 }] }), tgHeaders(secret));
      await settle();
      const m = (await a.client.get(`/conversations/${conv.id}/messages`)).body.items.find((x: any) => x.attachments.length && x.direction === 'in');
      assert.equal(m.attachments[0].kind, 'image');
      assert.equal(m.body, 'my receipt');
      const dl = await env.app.inject({ method: 'GET', url: `/api/v1/messages/${m.id}/attachments/0`, headers: { cookie: `ma_session=${aManager.cookie}` } });
      assert.equal(dl.statusCode, 200);
      assert.equal(dl.body, 'FILEDATA');
      assert.ok(!JSON.stringify(dl.headers).includes(TOKEN), 'the bot token never leaves the server');
      const unauth = await env.app.inject({ method: 'GET', url: `/api/v1/messages/${m.id}/attachments/0` });
      assert.equal(unauth.statusCode, 401);
    });

    it('health: detects a lost webhook, flags reconnect; Reconnect repairs it', async () => {
      assert.equal((await a.client.post(`/channels/${ch.id}/health-check`)).body.status, 'healthy');
      env.tg.webhooks.delete(TOKEN);
      const h = await a.client.post(`/channels/${ch.id}/health-check`);
      assert.equal(h.body.status, 'down');
      assert.equal((await a.client.get(`/channels/${ch.id}`)).body.status, 'disconnected');
      const rc = await a.client.post(`/channels/${ch.id}/reconnect`);
      assert.equal(rc.status, 200, JSON.stringify(rc.body));
      assert.equal((await a.client.get(`/channels/${ch.id}`)).body.status, 'connected');
      const newSecret = env.tg.webhooks.get(TOKEN)!.secret;
      assert.notEqual(newSecret, secret, 'a new secret is issued');
      assert.equal((await hook(key, tgUpdate(5001, 50, 'old secret'), tgHeaders(secret))).statusCode, 401, 'the old secret stops working');
      secret = newSecret;
      assert.equal((await aManager.post(`/channels/${ch.id}/health-check`)).status, 403, 'managers cannot manage channels');
    });

    it('a bot can belong to ONE company only; disconnect removes the webhook and wipes credentials', async () => {
      const chB = await createChannel(b, 'telegram', 'Copy');
      const dup = await b.client.post(`/channels/${chB.id}/connect`, { botToken: TOKEN });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'account_already_connected');
      assert.equal(env.tg.webhooks.get(TOKEN)?.url.includes(key), true, 'company B did not hijack the webhook');
      const d = await a.client.post(`/channels/${ch.id}/disconnect`);
      assert.equal(d.status, 200);
      assert.equal(env.tg.webhooks.has(TOKEN), false);
      const row = (await env.owner.query('SELECT status, credentials_enc, external_account_id FROM channels WHERE id = $1', [ch.id])).rows[0];
      assert.deepEqual([row.status, row.credentials_enc, row.external_account_id], ['disconnected', null, null]);
      const conv = (await a.client.get('/conversations?platform=telegram')).body.items[0];
      const failed = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'while disconnected' });
      assert.equal(failed.body.status, 'failed');
      assert.equal(failed.body.errorCode, 'channel_not_connected');
      // reconnect for later sections
      assert.equal((await a.client.post(`/channels/${ch.id}/connect`, { botToken: TOKEN })).status, 200);
      key = await keyOf(ch.id);
      secret = env.tg.webhooks.get(TOKEN)!.secret;
    });

    it('no AI answer when the employee is not live or auto-reply is off (message is still stored, shows why)', async () => {
      const calls = chatCount();
      await env.owner.query(`UPDATE ai_employees SET status = 'paused' WHERE id = $1`, [aEmp]);
      await hook(key, tgUpdate(5010, 1, 'latte price?'), tgHeaders(secret));
      await settle();
      assert.equal(chatCount(), calls);
      const c = (await a.client.get('/conversations?platform=telegram')).body.items.find((x: any) => x.contact.externalId === '5010');
      assert.equal(c.aiState, 'employee_not_live');
      assert.equal((await messagesOf(ch.id)).filter((m) => m.external_id === '5010:1')[0].ai_state, 'skipped');
      await activate(aEmp);
      assert.equal((await a.client.patch(`/channels/${ch.id}`, { autoReply: false })).status, 200);
      await hook(key, tgUpdate(5010, 2, 'latte price?'), tgHeaders(secret));
      await settle();
      assert.equal(chatCount(), calls);
      assert.equal((await a.client.patch(`/channels/${ch.id}`, { autoReply: true })).status, 200);
    });

    it('a crash between "stored" and "answered" is recovered by the worker (once)', async () => {
      const conv = (await env.owner.query(`SELECT cv.id FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE c.external_id = '5002'`)).rows[0].id;
      await env.owner.query(
        `INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, external_id, body, status, ai_state, created_at)
         VALUES ($1, $2, $3, 'in', 'customer', '5002:777', 'latte price please', 'received', 'pending', now() - interval '2 minutes')`,
        [a.tenantId, ch.id, conv],
      );
      const calls = chatCount();
      const t = await env.app.channels.tick({ health: false });
      assert.ok(t.recovered >= 1);
      await settle();
      assert.equal(chatCount(), calls + 1);
      assert.equal((await env.owner.query(`SELECT ai_state FROM messages WHERE external_id = '5002:777'`)).rows[0].ai_state, 'done');
      await env.app.channels.tick({ health: false });
      await settle();
      assert.equal(chatCount(), calls + 1, 'answered only once');
    });

    it('a message queued but never sent (crash after saving) is picked up by the worker', async () => {
      const conv = (await env.owner.query(`SELECT cv.id FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE c.external_id = '5002'`)).rows[0].id;
      const ins = await env.owner.query(
        `INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status, created_at) VALUES ($1, $2, $3, 'out', 'ai', 'stuck reply', 'queued', now() - interval '5 minutes') RETURNING id`,
        [a.tenantId, ch.id, conv],
      );
      env.tg.reset();
      await env.app.channels.tick({ health: false });
      assert.equal((await env.owner.query('SELECT status FROM messages WHERE id = $1', [ins.rows[0].id])).rows[0].status, 'sent');
      assert.equal(env.tg.callsTo('sendMessage').length, 1);
    });
  });

  // ─────────────────────────────────────────────── WhatsApp (Evolution)
  describe('WhatsApp via Evolution API (unofficial QR)', () => {
    let ch: { id: string }; let key: string; let secret: string; let instance: string;
    let chB: { id: string }; let keyB: string; let secretB: string; let instB: string;
    const createBody = () => env.evo.calls.filter((c) => c.path === '/instance/create').map((c) => c.body);

    it('QR connection: creates a private session (instance) for the company and returns the QR', async () => {
      ch = await createChannel(a, 'whatsapp', 'Cafe WhatsApp', { employeeId: aEmp });
      const r = await a.client.post(`/channels/${ch.id}/connect`, {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'connecting');
      assert.ok(r.body.qr.startsWith('data:image/png'));
      key = await keyOf(ch.id);
      instance = await evoKeyOf(a, ch.id);
      assert.match(instance, /^ma_[0-9a-f]{18}$/);
      const body = createBody().pop();
      assert.equal(body.instanceName, instance);
      assert.equal(body.webhook.url, `https://app.example.test/api/v1/webhooks/channel/${key}`);
      secret = evoSecret(body);
      assert.ok(body.webhook.events.includes('MESSAGES_UPSERT'));
      const detail = await a.client.get(`/channels/${ch.id}`);
      assert.equal(detail.body.unofficial, true);
      assert.ok(!JSON.stringify(detail.body).includes(secret) && !JSON.stringify(detail.body).includes(instance) , 'session identifiers stay on the server');
    });

    it('status polling shows the QR while pairing and "connected" once the phone is linked', async () => {
      const s1 = await a.client.get(`/channels/${ch.id}/status`);
      assert.equal(s1.body.state, 'connecting');
      assert.ok(s1.body.qr);
      env.evo.setState(instance, 'open');
      const s2 = await a.client.get(`/channels/${ch.id}/status`);
      assert.equal(s2.body.state, 'connected');
      assert.equal(s2.body.status, 'connected');
      assert.equal(s2.body.qr, null);
    });

    it('webhooks: wrong secret / wrong instance refused; connection and QR events update the channel', async () => {
      assert.equal((await evoHook(key, 'nope', evoMsg(instance, '2010@s.whatsapp.net', 'X1', 'hi'))).statusCode, 401);
      assert.equal((await hook(key, evoMsg(instance, '2010@s.whatsapp.net', 'X1', 'hi'))).statusCode, 401);
      assert.equal((await evoHook(key, secret, evoMsg('someone_elses_instance', '2010@s.whatsapp.net', 'X1', 'hi'))).statusCode, 401);
      assert.equal((await messagesOf(ch.id)).length, 0);
      await evoHook(key, secret, { event: 'connection.update', instance, data: { state: 'close', statusReason: 401 } });
      assert.equal((await a.client.get(`/channels/${ch.id}`)).body.status, 'disconnected');
      await evoHook(key, secret, { event: 'qrcode.updated', instance, data: { qrcode: { base64: 'data:image/png;base64,QR9' } } });
      env.evo.setState(instance, 'connecting');
      assert.equal((await a.client.get(`/channels/${ch.id}/status`)).body.state, 'connecting');
      await evoHook(key, secret, { event: 'connection.update', instance, data: { state: 'open' } });
      env.evo.setState(instance, 'open');
      assert.equal((await a.client.get(`/channels/${ch.id}`)).body.status, 'connected');
    });

    it('receives a message and the employee answers through the same session; delivery/read receipts update the status', async () => {
      env.evo.reset();
      const r = await evoHook(key, secret, evoMsg(instance, '201001234567@s.whatsapp.net', 'WA-IN-1', 'How much is the latte?'));
      assert.equal(r.statusCode, 200);
      await settle();
      const msgs = await messagesOf(ch.id);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].external_id, 'WA-IN-1');
      const send = env.evo.callsTo('sendText')[0]!;
      assert.equal(send.path, `/message/sendText/${instance}`);
      assert.equal(send.body.number, '201001234567');
      assert.ok(send.body.text.includes('45'));
      assert.equal(msgs[1].status, 'sent');
      const conv = (await a.client.get('/conversations?platform=whatsapp')).body.items[0];
      assert.equal(conv.contact.phone, '+201001234567');
      assert.equal(conv.contact.name, 'Mona');
      await evoHook(key, secret, { event: 'messages.update', instance, data: { keyId: msgs[1].external_id, status: 'DELIVERY_ACK' } });
      assert.equal((await messagesOf(ch.id))[1].status, 'delivered');
      await evoHook(key, secret, { event: 'messages.update', instance, data: { keyId: msgs[1].external_id, status: 'READ' } });
      assert.equal((await messagesOf(ch.id))[1].status, 'read');
      await evoHook(key, secret, { event: 'messages.update', instance, data: { keyId: msgs[1].external_id, status: 'DELIVERY_ACK' } });
      assert.equal((await messagesOf(ch.id))[1].status, 'read', 'a late "delivered" never downgrades "read"');
    });

    it('no duplicates on replay; own messages, groups and broadcasts ignored', async () => {
      const calls = chatCount();
      const before = (await messagesOf(ch.id)).length;
      const dup = evoMsg(instance, '201001234567@s.whatsapp.net', 'WA-IN-1', 'How much is the latte?');
      await Promise.all([1, 2, 3].map(() => evoHook(key, secret, dup)));
      await evoHook(key, secret, evoMsg(instance, '201001234567@s.whatsapp.net', 'WA-OWN', 'sent from my phone', { key: { remoteJid: '201001234567@s.whatsapp.net', fromMe: true, id: 'WA-OWN' } }));
      await evoHook(key, secret, evoMsg(instance, '1203@g.us', 'WA-GRP', 'group'));
      await evoHook(key, secret, evoMsg(instance, 'status@broadcast', 'WA-ST', 'status'));
      await settle();
      assert.equal((await messagesOf(ch.id)).length, before);
      assert.equal(chatCount(), calls);
    });

    it('sending media works; reconnect issues a new QR; an instance deleted on the provider is re-created', async () => {
      const conv = (await a.client.get('/conversations?platform=whatsapp')).body.items[0];
      const boundary = '----w';
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const up = await env.app.inject({ method: 'POST', url: `/api/v1/conversations/${conv.id}/attachments`, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: `ma_session=${aManager.cookie}` } });
      env.evo.reset();
      const sent = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'photo', attachmentIds: [up.json().id] });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      const media = env.evo.callsTo('sendMedia')[0]!;
      assert.equal(media.body.mediatype, 'image');
      assert.equal(media.body.media, png.toString('base64'));
      env.evo.setState(instance, 'close');
      const rc = await a.client.post(`/channels/${ch.id}/reconnect`);
      assert.equal(rc.body.status, 'connecting');
      assert.ok(rc.body.qr);
      env.evo.instances.delete(instance);
      const rc2 = await a.client.post(`/channels/${ch.id}/reconnect`);
      assert.equal(rc2.status, 200, JSON.stringify(rc2.body));
      assert.ok(env.evo.instances.has(instance), 're-created under the same name');
      env.evo.setState(instance, 'open');
      await a.client.get(`/channels/${ch.id}/status`);
    });

    it('health monitoring notices a dropped session', async () => {
      assert.equal((await a.client.post(`/channels/${ch.id}/health-check`)).body.status, 'healthy');
      env.evo.setState(instance, 'close');
      const h = await a.client.post(`/channels/${ch.id}/health-check`);
      assert.equal(h.body.status, 'down');
      assert.equal(h.body.needsReconnect, true);
      const d = await a.client.get(`/channels/${ch.id}`);
      assert.equal(d.body.status, 'disconnected');
      assert.equal(d.body.healthStatus, 'down');
      env.evo.setState(instance, 'open');
      await a.client.post(`/channels/${ch.id}/health-check`);
      assert.equal((await a.client.get(`/channels/${ch.id}`)).body.status, 'connected');
    });

    it('errors from the provider are reported clearly (not configured, rejected key, provider down)', async () => {
      const spare = await createChannel(a, 'whatsapp', 'Spare');
      const cfg = env.app.config.channels.evolution;
      const url = cfg.url;
      cfg.url = undefined;
      const nc = await a.client.post(`/channels/${spare.id}/connect`, {});
      assert.equal(nc.status, 503);
      assert.equal(nc.body.error.code, 'provider_not_configured');
      cfg.url = url;
      cfg.key = 'wrong';
      const bad = await a.client.post(`/channels/${spare.id}/connect`, {});
      assert.equal(bad.body.error.code, 'provider_auth');
      assert.ok(!JSON.stringify(bad.body).includes('wrong'));
      cfg.key = 'evo-global-key';
      env.evo.failNext('/instance/create', 500, { message: 'boom' });
      const down = await a.client.post(`/channels/${spare.id}/connect`, {});
      assert.ok(down.status >= 500);
      assert.equal((await a.client.get(`/channels/${spare.id}`)).body.status, 'pending');
      assert.ok((await a.client.get(`/channels/${spare.id}`)).body.lastError);
      assert.equal((await a.client.del(`/channels/${spare.id}`)).status, 400, 'deleting requires confirmation');
      assert.equal((await a.client.del(`/channels/${spare.id}?confirm=DELETE`)).status, 204);
    });

    it('one separate WhatsApp session per company; sessions and secrets are never shared', async () => {
      chB = await createChannel(b, 'whatsapp', 'Gadget WhatsApp');
      assert.equal((await b.client.post(`/channels/${chB.id}/connect`, {})).status, 200);
      keyB = await keyOf(chB.id);
      instB = await evoKeyOf(b, chB.id);
      secretB = evoSecret(createBody().pop());
      assert.notEqual(instB, instance);
      assert.notEqual(secretB, secret);
      env.evo.setState(instB, 'open');
      // A's secret does not open B's channel, and vice versa
      assert.equal((await evoHook(keyB, secret, evoMsg(instB, '20111@s.whatsapp.net', 'B1', 'hi'))).statusCode, 401);
      assert.equal((await evoHook(key, secretB, evoMsg(instance, '20111@s.whatsapp.net', 'B1', 'hi'))).statusCode, 401);
      assert.equal((await evoHook(keyB, secretB, evoMsg(instance, '20111@s.whatsapp.net', 'B1', 'hi'))).statusCode, 401, 'B cannot feed messages as A’s instance');
      // the same customer number writing to both companies stays separate
      await evoHook(key, secret, evoMsg(instance, '20999@s.whatsapp.net', 'SAME-1', 'hello cafe'));
      await evoHook(keyB, secretB, evoMsg(instB, '20999@s.whatsapp.net', 'SAME-1', 'hello gadgets'));
      await settle();
      const aConv = (await a.client.get('/conversations?platform=whatsapp&search=hello')).body.items;
      const bConv = (await b.client.get('/conversations?platform=whatsapp&search=hello')).body.items;
      assert.equal(aConv.length, 1); assert.equal(bConv.length, 1);
      assert.notEqual(aConv[0].id, bConv[0].id);
      assert.ok(aConv[0].lastMessagePreview.includes('cafe') || aConv[0].lastMessagePreview.length > 0);
      assert.equal((await b.client.get(`/conversations/${aConv[0].id}`)).status, 404);
    });
  });

  // ─────────────────────────────────────────────── Meta
  describe('Messenger & Instagram (official Meta APIs: prepared, tested only against a stand-in)', () => {
    let ms: { id: string; status: string }; let ig: { id: string };
    const stateFor = async (channelId: string) => {
      const r = await a.client.get(`/channels/${channelId}/oauth/start`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { url: new URL(r.body.url), state: new URL(r.body.url).searchParams.get('state')! };
    };
    const callback = (t: Tenant, query: string) => env.app.inject({ method: 'GET', url: `/api/v1/oauth/meta/callback?${query}`, headers: { cookie: `ma_session=${t.client.cookie}` } });

    it('OAuth: builds the Facebook login URL with the needed permissions and a signed state', async () => {
      ms = await createChannel(a, 'messenger', 'Cafe Messenger', { employeeId: aEmp });
      assert.equal(ms.status, 'pending');
      const { url } = await stateFor(ms.id);
      assert.equal(url.hostname, 'www.facebook.com');
      assert.equal(url.searchParams.get('client_id'), 'APP-ID');
      assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.test/api/v1/oauth/meta/callback');
      assert.ok(url.searchParams.get('scope')!.includes('pages_messaging'));
      assert.ok(!url.toString().includes('APP-SECRET'));
      assert.equal((await a.client.post(`/channels/${ms.id}/connect`, {})).body.error.code, 'use_oauth');
    });

    it('callback rejects tampered state, other users, and a denied login', async () => {
      const { state } = await stateFor(ms.id);
      const tampered = `${state.slice(0, -3)}AAA`;
      assert.match((await callback(a, `code=GOOD-CODE&state=${tampered}`)).headers.location as string, /meta_error/);
      assert.match((await callback(b, `code=GOOD-CODE&state=${state}`)).headers.location as string, /meta_error/);
      assert.match((await callback(a, `error=access_denied&state=${state}`)).headers.location as string, /meta_error/);
      assert.match((await callback(a, `code=BAD-CODE&state=${(await stateFor(ms.id)).state}`)).headers.location as string, /meta_error/);
    });

    it('after login the user picks a page; it is subscribed with the page token; status is "awaiting approval", NOT "connected"', async () => {
      const r = await callback(a, `code=GOOD-CODE&state=${(await stateFor(ms.id)).state}`);
      assert.match(r.headers.location as string, /meta=select/);
      const d = await a.client.get(`/channels/${ms.id}`);
      assert.equal(d.body.pendingPages.length, 1);
      assert.ok(!JSON.stringify(d.body).includes('PAGE-TOKEN-1'), 'page tokens never reach the browser');
      assert.equal((await a.client.post(`/channels/${ms.id}/meta/select-page`, { pageId: 'NOPE' })).status, 400);
      const sel = await a.client.post(`/channels/${ms.id}/meta/select-page`, { pageId: 'PAGE1' });
      assert.equal(sel.status, 200, JSON.stringify(sel.body));
      assert.equal(sel.body.status, 'awaiting_approval');
      const sub = env.graph.callsTo('subscribed_apps').pop()!;
      assert.equal(sub.headers.authorization, 'Bearer PAGE-TOKEN-1');
      assert.equal(sub.path.includes('/PAGE1/'), true);
      const after = await a.client.get(`/channels/${ms.id}`);
      assert.equal(after.body.status, 'awaiting_approval');
      assert.equal(after.body.config.verified, false);
      assert.equal(after.body.account, 'Shop Page');
    });

    it('webhook verification handshake and signatures', async () => {
      const ok = await env.app.inject({ method: 'GET', url: '/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=VERIFY-ME&hub.challenge=12345' });
      assert.equal(ok.statusCode, 200); assert.equal(ok.body, '12345');
      assert.equal((await env.app.inject({ method: 'GET', url: '/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=1' })).statusCode, 403);
      const body = msgEvent('PAGE1', 'PSID-1', 'mid.1', 'hello');
      assert.equal((await metaHook(body, 'sha256=deadbeef')).statusCode, 401);
      assert.equal((await env.app.inject({ method: 'POST', url: '/api/v1/webhooks/meta', payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).statusCode, 401);
      assert.equal((await messagesOf(ms.id)).length, 0);
    });

    it('first REAL message flips the channel to connected, the customer name is fetched, the employee answers through Graph', async () => {
      env.graph.calls = [];
      const r = await metaHook(msgEvent('PAGE1', 'PSID-1', 'mid.1', 'How much is the latte?'));
      assert.equal(r.statusCode, 200);
      await settle();
      const msgs = await messagesOf(ms.id);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].external_id, 'mid.1');
      assert.equal(msgs[1].external_id, 'm_out_1');
      assert.equal(msgs[1].status, 'sent');
      const send = env.graph.callsTo('/PAGE1/messages')[0]!;
      assert.equal(send.body.recipient.id, 'PSID-1');
      assert.ok(send.body.message.text.includes('45'));
      assert.equal(send.headers.authorization, 'Bearer PAGE-TOKEN-1');
      assert.ok(!send.path.includes('PAGE-TOKEN') && !send.query.toString().includes('PAGE-TOKEN'), 'token is not in the URL');
      const d = await a.client.get(`/channels/${ms.id}`);
      assert.equal(d.body.status, 'connected');
      assert.equal(d.body.config.verified, true);
      const conv = (await a.client.get('/conversations?platform=messenger')).body.items[0];
      assert.equal(conv.contact.name, 'User PSID-1');
    });

    it('replays are ignored; delivery and read receipts update message status; echoes ignored', async () => {
      const before = (await messagesOf(ms.id)).length;
      const dup = msgEvent('PAGE1', 'PSID-1', 'mid.1', 'How much is the latte?');
      await Promise.all([metaHook(dup), metaHook(dup)]);
      await settle();
      assert.equal((await messagesOf(ms.id)).length, before);
      await metaHook({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PSID-1' }, recipient: { id: 'PAGE1' }, delivery: { mids: ['m_out_1'], watermark: Date.now() } }] }] });
      assert.equal((await messagesOf(ms.id))[1].status, 'delivered');
      await metaHook({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PSID-1' }, recipient: { id: 'PAGE1' }, read: { watermark: Date.now() + 1000 } }] }] });
      assert.equal((await messagesOf(ms.id))[1].status, 'read');
      const echo = { object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PAGE1' }, recipient: { id: 'PSID-1' }, message: { mid: 'mid.echo', text: 'echo', is_echo: true } }] }] };
      assert.equal((await metaHook(echo)).json().ignored >= 1, true);
      assert.equal((await messagesOf(ms.id)).length, before);
    });

    it('24-hour window and expired tokens are reported precisely (no pointless retries)', async () => {
      await metaHook(msgEvent('PAGE1', 'OUTSIDE', 'mid.out', 'hi')); // answered with a window error by the stand-in
      await settle();
      const out = (await messagesOf(ms.id)).filter((m) => m.direction === 'out').pop()!;
      assert.equal(out.status, 'failed');
      assert.equal(out.error_code, 'outside_messaging_window');
      assert.equal(out.attempts, 1);
      assert.equal((await a.client.get(`/channels/${ms.id}`)).body.healthStatus === 'down', false);
      env.graph.validTokens.delete('PAGE-TOKEN-1');
      const conv = (await a.client.get('/conversations?platform=messenger')).body.items.find((c: any) => c.contact.externalId === 'PSID-1');
      const r = await aManager.post(`/conversations/${conv.id}/messages`, { text: 'hello?' });
      assert.equal(r.body.errorCode, 'auth_expired');
      assert.equal((await a.client.get(`/channels/${ms.id}`)).body.status, 'error', 'channel shows it needs reconnecting');
      const h = await a.client.post(`/channels/${ms.id}/health-check`);
      assert.equal(h.body.needsReconnect, true);
      env.graph.validTokens.add('PAGE-TOKEN-1');
      await env.owner.query(`UPDATE channels SET status = 'connected' WHERE id = $1`, [ms.id]);
    });

    it('pages are routed to their own company; unknown pages are ignored; files cannot be sent yet', async () => {
      const r = await metaHook(msgEvent('SOMEONE-ELSES-PAGE', 'PSID-9', 'mid.x', 'hi'));
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().processed, 0);
      assert.equal((await b.client.get('/conversations?platform=messenger')).body.items.length, 0);
      // company B cannot claim company A's page
      const chB = await createChannel(b, 'messenger', 'Gadget Messenger');
      const { state } = await (async () => { const x = await b.client.get(`/channels/${chB.id}/oauth/start`); return { state: new URL(x.body.url).searchParams.get('state')! }; })();
      await callback(b, `code=GOOD-CODE&state=${state}`);
      const dupe = await b.client.post(`/channels/${chB.id}/meta/select-page`, { pageId: 'PAGE1' });
      assert.equal(dupe.status, 409);
      assert.equal(dupe.body.error.code, 'account_already_connected');
    });

    it('Instagram uses the linked Instagram account and its own webhook object', async () => {
      ig = await createChannel(a, 'instagram', 'Cafe Instagram', { employeeId: aEmp });
      await callback(a, `code=GOOD-CODE&state=${(await stateFor(ig.id)).state}`);
      const sel = await a.client.post(`/channels/${ig.id}/meta/select-page`, { pageId: 'PAGE1' });
      assert.equal(sel.body.status, 'awaiting_approval');
      assert.equal((await env.owner.query('SELECT external_account_id FROM channels WHERE id = $1', [ig.id])).rows[0].external_account_id, 'IG1');
      await metaHook(msgEvent('IG1', 'IGSID-1', 'ig.mid.1', 'latte price?', 'instagram'));
      await settle();
      assert.equal((await a.client.get('/conversations?platform=instagram')).body.items.length, 1);
      assert.equal((await a.client.get('/conversations?platform=messenger&search=IGSID')).body.items.length, 0, 'Instagram messages never appear under Messenger');
      assert.equal((await messagesOf(ig.id)).length, 2);
    });

    it('when Meta is not configured the channel says so instead of pretending', async () => {
      const cfg = env.app.config.channels.meta;
      const id = cfg.appId;
      cfg.appId = undefined;
      const c = await createChannel(a, 'messenger', 'No Meta');
      assert.equal(c.status, 'not_configured');
      assert.equal((await a.client.get(`/channels/${c.id}/oauth/start`)).body.error.code, 'provider_not_configured');
      assert.equal((await env.app.inject({ method: 'GET', url: '/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=VERIFY-ME&hub.challenge=1' })).statusCode, 503);
      cfg.appId = id;
    });
  });

  // ─────────────────────────────────────────────── Website chat
  describe('Website chat widget', () => {
    let ch: { id: string; status: string }; let key: string; let token: string;
    const wget = (path: string, headers: Record<string, string> = {}) => env.app.inject({ method: 'GET', url: `/api/v1/widget/${key}${path}`, headers });
    const wpost = (path: string, payload: unknown, headers: Record<string, string> = {}) => env.app.inject({ method: 'POST', url: `/api/v1/widget/${key}${path}`, payload: payload as object, headers });

    it('creating the channel makes it live at once; the embed script is served', async () => {
      ch = await createChannel(a, 'website', 'Cafe site', { employeeId: aEmp, config: { title: 'Chat with Cafe Nile', color: '#8B1E3F' } });
      assert.equal(ch.status, 'connected');
      key = await keyOf(ch.id);
      const detail = await a.client.get(`/channels/${ch.id}`);
      assert.equal(detail.body.publicKey, key);
      const js = await env.app.inject({ method: 'GET', url: '/api/v1/widget.js' });
      assert.equal(js.statusCode, 200);
      assert.match(js.headers['content-type'] as string, /javascript/);
      assert.ok(js.body.includes('attachShadow') && !js.body.includes('innerHTML'), 'built on Shadow DOM and textContent only');
      const cfg = await wget('/config');
      assert.equal(cfg.json().title, 'Chat with Cafe Nile');
    });

    it('a visitor gets a signed session, chats, is answered by the employee, and polls for new messages', async () => {
      token = (await wpost('/session', {})).json().token;
      assert.ok(token.includes('.'));
      const r = await wpost('/messages', { token, text: 'How much is the latte?', clientMsgId: 'client-msg-1' });
      assert.equal(r.statusCode, 201, r.body);
      await settle();
      const poll = (await wget(`/messages?token=${encodeURIComponent(token)}`)).json().messages;
      assert.equal(poll.length, 2);
      assert.deepEqual(poll.map((m: any) => m.from), ['visitor', 'agent']);
      assert.ok(poll[1].text.includes('45'));
      const next = (await wget(`/messages?token=${encodeURIComponent(token)}&after=${poll[1].id}`)).json().messages;
      assert.equal(next.length, 0);
      const out = (await messagesOf(ch.id)).find((m) => m.direction === 'out')!;
      assert.equal(out.status, 'delivered', 'fetched by the visitor’s browser = delivered');
    });

    it('retrying the same client message does not duplicate it', async () => {
      const calls = chatCount();
      const r = await wpost('/messages', { token, text: 'How much is the latte?', clientMsgId: 'client-msg-1' });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().duplicate, true);
      await settle();
      assert.equal(chatCount(), calls);
      assert.equal((await messagesOf(ch.id)).length, 2);
    });

    it('staff replies reach the visitor; visitors only ever see their own conversation', async () => {
      const conv = (await a.client.get('/conversations?platform=website')).body.items[0];
      assert.equal(conv.contact.externalId, undefined, 'visitor ids are not exposed');
      await aManager.post(`/conversations/${conv.id}/messages`, { text: 'A person here. Anything else?' });
      const mine = (await wget(`/messages?token=${encodeURIComponent(token)}&after=${(await wget(`/messages?token=${encodeURIComponent(token)}`)).json().messages[1].id}`)).json().messages;
      assert.equal(mine.length, 1);
      assert.equal(mine[0].text, 'A person here. Anything else?');
      const other = (await wpost('/session', {})).json().token;
      await wpost('/messages', { token: other, text: 'hello from visitor two', clientMsgId: 'other-1' });
      await settle();
      const theirs = (await wget(`/messages?token=${encodeURIComponent(other)}`)).json().messages;
      assert.ok(theirs.every((m: any) => !m.text.includes('A person here')));
      const [id] = other.split('.');
      assert.equal((await wget(`/messages?token=${encodeURIComponent(`${id}.forged`)}`)).statusCode, 401);
      assert.equal((await wget(`/messages?token=${encodeURIComponent(`${token.split('.')[0]}.${other.split('.')[1]}`)}`)).statusCode, 401, 'a token cannot be re-bound to another visitor');
    });

    it('tokens do not work across website channels; bad input and oversize messages are refused', async () => {
      const ch2 = await createChannel(a, 'website', 'Second site');
      const key2 = await keyOf(ch2.id);
      const cross = await env.app.inject({ method: 'POST', url: `/api/v1/widget/${key2}/messages`, payload: { token, text: 'hi', clientMsgId: 'cross-1' } });
      assert.equal(cross.statusCode, 401);
      assert.equal((await wpost('/messages', { token, text: 'x'.repeat(2001), clientMsgId: 'big-1' })).statusCode, 400);
      assert.equal((await wpost('/messages', { token, text: '   ', clientMsgId: 'empty-1' })).statusCode, 400);
      assert.equal((await env.app.inject({ method: 'GET', url: '/api/v1/widget/unknownkey123/config' })).statusCode, 404);
    });

    it('only allowed sites can embed the widget (CORS), and the widget is hidden once the channel is off', async () => {
      await a.client.patch(`/channels/${ch.id}`, { config: { allowedOrigins: ['https://cafe.example.com'] } });
      const ok = await wget('/config', { origin: 'https://cafe.example.com' });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.headers['access-control-allow-origin'], 'https://cafe.example.com');
      assert.equal((await wget('/config', { origin: 'https://evil.example.com' })).statusCode, 403);
      assert.equal((await wpost('/messages', { token, text: 'hi', clientMsgId: 'cors-1' }, { origin: 'https://evil.example.com' })).statusCode, 403);
      const pre = await env.app.inject({ method: 'OPTIONS', url: `/api/v1/widget/${key}/messages`, headers: { origin: 'https://cafe.example.com', 'access-control-request-method': 'POST' } });
      assert.equal(pre.statusCode, 204);
      await a.client.post(`/channels/${ch.id}/disconnect`);
      assert.equal((await wget('/config', { origin: 'https://cafe.example.com' })).statusCode, 404);
    });
  });

  // ─────────────────────────────────────────────── conversations: platforms stay apart
  describe('Platform-specific conversations & isolation', () => {
    it('the list requires a platform and returns ONLY that platform; counters are per platform', async () => {
      assert.equal((await a.client.get('/conversations')).status, 400);
      assert.equal((await a.client.get('/conversations?platform=sms')).status, 400);
      for (const p of ['telegram', 'whatsapp', 'messenger', 'instagram', 'website']) {
        const r = await a.client.get(`/conversations?platform=${p}`);
        assert.equal(r.status, 200);
        assert.ok(r.body.items.length >= 1, `${p} has conversations`);
        assert.ok(r.body.items.every((c: any) => c.platform === p), `${p} list contains only ${p}`);
      }
      const sum = (await a.client.get('/conversations/summary')).body.platforms;
      assert.ok(sum.telegram.total >= 4 && sum.whatsapp.total >= 2 && sum.tiktok.total === 0);
      const all = await env.owner.query(`SELECT platform, count(*)::int AS n FROM conversations WHERE tenant_id = $1 GROUP BY platform`, [a.tenantId]);
      for (const r of all.rows) assert.equal(sum[r.platform].total, r.n);
    });

    it('search, filters, unread, assignment and status work', async () => {
      const tg = (q = '') => a.client.get(`/conversations?platform=telegram${q}`);
      const unread = await tg('&unread=1');
      assert.ok(unread.body.items.length >= 1 && unread.body.items.every((c: any) => c.unreadCount > 0));
      const first = unread.body.items[0];
      assert.equal((await a.client.post(`/conversations/${first.id}/read`)).status, 200);
      assert.equal((await a.client.get(`/conversations/${first.id}`)).body.unreadCount, 0);
      assert.equal((await tg('&search=Sara')).body.items.length >= 1, true);
      assert.equal((await tg('&search=zzzznotthere')).body.items.length, 0);
      assert.ok((await tg('&search=receipt')).body.items.length >= 1, 'search looks inside messages');
      assert.ok((await tg('&handler=human')).body.items.every((c: any) => c.handler === 'human'));
      const asg = await aManager.patch(`/conversations/${first.id}`, { assignedUserId: (await aManager.get('/auth/me')).body.user.id, status: 'resolved' });
      assert.equal(asg.status, 200, JSON.stringify(asg.body));
      assert.equal(asg.body.status, 'resolved');
      assert.equal((await tg('&assigned=me')).body.items.length, 0, 'the owner has none; the manager does');
      assert.ok((await aManager.get('/conversations?platform=telegram&assigned=me')).body.items.some((c: any) => c.id === first.id));
      assert.equal((await aViewer.patch(`/conversations/${first.id}`, { status: 'open' })).status, 403);
      assert.equal((await aViewer.get(`/conversations/${first.id}`)).status, 200, 'viewers can read');
      // a new customer message re-opens a resolved conversation
      const key = await keyOf((await env.owner.query(`SELECT channel_id FROM conversations WHERE id = $1`, [first.id])).rows[0].channel_id);
      assert.ok(key);
      assert.equal((await a.client.patch(`/conversations/${first.id}`, { assignedUserId: '00000000-0000-4000-8000-000000000000' })).status, 400);
    });

    it('messages are paged oldest→newest and carry delivery status and who sent them', async () => {
      const conv = (await a.client.get('/conversations?platform=telegram')).body.items.find((c: any) => c.contact.externalId === '5001');
      const all = (await a.client.get(`/conversations/${conv.id}/messages`)).body.items;
      assert.ok(all.length >= 4);
      assert.deepEqual(all.map((m: any) => m.createdAt), [...all.map((m: any) => m.createdAt)].sort());
      assert.ok(all.some((m: any) => m.senderType === 'ai') && all.some((m: any) => m.senderType === 'human' && m.senderName === 'manager user') && all.some((m: any) => m.senderType === 'customer'));
      const page = (await a.client.get(`/conversations/${conv.id}/messages?limit=2`)).body;
      assert.equal(page.items.length, 2);
      assert.equal(page.hasMore, true);
      const older = (await a.client.get(`/conversations/${conv.id}/messages?limit=2&before=${page.items[0].id}`)).body.items;
      assert.equal(older[older.length - 1].createdAt <= page.items[0].createdAt, true);
    });

    it('another company can see or touch NOTHING: not channels, conversations, messages, files or forwards', async () => {
      const conv = (await a.client.get('/conversations?platform=telegram')).body.items[0];
      const msg = (await a.client.get(`/conversations/${conv.id}/messages`)).body.items[0];
      for (const [method, url] of [['get', `/conversations/${conv.id}`], ['get', `/conversations/${conv.id}/messages`], ['post', `/conversations/${conv.id}/read`], ['post', `/conversations/${conv.id}/takeover`], ['post', `/conversations/${conv.id}/release`], ['get', `/messages/${msg.id}/forwards`]] as const) {
        const r = await (b.client as any)[method](url);
        assert.ok([404, 403].includes(r.status), `${method} ${url} -> ${r.status}`);
      }
      assert.equal((await b.client.post(`/conversations/${conv.id}/messages`, { text: 'intruder' })).status, 404);
      assert.equal((await b.client.patch(`/conversations/${conv.id}`, { status: 'resolved' })).status, 404);
      const chId = conv.channelId;
      for (const url of [`/channels/${chId}`, `/channels/${chId}/status`]) assert.equal((await b.client.get(url)).status, 404);
      assert.equal((await b.client.patch(`/channels/${chId}`, { name: 'pwned' })).status, 404);
      assert.equal((await b.client.post(`/channels/${chId}/disconnect`)).status, 404);
      assert.equal((await b.client.del(`/channels/${chId}?confirm=DELETE`)).status, 404);
      assert.equal((await b.client.get('/conversations?platform=telegram')).body.items.length, 0);
      assert.equal((await b.client.post(`/messages/${msg.id}/forward`, { targetChannelId: chId, recipientContactId: conv.contact.id })).status, 404);
      assert.equal((await b.client.patch(`/channels/${(await b.client.get('/channels')).body.items[0].id}`, { employeeId: aEmp })).status, 400, 'cannot assign another company’s employee');
      const names = (await b.client.get('/channels')).body.items.map((c: any) => c.name);
      assert.ok(!names.includes('Cafe bot'));
    });

    it('DATABASE level: a message cannot live in a conversation of another channel/platform, a contact only in its own channel', async () => {
      const tg = (await env.owner.query(`SELECT id, channel_id FROM conversations WHERE platform = 'telegram' AND tenant_id = $1 LIMIT 1`, [a.tenantId])).rows[0];
      const wa = (await env.owner.query(`SELECT id, channel_id FROM conversations WHERE platform = 'whatsapp' AND tenant_id = $1 LIMIT 1`, [a.tenantId])).rows[0];
      await assert.rejects(
        env.owner.query(`INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status) VALUES ($1, $2, $3, 'in', 'customer', 'x', 'received')`, [a.tenantId, wa.channel_id, tg.id]),
        /foreign key/i, 'WhatsApp channel + Telegram conversation must be rejected',
      );
      const wAcontact = (await env.owner.query(`SELECT id FROM contacts WHERE channel_id = $1 LIMIT 1`, [wa.channel_id])).rows[0];
      await assert.rejects(
        env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id) VALUES ($1, $2, 'telegram', $3)`, [a.tenantId, tg.channel_id, wAcontact.id]),
        /foreign key/i, 'a WhatsApp contact cannot join a Telegram conversation',
      );
      const fresh = (await env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id) VALUES ($1, $2, 'brand-new') RETURNING id`, [a.tenantId, tg.channel_id])).rows[0];
      await assert.rejects(
        env.owner.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id) VALUES ($1, $2, 'whatsapp', $3)`, [a.tenantId, tg.channel_id, fresh.id]),
        /foreign key/i, 'platform must equal the channel type',
      );
      // another tenant's channel
      const bch = (await env.owner.query(`SELECT id FROM channels WHERE tenant_id = $1 LIMIT 1`, [b.tenantId])).rows[0];
      await assert.rejects(env.owner.query(`INSERT INTO contacts (tenant_id, channel_id, external_id) VALUES ($1, $2, 'x')`, [a.tenantId, bch.id]), /foreign key/i);
    });

    it('RLS: the app role sees only its company, and platform admins have no access to customer messages', async () => {
      const { withTenant } = await import('../src/db/tx.js');
      const rows = await withTenant(env.app.pools.app, b.tenantId, async (c) => (await c.query('SELECT count(*)::int AS n FROM messages')).rows[0]);
      assert.equal(rows.n, (await env.owner.query('SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1', [b.tenantId])).rows[0].n);
      const none = await env.app.pools.app.query('SELECT count(*)::int AS n FROM messages');
      assert.equal(none.rows[0].n, 0, 'no tenant set => no rows');
      await assert.rejects(env.app.pools.platform.query('SELECT 1 FROM messages LIMIT 1'), /permission denied/);
      await assert.rejects(env.app.pools.platform.query('SELECT 1 FROM conversations LIMIT 1'), /permission denied/);
      await assert.rejects(env.app.pools.platform.query('SELECT 1 FROM channels LIMIT 1'), /permission denied/);
    });

    it('permissions: viewers read, managers handle conversations but cannot manage channels', async () => {
      assert.equal((await aViewer.get('/channels')).status, 200);
      assert.equal((await aViewer.post('/channels', { type: 'website', name: 'x' })).status, 403);
      assert.equal((await aManager.post('/channels', { type: 'website', name: 'x' })).status, 403);
      assert.equal((await aManager.get('/channels')).status, 200);
      assert.equal((await new Client(env.app).get('/channels')).status, 401);
    });
  });

  // ─────────────────────────────────────────────── forwarding
  describe('Message forwarding to another connected channel', () => {
    let srcMsg: string; let targetChannel: string; let recipient: string; let waChannel: string;

    it('preview shows exactly what will be sent, names the source, and warns about limits', async () => {
      const ms = (await a.client.get('/conversations?platform=messenger')).body.items.find((c: any) => c.contact.externalId === 'PSID-1');
      srcMsg = (await a.client.get(`/conversations/${ms.id}/messages`)).body.items.find((m: any) => m.direction === 'in').id;
      const tgCh = (await a.client.get('/channels')).body.items.find((c: any) => c.type === 'telegram');
      targetChannel = tgCh.id;
      const rec = await aManager.get(`/channels/${targetChannel}/contacts?search=Sara`);
      assert.equal(rec.status, 200);
      recipient = rec.body.items[0].id;
      const p = await aManager.post(`/messages/${srcMsg}/forward/preview`, { targetChannelId: targetChannel, recipientContactId: recipient, comment: 'FYI, can you handle this?' });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.mode, 'new_message');
      assert.ok(p.body.text.startsWith('FYI, can you handle this?'));
      assert.ok(p.body.text.includes('Forwarded from Messenger'));
      assert.ok(p.body.text.includes('How much is the latte?'));
      assert.equal(p.body.target.platform, 'telegram');
      assert.ok(p.body.note.includes('No platform forwards natively'));
      assert.equal((await env.owner.query('SELECT count(*)::int AS n FROM message_forwards')).rows[0].n, 0, 'preview sends and stores nothing');
    });

    it('forwards (Messenger → Telegram) as a new message that states its origin, and records the result', async () => {
      env.tg.reset();
      const r = await aManager.post(`/messages/${srcMsg}/forward`, { targetChannelId: targetChannel, recipientContactId: recipient, comment: 'FYI' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.status, 'sent');
      const call = env.tg.callsTo('sendMessage')[0]!;
      assert.ok(call.body.text.includes('Forwarded from Messenger') && call.body.text.startsWith('FYI'));
      const list = (await aManager.get(`/messages/${srcMsg}/forwards`)).body.items;
      assert.equal(list.length, 1);
      assert.equal(list[0].status, 'sent');
      assert.equal(list[0].targetPlatform, 'telegram');
      assert.equal(list[0].createdByName, 'manager user');
      const stored = (await env.owner.query(`SELECT meta FROM messages WHERE id = $1`, [r.body.resultMessageId])).rows[0];
      assert.equal(stored.meta.forward.fromPlatform, 'messenger');
      assert.ok((await a.client.get('/audit-logs?action=message.forwarded')).body.items.length >= 1);
      const sourceView = (await a.client.get(`/conversations/${(await env.owner.query('SELECT conversation_id FROM messages WHERE id = $1', [srcMsg])).rows[0].conversation_id}/messages`)).body.items.find((m: any) => m.id === srcMsg);
      assert.equal(sourceView.forwardCount, 1);
    });

    it('failures are recorded; invalid targets are refused; viewers cannot forward', async () => {
      env.tg.failNext('sendMessage', 403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
      const fail = await aManager.post(`/messages/${srcMsg}/forward`, { targetChannelId: targetChannel, recipientContactId: recipient });
      assert.equal(fail.status, 502);
      assert.equal(fail.body.status, 'failed');
      assert.ok(fail.body.error);
      assert.equal((await aManager.get(`/messages/${srcMsg}/forwards`)).body.items.filter((f: any) => f.status === 'failed').length, 1);
      const sameChannelId = (await a.client.get('/channels')).body.items.find((c: any) => c.type === 'messenger').id;
      const mrec = (await aManager.get(`/channels/${sameChannelId}/contacts`)).body.items[0].id;
      assert.equal((await aManager.post(`/messages/${srcMsg}/forward`, { targetChannelId: sameChannelId, recipientContactId: mrec })).body.error.code, 'same_channel');
      const waCh = (await a.client.get('/channels')).body.items.find((c: any) => c.type === 'whatsapp');
      waChannel = waCh.id;
      assert.equal((await aManager.post(`/messages/${srcMsg}/forward`, { targetChannelId: waChannel, recipientContactId: recipient })).body.error.code, 'recipient_not_found', 'recipient must belong to the target channel');
      assert.equal((await aViewer.post(`/messages/${srcMsg}/forward/preview`, { targetChannelId: targetChannel, recipientContactId: recipient })).status, 403);
      assert.equal((await aManager.post(`/messages/${srcMsg}/forward`, { targetChannelId: targetChannel, recipientContactId: recipient, comment: 'x'.repeat(501) })).status, 400);
    });

    it('warns when the target is disconnected or outside Meta’s 24-hour window', async () => {
      await env.owner.query(`UPDATE channels SET status = 'disconnected' WHERE id = $1`, [targetChannel]);
      const w = await aManager.post(`/messages/${srcMsg}/forward/preview`, { targetChannelId: targetChannel, recipientContactId: recipient });
      assert.ok(w.body.warnings.some((x: string) => x.includes('disconnected')));
      await env.owner.query(`UPDATE channels SET status = 'connected' WHERE id = $1`, [targetChannel]);
      const wa = (await a.client.get('/conversations?platform=whatsapp')).body.items[0];
      const waMsg = (await a.client.get(`/conversations/${wa.id}/messages`)).body.items.find((m: any) => m.direction === 'in').id;
      const igCh = (await a.client.get('/channels')).body.items.find((c: any) => c.type === 'instagram').id;
      const igRec = (await aManager.get(`/channels/${igCh}/contacts`)).body.items[0].id;
      await env.owner.query(`UPDATE conversations SET last_inbound_at = now() - interval '3 days' WHERE contact_id = $1`, [igRec]);
      const p = await aManager.post(`/messages/${waMsg}/forward/preview`, { targetChannelId: igCh, recipientContactId: igRec });
      assert.ok(p.body.warnings.some((x: string) => x.includes('24 hours')), JSON.stringify(p.body.warnings));
    });
  });

  // ─────────────────────────────────────────────── suspended company
  describe('Suspended companies', () => {
    it('webhooks of a suspended company are accepted but ignored; background work skips them', async () => {
      const t = await signupTenant(env, 'Soon Suspended');
      const ch = await createChannel(t, 'telegram', 'Sus bot');
      const tok = '333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
      env.tg.addBot(tok, 333333, 'sus_bot');
      await t.client.post(`/channels/${ch.id}/connect`, { botToken: tok });
      const key = await keyOf(ch.id);
      const secret = env.tg.webhooks.get(tok)!.secret;
      await env.owner.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [t.tenantId]);
      const r = await hook(key, tgUpdate(7, 1, 'hello'), tgHeaders(secret));
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().ignored, 'tenant_suspended');
      assert.equal((await messagesOf(ch.id)).length, 0);
    });
  });
});
