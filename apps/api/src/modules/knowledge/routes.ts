import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiError } from '../../ai/types.js';
import { audit } from '../../agent/employee.js';
import { normKey } from '../../agent/text.js';
import { withTenant } from '../../db/tx.js';
import { chunkText, extractFromTable, extractWithAi, KINDS, saveCandidates, sha, type Candidate, type SaveMeta } from '../../discovery/extract.js';
import { FetchError, fetchPage } from '../../discovery/fetcher.js';
import { docxToText, excelToRows, htmlToText, parseCsv, parsePosts, pdfToText, tableToText, toTable, type Table } from '../../discovery/parsers.js';
import { refreshQuestions } from '../../discovery/questions.js';
import { AppError, notFound } from '../../shared/errors.js';

const SOURCE_TYPES = ['website', 'social', 'document', 'product_list', 'business_info'] as const;
const idParam = z.object({ id: z.uuid() });
const SRC_COLS = `id, type, name, config, post_limit AS "postLimit", status, last_analyzed_at AS "lastAnalyzedAt", last_error AS "lastError", stats, created_at AS "createdAt"`;
const ITEM_COLS = `i.id, i.source_id AS "sourceId", s.name AS "sourceName", i.kind, i.name, i.data, i.evidence, i.source_ref AS "sourceRef", i.source_date AS "sourceDate", i.origin, i.status, i.confirmed_at AS "confirmedAt", i.created_at AS "createdAt"`;

const sourceBody = z.object({
  type: z.enum(SOURCE_TYPES),
  name: z.string().trim().min(1).max(160),
  postLimit: z.number().int().min(1).max(200).default(30),
  config: z.object({
    url: z.url().max(500).optional(),
    platform: z.enum(['facebook', 'instagram', 'x', 'tiktok', 'linkedin', 'other']).optional(),
    handle: z.string().trim().max(120).optional(),
    maxPages: z.number().int().min(1).max(10).optional(),
  }).default({}),
});

const dataPatch = z.object({
  price: z.number().min(0).max(1e9).nullable().optional(),
  currency: z.string().trim().min(1).max(10).nullable().optional(),
  description: z.string().trim().max(600).nullable().optional(),
  question: z.string().trim().max(400).optional(),
  answer: z.string().trim().max(1000).optional(),
  text: z.string().trim().max(600).optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  category: z.string().trim().max(200).nullable().optional(),
}).strict();

function mergeData(old: Record<string, unknown>, patch: z.infer<typeof dataPatch>): Record<string, unknown> {
  const out = { ...old };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

const PAGE_HINT = /menu|product|shop|store|service|price|pricing|offer|about|contact|faq|catalog|منتج|خدم|سعر|اسعار|عروض|قائم|عن|اتصل|تواصل|اسئل/i;

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5 } });
  const read = [app.authenticate, app.requirePermission('knowledge:read')];
  const write = [app.authenticate, app.requirePermission('knowledge:write')];

  /* ───────── sources ───────── */
  app.get('/knowledge/sources', { preHandler: read }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(`SELECT ${SRC_COLS}, (SELECT count(*)::int FROM knowledge_items i WHERE i.source_id = s.id) AS "itemCount",
                      (SELECT count(*)::int FROM source_contents sc WHERE sc.source_id = s.id) AS "contentCount"
               FROM knowledge_sources s ORDER BY created_at DESC LIMIT 200`),
    );
    return { items: rows };
  });

  app.post('/knowledge/sources', { preHandler: write }, async (req, reply) => {
    const b = sourceBody.parse(req.body);
    if (b.type === 'website' && !b.config.url) throw new AppError(400, 'url_required', 'A website source needs a web address');
    const row = await app.tenantTx(req, async (c) => {
      const { rows } = await c.query(`INSERT INTO knowledge_sources (tenant_id, type, name, config, post_limit, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${SRC_COLS}`, [req.auth!.tenantId, b.type, b.name, JSON.stringify(b.config), b.postLimit, req.auth!.userId]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'knowledge_source.created', 'knowledge_source', rows[0].id, { type: b.type });
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/knowledge/sources/:id', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(160), postLimit: z.number().int().min(1).max(200) }).partial().refine((v) => Object.keys(v).length > 0).parse(req.body);
    const { rows } = await app.tenantTx(req, (c) => c.query(`UPDATE knowledge_sources SET name = COALESCE($2, name), post_limit = COALESCE($3, post_limit) WHERE id = $1 RETURNING ${SRC_COLS}`, [id, b.name ?? null, b.postLimit ?? null]));
    if (!rows[0]) throw notFound('Source not found');
    return rows[0];
  });

  app.delete('/knowledge/sources/:id', { preHandler: write }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await app.tenantTx(req, async (c) => {
      const r = await c.query('DELETE FROM knowledge_sources WHERE id = $1', [id]); // items of the source are deleted with it (FK cascade)
      if (r.rowCount) { await audit(c, req.auth!.tenantId!, req.auth!.userId, 'knowledge_source.deleted', 'knowledge_source', id); await refreshQuestions(c, req.auth!.tenantId!); }
      return r.rowCount ?? 0;
    });
    if (!n) throw notFound('Source not found');
    return reply.status(204).send();
  });

  /* ───────── adding content to a source ───────── */
  async function loadSource(req: Parameters<typeof app.tenantTx>[0], id: string) {
    const { rows } = await app.tenantTx(req, (c) => c.query(`SELECT ${SRC_COLS} FROM knowledge_sources WHERE id = $1`, [id]));
    if (!rows[0]) throw notFound('Source not found');
    return rows[0] as { id: string; type: (typeof SOURCE_TYPES)[number]; name: string; config: Record<string, unknown>; postLimit: number; status: string };
  }

  async function putContents(tenantId: string, sourceId: string, contents: Array<{ ref: string; title?: string; content: string; publishedAt?: Date | null; meta?: Record<string, unknown> }>) {
    return withTenant(app.pools.app, tenantId, async (c) => {
      for (const x of contents) {
        await c.query(
          `INSERT INTO source_contents (tenant_id, source_id, ref, title, content, meta, published_at, content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (source_id, ref) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, meta = EXCLUDED.meta, published_at = EXCLUDED.published_at, content_hash = EXCLUDED.content_hash, fetched_at = now()`,
          [tenantId, sourceId, x.ref.slice(0, 1000), (x.title ?? '').slice(0, 500), x.content.slice(0, 300000), JSON.stringify(x.meta ?? {}), x.publishedAt ?? null, sha(x.content)],
        );
      }
      await c.query(`UPDATE knowledge_sources SET status = 'pending' WHERE id = $1 AND status <> 'analyzing'`, [sourceId]);
    });
  }

  app.post('/knowledge/sources/:id/content', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const src = await loadSource(req, id);
    const tenantId = req.auth!.tenantId!;
    if (src.type === 'social') {
      const { posts } = z.object({ posts: z.string().min(1).max(250_000) }).parse(req.body);
      const parsed = parsePosts(posts).slice(0, 500);
      if (!parsed.length) throw new AppError(400, 'no_posts', 'No posts were found in that text');
      await putContents(tenantId, id, parsed.map((p, i) => ({ ref: p.url ?? `post:${sha(p.text)}`, title: '', content: p.text, publishedAt: p.date, meta: { order: i } })));
      return { stored: parsed.length, withDates: parsed.filter((p) => p.date).length };
    }
    if (src.type === 'product_list') {
      const { csv } = z.object({ csv: z.string().min(1).max(250_000) }).parse(req.body);
      return storeTable(tenantId, id, 'pasted-list', toTable(parseCsv(csv)));
    }
    if (src.type === 'business_info') {
      const f = z.object({ fields: z.object({ hours: z.string().trim().max(400), address: z.string().trim().max(400), phone: z.string().trim().max(100), delivery: z.string().trim().max(400), payment: z.string().trim().max(400), notes: z.string().trim().max(600) }).partial() }).parse(req.body).fields;
      const labels: Record<string, string> = { hours: 'Opening hours', address: 'Address', phone: 'Phone', delivery: 'Delivery', payment: 'Payment methods', notes: 'Notes' };
      let saved = 0;
      await withTenant(app.pools.app, tenantId, async (c) => {
        for (const [k, v] of Object.entries(f)) {
          if (!v) continue;
          const nk = normKey(labels[k]!);
          await c.query(`DELETE FROM knowledge_items WHERE source_id = $1 AND kind = 'business_info' AND norm_key = $2`, [id, nk]);
          await c.query(
            `INSERT INTO knowledge_items (tenant_id, source_id, kind, name, norm_key, data, evidence, source_ref, source_date, origin, status, confirmed_by, confirmed_at)
             VALUES ($1,$2,'business_info',$3,$4,$5,$6,'owner entry',now(),'owner','confirmed',$7,now())`,
            [tenantId, id, labels[k], nk, JSON.stringify({ text: v }), v.slice(0, 500), req.auth!.userId],
          );
          saved++;
        }
        await c.query(`UPDATE knowledge_sources SET status = 'analyzed', last_analyzed_at = now(), stats = $2 WHERE id = $1`, [id, JSON.stringify({ created: saved })]);
        await refreshQuestions(c, tenantId);
        await audit(c, tenantId, req.auth!.userId, 'knowledge.business_info_saved', 'knowledge_source', id, { fields: Object.keys(f) });
      });
      return { saved };
    }
    if (src.type === 'document') {
      const { text } = z.object({ text: z.string().min(1).max(250_000) }).parse(req.body);
      await putContents(tenantId, id, [{ ref: 'pasted-text', title: src.name, content: text }]);
      return { stored: 1 };
    }
    throw new AppError(400, 'content_not_supported', 'A website source reads its address when you analyze it');
  });

  async function storeTable(tenantId: string, id: string, ref: string, table: Table) {
    if (!table.headers.length || !table.rows.length) throw new AppError(400, 'empty_table', 'The list is empty');
    const rows = table.rows.slice(0, 2000);
    await putContents(tenantId, id, [{ ref, title: ref, content: tableToText({ headers: table.headers, rows }), meta: { table: { headers: table.headers, rows } } }]);
    return { stored: rows.length, headers: table.headers };
  }

  app.post('/knowledge/sources/:id/upload', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const src = await loadSource(req, id);
    if (src.type !== 'document' && src.type !== 'product_list') throw new AppError(400, 'upload_not_supported', 'Files can be added to a document or product list source');
    const file = await req.file();
    if (!file) throw new AppError(400, 'file_required', 'Attach a file');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'file_too_large', 'The file is larger than 8 MB');
    const name = file.filename.slice(0, 200);
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const isZip = buf.subarray(0, 2).toString('latin1') === 'PK';
    const tenantId = req.auth!.tenantId!;
    try {
      if (ext === 'pdf' && buf.subarray(0, 5).toString('latin1') === '%PDF-') {
        if (src.type === 'product_list') throw new AppError(400, 'table_required', 'A product list must be an Excel or CSV file');
        const text = await pdfToText(buf);
        if (text.length < 20) throw new AppError(422, 'no_text', 'No readable text in this PDF (scanned images are not supported yet)');
        await putContents(tenantId, id, [{ ref: name, title: name, content: text }]);
        return { stored: 1, characters: text.length };
      }
      if (ext === 'docx' && isZip) {
        if (src.type === 'product_list') throw new AppError(400, 'table_required', 'A product list must be an Excel or CSV file');
        const text = await docxToText(buf);
        if (text.length < 5) throw new AppError(422, 'no_text', 'This Word file has no text');
        await putContents(tenantId, id, [{ ref: name, title: name, content: text }]);
        return { stored: 1, characters: text.length };
      }
      if ((ext === 'xlsx' && isZip) || ext === 'csv') {
        const rows = ext === 'csv' ? parseCsv(buf.toString('utf8')) : await excelToRows(buf);
        return await storeTable(tenantId, id, name, toTable(rows));
      }
      if (ext === 'txt' && src.type === 'document') {
        await putContents(tenantId, id, [{ ref: name, title: name, content: buf.toString('utf8') }]);
        return { stored: 1 };
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(422, 'unreadable_file', 'This file could not be read. Make sure it is a valid PDF, Word, Excel or CSV file.');
    }
    throw new AppError(415, 'unsupported_file', 'Supported files: PDF, Word (.docx), Excel (.xlsx), CSV, TXT');
  });

  /* ───────── analysis ───────── */
  app.post('/knowledge/sources/:id/analyze', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ postLimit: z.number().int().min(1).max(200).optional() }).parse(req.body ?? {});
    const tenantId = req.auth!.tenantId!;
    const userId = req.auth!.userId;

    const claimed = await withTenant(app.pools.app, tenantId, async (c) => {
      const { rows } = await c.query(
        `UPDATE knowledge_sources SET status = 'analyzing', last_error = NULL, post_limit = COALESCE($2, post_limit)
         WHERE id = $1 AND (status <> 'analyzing' OR updated_at < now() - interval '5 minutes') RETURNING ${SRC_COLS}`,
        [id, body.postLimit ?? null],
      );
      if (rows[0]) return rows[0] as { id: string; type: (typeof SOURCE_TYPES)[number]; name: string; config: { url?: string; maxPages?: number }; postLimit: number };
      const ex = await c.query('SELECT 1 FROM knowledge_sources WHERE id = $1', [id]);
      if (!ex.rowCount) throw notFound('Source not found');
      throw new AppError(409, 'already_analyzing', 'This source is already being analyzed');
    });

    const stats: Record<string, unknown> = { pages: 0, posts: 0, created: 0, duplicates: 0, rejectedByEvidence: 0, pricesDropped: 0, aiCalls: 0 };
    try {
      if (claimed.type === 'website') await crawl(tenantId, claimed, stats);
      const contents = await withTenant(app.pools.app, tenantId, async (c) => {
        const order = claimed.type === 'social' ? `published_at DESC NULLS LAST, (meta->>'order')::int ASC NULLS LAST, fetched_at DESC LIMIT ${claimed.postLimit}` : 'fetched_at DESC LIMIT 60';
        return (await c.query(`SELECT ref, title, content, meta, published_at AS "publishedAt", fetched_at AS "fetchedAt" FROM source_contents WHERE source_id = $1 ORDER BY ${order}`, [id])).rows as Array<{ ref: string; title: string; content: string; meta: { table?: Table }; publishedAt: Date | null; fetchedAt: Date }>;
      });
      if (!contents.length) throw new AppError(400, 'nothing_to_analyze', 'Add content to this source first');
      if (claimed.type === 'social') stats.posts = contents.length;

      const cands: Array<Candidate & SaveMeta> = [];
      const dateOf = (x: { publishedAt: Date | null; fetchedAt: Date }) => x.publishedAt ?? x.fetchedAt;
      const aiTargets: Array<{ texts: string[]; src: typeof contents }> = [];
      for (const x of contents) {
        if (x.meta?.table) {
          const r = extractFromTable(x.meta.table, 'product');
          if (r.problem) throw new AppError(422, 'bad_table', r.problem);
          for (const k of r.candidates) cands.push({ ...k, sourceId: id, sourceRef: x.ref, sourceDate: dateOf(x) });
          stats.rows = ((stats.rows as number) ?? 0) + x.meta.table.rows.length;
        }
      }
      const textual = contents.filter((x) => !x.meta?.table);
      if (claimed.type === 'social') {
        for (let i = 0; i < textual.length;) {
          const batch: typeof textual = [];
          let size = 0;
          while (i < textual.length && batch.length < 8 && size + textual[i]!.content.length <= 6000) { size += textual[i]!.content.length; batch.push(textual[i++]!); }
          if (!batch.length) batch.push(textual[i++]!);
          aiTargets.push({ texts: batch.map((b) => b.content), src: batch });
        }
      } else {
        for (const x of textual) for (const ch of chunkText(x.content)) aiTargets.push({ texts: [ch], src: [x] });
      }
      if (aiTargets.length > 12) { aiTargets.length = 12; stats.truncated = true; }
      for (const t of aiTargets) {
        const r = await extractWithAi(app.ai, { tenantId }, t.texts);
        stats.aiCalls = (stats.aiCalls as number) + 1;
        stats.rejectedByEvidence = (stats.rejectedByEvidence as number) + r.rejected;
        stats.pricesDropped = (stats.pricesDropped as number) + r.pricesDropped;
        for (const k of r.items) { const s = t.src[Math.min(k.contentIndex, t.src.length - 1)]!; cands.push({ ...k, sourceId: id, sourceRef: s.ref, sourceDate: dateOf(s) }); }
      }

      const saved = await withTenant(app.pools.app, tenantId, async (c) => {
        const s = await saveCandidates(c, tenantId, cands);
        const q = await refreshQuestions(c, tenantId);
        Object.assign(stats, s, { questionsCreated: q.created });
        await c.query(`UPDATE knowledge_sources SET status = 'analyzed', last_analyzed_at = now(), stats = $2, last_error = NULL WHERE id = $1`, [id, JSON.stringify(stats)]);
        await audit(c, tenantId, userId, 'knowledge_source.analyzed', 'knowledge_source', id, stats);
        return s;
      });
      return { status: 'analyzed', stats, ...saved };
    } catch (err) {
      const message = err instanceof AiError || err instanceof AppError || err instanceof FetchError ? err.message : 'Analysis failed unexpectedly';
      await withTenant(app.pools.app, tenantId, (c) => c.query(`UPDATE knowledge_sources SET status = 'failed', last_error = $2, stats = $3 WHERE id = $1`, [id, message.slice(0, 500), JSON.stringify(stats)]));
      if (err instanceof AiError || err instanceof AppError) throw err;
      if (err instanceof FetchError) throw new AppError(422, `fetch_${err.code}`, err.message);
      req.log.error({ err }, 'analysis failed');
      throw new AppError(500, 'analysis_failed', message);
    }
  });

  async function crawl(tenantId: string, src: { id: string; config: { url?: string; maxPages?: number } }, stats: Record<string, unknown>) {
    const start = src.config.url!;
    const maxPages = src.config.maxPages ?? 5;
    const opts = { allowPrivate: app.config.allowPrivateFetch };
    const seen = new Set<string>();
    const queue = [start];
    const pages: Array<{ ref: string; title: string; content: string }> = [];
    while (queue.length && pages.length < maxPages) {
      const u = queue.shift()!;
      if (seen.has(u)) continue;
      seen.add(u);
      let page;
      try {
        page = await fetchPage(u, opts);
      } catch (e) {
        if (pages.length === 0) throw e; // the start page must work; failed sub-pages are skipped
        continue;
      }
      if (!/html/.test(page.contentType) && pages.length === 0 && !/text\/plain/.test(page.contentType)) throw new FetchError('unsupported_type', 'That address is not a web page.');
      const parsed = /html/.test(page.contentType) || /<html|<body/i.test(page.body) ? htmlToText(page.body, page.url) : { title: '', text: page.body, links: [] as string[] };
      if (parsed.text.length >= 30) pages.push({ ref: page.url, title: parsed.title, content: parsed.text });
      const next = parsed.links.filter((l) => !seen.has(l) && PAGE_HINT.test(decodeURIComponent(l))).slice(0, 8);
      queue.push(...next);
    }
    if (!pages.length) throw new AppError(422, 'no_text', 'No readable text was found on that website');
    stats.pages = pages.length;
    await putContents(tenantId, src.id, pages);
    await withTenant(app.pools.app, tenantId, (c) => c.query(`UPDATE knowledge_sources SET status = 'analyzing' WHERE id = $1`, [src.id]));
  }

  /* ───────── items ───────── */
  app.get('/knowledge/items', { preHandler: read }, async (req) => {
    const q = z.object({ kind: z.enum(KINDS).optional(), status: z.enum(['unconfirmed', 'confirmed', 'rejected', 'outdated']).optional(), sourceId: z.uuid().optional(), search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(
        `SELECT ${ITEM_COLS} FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id = i.source_id
         WHERE ($1::text IS NULL OR i.kind = $1) AND ($2::text IS NULL OR i.status = $2) AND ($3::uuid IS NULL OR i.source_id = $3) AND ($4::text IS NULL OR i.name ILIKE '%' || $4 || '%')
         ORDER BY i.created_at DESC LIMIT $5`,
        [q.kind ?? null, q.status ?? null, q.sourceId ?? null, q.search ?? null, q.limit],
      ),
    );
    return { items: rows };
  });

  app.get('/knowledge/summary', { preHandler: read }, async (req) =>
    app.tenantTx(req, async (c) => {
      const items = await c.query(`SELECT kind, status, count(*)::int AS n FROM knowledge_items GROUP BY kind, status`);
      const qs = await c.query(`SELECT count(*)::int AS n FROM business_questions WHERE status = 'open'`);
      return { items: items.rows, openQuestions: qs.rows[0].n };
    }),
  );

  const itemCreate = z.object({
    kind: z.enum(['product', 'service', 'offer', 'faq', 'business_info']),
    name: z.string().trim().min(1).max(300),
    data: dataPatch.default({}),
  });
  app.post('/knowledge/items', { preHandler: write }, async (req, reply) => {
    const b = itemCreate.parse(req.body);
    if (b.kind === 'faq' && (!b.data.question || !b.data.answer)) throw new AppError(400, 'faq_incomplete', 'An FAQ needs a question and an answer');
    const row = await app.tenantTx(req, async (c) => {
      const data = mergeData({}, b.data);
      const { rows } = await c.query(
        `INSERT INTO knowledge_items (tenant_id, kind, name, norm_key, data, evidence, source_ref, source_date, origin, status, confirmed_by, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,'','owner entry',now(),'owner','confirmed',$6,now()) RETURNING id`,
        [req.auth!.tenantId, b.kind, b.name, normKey(b.name) || b.name.toLowerCase(), JSON.stringify(data), req.auth!.userId],
      );
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'knowledge_item.created', 'knowledge_item', rows[0].id, { kind: b.kind });
      await refreshQuestions(c, req.auth!.tenantId!);
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/knowledge/items/:id', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(300), data: dataPatch, status: z.enum(['confirmed', 'rejected', 'outdated', 'unconfirmed']) }).partial().refine((v) => Object.keys(v).length > 0).parse(req.body);
    return app.tenantTx(req, async (c) => {
      const cur = (await c.query('SELECT id, name, data, status FROM knowledge_items WHERE id = $1 FOR UPDATE', [id])).rows[0] as { name: string; data: Record<string, unknown>; status: string } | undefined;
      if (!cur) throw notFound('Item not found');
      const name = b.name ?? cur.name;
      const data = b.data ? mergeData(cur.data, b.data) : cur.data;
      const status = b.status ?? cur.status;
      const confirming = status === 'confirmed' && cur.status !== 'confirmed';
      await c.query(
        `UPDATE knowledge_items SET name = $2, norm_key = $3, data = $4, status = $5,
           confirmed_by = CASE WHEN $6 THEN $7::uuid ELSE confirmed_by END, confirmed_at = CASE WHEN $6 THEN now() ELSE confirmed_at END WHERE id = $1`,
        [id, name, normKey(name) || name.toLowerCase(), JSON.stringify(data), status, confirming, req.auth!.userId],
      );
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'knowledge_item.updated', 'knowledge_item', id, { status, fields: Object.keys(b), previousStatus: cur.status });
      await refreshQuestions(c, req.auth!.tenantId!);
      return (await c.query(`SELECT ${ITEM_COLS} FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id = i.source_id WHERE i.id = $1`, [id])).rows[0];
    });
  });

  app.post('/knowledge/items/bulk-status', { preHandler: write }, async (req) => {
    const b = z.object({ ids: z.array(z.uuid()).min(1).max(500), status: z.enum(['confirmed', 'rejected']) }).parse(req.body);
    return app.tenantTx(req, async (c) => {
      const r = await c.query(`UPDATE knowledge_items SET status = $2, confirmed_by = CASE WHEN $2 = 'confirmed' THEN $3::uuid ELSE confirmed_by END, confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END WHERE id = ANY($1::uuid[])`, [b.ids, b.status, req.auth!.userId]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, `knowledge_item.bulk_${b.status}`, 'knowledge_item', null, { count: r.rowCount });
      await refreshQuestions(c, req.auth!.tenantId!);
      return { updated: r.rowCount ?? 0 };
    });
  });

  app.delete('/knowledge/items/:id', { preHandler: write }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await app.tenantTx(req, async (c) => {
      const r = await c.query('DELETE FROM knowledge_items WHERE id = $1', [id]);
      if (r.rowCount) { await audit(c, req.auth!.tenantId!, req.auth!.userId, 'knowledge_item.deleted', 'knowledge_item', id); await refreshQuestions(c, req.auth!.tenantId!); }
      return r.rowCount ?? 0;
    });
    if (!n) throw notFound('Item not found');
    return reply.status(204).send();
  });

  /* ───────── smart questions for the owner ───────── */
  app.get('/knowledge/questions', { preHandler: read }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.query);
    return app.tenantTx(req, async (c) => {
      const total = (await c.query(`SELECT count(*)::int AS n FROM business_questions WHERE status = 'open'`)).rows[0].n as number;
      // Only a few at a time: the owner is not buried under 50 questions.
      const { rows } = await c.query(`SELECT id, kind, question, options, related_item_ids AS "relatedItemIds", priority, created_at AS "createdAt" FROM business_questions WHERE status = 'open' ORDER BY priority DESC, created_at LIMIT $1`, [q.limit]);
      return { items: rows, openTotal: total };
    });
  });

  app.post('/knowledge/questions/refresh', { preHandler: write }, async (req) => app.tenantTx(req, (c) => refreshQuestions(c, req.auth!.tenantId!)));

  const answerBody = z.object({
    dismiss: z.boolean().optional(),
    price: z.number().min(0).max(1e9).optional(),
    currency: z.string().trim().min(1).max(10).optional(),
    itemId: z.uuid().optional(),
    stillValid: z.boolean().optional(),
    notSold: z.boolean().optional(),
    text: z.string().trim().min(1).max(600).optional(),
  });

  app.post('/knowledge/questions/:id/answer', { preHandler: write }, async (req) => {
    const { id } = idParam.parse(req.params);
    const a = answerBody.parse(req.body);
    const tenantId = req.auth!.tenantId!;
    const userId = req.auth!.userId;
    return app.tenantTx(req, async (c) => {
      const q = (await c.query(`SELECT id, kind, subject_key, options, related_item_ids, status FROM business_questions WHERE id = $1 FOR UPDATE`, [id])).rows[0] as { kind: string; subject_key: string; options: { type?: string; label?: string; name?: string }; related_item_ids: string[]; status: string } | undefined;
      if (!q) throw notFound('Question not found');
      if (q.status !== 'open') throw new AppError(409, 'question_closed', 'This question was already handled');
      const type = q.options.type;
      let resolution = 'dismissed';
      if (a.dismiss) {
        resolution = 'dismissed';
      } else if (type === 'price') {
        if (a.notSold) {
          await c.query(`UPDATE knowledge_items SET status = 'rejected' WHERE id = ANY($1::uuid[])`, [q.related_item_ids]);
          resolution = 'not_sold';
        } else {
          if (a.price === undefined) throw new AppError(400, 'price_required', 'Enter the price');
          const patch = JSON.stringify({ price: a.price, ...(a.currency ? { currency: a.currency } : {}) });
          // the first related item carries the confirmed price; extra duplicates without a price are rejected
          const [first, ...rest] = q.related_item_ids;
          await c.query(`UPDATE knowledge_items SET data = data || $2::jsonb, status = 'confirmed', confirmed_by = $3, confirmed_at = now(), source_date = now(), origin = 'owner' WHERE id = $1`, [first, patch, userId]);
          if (rest.length) await c.query(`UPDATE knowledge_items SET status = 'rejected' WHERE id = ANY($1::uuid[])`, [rest]);
          resolution = 'price_set';
        }
      } else if (type === 'choose_item') {
        if (a.itemId) {
          if (!q.related_item_ids.includes(a.itemId)) throw new AppError(400, 'bad_choice', 'Choose one of the listed prices');
          await c.query(`UPDATE knowledge_items SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), source_date = now() WHERE id = $1`, [a.itemId, userId]);
          await c.query(`UPDATE knowledge_items SET status = 'rejected' WHERE id = ANY($1::uuid[]) AND id <> $2`, [q.related_item_ids, a.itemId]);
        } else if (a.price !== undefined) {
          const base = (await c.query('SELECT kind, name, norm_key, data FROM knowledge_items WHERE id = $1', [q.related_item_ids[0]])).rows[0] as { kind: string; name: string; norm_key: string; data: Record<string, unknown> };
          await c.query(`UPDATE knowledge_items SET status = 'rejected' WHERE id = ANY($1::uuid[])`, [q.related_item_ids]);
          await c.query(
            `INSERT INTO knowledge_items (tenant_id, kind, name, norm_key, data, evidence, source_ref, source_date, origin, status, confirmed_by, confirmed_at) VALUES ($1,$2,$3,$4,$5,'','owner answer',now(),'owner','confirmed',$6,now())`,
            [tenantId, base.kind, base.name, base.norm_key, JSON.stringify({ ...base.data, price: a.price }), userId],
          );
        } else throw new AppError(400, 'choice_required', 'Choose the correct price or type a new one');
        resolution = 'conflict_resolved';
      } else if (type === 'still_valid') {
        if (a.stillValid === undefined) throw new AppError(400, 'answer_required', 'Say whether it is still valid');
        if (a.stillValid) {
          const patch = a.price !== undefined ? { price: a.price } : {};
          await c.query(`UPDATE knowledge_items SET data = data || $2::jsonb, status = 'confirmed', confirmed_by = $3, confirmed_at = now(), source_date = now() WHERE id = $1`, [q.related_item_ids[0], JSON.stringify(patch), userId]);
          resolution = 'still_valid';
        } else {
          await c.query(`UPDATE knowledge_items SET status = 'outdated' WHERE id = $1`, [q.related_item_ids[0]]);
          resolution = 'outdated';
        }
      } else if (type === 'info') {
        if (!a.text) throw new AppError(400, 'text_required', 'Write the answer');
        const label = ({ hours: 'Opening hours', address: 'Address', phone: 'Phone', delivery: 'Delivery', payment: 'Payment methods' } as Record<string, string>)[q.options.label ?? ''] ?? 'Info';
        await c.query(
          `INSERT INTO knowledge_items (tenant_id, kind, name, norm_key, data, evidence, source_ref, source_date, origin, status, confirmed_by, confirmed_at) VALUES ($1,'business_info',$2,$3,$4,$5,'owner answer',now(),'owner','confirmed',$6,now())`,
          [tenantId, label, normKey(label), JSON.stringify({ text: a.text }), a.text.slice(0, 500), userId],
        );
        resolution = 'info_saved';
      }
      await c.query(`UPDATE business_questions SET status = $2, answer = $3, answered_by = $4, answered_at = now() WHERE id = $1`, [id, a.dismiss ? 'dismissed' : 'answered', JSON.stringify({ resolution, ...a }), userId]);
      await audit(c, tenantId, userId, 'business_question.answered', 'business_question', id, { resolution });
      const r = await refreshQuestions(c, tenantId);
      return { resolution, ...r };
    });
  });
}

