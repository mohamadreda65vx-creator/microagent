import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../agent/employee.js';
import { buildDraft } from '../../campaigns/builder.js';
import { CAMPAIGN_COLS, type CampaignRow } from '../../campaigns/engine.js';
import { CAMPAIGN_PLATFORMS, audienceSchema, normalizeFilter, type CampaignPlatform } from '../../campaigns/audience.js';
import type { Client } from '../../db/pool.js';
import { AppError, notFound } from '../../shared/errors.js';

const idParam = z.object({ id: z.uuid() });
const message = z.string().trim().max(1500);
const base = {
  name: z.string().trim().min(1).max(160),
  message,
  optoutFooter: z.boolean().optional(),
  audience: audienceSchema.default({}),
  ratePerMinute: z.number().int().min(1).max(600).nullable().optional(),
  brief: z.string().trim().max(4000).nullable().optional(),
};

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  const E = app.campaigns;
  const read = [app.authenticate, app.requirePermission('campaigns:read')];
  const manage = [app.authenticate, app.requirePermission('campaigns:manage')];
  const approve = [app.authenticate, app.requirePermission('campaigns:approve')];

  const channelOf = async (c: Client, channelId: string) => {
    const ch = (await c.query(`SELECT id, type, name, status, provider FROM channels WHERE id = $1`, [channelId])).rows[0];
    if (!ch) throw new AppError(404, 'channel_not_found', 'Channel not found');
    if (!(CAMPAIGN_PLATFORMS as readonly string[]).includes(ch.type)) throw new AppError(400, 'platform_not_supported', ch.type === 'website' ? 'Website chat visitors cannot receive campaigns: there is no way to reach them once they leave the page.' : 'This platform cannot send campaigns.');
    return ch as { id: string; type: CampaignPlatform; name: string; status: string; provider: string };
  };
  const checkRefs = async (c: Client, filter: z.infer<typeof audienceSchema>) => {
    if (filter.previousCampaign && !(await c.query(`SELECT 1 FROM campaigns WHERE id = $1`, [filter.previousCampaign.campaignId])).rows[0]) throw new AppError(400, 'campaign_not_found', 'The previous campaign in the audience filter does not exist.');
  };
  const resetApproval = (c: Client, id: string) => c.query(`UPDATE campaigns SET status = 'draft', approved_hash = NULL, approved_by = NULL, approved_at = NULL, approved_eligible = NULL, updated_at = now() WHERE id = $1 AND status = 'approved'`, [id]);
  const view = async (c: Client, id: string) => {
    const camp = await E.load(c, id);
    const ch = (await c.query(`SELECT name AS "channelName", status AS "channelStatus", provider FROM channels WHERE id = $1`, [camp.channelId])).rows[0] ?? {};
    return { ...camp, ...ch, effectiveRatePerMinute: E.effectiveRate(camp), dailyCap: E.limits[camp.platform].perDay };
  };

  // ───────────── what each platform allows (shown in the UI) ─────────────
  app.get('/campaigns/platforms', { preHandler: read }, async (req) => {
    const chs = (await app.tenantTx(req, (c) => c.query(`SELECT id, type, name, status, provider FROM channels WHERE type = ANY($1::text[]) ORDER BY created_at`, [[...CAMPAIGN_PLATFORMS]]))).rows;
    const rules: Record<CampaignPlatform, string[]> = {
      messenger: ['Only people who wrote to you in the last 24 hours (standard messaging window).', 'Meta Marketing Messages (outside the window) are not implemented yet, so older contacts are excluded.', 'People who asked to stop are never messaged.'],
      instagram: ['Only people who wrote to you in the last 24 hours.', 'Messages outside the window are not allowed and are excluded.', 'People who asked to stop are never messaged.'],
      whatsapp: ['Inside 24 hours of the customer’s last message: allowed.', 'Outside 24 hours: only people who explicitly opted in to marketing (QR connection). The official API would require an approved template, which is not connected.', 'Unofficial connection: sending is slow and limited per day, and the number can still be restricted by WhatsApp.'],
      telegram: ['Only people who started a chat with your bot.', 'People who block the bot are marked unreachable and skipped.', 'Telegram does not report delivery.'],
    };
    return {
      platforms: CAMPAIGN_PLATFORMS.map((p) => ({ platform: p, rules: rules[p], limits: E.limits[p], channels: chs.filter((c) => c.type === p).map((c) => ({ id: c.id, name: c.name, status: c.status, unofficial: p === 'whatsapp' && c.provider === 'evolution' })) })),
      notSupported: [{ platform: 'website', reason: 'Website chat visitors cannot be reached after they leave the page.' }],
    };
  });

  // ───────────── list / create ─────────────
  app.get('/campaigns', { preHandler: read }, async (req) => {
    const q = z.object({ status: z.enum(['draft', 'approved', 'scheduled', 'running', 'paused', 'completed', 'cancelled']).optional(), platform: z.enum(CAMPAIGN_PLATFORMS).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const rows = (await app.tenantTx(req, (c) => c.query(
      `SELECT ${CAMPAIGN_COLS.replace(/\b(id|name|platform|status)\b(?! AS)/g, 'cp.$1').replace(/cp\.(\w+) AS/g, 'cp.$1 AS')},
          (SELECT count(*)::int FROM campaign_recipients r WHERE r.campaign_id = cp.id) AS "totalAudience",
          (SELECT count(*)::int FROM campaign_recipients r JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = cp.id AND m.status IN ('sent', 'delivered', 'read')) AS sent,
          (SELECT count(*)::int FROM campaign_recipients r JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = cp.id AND m.status IN ('delivered', 'read')) AS delivered,
          (SELECT count(*)::int FROM campaign_recipients r WHERE r.campaign_id = cp.id AND r.status = 'failed') AS failed,
          (SELECT name FROM channels WHERE id = cp.channel_id) AS "channelName"
         FROM campaigns cp WHERE ($1::text IS NULL OR cp.status = $1) AND ($2::text IS NULL OR cp.platform = $2) ORDER BY cp.created_at DESC LIMIT $3`,
      [q.status ?? null, q.platform ?? null, q.limit],
    ))).rows;
    return { items: rows };
  });

  app.post('/campaigns', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ ...base, channelId: z.uuid() }).strict().parse(req.body);
    const out = await app.tenantTx(req, async (c) => {
      const ch = await channelOf(c, b.channelId);
      const audienceF = normalizeFilter(b.audience);
      await checkRefs(c, audienceF);
      const r = await c.query(
        `INSERT INTO campaigns (tenant_id, name, channel_id, platform, brief, message, optout_footer, audience, rate_per_minute, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [req.auth!.tenantId, b.name, ch.id, ch.type, b.brief ?? null, b.message, b.optoutFooter ?? true, JSON.stringify(audienceF), b.ratePerMinute ?? null, req.auth!.userId],
      );
      await E.event(c, req.auth!.tenantId!, r.rows[0].id, 'created', req.auth!.userId);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'campaign.created', 'campaign', r.rows[0].id, { platform: ch.type });
      return view(c, r.rows[0].id);
    });
    return reply.code(201).send(out);
  });

  // Live audience preview while the owner is still choosing filters (nothing is saved).
  app.post('/campaigns/audience/preview', { preHandler: read }, async (req) => {
    const b = z.object({ channelId: z.uuid(), audience: audienceSchema.default({}), message: message.default(''), optoutFooter: z.boolean().default(true) }).strict().parse(req.body);
    return app.tenantTx(req, async (c) => {
      const ch = await channelOf(c, b.channelId);
      await checkRefs(c, b.audience);
      const fake = { id: '00000000-0000-0000-0000-000000000000', channelId: ch.id, platform: ch.type, message: b.message, optoutFooter: b.optoutFooter, audience: normalizeFilter(b.audience), ratePerMinute: null } as unknown as CampaignRow;
      return (await E.computePreview(c, fake)).preview;
    });
  });

  // ───────────── AI builder (drafts only: it can never launch) ─────────────
  app.post('/campaigns/ai/draft', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ prompt: z.string().trim().min(5).max(2000), channelId: z.uuid().optional() }).strict().parse(req.body);
    const tenantId = req.auth!.tenantId!;
    const draft = await buildDraft(app.ai, app.pools, tenantId, { prompt: b.prompt });
    const result = await app.tenantTx(req, async (c) => {
      if (!draft.platform) return { needs: 'platform' as const };
      const chs = (await c.query(`SELECT id, name, status FROM channels WHERE type = $1 ORDER BY created_at`, [draft.platform])).rows as Array<{ id: string; name: string; status: string }>;
      let chosen = b.channelId ? chs.find((x) => x.id === b.channelId) : chs.filter((x) => x.status === 'connected').length === 1 ? chs.find((x) => x.status === 'connected') : chs.length === 1 ? chs[0] : undefined;
      if (b.channelId && !chosen) throw new AppError(400, 'channel_platform_mismatch', 'That channel does not belong to the platform in the request.');
      if (!chosen) return { needs: chs.length === 0 ? ('channel_missing' as const) : ('channel' as const), channels: chs };
      await checkRefs(c, draft.audience);
      const r = await c.query(
        `INSERT INTO campaigns (tenant_id, name, channel_id, platform, brief, message, audience, created_by_ai, ai_notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9) RETURNING id`,
        [tenantId, draft.name, chosen.id, draft.platform, b.prompt, draft.message, JSON.stringify(draft.audience), JSON.stringify({ improvements: draft.improvements, questions: draft.questions, warnings: draft.warnings }), req.auth!.userId],
      );
      await E.event(c, tenantId, r.rows[0].id, 'created_by_ai', req.auth!.userId, { prompt: b.prompt.slice(0, 300) });
      await audit(c, tenantId, req.auth!.userId, 'campaign.ai_drafted', 'campaign', r.rows[0].id, { platform: draft.platform });
      const camp = await view(c, r.rows[0].id);
      return { campaign: camp, preview: (await E.computePreview(c, camp)).preview };
    });
    return reply.code('campaign' in result ? 201 : 200).send({ draft, ...result });
  });

  app.post('/campaigns/:id/ai/revise', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ instruction: z.string().trim().min(3).max(1500) }).strict().parse(req.body);
    const tenantId = req.auth!.tenantId!;
    const cur = await app.tenantTx(req, (c) => E.load(c, id));
    if (!['draft', 'approved'].includes(cur.status)) throw new AppError(409, 'campaign_not_editable', 'Only a draft can be changed. Create a new campaign instead.');
    const draft = await buildDraft(app.ai, app.pools, tenantId, { prompt: b.instruction, current: { name: cur.name, platform: cur.platform, audience: cur.audience, message: cur.message } });
    return app.tenantTx(req, async (c) => {
      const warnings = [...draft.warnings];
      if (draft.platform && draft.platform !== cur.platform) warnings.push(`The platform of a campaign cannot change (it stays ${cur.platform}). Create a new campaign for ${draft.platform}.`);
      await checkRefs(c, draft.audience);
      // The model sees the current draft, so an unchanged field comes back unchanged; a previous-campaign filter (not exposed to the model) is kept.
      const keep = cur.audience.previousCampaign ? { ...draft.audience, previousCampaign: cur.audience.previousCampaign } : draft.audience;
      await c.query(`UPDATE campaigns SET name = $2, message = $3, audience = $4, ai_notes = $5, updated_at = now() WHERE id = $1`, [id, draft.name, draft.message || cur.message, JSON.stringify(keep), JSON.stringify({ improvements: draft.improvements, questions: draft.questions, warnings })]);
      await resetApproval(c, id);
      await E.event(c, tenantId, id, 'revised_by_ai', req.auth!.userId, { instruction: b.instruction.slice(0, 300) });
      const camp = await view(c, id);
      return { campaign: camp, draft: { ...draft, warnings }, preview: (await E.computePreview(c, camp)).preview };
    });
  });

  // ───────────── one campaign ─────────────
  app.get('/campaigns/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    return app.tenantTx(req, (c) => view(c, id));
  });

  app.patch('/campaigns/:id', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, (v as z.ZodType).optional()]))).strict().parse(req.body) as Partial<{ name: string; message: string; optoutFooter: boolean; audience: z.infer<typeof audienceSchema>; ratePerMinute: number | null; brief: string | null }>;
    return app.tenantTx(req, async (c) => {
      const cur = await E.load(c, id);
      if (!['draft', 'approved'].includes(cur.status)) throw new AppError(409, 'campaign_not_editable', `A ${cur.status} campaign cannot be edited. Pause or cancel it, then create a new one.`);
      const audienceF = b.audience ? normalizeFilter(b.audience) : undefined;
      if (audienceF) await checkRefs(c, audienceF);
      await c.query(
        `UPDATE campaigns SET name = COALESCE($2, name), message = COALESCE($3, message), optout_footer = COALESCE($4, optout_footer), audience = COALESCE($5::jsonb, audience),
           rate_per_minute = CASE WHEN $6 THEN $7 ELSE rate_per_minute END, brief = CASE WHEN $8 THEN $9 ELSE brief END, updated_at = now() WHERE id = $1`,
        [id, b.name ?? null, b.message ?? null, b.optoutFooter ?? null, audienceF ? JSON.stringify(audienceF) : null, b.ratePerMinute !== undefined, b.ratePerMinute ?? null, b.brief !== undefined, b.brief ?? null],
      );
      await resetApproval(c, id); // any edit voids the approval
      await E.event(c, req.auth!.tenantId!, id, 'edited', req.auth!.userId);
      return view(c, id);
    });
  });

  app.delete('/campaigns/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await app.tenantTx(req, async (c) => {
      const cur = await E.load(c, id);
      if (!['draft', 'approved'].includes(cur.status)) throw new AppError(409, 'campaign_not_deletable', 'A campaign that was launched is kept for your records. You can cancel it instead.');
      await c.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'campaign.deleted', 'campaign', id, {});
    });
    return reply.code(204).send();
  });

  app.get('/campaigns/:id/preview', { preHandler: read }, async (req) => E.preview(req.auth!.tenantId!, idParam.parse(req.params).id));

  app.post('/campaigns/:id/approve', { preHandler: approve }, async (req) => {
    const b = z.object({ hash: z.string().length(64), confirmRecipients: z.number().int().min(0), acknowledgeUnofficialRisk: z.boolean().optional() }).strict().parse(req.body);
    return E.approve(req.auth!.tenantId!, req.auth!.userId, idParam.parse(req.params).id, b);
  });
  app.post('/campaigns/:id/launch', { preHandler: approve }, async (req) => {
    const b = z.object({ scheduleAt: z.iso.datetime({ offset: true }).optional() }).strict().parse(req.body ?? {});
    return E.launch(req.auth!.tenantId!, req.auth!.userId, idParam.parse(req.params).id, { scheduleAt: b.scheduleAt ? new Date(b.scheduleAt) : null });
  });
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/campaigns/:id/${action}`, { preHandler: manage }, async (req) => E.control(req.auth!.tenantId!, req.auth!.userId, idParam.parse(req.params).id, action));
  }

  app.get('/campaigns/:id/analytics', { preHandler: read }, async (req) => E.analytics(req.auth!.tenantId!, idParam.parse(req.params).id));
  app.get('/campaigns/:id/events', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { items: (await app.tenantTx(req, async (c) => { await E.load(c, id); return c.query(`SELECT e.id, e.kind, e.detail, e.created_at AS "createdAt", u.full_name AS "actorName" FROM campaign_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.campaign_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 200`, [id]); })).rows };
  });
  app.get('/campaigns/:id/recipients', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ status: z.enum(['queued', 'sending', 'sent', 'retrying', 'failed', 'skipped', 'cancelled', 'excluded']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return app.tenantTx(req, async (c) => {
      await E.load(c, id);
      const where = `r.campaign_id = $1 AND ($2::text IS NULL OR r.status = $2)`;
      const total = (await c.query(`SELECT count(*)::int AS n FROM campaign_recipients r WHERE ${where}`, [id, q.status ?? null])).rows[0].n;
      const items = (await c.query(
        `SELECT r.id, r.contact_id AS "customerId", ct.name, ct.phone, r.status, r.reason, r.detail, r.sent_at AS "sentAt", m.status AS "messageStatus", m.attempts
           FROM campaign_recipients r JOIN contacts ct ON ct.id = r.contact_id LEFT JOIN messages m ON m.id = r.message_id WHERE ${where} ORDER BY r.created_at, r.id LIMIT $3 OFFSET $4`, [id, q.status ?? null, q.limit, q.offset])).rows;
      return { items, total };
    });
  });

  // ───────────── templates ─────────────
  app.get('/campaign-templates', { preHandler: read }, async (req) => ({ items: (await app.tenantTx(req, (c) => c.query(`SELECT id, name, body, created_at AS "createdAt" FROM campaign_templates ORDER BY name`))).rows }));
  app.post('/campaign-templates', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(1500) }).strict().parse(req.body);
    const row = await app.tenantTx(req, async (c) => {
      try { return (await c.query(`INSERT INTO campaign_templates (tenant_id, name, body, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, body, created_at AS "createdAt"`, [req.auth!.tenantId, b.name, b.body, req.auth!.userId])).rows[0]; }
      catch (e) { if ((e as { code?: string }).code === '23505') throw new AppError(409, 'template_exists', 'A template with this name already exists.'); throw e; }
    });
    return reply.code(201).send(row);
  });
  app.delete('/campaign-templates/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await app.tenantTx(req, async (c) => (await c.query(`DELETE FROM campaign_templates WHERE id = $1`, [id])).rowCount);
    if (!n) throw notFound('Template not found');
    return reply.code(204).send();
  });
}
