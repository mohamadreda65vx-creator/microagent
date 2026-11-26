import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../agent/employee.js';
import { CHANNEL_TYPES } from '../../channels/types.js';
import type { Client } from '../../db/pool.js';
import { AppError, notFound } from '../../shared/errors.js';
import { CUSTOMER_STATUSES } from '../../campaigns/audience.js';

const idParam = z.object({ id: z.uuid() });
const tag = z.string().trim().min(1).max(40).transform((t) => t.toLowerCase());
const tagList = z.array(tag).max(30).transform((a) => [...new Set(a)].sort());

const COLS = `ct.id, ch.type AS platform, ch.id AS "channelId", ch.name AS "channelName", ct.external_id AS "platformUserId", ct.name, ct.phone, ct.email, ct.status,
  ct.consent_status AS "consentStatus", ct.consent_source AS "consentSource", ct.consent_at AS "consentAt", ct.notes, ct.tags, ct.interests,
  ct.first_seen_at AS "firstInteractionAt", COALESCE(ct.last_inbound_at, ct.last_seen_at) AS "lastInteractionAt", ct.unreachable_at AS "unreachableAt", ct.unreachable_reason AS "unreachableReason",
  cv.id AS "conversationId", cv.last_message_preview AS "lastMessage", cv.last_message_at AS "lastMessageAt", (ct.meta ->> 'phoneSource') AS "phoneSource"`;
const FROM = `FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id LEFT JOIN conversations cv ON cv.contact_id = ct.id`;

const shape = (r: Record<string, any>) => {
  const { phoneSource, ...x } = r;
  return { ...x, platformUserId: r.platform === 'website' ? null : r.platformUserId, phoneEditable: !r.phone || phoneSource === 'manual' };
};
const esc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  const read = [app.authenticate, app.requirePermission('customers:read')];
  const manage = [app.authenticate, app.requirePermission('customers:manage')];

  const load = async (c: Client, id: string) => {
    const { rows } = await c.query(`SELECT ${COLS} ${FROM} WHERE ct.id = $1`, [id]);
    if (!rows[0]) throw notFound('Customer not found');
    return rows[0] as Record<string, any>;
  };
  const event = (c: Client, tenantId: string, ct: { id: string; channelId: string }, kind: string, detail: object, actor: string | null) =>
    c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6)`, [tenantId, ct.channelId, ct.id, kind, JSON.stringify(detail), actor]);

  app.get('/customers/summary', { preHandler: read }, async (req) => {
    const r = await app.tenantTx(req, async (c) => ({
      platforms: (await c.query(`SELECT ch.type AS platform, count(*)::int AS total, count(*) FILTER (WHERE ct.consent_status = 'opted_out')::int AS "optedOut",
          count(*) FILTER (WHERE ct.consent_status = 'opted_in')::int AS "optedIn", count(*) FILTER (WHERE ct.status = 'customer')::int AS customers, count(*) FILTER (WHERE ct.status = 'lead')::int AS leads
        FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id GROUP BY ch.type`)).rows,
    }));
    return { platforms: Object.fromEntries(CHANNEL_TYPES.map((t) => [t, r.platforms.find((x) => x.platform === t) ?? { platform: t, total: 0, optedOut: 0, optedIn: 0, customers: 0, leads: 0 }])) };
  });

  app.get('/customers/tags', { preHandler: read }, async (req) => ({
    items: (await app.tenantTx(req, (c) => c.query(`SELECT t AS tag, count(*)::int AS count FROM contacts, unnest(tags) t GROUP BY t ORDER BY count DESC, t LIMIT 200`))).rows,
  }));

  app.get('/customers', { preHandler: read }, async (req) => {
    const q = z.object({
      platform: z.enum(CHANNEL_TYPES).optional(), channelId: z.uuid().optional(), search: z.string().trim().max(100).optional(), tag: tag.optional(),
      status: z.enum(CUSTOMER_STATUSES).optional(), consent: z.enum(['unknown', 'opted_in', 'opted_out']).optional(),
      inactiveDays: z.coerce.number().int().min(1).max(3650).optional(), activeDays: z.coerce.number().int().min(1).max(3650).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(req.query);
    const w: string[] = [], p: unknown[] = [];
    const add = (sql: string, v?: unknown) => { if (v !== undefined) p.push(v); w.push(sql.replace('?', `$${p.length}`)); };
    if (q.platform) add('ch.type = ?', q.platform);
    if (q.channelId) add('ct.channel_id = ?', q.channelId);
    if (q.search) add(`(ct.name ILIKE ? ESCAPE '\\' OR ct.phone ILIKE ? ESCAPE '\\' OR ct.email ILIKE ? ESCAPE '\\')`.replaceAll('?', '$' + (p.length + 1)), `%${esc(q.search)}%`);
    if (q.tag) add('? = ANY(ct.tags)', q.tag);
    if (q.status) add('ct.status = ?', q.status);
    if (q.consent) add('ct.consent_status = ?', q.consent);
    if (q.inactiveDays) add(`COALESCE(ct.last_inbound_at, ct.last_seen_at) < now() - make_interval(days => ?::int)`, q.inactiveDays);
    if (q.activeDays) add(`COALESCE(ct.last_inbound_at, ct.last_seen_at) >= now() - make_interval(days => ?::int)`, q.activeDays);
    const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
    const r = await app.tenantTx(req, async (c) => ({
      total: (await c.query(`SELECT count(*)::int AS n ${FROM} ${where}`, p)).rows[0].n as number,
      rows: (await c.query(`SELECT ${COLS} ${FROM} ${where} ORDER BY COALESCE(ct.last_inbound_at, ct.last_seen_at) DESC, ct.id LIMIT ${q.limit} OFFSET ${q.offset}`, p)).rows,
    }));
    return { items: r.rows.map(shape), total: r.total, next: q.offset + q.limit < r.total ? q.offset + q.limit : null };
  });

  app.get('/customers/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    return app.tenantTx(req, async (c) => {
      const ct = await load(c, id);
      const events = (await c.query(`SELECT e.id, e.kind, e.detail, e.created_at AS "createdAt", u.full_name AS "actorName" FROM customer_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.contact_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 40`, [id])).rows;
      const stats = (await c.query(`SELECT count(*)::int AS messages, count(*) FILTER (WHERE m.direction = 'in')::int AS inbound, count(*) FILTER (WHERE m.direction = 'out')::int AS outbound
        FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.contact_id = $1`, [id])).rows[0];
      const campaigns = (await c.query(`SELECT cp.id, cp.name, r.status, r.reason, r.sent_at AS "sentAt" FROM campaign_recipients r JOIN campaigns cp ON cp.id = r.campaign_id WHERE r.contact_id = $1 AND r.status <> 'excluded' ORDER BY r.created_at DESC LIMIT 20`, [id])).rows;
      return { ...shape(ct), stats, events, campaigns };
    });
  });

  app.patch('/customers/:id', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({
      name: z.string().trim().max(200).nullable().optional(), email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
      phone: z.string().trim().regex(/^\+?[0-9 ()-]{5,30}$/, 'Enter a valid phone number').nullable().optional(),
      status: z.enum(CUSTOMER_STATUSES).optional(), notes: z.string().max(4000).nullable().optional(), tags: tagList.optional(), interests: tagList.optional(),
    }).strict().parse(req.body);
    const box: { v: { platform: string; conversationId: string | null; contactId: string; channelId: string; from: string; to: string } | null } = { v: null };
    const result = await app.tenantTx(req, async (c) => {
      const ct = await load(c, id);
      const sets: string[] = [], p: unknown[] = [id];
      const set = (col: string, v: unknown) => { p.push(v); sets.push(`${col} = $${p.length}`); };
      const changed: string[] = [];
      if (b.name !== undefined && (b.name || null) !== ct.name) { set('name', b.name || null); changed.push('name'); }
      if (b.email !== undefined && (b.email || null) !== ct.email) { set('email', b.email || null); changed.push('email'); }
      if (b.phone !== undefined && (b.phone || null) !== ct.phone) {
        if (!(!ct.phone || ct.phoneSource === 'manual')) throw new AppError(409, 'phone_from_platform', 'This phone number came from the platform and cannot be edited.');
        set('phone', b.phone || null); sets.push(`meta = meta || '{"phoneSource": "manual"}'::jsonb`); changed.push('phone');
      }
      if (b.notes !== undefined && (b.notes || null) !== ct.notes) { set('notes', b.notes || null); changed.push('notes'); }
      if (b.interests !== undefined) { set('interests', b.interests); changed.push('interests'); }
      if (b.status && b.status !== ct.status) set('status', b.status);
      if (b.tags) set('tags', b.tags);
      if (!sets.length) return shape(ct);
      try { await c.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1`, p); }
      catch (e) { if ((e as { code?: string }).code === '23514') throw new AppError(400, 'too_many_tags', 'A customer can have at most 30 tags or interests.'); throw e; }
      const who = req.auth!.userId;
      if (b.status && b.status !== ct.status) {
        await event(c, req.auth!.tenantId!, ct as any, 'status_changed', { from: ct.status, to: b.status }, who);
        const cv = (await c.query(`SELECT id, platform FROM conversations WHERE contact_id = $1`, [id])).rows[0];
        box.v = { platform: cv?.platform ?? (ct as any).platform, conversationId: cv?.id ?? null, contactId: id, channelId: (ct as any).channelId, from: ct.status, to: b.status };
      }
      if (b.tags) {
        for (const t of b.tags.filter((x) => !ct.tags.includes(x))) await event(c, req.auth!.tenantId!, ct as any, 'tag_added', { tag: t }, who);
        for (const t of (ct.tags as string[]).filter((x) => !b.tags!.includes(x))) await event(c, req.auth!.tenantId!, ct as any, 'tag_removed', { tag: t }, who);
      }
      if (changed.length) await event(c, req.auth!.tenantId!, ct as any, 'details_updated', { fields: changed }, who);
      return shape(await load(c, id));
    });
    const ev = box.v;
    if (ev) app.workflows.fire(req.auth!.tenantId!, 'customer_status_changed', { platform: ev.platform, conversationId: ev.conversationId, contactId: ev.contactId, channelId: ev.channelId, fromStatus: ev.from, toStatus: ev.to, dedupe: `status:${ev.contactId}:${ev.to}:${Date.now()}` });
    return result;
  });

  app.post('/customers/:id/consent', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ status: z.enum(['unknown', 'opted_in', 'opted_out']), source: z.enum(['form', 'verbal', 'customer_message', 'manual']), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
    return app.tenantTx(req, async (c) => {
      const ct = await load(c, id);
      if (ct.consentStatus === b.status) return shape(ct);
      if (ct.consentStatus === 'opted_out' && b.status === 'opted_in' && (b.note?.length ?? 0) < 3) throw new AppError(400, 'note_required', 'This person asked to stop. To record a new opt-in, write where and when they agreed.');
      await c.query(`UPDATE contacts SET consent_status = $2, consent_source = $3, consent_at = now(), consent_by = $4 WHERE id = $1`, [id, b.status, b.source, req.auth!.userId]);
      await event(c, req.auth!.tenantId!, ct as any, 'consent_changed', { from: ct.consentStatus, to: b.status, source: b.source, note: b.note ?? null }, req.auth!.userId);
      await audit(c, req.auth!.tenantId!, req.auth!.userId, 'customer.consent_changed', 'contact', id, { from: ct.consentStatus, to: b.status, source: b.source });
      return shape(await load(c, id));
    });
  });

  app.post('/customers/bulk-tags', { preHandler: manage }, async (req) => {
    const b = z.object({ ids: z.array(z.uuid()).min(1).max(500), add: tagList.default([]), remove: tagList.default([]) }).strict().refine((x) => x.add.length + x.remove.length > 0, 'Choose tags to add or remove').parse(req.body);
    return app.tenantTx(req, async (c) => {
      try {
        const r = await c.query(
          `UPDATE contacts SET tags = COALESCE((SELECT array_agg(DISTINCT t ORDER BY t) FROM unnest(tags || $2::text[]) t WHERE NOT (t = ANY($3::text[]))), '{}') WHERE id = ANY($1::uuid[])`,
          [b.ids, b.add, b.remove],
        );
        await audit(c, req.auth!.tenantId!, req.auth!.userId, 'customers.bulk_tags', 'contact', null, { count: r.rowCount, add: b.add, remove: b.remove });
        return { updated: r.rowCount ?? 0 };
      } catch (e) { if ((e as { code?: string }).code === '23514') throw new AppError(400, 'too_many_tags', 'A customer can have at most 30 tags.'); throw e; }
    });
  });
}
