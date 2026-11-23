import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../agent/employee.js';
import { PLATFORM_LABEL } from '../../channels/manager.js';
import { CHANNEL_TYPES, ChannelError, type AttachmentMeta, type ChannelType } from '../../channels/types.js';
import type { Client } from '../../db/pool.js';
import { AppError, notFound } from '../../shared/errors.js';

const platformEnum = z.enum(CHANNEL_TYPES);
const idParam = z.object({ id: z.uuid() });

const CONV_COLS = `cv.id, cv.platform, cv.channel_id AS "channelId", ch.name AS "channelName", ch.status AS "channelStatus",
  cv.status, cv.handler, cv.assigned_user_id AS "assignedUserId", au.full_name AS "assignedUserName",
  ch.employee_id AS "employeeId", e.name AS "employeeName", e.status AS "employeeStatus", ch.auto_reply AS "autoReply",
  cv.unread_count AS "unreadCount", cv.last_message_at AS "lastMessageAt", cv.last_message_preview AS "lastMessagePreview", cv.last_inbound_at AS "lastInboundAt",
  cv.handoff_reason AS "handoffReason", cv.handoff_at AS "handoffAt", cv.created_at AS "createdAt",
  ct.id AS "contactId", ct.name AS "contactName", ct.phone AS "contactPhone", ct.external_id AS "contactExternalId", ct.first_seen_at AS "contactFirstSeenAt"`;
const CONV_FROM = `FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id JOIN contacts ct ON ct.id = cv.contact_id
  LEFT JOIN users au ON au.id = cv.assigned_user_id LEFT JOIN ai_employees e ON e.id = ch.employee_id`;

function shape(r: Record<string, any>) {
  const { contactId, contactName, contactPhone, contactExternalId, contactFirstSeenAt, assignedUserId, assignedUserName, ...rest } = r;
  return {
    ...rest,
    contact: { id: contactId, name: contactName, phone: contactPhone, externalId: r.platform === 'website' ? undefined : contactExternalId, firstSeenAt: contactFirstSeenAt },
    assignedTo: assignedUserId ? { id: assignedUserId, name: assignedUserName } : null,
    /** Why the AI is (not) answering: shown in the UI so nobody wonders why a chat is silent. */
    aiState: r.handler === 'human' ? 'human_has_it' : !r.employeeId ? 'no_employee' : r.employeeStatus !== 'active' ? 'employee_not_live' : !r.autoReply ? 'auto_reply_off' : ['connected', 'awaiting_approval'].includes(r.channelStatus) ? 'ai_answering' : 'channel_not_connected',
  };
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 } });
  const m = app.channels;
  const read = [app.authenticate, app.requirePermission('conversations:read')];
  const reply = [app.authenticate, app.requirePermission('conversations:reply')];
  const manage = [app.authenticate, app.requirePermission('conversations:manage')];
  const forward = [app.authenticate, app.requirePermission('conversations:forward')];

  const loadConv = async (c: Client, id: string) => {
    const { rows } = await c.query(`SELECT ${CONV_COLS} ${CONV_FROM} WHERE cv.id = $1`, [id]);
    if (!rows[0]) throw notFound('Conversation not found');
    return rows[0] as Record<string, any>;
  };

  // ───────────── lists: ONE PLATFORM AT A TIME ─────────────
  /** Unread counters per platform (sidebar badges). */
  app.get('/conversations/summary', { preHandler: read }, async (req) => {
    const { rows } = await app.tenantTx(req, (c) =>
      c.query(`SELECT platform, count(*)::int AS total, count(*) FILTER (WHERE unread_count > 0)::int AS "unreadConversations", COALESCE(sum(unread_count), 0)::int AS unread,
                      count(*) FILTER (WHERE handler = 'human' AND status = 'pending')::int AS "needsHuman" FROM conversations GROUP BY platform`),
    );
    return { platforms: Object.fromEntries(CHANNEL_TYPES.map((t) => [t, rows.find((r) => r.platform === t) ?? { platform: t, total: 0, unreadConversations: 0, unread: 0, needsHuman: 0 }])) };
  });

  app.get('/conversations', { preHandler: read }, async (req) => {
    const q = z
      .object({
        platform: platformEnum, // REQUIRED: there is no endpoint that mixes platforms
        channelId: z.uuid().optional(),
        status: z.enum(['open', 'pending', 'resolved']).optional(),
        handler: z.enum(['ai', 'human']).optional(),
        assigned: z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]).optional(),
        unread: z.enum(['1', 'true']).optional(),
        search: z.string().trim().max(80).optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const a = req.auth!;
    const assignedUser = q.assigned === 'me' ? a.userId : q.assigned && q.assigned !== 'unassigned' ? q.assigned : null;
    const { rows, counts } = await app.tenantTx(req, async (c) => {
      const rows = (
        await c.query(
          `SELECT ${CONV_COLS} ${CONV_FROM}
           WHERE cv.platform = $1 AND ($2::uuid IS NULL OR cv.channel_id = $2) AND ($3::text IS NULL OR cv.status = $3) AND ($4::text IS NULL OR cv.handler = $4)
             AND ($5::uuid IS NULL OR cv.assigned_user_id = $5) AND ($6::boolean IS NOT TRUE OR cv.assigned_user_id IS NULL)
             AND ($7::boolean IS NOT TRUE OR cv.unread_count > 0) AND ($8::timestamptz IS NULL OR cv.last_message_at < $8)
             AND ($9::text IS NULL OR ct.name ILIKE '%' || $9 || '%' OR ct.phone ILIKE '%' || $9 || '%' OR cv.last_message_preview ILIKE '%' || $9 || '%'
                  OR EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = cv.id AND mm.body ILIKE '%' || $9 || '%'))
           ORDER BY cv.last_message_at DESC, cv.id LIMIT $10`,
          [q.platform, q.channelId ?? null, q.status ?? null, q.handler ?? null, assignedUser, q.assigned === 'unassigned', !!q.unread, q.before ?? null, q.search ?? null, q.limit],
        )
      ).rows;
      const counts = (
        await c.query(
          `SELECT count(*)::int AS "all", count(*) FILTER (WHERE unread_count > 0)::int AS unread, count(*) FILTER (WHERE assigned_user_id IS NULL AND status <> 'resolved')::int AS unassigned,
                  count(*) FILTER (WHERE assigned_user_id = $2)::int AS mine, count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'open')::int AS open,
                  count(*) FILTER (WHERE status = 'resolved')::int AS resolved, count(*) FILTER (WHERE handler = 'human')::int AS human
           FROM conversations WHERE platform = $1`,
          [q.platform, a.userId],
        )
      ).rows[0];
      return { rows, counts };
    });
    return { platform: q.platform, items: rows.map(shape), counts, next: rows.length === q.limit ? rows[rows.length - 1]!.lastMessageAt : null };
  });

  app.get('/conversations/:id', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    return app.tenantTx(req, async (c) => {
      const cv = await loadConv(c, id);
      const stats = (await c.query(`SELECT count(*)::int AS messages, count(*) FILTER (WHERE direction = 'in')::int AS inbound FROM messages WHERE conversation_id = $1`, [id])).rows[0];
      const connector = m.registry.forType(cv.platform as ChannelType);
      return { ...shape(cv), stats, capabilities: connector.capabilities, platformLabel: PLATFORM_LABEL[cv.platform as ChannelType] };
    });
  });

  app.get('/conversations/:id/messages', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    return app.tenantTx(req, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM (
           SELECT mm.id, mm.direction, mm.sender_type AS "senderType", u.full_name AS "senderName", mm.body, mm.attachments, mm.status, mm.error, mm.error_code AS "errorCode", mm.attempts,
                  mm.meta, mm.created_at AS "createdAt", mm.sent_at AS "sentAt",
                  (SELECT count(*)::int FROM message_forwards f WHERE f.source_message_id = mm.id) AS "forwardCount"
           FROM messages mm LEFT JOIN users u ON u.id = mm.sender_user_id
           WHERE mm.conversation_id = $1 AND ($2::uuid IS NULL OR (mm.created_at, mm.id) < (SELECT created_at, id FROM messages WHERE id = $2 AND conversation_id = $1))
           ORDER BY mm.created_at DESC, mm.id DESC LIMIT $3) t ORDER BY "createdAt", id`,
        [id, q.before ?? null, q.limit],
      );
      const exists = rows.length || (await c.query('SELECT 1 FROM conversations WHERE id = $1', [id])).rows[0];
      if (!exists) throw notFound('Conversation not found');
      return { items: rows, hasMore: rows.length === q.limit };
    });
  });

  app.post('/conversations/:id/read', { preHandler: read }, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.tenantTx(req, async (c) => {
      const r = await c.query('UPDATE conversations SET unread_count = 0 WHERE id = $1 RETURNING id', [id]);
      if (!r.rows[0]) throw notFound('Conversation not found');
    });
    return { ok: true };
  });

  // ───────────── replying ─────────────
  app.post('/conversations/:id/messages', { preHandler: reply }, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ text: z.string().max(8000).default(''), attachmentIds: z.array(z.uuid()).max(5).optional() }).parse(req.body);
    const a = req.auth!;
    try {
      const r = await m.sendMessage(a.tenantId!, { conversationId: id, text: b.text, fileIds: b.attachmentIds, senderType: 'human', userId: a.userId });
      return res.status(r.status === 'failed' ? 202 : 201).send(r);
    } catch (e) {
      if (e instanceof ChannelError) throw new AppError(e.status, e.code, e.message);
      throw e;
    }
  });

  /** Upload a file to attach to the next reply (kept per conversation, max 5 MB). */
  app.post('/conversations/:id/attachments', { preHandler: reply }, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const file = await req.file();
    if (!file) throw new AppError(400, 'file_required', 'Attach a file');
    const data = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'file_too_large', 'The file is larger than 5 MB');
    if (data.length === 0) throw new AppError(400, 'empty_file', 'The file is empty');
    const name = file.filename.replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'file';
    const saved = await app.tenantTx(req, async (c) => {
      const cv = await c.query('SELECT cv.channel_id FROM conversations cv WHERE cv.id = $1', [id]);
      if (!cv.rows[0]) throw notFound('Conversation not found');
      const r = await c.query(`INSERT INTO message_files (tenant_id, channel_id, conversation_id, name, mime, size, data, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, mime, size`, [req.auth!.tenantId, cv.rows[0].channel_id, id, name, file.mimetype || 'application/octet-stream', data.length, data, req.auth!.userId]);
      return r.rows[0];
    });
    return res.status(201).send(saved);
  });

  const sendFile = (res: import('fastify').FastifyReply, f: { name: string; mime: string; data: Buffer }) =>
    res.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store').send(f.data);

  /** Download an attachment of a message (ours from the database; the customer's fetched from the provider on demand). */
  app.get('/messages/:id/attachments/:index', { preHandler: read }, async (req, res) => {
    const { id, index } = z.object({ id: z.uuid(), index: z.coerce.number().int().min(0).max(20) }).parse(req.params);
    const tenantId = req.auth!.tenantId!;
    const row = await app.tenantTx(req, async (c) => {
      const mm = (await c.query('SELECT channel_id, attachments FROM messages WHERE id = $1', [id])).rows[0];
      if (!mm) throw notFound('Message not found');
      const att = (mm.attachments as AttachmentMeta[])[index];
      if (!att) throw notFound('Attachment not found');
      if (att.fileId) {
        const f = (await c.query('SELECT name, mime, data FROM message_files WHERE id = $1', [att.fileId])).rows[0];
        if (!f) throw notFound('File not found');
        return { kind: 'local' as const, f };
      }
      return { kind: 'remote' as const, att, ch: await m.load(c, mm.channel_id) };
    });
    if (row.kind === 'local') return sendFile(res, row.f);
    const connector = m.connectorOf(row.ch);
    if (!connector.download) throw new AppError(501, 'download_not_supported', 'This channel does not support downloading attachments yet');
    try {
      const f = await connector.download(m.context(row.ch), row.att);
      return sendFile(res, { name: f.name, mime: f.mime, data: f.data });
    } catch (e) {
      if (e instanceof ChannelError) throw new AppError(e.status, e.code, e.message);
      throw e;
    } finally {
      void tenantId;
    }
  });

  app.post('/messages/:id/retry', { preHandler: reply }, async (req) => {
    const { id } = idParam.parse(req.params);
    const a = req.auth!;
    const ok = await app.tenantTx(req, async (c) => (await c.query(`UPDATE messages SET status = 'queued', error = NULL, error_code = NULL, attempts = 0 WHERE id = $1 AND direction = 'out' AND status = 'failed' RETURNING id`, [id])).rows[0]);
    if (!ok) throw new AppError(409, 'not_retryable', 'Only failed messages can be retried');
    return m.deliver(a.tenantId!, id);
  });

  // ───────────── assignment, status, hand-off ─────────────
  app.patch('/conversations/:id', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ status: z.enum(['open', 'pending', 'resolved']).optional(), assignedUserId: z.uuid().nullable().optional() }).strict().parse(req.body);
    const a = req.auth!;
    return app.tenantTx(req, async (c) => {
      const cur = await loadConv(c, id);
      if (b.assignedUserId) {
        const u = await c.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [b.assignedUserId]);
        if (!u.rows[0]) throw new AppError(400, 'user_not_found', 'That team member does not exist or is disabled');
      }
      await c.query(`UPDATE conversations SET status = COALESCE($2, status), assigned_user_id = CASE WHEN $3 THEN $4::uuid ELSE assigned_user_id END WHERE id = $1`, [id, b.status ?? null, 'assignedUserId' in b, b.assignedUserId ?? null]);
      if (b.status && b.status !== cur.status) await audit(c, a.tenantId!, a.userId, 'conversation.status', 'conversation', id, { from: cur.status, to: b.status });
      if ('assignedUserId' in b) await audit(c, a.tenantId!, a.userId, 'conversation.assigned', 'conversation', id, { to: b.assignedUserId ?? null });
      return shape(await loadConv(c, id));
    });
  });

  /** A person takes the conversation: the AI stops answering it. */
  app.post('/conversations/:id/takeover', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const a = req.auth!;
    return app.tenantTx(req, async (c) => {
      await loadConv(c, id);
      await c.query(`UPDATE conversations SET handler = 'human', assigned_user_id = $2, status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END, handoff_reason = COALESCE(handoff_reason, 'A team member took over'), handoff_at = COALESCE(handoff_at, now()) WHERE id = $1`, [id, a.userId]);
      await c.query(`UPDATE messages SET ai_state = 'skipped' WHERE conversation_id = $1 AND ai_state = 'pending'`, [id]);
      await audit(c, a.tenantId!, a.userId, 'conversation.takeover', 'conversation', id, { via: 'button' });
      return shape(await loadConv(c, id));
    });
  });

  /** Hand the conversation back to the AI employee. */
  app.post('/conversations/:id/release', { preHandler: manage }, async (req) => {
    const { id } = idParam.parse(req.params);
    const a = req.auth!;
    return app.tenantTx(req, async (c) => {
      await loadConv(c, id);
      await c.query(`UPDATE conversations SET handler = 'ai', assigned_user_id = NULL, status = 'open', handoff_reason = NULL, handoff_at = NULL WHERE id = $1`, [id]);
      await audit(c, a.tenantId!, a.userId, 'conversation.released_to_ai', 'conversation', id);
      return shape(await loadConv(c, id));
    });
  });

  // ───────────── forwarding to another connected channel ─────────────
  const forwardBody = z.object({ targetChannelId: z.uuid(), recipientContactId: z.uuid(), comment: z.string().trim().max(500).optional() });

  async function composeForward(c: Client, messageId: string, b: z.infer<typeof forwardBody>) {
    const src = (
      await c.query(
        `SELECT mm.id, mm.body, mm.attachments, mm.created_at AS "createdAt", mm.channel_id AS "channelId", ch.type, ch.name AS "channelName", ct.name AS "contactName", ct.phone AS "contactPhone"
         FROM messages mm JOIN channels ch ON ch.id = mm.channel_id JOIN conversations cv ON cv.id = mm.conversation_id JOIN contacts ct ON ct.id = cv.contact_id WHERE mm.id = $1`,
        [messageId],
      )
    ).rows[0];
    if (!src) throw notFound('Message not found');
    if (src.channelId === b.targetChannelId) throw new AppError(400, 'same_channel', 'Choose a different channel. Forwarding is for sending a message to ANOTHER channel.');
    const target = (await c.query(`SELECT id, type, provider, name, status FROM channels WHERE id = $1`, [b.targetChannelId])).rows[0];
    if (!target) throw new AppError(400, 'target_not_found', 'That channel does not exist');
    const recipient = (
      await c.query(`SELECT ct.id, ct.name, ct.phone, cv.id AS "conversationId", cv.last_inbound_at AS "lastInboundAt" FROM contacts ct JOIN conversations cv ON cv.contact_id = ct.id WHERE ct.id = $1 AND ct.channel_id = $2`, [b.recipientContactId, b.targetChannelId])
    ).rows[0];
    if (!recipient) throw new AppError(400, 'recipient_not_found', 'That recipient has not written to the chosen channel');
    const connector = m.registry.get(target.type, target.provider);
    const warnings: string[] = [];
    if (!['connected', 'awaiting_approval'].includes(target.status)) warnings.push(`The ${PLATFORM_LABEL[target.type as ChannelType]} channel is ${target.status}: sending will fail until it is connected.`);
    if (connector.capabilities.replyWindowHours && (!recipient.lastInboundAt || Date.now() - new Date(recipient.lastInboundAt).getTime() > connector.capabilities.replyWindowHours * 3600_000)) warnings.push(`${PLATFORM_LABEL[target.type as ChannelType]} only allows messages within ${connector.capabilities.replyWindowHours} hours of the recipient’s last message. This one may be refused.`);
    if ((src.attachments as unknown[]).length) warnings.push('Attachments are not forwarded; only the text is.');
    if (!src.body.trim()) throw new AppError(400, 'nothing_to_forward', 'This message has no text to forward');
    const when = new Date(src.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const who = src.contactName ?? src.contactPhone ?? 'a customer';
    // No platform forwards natively to another platform, so this is always a NEW message that says where it came from.
    const text = `${b.comment ? `${b.comment}\n\n` : ''}↪ Forwarded from ${PLATFORM_LABEL[src.type as ChannelType]} · ${who} · ${when} UTC\n“${src.body.trim()}”`;
    if (text.length > connector.capabilities.maxTextLength) throw new AppError(400, 'message_too_long', `With the comment, this message is longer than ${PLATFORM_LABEL[target.type as ChannelType]} accepts (${connector.capabilities.maxTextLength} characters).`);
    return { src, target, recipient, text, warnings, mode: 'new_message' as const };
  }

  app.post('/messages/:id/forward/preview', { preHandler: forward }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = forwardBody.parse(req.body);
    const r = await app.tenantTx(req, (c) => composeForward(c, id, b));
    return { mode: r.mode, text: r.text, warnings: r.warnings, source: { platform: r.src.type, channelName: r.src.channelName }, target: { platform: r.target.type, channelName: r.target.name, status: r.target.status }, recipient: { id: r.recipient.id, name: r.recipient.name, phone: r.recipient.phone }, note: 'No platform forwards natively to another platform, so a new message is sent that states where it came from.' };
  });

  app.post('/messages/:id/forward', { preHandler: forward }, async (req, res) => {
    const { id } = idParam.parse(req.params);
    const b = forwardBody.parse(req.body);
    const a = req.auth!;
    const plan = await app.tenantTx(req, (c) => composeForward(c, id, b));
    const fwdId = await app.tenantTx(req, async (c) => {
      const r = await c.query(
        `INSERT INTO message_forwards (tenant_id, source_message_id, source_channel_id, target_channel_id, target_contact_id, comment, sent_text, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8) RETURNING id`,
        [a.tenantId, id, plan.src.channelId, b.targetChannelId, b.recipientContactId, b.comment ?? null, plan.text, a.userId],
      );
      await audit(c, a.tenantId!, a.userId, 'message.forwarded', 'message', id, { from: plan.src.type, to: plan.target.type, targetChannelId: b.targetChannelId, recipientContactId: b.recipientContactId });
      return r.rows[0].id as string;
    });
    let result: { id: string; status: string; error?: string | null };
    try {
      result = await m.sendMessage(a.tenantId!, { conversationId: plan.recipient.conversationId, text: plan.text, senderType: 'human', userId: a.userId, takeover: false, meta: { forward: { fromMessageId: id, fromPlatform: plan.src.type, fromChannelId: plan.src.channelId, forwardId: fwdId } } });
    } catch (e) {
      result = { id: '', status: 'failed', error: (e as Error).message };
    }
    const status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'queued';
    await app.tenantTx(req, (c) => c.query('UPDATE message_forwards SET status = $2, result_message_id = $3, error = $4 WHERE id = $1', [fwdId, status, result.id || null, result.error ?? null]));
    return res.status(status === 'failed' ? 502 : 201).send({ id: fwdId, status, resultMessageId: result.id || null, error: result.error ?? null, text: plan.text });
  });

  /** What happened to forwards of a message (the recorded result). */
  app.get('/messages/:id/forwards', { preHandler: forward }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.tenantTx(req, async (c) => {
      if (!(await c.query('SELECT 1 FROM messages WHERE id = $1', [id])).rows[0]) throw notFound('Message not found');
      return c.query(
        `SELECT f.id, f.status, f.comment, f.error, f.created_at AS "createdAt", tc.name AS "targetChannelName", tc.type AS "targetPlatform", ct.name AS "recipientName",
                rm.status AS "deliveryStatus", u.full_name AS "createdByName"
         FROM message_forwards f JOIN channels tc ON tc.id = f.target_channel_id JOIN contacts ct ON ct.id = f.target_contact_id LEFT JOIN messages rm ON rm.id = f.result_message_id LEFT JOIN users u ON u.id = f.created_by
         WHERE f.source_message_id = $1 ORDER BY f.created_at DESC`,
        [id],
      );
    });
    return { items: rows };
  });
}
