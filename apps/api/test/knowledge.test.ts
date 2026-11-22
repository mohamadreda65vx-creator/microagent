import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { fetchPage, isPrivateIp } from '../src/discovery/fetcher.js';
import { validate } from '../src/discovery/extract.js';
import { createTestEnv, signupTenant, type TestEnv, type Tenant } from './helpers.js';

let env: TestEnv;
let a: Tenant;
let b: Tenant;
let site: http.Server;
let siteUrl: string;

const PAGE = `<html><head><title>Cafe Nile</title></head><body><h1>Cafe Nile</h1>
<p>Latte 45 EGP</p><p>Cappuccino 60 EGP</p><p>Open daily 9am to 11pm</p><script>var hidden="Secret 999 EGP"</script></body></html>`;

async function upload(t: Tenant, sourceId: string, filename: string, data: Buffer) {
  const boundary = '----t' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const res = await env.app.inject({ method: 'POST', url: `/api/v1/knowledge/sources/${sourceId}/upload`, payload: Buffer.concat([head, data, tail]), headers: { cookie: `ma_session=${t.client.cookie}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

const newSource = async (t: Tenant, type: string, name: string, extra: object = {}) => (await t.client.post('/knowledge/sources', { type, name, ...extra })).body.id as string;

describe('business discovery', () => {
  before(async () => {
    env = await createTestEnv();
    a = await signupTenant(env, 'Company A');
    b = await signupTenant(env, 'Company B');
    site = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  });
  after(async () => { site.close(); await env.close(); });

  it('product list (CSV): deterministic, no AI call, missing price stays missing, questions are generated and answered', async () => {
    const id = await newSource(a, 'product_list', 'Menu CSV');
    const before = env.fake.chatCalls.length;
    assert.equal((await a.client.post(`/knowledge/sources/${id}/content`, { csv: 'اسم المنتج,السعر,الوصف\nقهوة تركي,35,\nشاي,,ساخن\nعصير برتقال,50 جنيه,طازج\n' })).status, 200);
    const r = await a.client.post(`/knowledge/sources/${id}/analyze`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, 3);
    assert.equal(env.fake.chatCalls.length, before, 'no AI used for a table');
    const items = (await a.client.get('/knowledge/items?kind=product')).body.items as any[];
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(byName['قهوة تركي'].data.price, 35);
    assert.equal(byName['عصير برتقال'].data.price, 50, 'Arabic currency word parsed');
    assert.equal(byName['شاي'].data.price, undefined, 'a missing price is NOT invented');
    assert.ok(items.every((i) => i.status === 'unconfirmed' && i.sourceDate && i.sourceRef && i.evidence), 'every fact has status, date, source and evidence');

    const qs = (await a.client.get('/knowledge/questions')).body;
    const missing = qs.items.find((q: any) => q.question.includes('شاي'));
    assert.ok(missing, 'asks for the missing price');
    assert.equal((await a.client.post(`/knowledge/questions/${missing.id}/answer`, { price: 20 })).status, 200);
    const tea = (await a.client.get('/knowledge/items?search=شاي')).body.items[0];
    assert.equal(tea.data.price, 20);
    assert.equal(tea.status, 'confirmed');
    assert.equal(tea.origin, 'owner');
    // answered questions are never asked again
    await a.client.post('/knowledge/questions/refresh');
    const again = (await a.client.get('/knowledge/questions?limit=20')).body.items as any[];
    assert.ok(!again.some((q) => q.question.includes('شاي')));
    assert.equal((await a.client.post(`/knowledge/questions/${missing.id}/answer`, { price: 1 })).status, 409, 'cannot answer twice');
  });

  it('an unusable table is refused with a clear reason (no guessing columns)', async () => {
    const id = await newSource(a, 'product_list', 'Bad');
    await a.client.post(`/knowledge/sources/${id}/content`, { csv: 'foo,bar\n1,2\n' });
    const r = await a.client.post(`/knowledge/sources/${id}/analyze`, {});
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'bad_table');
    const s = (await a.client.get('/knowledge/sources')).body.items.find((x: any) => x.id === id);
    assert.equal(s.status, 'failed');
  });

  it('website: reads the page, AI facts are kept only with real evidence; invented facts and prices are dropped', async () => {
    env.fake.responder = () => JSON.stringify({ items: [
      { kind: 'product', name: 'Latte', price: 45, currency: 'EGP', evidence: 'Latte 45 EGP', post: 0 },
      { kind: 'product', name: 'Cappuccino', price: 55, currency: 'EGP', evidence: 'Cappuccino 60 EGP', post: 0 },
      { kind: 'product', name: 'Espresso', price: 20, evidence: 'Espresso 20 EGP', post: 0 },
      { kind: 'product', name: 'Hidden', price: 999, evidence: 'Secret 999 EGP', post: 0 },
      { kind: 'business_info', name: 'Opening hours', text: '9am to 11pm', evidence: 'Open daily 9am to 11pm', post: 0 },
    ] });
    const id = await newSource(a, 'website', 'Site', { config: { url: siteUrl } });
    const r = await a.client.post(`/knowledge/sources/${id}/analyze`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stats.rejectedByEvidence, 2, 'Espresso (not in page) and Hidden (script text) rejected');
    assert.equal(r.body.stats.pricesDropped, 1, 'Cappuccino price 55 is not in its evidence');
    const items = (await a.client.get(`/knowledge/items?sourceId=${id}`)).body.items as any[];
    assert.deepEqual(items.map((i) => i.name).sort(), ['Cappuccino', 'Latte', 'Opening hours']);
    assert.equal(items.find((i) => i.name === 'Latte').data.price, 45);
    assert.equal(items.find((i) => i.name === 'Cappuccino').data.price, undefined);
    assert.ok(items.every((i) => i.sourceRef.startsWith('http') || i.sourceRef === 'owner entry'));
    const sent = JSON.stringify(env.fake.chatCalls.at(-1)!.body);
    assert.ok(!sent.includes('Secret 999'), 'script content is never sent to the model');
  });

  it('social: analyzes the newest 30 posts by default and the count is adjustable', async () => {
    const posts = Array.from({ length: 40 }, (_, i) => ({ text: `Post number ${i + 1}: offer ${i + 1}`, date: new Date(Date.UTC(2026, 10, 20) - i * 86_400_000).toISOString() }));
    const id = await newSource(a, 'social', 'Facebook page', { config: { platform: 'facebook' } });
    assert.equal((await a.client.post(`/knowledge/sources/${id}/content`, { posts: JSON.stringify(posts) })).body.stored, 40);
    env.fake.reset();
    env.fake.responder = () => '{"items":[]}';
    let r = await a.client.post(`/knowledge/sources/${id}/analyze`, {});
    assert.equal(r.body.stats.posts, 30);
    let sent = env.fake.chatCalls.map((c) => JSON.stringify(c.body)).join(' ');
    assert.ok(sent.includes('Post number 1:') && sent.includes('Post number 30:'));
    assert.ok(!sent.includes('Post number 31:'), 'older posts are not analyzed');
    env.fake.reset();
    r = await a.client.post(`/knowledge/sources/${id}/analyze`, { postLimit: 10 });
    assert.equal(r.body.stats.posts, 10);
    sent = env.fake.chatCalls.map((c) => JSON.stringify(c.body)).join(' ');
    assert.ok(sent.includes('Post number 10:') && !sent.includes('Post number 11:'));
    assert.equal((await a.client.get('/knowledge/sources')).body.items.find((s: any) => s.id === id).postLimit, 10);
    assert.equal((await a.client.post(`/knowledge/sources/${id}/analyze`, { postLimit: 500 })).status, 400);
  });

  it('price conflict between sources → one question; choosing a price confirms it and rejects the other', async () => {
    const s1 = await newSource(b, 'product_list', 'List 1');
    const s2 = await newSource(b, 'product_list', 'List 2');
    await b.client.post(`/knowledge/sources/${s1}/content`, { csv: 'name,price\nBurger,100\n' });
    await b.client.post(`/knowledge/sources/${s2}/content`, { csv: 'name,price\nBurger,120\n' });
    await b.client.post(`/knowledge/sources/${s1}/analyze`, {});
    await b.client.post(`/knowledge/sources/${s2}/analyze`, {});
    const qs = (await b.client.get('/knowledge/questions?limit=20')).body.items as any[];
    const conflicts = qs.filter((q) => q.kind === 'conflict');
    assert.equal(conflicts.length, 1);
    const choice = conflicts[0].options.choices.find((c: any) => c.price === 120);
    assert.equal((await b.client.post(`/knowledge/questions/${conflicts[0].id}/answer`, { itemId: choice.itemId })).status, 200);
    const burgers = (await b.client.get('/knowledge/items?search=Burger')).body.items as any[];
    assert.deepEqual(burgers.map((i) => [i.data.price, i.status]).sort(), [[100, 'rejected'], [120, 'confirmed']]);
    assert.equal((await b.client.post(`/knowledge/questions/${conflicts[0].id}/answer`, { itemId: choice.itemId })).status, 409);
  });

  it('outdated information is detected from the item date and can be marked outdated', async () => {
    const id = await newSource(b, 'product_list', 'Old list');
    await b.client.post(`/knowledge/sources/${id}/content`, { csv: 'name,price\nOld Pizza,80\n' });
    await b.client.post(`/knowledge/sources/${id}/analyze`, {});
    await env.owner.query(`UPDATE knowledge_items SET source_date = now() - interval '200 days' WHERE tenant_id = $1 AND norm_key = 'old pizza'`, [b.tenantId]);
    await b.client.post('/knowledge/questions/refresh');
    const q = ((await b.client.get('/knowledge/questions?limit=20')).body.items as any[]).find((x) => x.kind === 'outdated');
    assert.ok(q, 'an outdated question exists');
    await b.client.post(`/knowledge/questions/${q.id}/answer`, { stillValid: false });
    assert.equal((await b.client.get('/knowledge/items?search=Old Pizza')).body.items[0].status, 'outdated');
  });

  it('the owner is not flooded: at most N questions are shown, the rest are counted', async () => {
    const r = (await a.client.get('/knowledge/questions?limit=2')).body;
    assert.ok(r.items.length <= 2);
    assert.ok(r.openTotal >= r.items.length);
  });

  it('business info is saved as confirmed owner facts without AI', async () => {
    const id = await newSource(a, 'business_info', 'Basics');
    const r = await a.client.post(`/knowledge/sources/${id}/content`, { fields: { hours: '9-11', phone: '0100' } });
    assert.equal(r.body.saved, 2);
    const items = (await a.client.get(`/knowledge/items?sourceId=${id}`)).body.items as any[];
    assert.ok(items.every((i) => i.status === 'confirmed' && i.origin === 'owner'));
  });

  it('documents: Excel, Word and PDF files are really read', async () => {
    // Excel product list
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Product', 'Price']); ws.addRow(['Mug', 75]); ws.addRow(['Plate', 120]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const pl = await newSource(a, 'product_list', 'Excel list');
    assert.equal((await upload(a, pl, 'list.xlsx', xlsx)).status, 200);
    assert.equal((await a.client.post(`/knowledge/sources/${pl}/analyze`, {})).body.created, 2);
    assert.equal(((await a.client.get('/knowledge/items?search=Mug')).body.items[0]).data.price, 75);

    // Word
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Delivery costs 30 EGP inside Cairo</w:t></w:r></w:p></w:body></w:document>');
    const docx = await zip.generateAsync({ type: 'nodebuffer' });
    const dw = await newSource(a, 'document', 'Word doc');
    assert.equal((await upload(a, dw, 'policy.docx', docx)).status, 200);
    env.fake.responder = () => JSON.stringify({ items: [{ kind: 'faq', name: 'Delivery cost', question: 'How much is delivery?', answer: '30 EGP inside Cairo', evidence: 'Delivery costs 30 EGP inside Cairo', post: 0 }] });
    assert.equal((await a.client.post(`/knowledge/sources/${dw}/analyze`, {})).body.created, 1);

    // PDF (minimal hand-written file)
    const stream = 'BT /F1 18 Tf 20 100 Td (Opening hours are 9 to 5 every day) Tj ET';
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let pdf = '%PDF-1.4\n'; const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const pw = await newSource(a, 'document', 'PDF doc');
    const up = await upload(a, pw, 'info.pdf', Buffer.from(pdf));
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.ok(up.body.characters > 10);

    // rejected files
    assert.equal((await upload(a, pw, 'evil.exe', Buffer.from('MZ'))).status, 415);
    assert.equal((await upload(a, pw, 'fake.pdf', Buffer.from('not a pdf'))).status, 415);
  });

  it('SSRF: private addresses are refused', async () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('10.1.2.3'), true);
    assert.equal(isPrivateIp('169.254.169.254'), true);
    assert.equal(isPrivateIp('192.168.1.1'), true);
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIp('8.8.8.8'), false);
    await assert.rejects(fetchPage('http://127.0.0.1:1/', { allowPrivate: false }), { code: 'blocked_address' });
    await assert.rejects(fetchPage('http://169.254.169.254/latest/meta-data', { allowPrivate: false }), { code: 'blocked_address' });
    await assert.rejects(fetchPage('http://localhost:1/', { allowPrivate: false }), { code: 'blocked_address' });
    await assert.rejects(fetchPage('file:///etc/passwd', { allowPrivate: false }), { code: 'bad_url' });
    await assert.rejects(fetchPage('ftp://example.com/', { allowPrivate: false }), { code: 'bad_url' });
  });

  it('evidence validation unit: normalises Arabic/digits when matching quotes', () => {
    const r = validate({ items: [{ kind: 'product', name: 'قهوة', price: 60, evidence: 'القهوة ٦٠ جنيه', post: 0 }] }, ['عندنا القهوة ٦٠ جنيه النهاردة']);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.data.price, 60);
    assert.equal(validate({ items: [{ kind: 'product', name: 'x', evidence: 'ghost', post: 0 }] }, ['real text']).rejected, 1);
    assert.equal(validate('garbage', ['t']).items.length, 0);
  });

  it('AI errors are reported, the source is marked failed, and nothing is half-saved', async () => {
    const id = await newSource(a, 'document', 'Doc AI down');
    await a.client.post(`/knowledge/sources/${id}/content`, { text: 'Some price list: Tea 10 EGP' });
    env.fake.enqueue({ status: 401, body: { error: { message: 'bad key' } } }, { status: 401, body: { error: { message: 'bad key' } } });
    const r = await a.client.post(`/knowledge/sources/${id}/analyze`, {});
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.body).includes('test-key-SECRET'));
    assert.equal((await a.client.get('/knowledge/sources')).body.items.find((s: any) => s.id === id).status, 'failed');
    assert.equal((await a.client.get(`/knowledge/items?sourceId=${id}`)).body.items.length, 0);
  });

  it('tenant isolation: B sees none of A’s sources, items or questions and cannot act on them', async () => {
    const aSources = (await a.client.get('/knowledge/sources')).body.items as any[];
    const aItem = (await a.client.get('/knowledge/items')).body.items[0];
    const aQ = (await a.client.get('/knowledge/questions?limit=20')).body.items[0];
    const bIds = new Set(((await b.client.get('/knowledge/sources')).body.items as any[]).map((s) => s.id));
    assert.ok(aSources.every((s) => !bIds.has(s.id)));
    assert.equal((await b.client.patch(`/knowledge/items/${aItem.id}`, { status: 'rejected' })).status, 404);
    assert.equal((await b.client.del(`/knowledge/items/${aItem.id}`)).status, 404);
    assert.equal((await b.client.post(`/knowledge/questions/${aQ.id}/answer`, { dismiss: true })).status, 404);
    assert.equal((await b.client.post(`/knowledge/sources/${aSources[0].id}/analyze`, {})).status, 404);
    assert.equal((await b.client.del(`/knowledge/sources/${aSources[0].id}`)).status, 404);
    const still = (await a.client.get(`/knowledge/items?search=${encodeURIComponent(aItem.name)}`)).body.items;
    assert.ok(still.length >= 1, 'A’s data is untouched');
  });

  it('role check: a viewer can read knowledge but not change it', async () => {
    const email = `viewer-${Date.now()}@example.test`;
    const inv = await a.client.post('/team/invitations', { email, role: 'viewer' });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const { rows } = await env.owner.query(`SELECT body FROM email_outbox WHERE to_email = $1 ORDER BY id DESC LIMIT 1`, [email]);
    const token = /token=([A-Za-z0-9_-]+)/.exec(rows[0].body)![1];
    const { Client, PASSWORD } = await import('./helpers.js');
    const v = new Client(env.app);
    const acc = await v.post('/auth/accept-invitation', { token, fullName: 'Vee', password: PASSWORD });
    assert.ok([200, 201].includes(acc.status), JSON.stringify(acc.body));
    if (!v.cookie) await v.post('/auth/login', { email, password: PASSWORD });
    assert.equal((await v.get('/knowledge/items')).status, 200);
    assert.equal((await v.post('/knowledge/sources', { type: 'social', name: 'x' })).status, 403);
    assert.equal((await v.post('/knowledge/items', { kind: 'product', name: 'x' })).status, 403);
  });
});
