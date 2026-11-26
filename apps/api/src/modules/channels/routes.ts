import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enforceLimit } from '../../shared/limits.js';
import { audit } from '../../agent/employee.js';
import { PLATFORM_LABEL, type ChannelManager, type ChannelRecord } from '../../channels/manager.js';
import { DEFAULT_PROVIDER } from '../../channels/registry.js';
import { CHANNEL_TYPES, ChannelError, type ChannelType } from '../../channels/types.js';
import { AppError, notFound } from '../../shared/errors.js';

const SETUP: Record<ChannelType, 'token' | 'qr' | 'oauth' | 'none'> = { whatsapp: 'qr', messenger: 'oauth', instagram: 'oauth', telegram: 'token', website: 'none', tiktok: 'none' };

const websiteConfig = z.object({
  title: z.string().trim().max(60).optional(),
  welcome: z.string().trim().max(300).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Origins allowed to embed the widget, e.g. https://shop.example.com. Empty = any site. */
  allowedOrigins: z.array(z.string().url().max(200)).max(20).optional(),
});

const LIST_SQL = `
  SELECT ch.id, ch.type, ch.provider, ch.name, ch.status, ch.employee_id AS "employeeId", e.name AS "employeeName", e.status AS "employeeStatus", ch.auto_reply AS "autoReply",
         ch.public_key AS "publicKey", ch.config, ch.health_status AS "healthStatus", ch.last_health_at AS "lastHealthAt", ch.last_error AS "lastError", ch.last_error_at AS "lastErrorAt",
         ch.last_inbound_at AS "lastInboundAt", ch.last_outbound_at AS "lastOutboundAt", ch.consecutive_failures AS "consecutiveFailures", ch.created_at AS "createdAt",
         (SELECT count(*)::int FROM conversations cv WHERE cv.channel_id = ch.id) AS "conversations",
         (SELECT COALESCE(sum(cv.unread_count), 0)::int FROM conversations cv WHERE cv.channel_id = ch.id) AS "unread",
         (SELECT count(*)::int FROM messages m WHERE m.channel_id = ch.id AND m.status IN ('failed', 'retry')) AS "failedMessages"
  FROM channels ch LEFT JOIN ai_employees e ON e.id = ch.employee_id`;

function view(m: ChannelManager, r: Record<string, any>) {
  const connector = m.registry.get(r.type, r.provider);
  const cfg = { ...(r.config ?? {}) } as Record<string, unknown>;
  const hasQr = typeof cfg.lastQr === 'string';
  delete cfg.lastQr;
  delete cfg.qrAt;
  delete cfg.pages; // page list is only shown during the selection step
  const account = r.type === 'telegram' && cfg.username ? `@${String(cfg.username)}` : r.type === 'messenger' ? (cfg.pageName as string) ?? null : r.type === 'instagram' ? (cfg.igUsername ? `@${String(cfg.igUsername)}` : (cfg.pageName as string) ?? null) : null;
  return {
    ...r,
    config: cfg,
    hasQr,
    account,
    webhookUrl: r.type === 'website' ? null : m.webhookUrl({ type: r.type, publicKey: r.publicKey }),
    setup: SETUP[r.type as ChannelType],
    unofficial: r.provider === 'evolution',
    pendingPages: Array.isArray((r.config ?? {}).pages) ? ((r.config as any).pages as Array<{ id: string; name: string; igId?: string; igUsername?: string }>) : [],
    capabilities: connector.capabilities,
    publicKey: r.type === 'website' ? r.publicKey : undefined,
  };
}

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  const m = app.channels;
  const read = [app.authenticate, app.requirePermission('channels:read')];
  const manage = [app.authenticate, app.requirePermission('channels:manage')];
  const idParam = z.object({ id: z.uuid() });
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ChannelError) throw new AppError(e.status === 401 || e.status === 403 ? 502 : e.status, e.code, e.message);
      throw e;
    }
  };

  app.get('/channels/catalog', { preHandler: read }, async () => {
    const cfg = app.config;
    const publicHttps = cfg.appUrl.startsWith('https://');
    return {
      vaultConfigured: m.registry.vault.configured,
      publicHttps,
      items: CHANNEL_TYPES.map((type) => {
        const c = m.registry.forType(type);
        const notes: string[] = [];
        let serverReady = m.registry.vault.configured;
        if (type === 'whatsapp') { if (!cfg.channels.evolution.url || !cfg.channels.evolution.key) { serverReady = false; notes.push('The server has no Evolution API configured (EVOLUTION_API_URL / EVOLUTION_API_KEY).'); } notes.push('Unofficial QR connection (WhatsApp Web). Your number can be restricted by WhatsApp. Use it for testing; plan to move to the official WhatsApp Cloud API.'); }
        if (type === 'telegram' && !publicHttps) { serverReady = false; notes.push('Telegram needs a public https:// APP_URL to send messages to MicroAgent.'); }
        if (type === 'messenger' || type === 'instagram') { if (!m.registry.meta.configured) { serverReady = false; notes.push('Meta is not configured on this server (META_APP_ID / META_APP_SECRET / META_VERIFY_TOKEN).'); } notes.push('Prepared, not verified with Meta. It needs a Meta app, approved permissions (App Review) and a public https address. It is marked “awaiting approval” until a real message arrives.'); }
        if (!c.available && c.unavailableReason) notes.push(c.unavailableReason);
        return { type, label: PLATFORM_LABEL[type], provider: DEFAULT_PROVIDER[type], available: c.available, setup: SETUP[type], serverReady: c.available && serverReady, unofficial: DEFAULT_PROVIDER[type] === 'evolution', notes, capabilities: c.capabilities };
      }),
    };
  });

  app.get('/channels', { preHandler: read }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) => c.query(`${LIST_SQL} ORDER BY ch.created_at`));
    return { items: rows.map((r) => view(m, r)) };
  });

  app.post('/channels', { preHandler: manage }, async (req, reply) => {
    const body = z.object({ type: z.enum(CHANNEL_TYPES), name: z.string().trim().min(1).max(80), employeeId: z.uuid().nullish(), autoReply: z.boolean().optional(), config: websiteConfig.optional() }).parse(req.body);
    const a = req.auth!;
    await app.tenantTx(req, (c) => enforceLimit(c, a.tenantId!, 'maxChannels'));
    const ch = await guard(() => m.create(a.tenantId!, a.userId, { ...body, config: body.type === 'website' ? body.config : undefined }));
    // The website widget needs no external account: it is ready immediately.
    if (ch.type === 'website') await guard(() => m.connect(a.tenantId!, a.userId, ch.id, {}));
    const { rows } = await app.tenantTx(req, (c) => c.query(`${LIST_SQL} WHERE ch.id = $1`, [ch.id]));
    return reply.status(201).send(view(m, rows[0]));
  });

  app.get('/channels/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    return app.tenantTx(req, async (c) => {
      const { rows } = await c.query(`${LIST_SQL} WHERE ch.id = $1`, [id]);
      if (!rows[0]) throw notFound('Channel not found');
      const events = await c.query(`SELECT id, kind, status, detail, created_at AS "createdAt" FROM webhook_events WHERE channel_id = $1 ORDER BY id DESC LIMIT 15`, [id]);
      const stats = await c.query(`SELECT count(*) FILTER (WHERE status = 'rejected')::int AS rejected, count(*) FILTER (WHERE status = 'error')::int AS errors, count(*) FILTER (WHERE status = 'duplicate')::int AS duplicates
                                   FROM webhook_events WHERE channel_id = $1 AND created_at > now() - interval '24 hours'`, [id]);
      return { ...view(m, rows[0]), recentEvents: events.rows, last24h: stats.rows[0] };
    });
  });

  app.patch('/channels/:id', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), employeeId: z.uuid().nullable().optional(), autoReply: z.boolean().optional(), config: websiteConfig.optional() }).strict().parse(req.body);
    return app.tenantTx(req, async (c) => {
      const cur = await m.load(c, id);
      if (b.config && cur.type !== 'website') throw new AppError(400, 'config_not_supported', 'Only the website chat has widget settings');
      if (b.employeeId) {
        const e = await c.query('SELECT 1 FROM ai_employees WHERE id = $1', [b.employeeId]);
        if (!e.rows[0]) throw new AppError(400, 'employee_not_found', 'That AI employee does not exist');
      }
      const config = b.config ? { ...cur.config, ...b.config } : cur.config;
      await c.query(
        `UPDATE channels SET name = COALESCE($2, name), employee_id = CASE WHEN $3 THEN $4::uuid ELSE employee_id END, auto_reply = COALESCE($5, auto_reply), config = $6 WHERE id = $1`,
        [id, b.name ?? null, 'employeeId' in b, b.employeeId ?? null, b.autoReply ?? null, JSON.stringify(config)],
      );
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'channel.updated', 'channel', id, { fields: Object.keys(b) });
      const { rows } = await c.query(`${LIST_SQL} WHERE ch.id = $1`, [id]);
      return view(m, rows[0]);
    });
  });

  app.post('/channels/:id/connect', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ botToken: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    const a = req.auth!;
    const res = await m.connect(a.tenantId!, a.userId, id, b.botToken ? { botToken: b.botToken } : {}).catch((e) => { throw e instanceof AppError ? e : e; });
    return { status: res.status, qr: res.qr ?? null, message: res.message ?? null };
  });

  /** Poll while the QR is on screen. Returns the live state and the current QR image (data) when pairing. */
  app.get('/channels/:id/status', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const st = await guard(() => m.refreshStatus(req.auth!.tenantId!, id));
    const row = await app.tenantTx(req, async (c) => (await c.query('SELECT status, config FROM channels WHERE id = $1', [id])).rows[0]);
    return { status: row.status, state: st.state, detail: st.detail ?? null, qr: st.state === 'connecting' ? (st.qr ?? (row.config?.lastQr as string | undefined) ?? null) : null };
  });

  app.post('/channels/:id/reconnect', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const res = await m.reconnect(req.auth!.tenantId!, req.auth!.userId, id);
    return { status: res.status, qr: res.qr ?? null };
  });

  app.post('/channels/:id/disconnect', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    return m.disconnect(req.auth!.tenantId!, req.auth!.userId, id);
  });

  app.post('/channels/:id/health-check', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    return m.checkHealth(req.auth!.tenantId!, id);
  });

  app.delete('/channels/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ confirm: z.literal('DELETE') }).safeParse(req.query);
    if (!q.success) throw new AppError(400, 'confirmation_required', 'Deleting a channel also deletes all its conversations. Confirm with ?confirm=DELETE');
    await m.remove(req.auth!.tenantId!, req.auth!.userId, id);
    return reply.status(204).send();
  });

  /** People who have written to a channel: recipients for forwarding. */
  app.get('/channels/:id/contacts', { preHandler: [app.authenticate, app.requirePermission('conversations:forward')] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ search: z.string().trim().max(80).optional() }).parse(req.query);
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(
        `SELECT ct.id, ct.name, ct.phone, ct.external_id AS "externalId", cv.last_message_at AS "lastMessageAt", cv.last_inbound_at AS "lastInboundAt"
         FROM contacts ct JOIN conversations cv ON cv.contact_id = ct.id WHERE ct.channel_id = $1
           AND ($2::text IS NULL OR ct.name ILIKE '%' || $2 || '%' OR ct.phone ILIKE '%' || $2 || '%') ORDER BY cv.last_message_at DESC LIMIT 30`,
        [id, q.search ?? null],
      ),
    );
    return { items: rows };
  });

  // ───────────── Meta (Messenger / Instagram): OAuth ─────────────
  const oauthRedirect = () => `${app.config.appUrl}/api/v1/oauth/meta/callback`;

  app.get('/channels/:id/oauth/start', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const a = req.auth!;
    const ch = await app.tenantTx(req, (c) => m.load(c, id));
    if (ch.type !== 'messenger' && ch.type !== 'instagram') throw new AppError(400, 'not_meta', 'Only Messenger and Instagram connect through Facebook');
    const payload = Buffer.from(JSON.stringify({ c: id, t: a.tenantId, u: a.userId, exp: Date.now() + 10 * 60_000 })).toString('base64url');
    const state = `${payload}.${m.registry.vault.sign('oauth', payload)}`;
    return { url: await guard(async () => m.registry.meta.oauthUrl(ch.type as 'messenger' | 'instagram', oauthRedirect(), state)) };
  });

  // The browser comes back from Facebook here (with the user's session cookie).
  app.get('/oauth/meta/callback', { preHandler: [app.authenticate] }, async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }).parse(req.query);
    const a = req.auth!;
    const back = (params: Record<string, string>, channelId?: string) => reply.redirect(`${app.config.appUrl}/app/channels?${new URLSearchParams({ ...(channelId ? { channel: channelId } : {}), ...params })}`);
    const [payload, sig] = q.state.split('.');
    if (!payload || !sig || !m.registry.vault.verify('oauth', payload, sig)) return back({ meta_error: 'Invalid or tampered login state. Start again.' });
    const st = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { c: string; t: string; u: string; exp: number };
    if (st.exp < Date.now() || st.t !== a.tenantId || st.u !== a.userId) return back({ meta_error: 'This login expired or belongs to another user. Start again.' }, st.c);
    if (q.error || !q.code) return back({ meta_error: 'Facebook login was cancelled or denied.' }, st.c);
    try {
      const ch = await app.tenantTx(req, (c) => m.load(c, st.c));
      const pages = await m.registry.meta.pagesFromCode(q.code, oauthRedirect());
      const usable = ch.type === 'instagram' ? pages.filter((p) => p.igId) : pages;
      if (usable.length === 0) return back({ meta_error: ch.type === 'instagram' ? 'No Facebook Page with a linked Instagram professional account was found.' : 'No Facebook Pages were found for this account.' }, st.c);
      await app.tenantTx(req, async (c) => {
        await c.query(`UPDATE channels SET credentials_enc = $2, config = config || $3::jsonb, status = 'pending' WHERE id = $1`, [
          st.c,
          m.registry.vault.encrypt({ pending: JSON.stringify(usable) }),
          JSON.stringify({ pages: usable.map((p) => ({ id: p.id, name: p.name, igId: p.igId, igUsername: p.igUsername })) }),
        ]);
        await audit(c, a.tenantId!, a.userId, 'channel.meta_login', 'channel', st.c, { pages: usable.length });
      });
      return back({ meta: 'select' }, st.c);
    } catch (e) {
      return back({ meta_error: e instanceof ChannelError ? e.message : 'Could not complete the Facebook login.' }, st.c);
    }
  });

  app.post('/channels/:id/meta/select-page', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { pageId } = z.object({ pageId: z.string().min(1).max(40) }).parse(req.body);
    const a = req.auth!;
    const ch = await app.tenantTx(req, (c) => m.load(c, id));
    const creds = m.registry.vault.decrypt(ch.credentialsEnc);
    const pages = JSON.parse(creds.pending ?? '[]') as Array<{ id: string; name: string; token: string; igId?: string; igUsername?: string }>;
    const page = pages.find((p) => p.id === pageId);
    if (!page) throw new AppError(400, 'page_not_found', 'Choose one of the pages from the login step (the list may have expired).');
    const account = ch.type === 'instagram' ? page.igId! : page.id;
    const dup = await app.pools.app.query('SELECT channel_id FROM channel_resolve_external($1, $2)', [ch.type, account]);
    if (dup.rows[0] && dup.rows[0].channel_id !== id) throw new AppError(409, 'account_already_connected', 'This page is already connected to a channel. An account can belong to only one company.');
    const res = await guard(() => m.connectorOf(ch).connect({ pageId: page.id, pageToken: page.token, igId: page.igId ?? '', pageName: page.name, igUsername: page.igUsername ?? '' }, m.context(ch, {})));
    await app.tenantTx(req, async (c) => {
      await c.query(`UPDATE channels SET status = $2, credentials_enc = $3, external_account_id = $4, config = (config - 'pages') || $5::jsonb, last_error = NULL WHERE id = $1`, [id, res.status, m.registry.vault.encrypt(res.creds), res.externalAccountId, JSON.stringify(res.config ?? {})]);
      await audit(c, a.tenantId!, a.userId, 'channel.connected', 'channel', id, { type: ch.type, status: res.status });
    });
    return { status: res.status, message: res.message ?? null };
  });
}

export type { ChannelRecord };
