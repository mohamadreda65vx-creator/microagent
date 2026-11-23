import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../db/tx.js';
import { WIDGET_SCRIPT } from '../../channels/widget-script.js';
import type { ChannelRecord } from '../../channels/manager.js';
import type { WebhookRequest } from '../../channels/types.js';

const asHeaders = (h: FastifyRequest['headers']) => h as WebhookRequest['headers'];

/**
 * Unauthenticated endpoints: provider webhooks and the website widget.
 * They are protected by: unguessable channel keys, provider signatures/secrets, size limits, rate limits,
 * and (widget) signed visitor tokens. They never trust the request to name a tenant: the tenant comes from the channel key.
 */
export async function publicChannelRoutes(app: FastifyInstance): Promise<void> {
  const m = app.channels;

  // Keep the raw bytes: Meta signs the exact body.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {});
    } catch {
      const err = new Error('Invalid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  const raw = (req: FastifyRequest) => (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const toWebhook = (req: FastifyRequest): WebhookRequest => ({ method: req.method, headers: asHeaders(req.headers), query: req.query as Record<string, string>, body: req.body, rawBody: raw(req) });

  // ───────────── provider webhooks ─────────────
  app.post('/webhooks/channel/:key', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { key } = z.object({ key: z.string().min(8).max(64) }).parse(req.params);
    const r = await m.handleWebhook(key, toWebhook(req));
    return reply.status(r.status).send(r.body);
  });

  // Meta: GET = one-time verification of the callback URL; POST = events for every connected page.
  app.get('/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    let token: string | undefined;
    try { token = m.registry.meta.need().verifyToken; } catch { return reply.status(503).send({ error: { code: 'provider_not_configured', message: 'Meta is not configured' } }); }
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === token && q['hub.challenge']) return reply.type('text/plain').send(q['hub.challenge']);
    return reply.status(403).send({ error: { code: 'forbidden', message: 'Verification failed' } });
  });
  app.post('/webhooks/meta', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await m.handleMetaWebhook(toWebhook(req));
    return reply.status(r.status).send(r.body);
  });

  // ───────────── website widget ─────────────
  app.get('/widget.js', async (_req, reply) => reply.header('Content-Type', 'application/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=300').header('Cross-Origin-Resource-Policy', 'cross-origin').send(WIDGET_SCRIPT));

  const loadWidget = async (key: string): Promise<ChannelRecord | null> => {
    const { rows } = await app.pools.app.query('SELECT * FROM channel_resolve($1)', [key]);
    const r = rows[0];
    if (!r || r.type !== 'website' || r.tenant_status !== 'active') return null;
    return withTenant(app.pools.app, r.tenant_id, (c) => m.load(c, r.channel_id)).then((ch) => (ch.status === 'connected' ? ch : null));
  };

  /** CORS: only for origins the channel owner allowed (empty list = any site). Returns false when the origin is refused. */
  function cors(req: FastifyRequest, reply: FastifyReply, ch: ChannelRecord): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    const allowed = ((ch.config.allowedOrigins as string[] | undefined) ?? []).map((o) => o.replace(/\/+$/, ''));
    if (allowed.length && !allowed.includes(origin)) return false;
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin').header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type');
    return true;
  }
  const keyParam = z.object({ key: z.string().min(8).max(64) });
  const refuse = (reply: FastifyReply, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } });

  app.options('/widget/:key/*', async (req, reply) => {
    const { key } = keyParam.parse(req.params);
    const ch = await loadWidget(key);
    if (!ch || !cors(req, reply, ch)) return reply.status(403).send();
    return reply.header('Access-Control-Max-Age', '600').status(204).send();
  });

  app.get('/widget/:key/config', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { key } = keyParam.parse(req.params);
    const ch = await loadWidget(key);
    if (!ch) return refuse(reply, 404, 'not_found', 'Chat is not available');
    if (!cors(req, reply, ch)) return refuse(reply, 403, 'origin_not_allowed', 'This site is not allowed to use this chat');
    const c = ch.config as { title?: string; welcome?: string; color?: string };
    return { title: c.title ?? ch.name, welcome: c.welcome ?? 'Hi! How can we help you?', color: c.color ?? '#8B1E3F' };
  });

  app.post('/widget/:key/session', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { key } = keyParam.parse(req.params);
    const ch = await loadWidget(key);
    if (!ch) return refuse(reply, 404, 'not_found', 'Chat is not available');
    if (!cors(req, reply, ch)) return refuse(reply, 403, 'origin_not_allowed', 'This site is not allowed to use this chat');
    z.object({ name: z.string().trim().max(80).optional() }).parse(req.body ?? {});
    return { token: m.visitorToken(ch.id, m.newVisitorId()) };
  });

  app.post('/widget/:key/messages', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { key } = keyParam.parse(req.params);
    const ch = await loadWidget(key);
    if (!ch) return refuse(reply, 404, 'not_found', 'Chat is not available');
    if (!cors(req, reply, ch)) return refuse(reply, 403, 'origin_not_allowed', 'This site is not allowed to use this chat');
    const b = z.object({ token: z.string().max(200), text: z.string().trim().min(1).max(2000), clientMsgId: z.string().min(6).max(80), name: z.string().trim().max(80).optional() }).parse(req.body);
    const visitor = m.verifyVisitor(ch.id, b.token);
    if (!visitor) return refuse(reply, 401, 'invalid_token', 'Session expired');
    const r = await m.ingestMessage(ch.tenantId, ch, { externalId: `v:${visitor}:${b.clientMsgId}`, contactExternalId: visitor, contactName: b.name, text: b.text, attachments: [], at: new Date() });
    return reply.status(r.duplicate ? 200 : 201).send({ ok: true, duplicate: r.duplicate });
  });

  app.get('/widget/:key/messages', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { key } = keyParam.parse(req.params);
    const ch = await loadWidget(key);
    if (!ch) return refuse(reply, 404, 'not_found', 'Chat is not available');
    if (!cors(req, reply, ch)) return refuse(reply, 403, 'origin_not_allowed', 'This site is not allowed to use this chat');
    const q = z.object({ token: z.string().max(200), after: z.uuid().optional() }).parse(req.query);
    const visitor = m.verifyVisitor(ch.id, q.token);
    if (!visitor) return refuse(reply, 401, 'invalid_token', 'Session expired');
    const messages = await withTenant(app.pools.app, ch.tenantId, async (c) => {
      const cv = await c.query(`SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.channel_id = $1 AND ct.external_id = $2`, [ch.id, visitor]);
      if (!cv.rows[0]) return [];
      const { rows } = await c.query(
        `SELECT id, direction, body, attachments, status, created_at FROM messages
         WHERE conversation_id = $1 AND sender_type <> 'system' AND status IN ('received', 'sent', 'delivered', 'read')
           AND ($2::uuid IS NULL OR (created_at, id) > (SELECT created_at, id FROM messages WHERE id = $2 AND conversation_id = $1))
         ORDER BY created_at, id LIMIT 100`,
        [cv.rows[0].id, q.after ?? null],
      );
      // The visitor's browser has now fetched the agent's messages: that is "delivered" for this channel.
      await c.query(`UPDATE messages SET status = 'delivered' WHERE conversation_id = $1 AND direction = 'out' AND status = 'sent'`, [cv.rows[0].id]);
      return rows;
    });
    return {
      messages: messages.map((r: any) => ({
        id: r.id,
        from: r.direction === 'in' ? 'visitor' : 'agent',
        text: r.body,
        at: r.created_at,
        attachments: (r.attachments as Array<{ name?: string; fileId?: string }>).filter((a) => a.fileId).map((a) => ({ name: a.name ?? 'file', url: `${app.config.appUrl}/api/v1/widget/${key}/files/${a.fileId}?token=${encodeURIComponent(q.token)}` })),
      })),
    };
  });

  app.get('/widget/:key/files/:fileId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { key, fileId } = z.object({ key: z.string().min(8).max(64), fileId: z.uuid() }).parse(req.params);
    const ch = await loadWidget(key);
    if (!ch) return refuse(reply, 404, 'not_found', 'Not found');
    const token = z.string().max(200).parse((req.query as Record<string, string>).token);
    const visitor = m.verifyVisitor(ch.id, token);
    if (!visitor) return refuse(reply, 401, 'invalid_token', 'Session expired');
    const f = await withTenant(app.pools.app, ch.tenantId, async (c) =>
      (await c.query(
        `SELECT f.name, f.mime, f.data FROM message_files f JOIN conversations cv ON cv.id = f.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
         WHERE f.id = $1 AND cv.channel_id = $2 AND ct.external_id = $3`, [fileId, ch.id, visitor])).rows[0]);
    if (!f) return refuse(reply, 404, 'not_found', 'Not found');
    if (req.headers.origin) cors(req, reply, ch);
    return reply.header('Content-Type', f.mime).header('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`).header('X-Content-Type-Options', 'nosniff').send(f.data);
  });
}
