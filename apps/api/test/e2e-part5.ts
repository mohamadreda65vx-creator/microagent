// Manual browser E2E harness (NOT a test): real API + real built web UI + local stand-ins for providers.
import { createTestEnv, signupTenant, inviteMember, createPlatformAdmin } from './helpers.js';
const env = await createTestEnv();
const PORT = 5173;
env.app.config.appUrl = 'https://app.example.test'; // Telegram needs https for webhook registration
const a = await signupTenant(env, 'Cafe Nile');
const emp = (await a.client.post('/ai-employees', { name: 'Nour', tasks: ['sales_assistant', 'customer_support', 'human_handoff'] })).body.id;
await a.client.post('/knowledge/items', { kind: 'product', name: 'Latte', data: { price: 45, currency: 'EGP' } });
await env.owner.query(`UPDATE ai_employees SET status='active' WHERE id=$1`, [emp]);
const reply = (text: string) => JSON.stringify({ reply: text, actions: [] });
env.fake.responder = (body: any) => {
  const sys = String(body.messages?.[0]?.content ?? '');
  if (/campaign/i.test(sys) && /improvements/.test(sys)) return JSON.stringify({ name: 'Ramadan latte offer', platform: 'telegram', audience: { lastInteraction: { withinDays: 90 } }, message: 'Hi {{first_name}}, our latte is 20% off this week! Reply to order.', improvements: ['Add an end date to create urgency.'], questions: [] });
  const last = [...body.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
  return /latte/i.test(String(last)) ? reply('The latte costs 45 EGP.') : reply('Sorry, I will check with the team.');
};

const T1 = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
env.tg.addBot(T1, 111111, 'cafe_bot');
const c1 = (await a.client.post('/channels', { type: 'telegram', name: 'Cafe bot', employeeId: emp })).body;
await a.client.post(`/channels/${c1.id}/connect`, { botToken: T1 });
const key = (await env.owner.query('SELECT public_key FROM channels WHERE id=$1', [c1.id])).rows[0].public_key as string;
const sec = env.tg.webhooks.get(T1)!.secret;
let n = 0;
const upd = (chat: number, name: string, text: string) => ({ update_id: ++n, message: { message_id: n, date: Math.floor(Date.now() / 1000), from: { id: chat, is_bot: false, first_name: name }, chat: { id: chat, type: 'private', first_name: name }, text } });
await env.app.inject({ method: 'POST', url: `/api/v1/webhooks/channel/${key}`, payload: upd(5001, 'Sara', 'How much is the latte?'), headers: { 'x-telegram-bot-api-secret-token': sec } });
await env.app.channels.idle();
const wf = (await a.client.post('/workflows', { name: 'Price question follow-up', description: 'Tag price askers and ask a manager' })).body;
const graph = { nodes: [
  { id: 't', type: 'trigger', position: { x: 0, y: 80 }, data: { kind: 'message_received', containsAny: ['price', 'how much'] } },
  { id: 'c', type: 'condition', position: { x: 280, y: 80 }, data: { match: 'all', rules: [{ left: '{{customer.status}}', op: 'equals', right: 'new' }] } },
  { id: 'a', type: 'action', position: { x: 560, y: 0 }, data: { kind: 'add_tag', tag: 'price-asker' } },
  { id: 'h', type: 'human_task', position: { x: 560, y: 180 }, data: { title: 'Call {{customer.name}}', instructions: 'Existing customer asked about prices', assigneeRole: 'manager' } },
], edges: [
  { id: 'e1', source: 't', target: 'c', sourceHandle: 'out' }, { id: 'e2', source: 'c', target: 'a', sourceHandle: 'true' }, { id: 'e3', source: 'c', target: 'h', sourceHandle: 'false' } ] };
const sv = await a.client.put(`/workflows/${wf.id}/graph`, { graph, baseVersion: 1 }); console.log('SAVE', sv.status);
const adm = await createPlatformAdmin(env);
await env.owner.query(`INSERT INTO system_errors (source, code, message) VALUES ('api','harness_sample','Sample error row written by the test harness')`).catch((e) => console.log('syserr', e.message));
env.app.config.appUrl = `http://localhost:${PORT}`;
env.app.workflows.start();
await env.app.listen({ port: PORT, host: '127.0.0.1' });
const ad = await env.owner.query(`SELECT email FROM users WHERE role='platform_admin' ORDER BY created_at DESC LIMIT 1`);
console.log(JSON.stringify({ ready: true, email: a.email, adminEmail: ad.rows[0].email, password: 'Correct-horse-battery-1', wf: wf.id }));
setInterval(() => {}, 1 << 30);
