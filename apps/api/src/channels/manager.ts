import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../agent/employee.js';
import { runTurn } from '../agent/runtime.js';
import type { ChatMessage } from '../ai/types.js';
import { withTenant } from '../db/tx.js';
import type { Client } from '../db/pool.js';
import { AppError, notFound } from '../shared/errors.js';
import { isOptOut } from '../campaigns/audience.js';
import { randomKey } from './crypto.js';
import { ConnectorRegistry } from './registry.js';
import {
  ChannelError,
  type AttachmentMeta,
  type ChannelStatus,
  type ChannelType,
  type Connector,
  type ConnectorContext,
  type InboundMessage,
  type OutboundFile,
  type Provider,
  type WebhookEvent,
  type WebhookRequest,
} from './types.js';

export const PLATFORM_LABEL: Record<ChannelType, string> = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', telegram: 'Telegram', website: 'Website chat', tiktok: 'TikTok' };
/** Errors about ONE recipient say nothing about the health of the channel itself. */
const RECIPIENT_ERRORS = new Set(['recipient_blocked', 'recipient_not_found', 'outside_messaging_window', 'attachments_not_supported', 'invalid_input']);
const MAX_ATTEMPTS = 5;

export interface ChannelRecord {
  id: string;
  tenantId: string;
  type: ChannelType;
  provider: Provider;
  name: string;
  status: ChannelStatus;
  publicKey: string;
  externalAccountId: string | null;
  config: Record<string, unknown>;
  employeeId: string | null;
  autoReply: boolean;
  credentialsEnc: string | null;
}

const CHANNEL_COLS = `id, tenant_id AS "tenantId", type, provider, name, status, public_key AS "publicKey", external_account_id AS "externalAccountId",
  config, employee_id AS "employeeId", auto_reply AS "autoReply", credentials_enc AS "credentialsEnc"`;

const preview = (t: string, atts: AttachmentMeta[] = []) => (t.trim() ? t.trim() : atts.length ? `📎 ${atts[0]!.kind}` : '').replace(/\s+/g, ' ').slice(0, 140);

export interface IngestSummary { processed: number; duplicates: number; ignored: number }

export class ChannelManager {
  readonly registry: ConnectorRegistry;
  /** Seconds to wait before attempt 2, 3, 4, 5. Tests shorten it. */
  retryDelaysSeconds = [30, 120, 600, 1800];
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly app: FastifyInstance) {
    this.registry = new ConnectorRegistry(app.config);
  }

  private tx<T>(tenantId: string, fn: (c: Client) => Promise<T>) {
    return withTenant(this.app.pools.app, tenantId, fn);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /** Wait for background work (AI replies) to finish. Used by tests and by graceful shutdown. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  // ───────────────────────── channels ─────────────────────────

  webhookUrl(ch: Pick<ChannelRecord, 'type' | 'publicKey'>): string {
    const base = `${this.app.config.appUrl}/api/v1/webhooks`;
    return ch.type === 'messenger' || ch.type === 'instagram' ? `${base}/meta` : `${base}/channel/${ch.publicKey}`;
  }

  context(ch: ChannelRecord, creds?: Record<string, string>): ConnectorContext {
    return {
      channel: { id: ch.id, tenantId: ch.tenantId, type: ch.type, provider: ch.provider, name: ch.name, publicKey: ch.publicKey, externalAccountId: ch.externalAccountId, config: ch.config },
      creds: creds ?? this.registry.vault.decrypt(ch.credentialsEnc),
      webhookUrl: this.webhookUrl(ch),
    };
  }

  connectorOf(ch: Pick<ChannelRecord, 'type' | 'provider'>): Connector {
    return this.registry.get(ch.type, ch.provider);
  }

  async load(c: Client, channelId: string): Promise<ChannelRecord> {
    const { rows } = await c.query(`SELECT ${CHANNEL_COLS} FROM channels WHERE id = $1`, [channelId]);
    if (!rows[0]) throw notFound('Channel not found');
    return rows[0] as ChannelRecord;
  }

  async create(tenantId: string, userId: string, input: { type: ChannelType; name: string; employeeId?: string | null; autoReply?: boolean; config?: Record<string, unknown> }) {
    const connector = this.registry.forType(input.type);
    if (!connector.available) throw new AppError(409, 'channel_unavailable', connector.unavailableReason ?? 'This channel is not available yet');
    if (!this.registry.vault.configured) throw new AppError(503, 'vault_not_configured', 'CHANNEL_SECRET_KEY is not configured on the server, so channels cannot be created safely.');
    const notConfigured = (input.type === 'messenger' || input.type === 'instagram') && !this.registry.meta.configured;
    return this.tx(tenantId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO channels (tenant_id, type, provider, name, status, employee_id, auto_reply, public_key, config, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${CHANNEL_COLS}`,
        [tenantId, input.type, connector.provider, input.name, notConfigured ? 'not_configured' : 'pending', input.employeeId ?? null, input.autoReply ?? true, randomKey(18), JSON.stringify(input.config ?? {}), userId],
      );
      const ch = rows[0] as ChannelRecord;
      await audit(c, tenantId, userId, 'channel.created', 'channel', ch.id, { type: ch.type, provider: ch.provider });
      return ch;
    });
  }

  /** Connect with what the user provided (bot token, nothing for WhatsApp/website). Meta channels connect through OAuth + selectPage(). */
  async connect(tenantId: string, userId: string, channelId: string, input: Record<string, string>) {
    const ch = await this.tx(tenantId, (c) => this.load(c, channelId));
    const connector = this.connectorOf(ch);
    if (!connector.available) throw new AppError(409, 'channel_unavailable', connector.unavailableReason ?? 'Not available');
    if (ch.type === 'messenger' || ch.type === 'instagram') throw new AppError(400, 'use_oauth', 'Connect Messenger and Instagram with the “Connect with Facebook” button.');
    const ctx = this.context(ch, {});
    try {
      if (connector.identify) {
        const ident = await connector.identify(input, ctx);
        await this.assertAccountFree(ch.type, ident.externalAccountId, ch.id);
      }
      const res = await connector.connect(input, ctx);
      if (res.externalAccountId) await this.assertAccountFree(ch.type, res.externalAccountId, ch.id).catch(async (e) => {
        await connector.disconnect({ ...ctx, creds: res.creds }).catch(() => undefined);
        throw e;
      });
      await this.persistConnection(tenantId, userId, ch, res, 'channel.connected');
      return res;
    } catch (e) {
      await this.recordError(tenantId, ch.id, e);
      throw this.asApp(e);
    }
  }

  private async assertAccountFree(type: ChannelType, externalId: string, selfId: string) {
    const { rows } = await this.app.pools.app.query('SELECT channel_id FROM channel_resolve_external($1, $2)', [type, externalId]);
    if (rows[0] && rows[0].channel_id !== selfId) throw new AppError(409, 'account_already_connected', 'This account is already connected to a channel. An account can belong to only one company.');
  }

  private async persistConnection(tenantId: string, userId: string | null, ch: ChannelRecord, res: { status: ChannelStatus; creds: Record<string, string>; externalAccountId?: string; config?: Record<string, unknown>; qr?: string }, auditAction: string) {
    const config = { ...ch.config, ...(res.config ?? {}), ...(res.qr ? { lastQr: res.qr, qrAt: new Date().toISOString() } : {}) };
    if (res.status === 'connected') delete (config as Record<string, unknown>).lastQr;
    await this.tx(tenantId, async (c) => {
      await c.query(
        `UPDATE channels SET status = $2, credentials_enc = $3, external_account_id = COALESCE($4, external_account_id), config = $5,
           last_error = NULL, consecutive_failures = 0, health_status = $6 WHERE id = $1`,
        [ch.id, res.status, Object.keys(res.creds).length ? this.registry.vault.encrypt(res.creds) : null, res.externalAccountId ?? null, JSON.stringify(config), res.status === 'connected' ? 'healthy' : 'unknown'],
      );
      await audit(c, tenantId, userId, auditAction, 'channel', ch.id, { type: ch.type, status: res.status });
    });
  }

  async reconnect(tenantId: string, userId: string, channelId: string) {
    const ch = await this.tx(tenantId, (c) => this.load(c, channelId));
    const connector = this.connectorOf(ch);
    if (!connector.reconnect) throw new AppError(400, 'not_supported', 'This channel cannot be reconnected this way');
    try {
      const res = await connector.reconnect(this.context(ch));
      await this.persistConnection(tenantId, userId, ch, res, 'channel.reconnected');
      return res;
    } catch (e) {
      await this.recordError(tenantId, ch.id, e);
      throw this.asApp(e);
    }
  }

  async disconnect(tenantId: string, userId: string, channelId: string) {
    const ch = await this.tx(tenantId, (c) => this.load(c, channelId));
    const connector = this.connectorOf(ch);
    let warning: string | null = null;
    try {
      await connector.disconnect(this.context(ch));
    } catch (e) {
      warning = (e as Error).message; // still disconnect locally: the user wants it gone
    }
    await this.tx(tenantId, async (c) => {
      await c.query(`UPDATE channels SET status = 'disconnected', credentials_enc = NULL, external_account_id = NULL, health_status = 'unknown', config = config - 'lastQr' - 'qrAt' WHERE id = $1`, [ch.id]);
      await audit(c, tenantId, userId, 'channel.disconnected', 'channel', ch.id, { type: ch.type, warning });
    });
    return { warning };
  }

  async remove(tenantId: string, userId: string, channelId: string) {
    const ch = await this.tx(tenantId, (c) => this.load(c, channelId));
    await this.disconnect(tenantId, userId, channelId).catch(() => undefined);
    await this.tx(tenantId, async (c) => {
      await c.query('DELETE FROM channels WHERE id = $1', [ch.id]);
      await audit(c, tenantId, userId, 'channel.deleted', 'channel', ch.id, { type: ch.type, name: ch.name });
    });
  }

  /** Poll the provider (QR flow). Updates the stored status. */
  async refreshStatus(tenantId: string, channelId: string) {
    const ch = await this.tx(tenantId, (c) => this.load(c, channelId));
    const connector = this.connectorOf(ch);
    if (ch.status === 'pending' || ch.status === 'not_configured') return { state: 'disconnected' as const, qr: undefined, detail: 'Not connected yet' };
    try {
      const st = await connector.status(this.context(ch));
      const next: ChannelStatus = st.state === 'connected' ? (ch.status === 'awaiting_approval' ? 'awaiting_approval' : 'connected') : st.state === 'connecting' ? 'connecting' : 'disconnected';
      await this.tx(tenantId, (c) =>
        c.query(`UPDATE channels SET status = $2, config = CASE WHEN $3::text IS NULL THEN config - 'lastQr' ELSE config || jsonb_build_object('lastQr', $3::text, 'qrAt', now()) END WHERE id = $1`, [ch.id, next, st.qr ?? null]),
      );
      return st;
    } catch (e) {
      await this.recordError(tenantId, ch.id, e);
      throw this.asApp(e);
    }
  }

  async checkHealth(tenantId: string, channelId: string) {
    const ch = await this.tx(tenantId, (c) => this.load(c, channelId));
    const connector = this.connectorOf(ch);
    let h;
    try {
      h = await connector.health(this.context(ch));
    } catch (e) {
      h = { status: 'down' as const, detail: (e as Error).message, needsReconnect: false };
    }
    await this.tx(tenantId, async (c) => {
      const nextStatus: ChannelStatus | null = h.needsReconnect && ch.status !== 'pending' ? (ch.type === 'messenger' || ch.type === 'instagram' ? 'error' : 'disconnected') : h.status === 'healthy' && ['disconnected', 'error', 'connecting'].includes(ch.status) && ch.type !== 'whatsapp' ? 'connected' : h.status === 'healthy' && ch.type === 'whatsapp' && ch.status !== 'awaiting_approval' ? 'connected' : null;
      await c.query(
        `UPDATE channels SET health_status = $2, last_health_at = now(), last_error = CASE WHEN $3::text IS NULL THEN last_error ELSE $3 END,
           last_error_at = CASE WHEN $3::text IS NULL THEN last_error_at ELSE now() END, status = COALESCE($4, status) WHERE id = $1`,
        [ch.id, h.status, h.status === 'healthy' ? null : (h.detail ?? 'unhealthy').slice(0, 300), nextStatus],
      );
      await c.query(`DELETE FROM webhook_events WHERE channel_id = $1 AND created_at < now() - interval '14 days'`, [ch.id]);
    });
    return h;
  }

  private async recordError(tenantId: string, channelId: string, e: unknown) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : 'error';
    await this.tx(tenantId, (c) => c.query('UPDATE channels SET last_error = $2, last_error_at = now() WHERE id = $1', [channelId, msg])).catch(() => undefined);
  }

  private asApp(e: unknown): unknown {
    if (e instanceof ChannelError) return new AppError(e.status >= 400 && e.status < 600 ? (e.status === 401 || e.status === 403 ? 502 : e.status) : 502, e.code, e.message);
    return e;
  }

  // ───────────────────────── webhooks (inbound) ─────────────────────────

  /** Resolve the channel for a public key, verify authenticity, and ingest. */
  async handleWebhook(publicKey: string, req: WebhookRequest): Promise<{ status: number; body: unknown }> {
    const { rows } = await this.app.pools.app.query('SELECT * FROM channel_resolve($1)', [publicKey]);
    const r = rows[0];
    if (!r || r.type === 'website' || r.type === 'messenger' || r.type === 'instagram') return { status: 404, body: { error: { code: 'not_found', message: 'Unknown channel' } } };
    if (r.tenant_status !== 'active') return { status: 200, body: { ok: true, ignored: 'tenant_suspended' } };
    const tenantId = r.tenant_id as string;
    const ch = await this.tx(tenantId, (c) => this.load(c, r.channel_id));
    const connector = this.connectorOf(ch);
    let events: WebhookEvent[];
    try {
      events = await connector.parseWebhook(this.context(ch), req);
    } catch (e) {
      const code = e instanceof ChannelError ? e.code : 'parse_error';
      await this.logEvent(tenantId, ch.id, 'webhook', code === 'invalid_signature' ? 'rejected' : 'error', (e as Error).message);
      if (code === 'invalid_signature') return { status: 401, body: { error: { code: 'invalid_signature', message: 'Not authorized' } } };
      return { status: 200, body: { ok: false } }; // a malformed payload must not make the provider retry forever
    }
    const summary = await this.ingest(tenantId, ch, events);
    return { status: 200, body: { ok: true, ...summary } };
  }

  /** Meta delivers every page/account to ONE app-level URL: verify once, then route each entry to its channel. */
  async handleMetaWebhook(req: WebhookRequest): Promise<{ status: number; body: unknown }> {
    const sig = req.headers['x-hub-signature-256'];
    let ok = false;
    try {
      ok = this.registry.meta.verifySignature(req.rawBody, Array.isArray(sig) ? sig[0] : sig);
    } catch {
      return { status: 503, body: { error: { code: 'provider_not_configured', message: 'Meta is not configured' } } };
    }
    if (!ok) return { status: 401, body: { error: { code: 'invalid_signature', message: 'Not authorized' } } };
    const body = req.body as { object?: string; entry?: Array<{ id?: string }> } | undefined;
    const type: ChannelType | null = body?.object === 'page' ? 'messenger' : body?.object === 'instagram' ? 'instagram' : null;
    if (!type) return { status: 200, body: { ok: true, ignored: 'object' } };
    const total: IngestSummary = { processed: 0, duplicates: 0, ignored: 0 };
    for (const entry of body?.entry ?? []) {
      if (!entry.id) continue;
      const { rows } = await this.app.pools.app.query('SELECT * FROM channel_resolve_external($1, $2)', [type, String(entry.id)]);
      const r = rows[0];
      if (!r || r.tenant_status !== 'active') { total.ignored++; continue; }
      const ch = await this.tx(r.tenant_id, (c) => this.load(c, r.channel_id));
      const connector = this.connectorOf(ch);
      const events = await connector.parseWebhook(this.context(ch), { ...req, body: { object: body?.object, entry: [entry] } });
      const s = await this.ingest(r.tenant_id, ch, events);
      total.processed += s.processed; total.duplicates += s.duplicates; total.ignored += s.ignored;
    }
    return { status: 200, body: { ok: true, ...total } };
  }

  private async logEvent(tenantId: string, channelId: string, kind: string, status: 'processed' | 'duplicate' | 'ignored' | 'rejected' | 'error', detail?: string) {
    await this.tx(tenantId, (c) => c.query('INSERT INTO webhook_events (tenant_id, channel_id, kind, status, detail) VALUES ($1, $2, $3, $4, $5)', [tenantId, channelId, kind, status, detail?.slice(0, 300) ?? null])).catch(() => undefined);
  }

  async ingest(tenantId: string, ch: ChannelRecord, events: WebhookEvent[]): Promise<IngestSummary> {
    const sum: IngestSummary = { processed: 0, duplicates: 0, ignored: 0 };
    for (const ev of events) {
      try {
        switch (ev.kind) {
          case 'message': {
            const r = await this.ingestMessage(tenantId, ch, ev.message);
            if (r.duplicate) { sum.duplicates++; await this.logEvent(tenantId, ch.id, 'message', 'duplicate', ev.message.externalId); } else { sum.processed++; await this.logEvent(tenantId, ch.id, 'message', 'processed'); }
            break;
          }
          case 'status':
            await this.tx(tenantId, (c) =>
              c.query(
                `UPDATE messages SET status = $3 WHERE channel_id = $1 AND direction = 'out' AND external_id = $2
                   AND CASE $3 WHEN 'sent' THEN status IN ('sending', 'queued') WHEN 'delivered' THEN status IN ('sending', 'queued', 'sent')
                                WHEN 'read' THEN status IN ('sending', 'queued', 'sent', 'delivered') WHEN 'failed' THEN status IN ('sending', 'sent') ELSE false END`,
                [ch.id, ev.externalId, ev.status],
              ),
            );
            sum.processed++;
            await this.logEvent(tenantId, ch.id, `status:${ev.status}`, 'processed');
            break;
          case 'read_until':
            await this.tx(tenantId, (c) =>
              c.query(
                `UPDATE messages SET status = 'read' WHERE channel_id = $1 AND direction = 'out' AND status IN ('sent', 'delivered') AND created_at <= $3
                   AND conversation_id IN (SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.channel_id = $1 AND ct.external_id = $2)`,
                [ch.id, ev.contactExternalId, ev.at],
              ),
            );
            sum.processed++;
            break;
          case 'connection':
            await this.tx(tenantId, async (c) => {
              const status: ChannelStatus = ev.state === 'connected' ? 'connected' : ev.state === 'connecting' ? 'connecting' : 'disconnected';
              await c.query(
                `UPDATE channels SET status = $2, health_status = $3, last_error = CASE WHEN $2 = 'disconnected' THEN $4 ELSE NULL END,
                   config = CASE WHEN $2 = 'connected' THEN config - 'lastQr' - 'qrAt' ELSE config END WHERE id = $1 AND status <> 'pending'`,
                [ch.id, status, status === 'connected' ? 'healthy' : status === 'disconnected' ? 'down' : 'unknown', ev.detail ?? 'disconnected'],
              );
            });
            sum.processed++;
            await this.logEvent(tenantId, ch.id, `connection:${ev.state}`, 'processed', ev.detail);
            break;
          case 'qr':
            await this.tx(tenantId, (c) => c.query(`UPDATE channels SET config = config || jsonb_build_object('lastQr', $2::text, 'qrAt', now()) WHERE id = $1 AND status IN ('connecting', 'disconnected')`, [ch.id, ev.qr]));
            sum.processed++;
            break;
          case 'ignored':
            sum.ignored++;
            await this.logEvent(tenantId, ch.id, 'event', 'ignored', ev.reason);
            break;
        }
      } catch (e) {
        this.app.log.error({ err: e, channel: ch.id }, 'webhook event failed');
        await this.logEvent(tenantId, ch.id, ev.kind, 'error', (e as Error).message);
      }
    }
    return sum;
  }

  /** Store one inbound message exactly once and schedule the AI reply. */
  async ingestMessage(tenantId: string, ch: ChannelRecord, m: InboundMessage): Promise<{ duplicate: boolean; conversationId?: string; messageId?: string }> {
    const res = await this.tx(tenantId, async (c) => {
      const ct = await c.query(
        `INSERT INTO contacts (tenant_id, channel_id, external_id, name, phone) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, external_id) DO UPDATE SET last_seen_at = now(), name = COALESCE(contacts.name, EXCLUDED.name), phone = COALESCE(contacts.phone, EXCLUDED.phone)
         RETURNING id, name, (xmax = 0) AS created`,
        [tenantId, ch.id, m.contactExternalId, m.contactName ?? null, m.contactPhone ?? null],
      );
      const contact = ct.rows[0];
      await c.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id, employee_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (channel_id, contact_id) DO NOTHING`, [tenantId, ch.id, ch.type, contact.id, ch.employeeId]);
      const cv = (await c.query('SELECT id, handler, status FROM conversations WHERE channel_id = $1 AND contact_id = $2', [ch.id, contact.id])).rows[0];
      const optOut = isOptOut(m.text);
      const aiState = !optOut && cv.handler === 'ai' && ch.employeeId && ch.autoReply ? 'pending' : 'skipped';
      const ins = await c.query(
        `INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, external_id, body, attachments, status, ai_state, meta)
         VALUES ($1, $2, $3, 'in', 'customer', $4, $5, $6, 'received', $7, $8)
         ON CONFLICT (channel_id, direction, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
        [tenantId, ch.id, cv.id, m.externalId, m.text.slice(0, 8000), JSON.stringify(m.attachments), aiState, JSON.stringify({ providerAt: m.at.toISOString(), ...(optOut ? { optOut: true } : {}) })],
      );
      if (!ins.rows[0]) return { duplicate: true as const };
      // Customer facts (only for a NEW message, so a replayed webhook cannot double-log anything).
      const prev = (await c.query(`SELECT consent_status, unreachable_at FROM contacts WHERE id = $1`, [contact.id])).rows[0];
      await c.query(`UPDATE contacts SET last_inbound_at = now(), unreachable_at = NULL, unreachable_reason = NULL WHERE id = $1`, [contact.id]);
      if (contact.created) await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind) VALUES ($1, $2, $3, 'first_contact')`, [tenantId, ch.id, contact.id]);
      if (prev.unreachable_at) await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail) VALUES ($1, $2, $3, 'reachable_again', '{}')`, [tenantId, ch.id, contact.id]);
      if (optOut && prev.consent_status !== 'opted_out') {
        await c.query(`UPDATE contacts SET consent_status = 'opted_out', consent_source = 'customer_message', consent_at = now(), consent_by = NULL WHERE id = $1`, [contact.id]);
        await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail) VALUES ($1, $2, $3, 'consent_changed', $4)`, [tenantId, ch.id, contact.id, JSON.stringify({ from: prev.consent_status, to: 'opted_out', source: 'customer_message' })]);
      }
      await c.query(
        `UPDATE conversations SET last_message_at = now(), last_inbound_at = now(), last_message_preview = $2, unread_count = unread_count + 1,
           status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END WHERE id = $1`,
        [cv.id, preview(m.text, m.attachments)],
      );
      await c.query(
        `UPDATE channels SET last_inbound_at = now(),
           status = CASE WHEN status = 'awaiting_approval' THEN 'connected' ELSE status END,
           config = CASE WHEN status = 'awaiting_approval' THEN config || '{"verified": true}'::jsonb ELSE config END,
           health_status = CASE WHEN status = 'awaiting_approval' THEN 'healthy' ELSE health_status END WHERE id = $1`,
        [ch.id],
      );
      return { duplicate: false as const, conversationId: cv.id as string, messageId: ins.rows[0].id as string, aiPending: aiState === 'pending', needsProfile: contact.created && !contact.name, contactId: contact.id as string };
    });
    if (res.duplicate) return { duplicate: true };
    if (res.needsProfile) void this.track(this.fetchProfile(tenantId, ch, res.contactId, m.contactExternalId));
    if (res.aiPending) this.enqueueAi(tenantId, res.conversationId);
    return { duplicate: false, conversationId: res.conversationId, messageId: res.messageId };
  }

  private async fetchProfile(tenantId: string, ch: ChannelRecord, contactId: string, externalId: string) {
    try {
      const connector = this.connectorOf(ch);
      if (!connector.profile) return;
      const p = await connector.profile(this.context(ch), externalId);
      if (p.name) await this.tx(tenantId, (c) => c.query('UPDATE contacts SET name = $2 WHERE id = $1 AND name IS NULL', [contactId, p.name!.slice(0, 120)]));
    } catch {
      /* cosmetic only */
    }
  }

  // ───────────────────────── AI replies ─────────────────────────

  enqueueAi(tenantId: string, conversationId: string): void {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const next = prev
      .then(() => this.processAi(tenantId, conversationId))
      .catch((e) => this.app.log.error({ err: e, conversationId }, 'AI reply failed'))
      .finally(() => { if (this.chains.get(conversationId) === next) this.chains.delete(conversationId); });
    this.chains.set(conversationId, next);
    void this.track(next);
  }

  /**
   * Answer ALL customer messages that arrived since the last answer as one turn (people write in bursts).
   * Not answered when: a human has the conversation, the channel has no active employee, or auto-reply is off.
   */
  async processAi(tenantId: string, conversationId: string): Promise<void> {
    const ctx = await this.tx(tenantId, async (c) => {
      const cv = (
        await c.query(
          `SELECT cv.id, cv.handler, cv.channel_id AS "channelId", ch.employee_id AS "employeeId", ch.auto_reply AS "autoReply", ch.status AS "channelStatus", e.status AS "employeeStatus"
           FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id LEFT JOIN ai_employees e ON e.id = ch.employee_id WHERE cv.id = $1`,
          [conversationId],
        )
      ).rows[0];
      if (!cv) return null;
      const pending = (await c.query(`SELECT id, body, attachments FROM messages WHERE conversation_id = $1 AND ai_state = 'pending' ORDER BY created_at, id`, [conversationId])).rows;
      if (pending.length === 0) return null;
      const ids = pending.map((p) => p.id);
      const skip = cv.handler !== 'ai' || !cv.employeeId || cv.employeeStatus !== 'active' || !cv.autoReply || !['connected', 'awaiting_approval'].includes(cv.channelStatus);
      if (skip) {
        await c.query(`UPDATE messages SET ai_state = 'skipped' WHERE id = ANY($1::uuid[])`, [ids]);
        return null;
      }
      const hist = (
        await c.query(
          `SELECT direction, body FROM messages WHERE conversation_id = $1 AND ai_state IS DISTINCT FROM 'pending' AND status <> 'failed' AND sender_type <> 'system' AND body <> ''
           ORDER BY created_at DESC, id DESC LIMIT 20`,
          [conversationId],
        )
      ).rows.reverse();
      const history: ChatMessage[] = hist.map((h: { direction: string; body: string }) => ({ role: h.direction === 'in' ? 'user' : 'assistant', content: h.body }));
      const text = pending.map((p: { body: string; attachments: AttachmentMeta[] }) => p.body || `[the customer sent ${p.attachments.map((a) => a.kind).join(', ') || 'a file'}]`).join('\n');
      return { employeeId: cv.employeeId as string, ids, history, text };
    });
    if (!ctx) return;

    const result = await runTurn(this.app, { tenantId, employeeId: ctx.employeeId, mode: 'live', history: ctx.history, message: ctx.text, conversationId });

    // Save the answer and mark the questions answered in ONE transaction, so a crash can never answer twice.
    const messageId = await this.tx(tenantId, async (c) => {
      const m = await c.query(
        `INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status, meta)
         SELECT $1, channel_id, id, 'out', 'ai', $3, 'queued', $4 FROM conversations WHERE id = $2 RETURNING id`,
        [tenantId, conversationId, result.reply, JSON.stringify({ ai: { employeeId: ctx.employeeId, model: result.usage?.model ?? null, tokens: result.usage?.totalTokens ?? 0, usedModel: result.usedModel, error: result.error?.code ?? null, decisions: result.decisions.map((d) => ({ type: d.type, decision: d.decision })), blocked: result.findings.filter((f) => f.severity === 'block').map((f) => f.code) } })],
      );
      await c.query(`UPDATE messages SET ai_state = 'done' WHERE id = ANY($1::uuid[])`, [ctx.ids]);
      await c.query(`UPDATE conversations SET last_message_at = now(), last_message_preview = $2, employee_id = $3 WHERE id = $1`, [conversationId, preview(result.reply), ctx.employeeId]);
      if (result.handoff) {
        await c.query(`UPDATE conversations SET handler = 'human', status = 'pending', handoff_reason = $2, handoff_at = now() WHERE id = $1 AND handler = 'ai'`, [conversationId, result.handoff.reason.slice(0, 300)]);
        await audit(c, tenantId, null, 'conversation.handoff', 'conversation', conversationId, { reason: result.handoff.reason, employeeId: ctx.employeeId });
      }
      return m.rows[0].id as string;
    });
    await this.deliver(tenantId, messageId);
  }

  // ───────────────────────── outbound ─────────────────────────

  /** Queue a message from staff (or the system) into a conversation and send it. */
  async sendMessage(tenantId: string, opts: { conversationId: string; text: string; fileIds?: string[]; senderType: 'human' | 'system'; userId?: string | null; takeover?: boolean; meta?: Record<string, unknown> }) {
    const queued = await this.tx(tenantId, async (c) => {
      const cv = (await c.query(`SELECT cv.id, cv.handler, cv.channel_id AS "channelId", ch.type, ch.provider, ch.status FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id WHERE cv.id = $1`, [opts.conversationId])).rows[0];
      if (!cv) throw notFound('Conversation not found');
      const connector = this.registry.get(cv.type, cv.provider);
      const text = opts.text.trim();
      if (text.length > connector.capabilities.maxTextLength) throw new AppError(400, 'message_too_long', `This channel accepts messages up to ${connector.capabilities.maxTextLength} characters.`);
      const files = opts.fileIds?.length ? (await c.query(`SELECT id, name, mime, size FROM message_files WHERE id = ANY($1::uuid[]) AND conversation_id = $2`, [opts.fileIds, opts.conversationId])).rows : [];
      if (files.length !== (opts.fileIds?.length ?? 0)) throw new AppError(400, 'invalid_attachment', 'One of the attachments does not belong to this conversation');
      if (files.length && !connector.capabilities.sendFiles) throw new AppError(400, 'attachments_not_supported', `${PLATFORM_LABEL[cv.type as ChannelType]} does not support sending files from here yet.`);
      if (!text && files.length === 0) throw new AppError(400, 'empty_message', 'Write a message or attach a file');
      const atts: AttachmentMeta[] = files.map((f: { id: string; name: string; mime: string; size: number }): AttachmentMeta => ({ kind: f.mime.startsWith('image/') ? 'image' : f.mime.startsWith('video/') ? 'video' : 'document', name: f.name, mime: f.mime, size: f.size, fileId: f.id }));
      const m = await c.query(
        `INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, sender_user_id, body, attachments, status, meta)
         VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, 'queued', $8) RETURNING id`,
        [tenantId, cv.channelId, opts.conversationId, opts.senderType, opts.userId ?? null, text, JSON.stringify(atts), JSON.stringify(opts.meta ?? {})],
      );
      const took = opts.takeover !== false && opts.senderType === 'human' && cv.handler === 'ai';
      await c.query(
        `UPDATE conversations SET last_message_at = now(), last_message_preview = $2,
           handler = CASE WHEN $3 THEN 'human' ELSE handler END, assigned_user_id = CASE WHEN $3 THEN $4::uuid ELSE assigned_user_id END,
           status = CASE WHEN $3 AND status = 'open' THEN 'open' ELSE status END,
           handoff_reason = CASE WHEN $3 THEN 'A team member replied' ELSE handoff_reason END, handoff_at = CASE WHEN $3 THEN now() ELSE handoff_at END WHERE id = $1`,
        [opts.conversationId, preview(text, atts), took, opts.userId ?? null],
      );
      if (took) await audit(c, tenantId, opts.userId ?? null, 'conversation.takeover', 'conversation', opts.conversationId, { via: 'reply' });
      return m.rows[0].id as string;
    });
    return this.deliver(tenantId, queued);
  }

  /**
   * One campaign message to one customer. Lives in the same thread as the conversation (so staff see it) but never touches
   * handler / unread / AI state. At most ONE message per campaign recipient exists (unique index), so a crash + retry cannot double-send.
   */
  async sendCampaignMessage(tenantId: string, o: { campaignId: string; campaignName: string; recipientId: string; contactId: string; channelId: string; text: string }) {
    const messageId = await this.tx(tenantId, async (c) => {
      const ch = await this.load(c, o.channelId);
      const connector = this.registry.get(ch.type, ch.provider);
      if (o.text.length > connector.capabilities.maxTextLength) throw new AppError(400, 'message_too_long', `This channel accepts messages up to ${connector.capabilities.maxTextLength} characters.`);
      await c.query(`INSERT INTO conversations (tenant_id, channel_id, platform, contact_id, employee_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (channel_id, contact_id) DO NOTHING`, [tenantId, ch.id, ch.type, o.contactId, ch.employeeId]);
      const cv = (await c.query('SELECT id FROM conversations WHERE channel_id = $1 AND contact_id = $2', [ch.id, o.contactId])).rows[0];
      const meta = JSON.stringify({ campaign: { id: o.campaignId, name: o.campaignName }, campaignRecipientId: o.recipientId });
      const ins = await c.query(
        `INSERT INTO messages (tenant_id, channel_id, conversation_id, direction, sender_type, body, status, meta) VALUES ($1, $2, $3, 'out', 'system', $4, 'queued', $5)
         ON CONFLICT ((meta ->> 'campaignRecipientId')) WHERE meta ? 'campaignRecipientId' AND direction = 'out' DO NOTHING RETURNING id`,
        [tenantId, ch.id, cv.id, o.text, meta],
      );
      if (ins.rows[0]) {
        await c.query(`UPDATE conversations SET last_message_at = now(), last_message_preview = $2 WHERE id = $1`, [cv.id, preview(o.text)]);
        return ins.rows[0].id as string;
      }
      return (await c.query(`SELECT id FROM messages WHERE direction = 'out' AND meta ->> 'campaignRecipientId' = $1`, [o.recipientId])).rows[0].id as string;
    });
    const res = await this.deliver(tenantId, messageId);
    return { messageId, ...res };
  }

  /** Send (or re-send) one queued/retry message. Safe to call twice: only one caller can claim it. */
  async deliver(tenantId: string, messageId: string): Promise<{ id: string; status: string; error?: string | null; errorCode?: string | null }> {
    const claim = await this.tx(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE messages SET status = 'sending', attempts = attempts + 1 WHERE id = $1 AND direction = 'out' AND (status IN ('queued', 'retry') OR (status = 'sending' AND created_at < now() - interval '2 minutes'))
         RETURNING id, conversation_id, channel_id, body, attachments, attempts`,
        [messageId],
      );
      const m = r.rows[0];
      if (!m) return null;
      const ch = await this.load(c, m.channel_id);
      const contact = (await c.query(`SELECT ct.external_id FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1`, [m.conversation_id])).rows[0];
      const fileIds = (m.attachments as AttachmentMeta[]).map((a) => a.fileId).filter(Boolean);
      const files: OutboundFile[] = fileIds.length ? (await c.query(`SELECT id, name, mime, data FROM message_files WHERE id = ANY($1::uuid[])`, [fileIds])).rows.map((f: { name: string; mime: string; data: Buffer }) => ({ kind: f.mime.startsWith('image/') ? 'image' as const : f.mime.startsWith('video/') ? 'video' as const : 'document' as const, name: f.name, mime: f.mime, data: f.data })) : [];
      return { m, ch, to: contact.external_id as string, files };
    });
    if (!claim) {
      const cur = await this.tx(tenantId, (c) => c.query('SELECT id, status, error, error_code AS "errorCode" FROM messages WHERE id = $1', [messageId]));
      return cur.rows[0] ?? { id: messageId, status: 'unknown' };
    }
    const { m, ch, to, files } = claim;
    try {
      if (!['connected', 'awaiting_approval'].includes(ch.status)) throw new ChannelError('channel_not_connected', `The ${PLATFORM_LABEL[ch.type as ChannelType]} channel is ${ch.status}. Reconnect it, then retry.`, { retryable: false });
      const res = await this.connectorOf(ch).send(this.context(ch), { contactExternalId: to, text: m.body, files });
      await this.tx(tenantId, async (c) => {
        try {
          await c.query('SAVEPOINT s');
          await c.query(`UPDATE messages SET status = 'sent', external_id = $2, sent_at = now(), error = NULL, error_code = NULL, next_attempt_at = NULL WHERE id = $1`, [m.id, res.externalId]);
        } catch {
          await c.query('ROLLBACK TO SAVEPOINT s'); // external id already known (echo): keep the message, drop the duplicate id
          await c.query(`UPDATE messages SET status = 'sent', sent_at = now(), error = NULL, error_code = NULL, next_attempt_at = NULL WHERE id = $1`, [m.id]);
        }
        await c.query(`UPDATE channels SET last_outbound_at = now(), consecutive_failures = 0, health_status = CASE WHEN health_status IN ('down', 'degraded') AND status = 'connected' THEN 'healthy' ELSE health_status END WHERE id = $1`, [ch.id]);
      });
      return { id: m.id, status: 'sent' };
    } catch (e) {
      const ce = e instanceof ChannelError ? e : new ChannelError('send_failed', (e as Error).message, { retryable: false });
      const retry = ce.retryable && m.attempts < MAX_ATTEMPTS;
      const delay = this.retryDelaysSeconds[Math.min(m.attempts - 1, this.retryDelaysSeconds.length - 1)] ?? 1800;
      const channelFault = !RECIPIENT_ERRORS.has(ce.code);
      await this.tx(tenantId, async (c) => {
        if (ce.code === 'recipient_blocked' || ce.code === 'recipient_not_found') {
          const ct = await c.query(`UPDATE contacts SET unreachable_at = now(), unreachable_reason = $2 WHERE unreachable_at IS NULL AND id = (SELECT contact_id FROM conversations WHERE id = $1) RETURNING id, channel_id`, [m.conversation_id, ce.code]);
          if (ct.rows[0]) await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail) VALUES ($1, $2, $3, 'unreachable', $4)`, [tenantId, ct.rows[0].channel_id, ct.rows[0].id, JSON.stringify({ code: ce.code })]);
        }
        await c.query(
          `UPDATE messages SET status = $2, error = $3, error_code = $4, next_attempt_at = CASE WHEN $2 = 'retry' THEN now() + make_interval(secs => $5) ELSE NULL END WHERE id = $1`,
          [m.id, retry ? 'retry' : 'failed', ce.message.slice(0, 400), ce.code, delay],
        );
        if (channelFault) {
          await c.query(
            `UPDATE channels SET last_error = $2, last_error_at = now(), consecutive_failures = consecutive_failures + 1,
               health_status = CASE WHEN consecutive_failures + 1 >= 5 THEN 'down' WHEN consecutive_failures + 1 >= 3 THEN 'degraded' ELSE health_status END,
               status = CASE WHEN $3 IN ('auth_expired', 'invalid_token') THEN 'error' ELSE status END WHERE id = $1`,
            [ch.id, ce.message.slice(0, 300), ce.code],
          );
        }
      });
      return { id: m.id, status: retry ? 'retry' : 'failed', error: ce.message, errorCode: ce.code };
    }
  }

  // ───────────────────────── background work ─────────────────────────

  /** One pass of: due retries, unanswered messages, health checks. Called by timers in production and directly by tests. */
  async tick(opts: { health?: boolean } = {}): Promise<{ retried: number; recovered: number; checked: number }> {
    const out = { retried: 0, recovered: 0, checked: 0 };
    const due = await this.app.pools.app.query('SELECT * FROM worker_due_retries(50)');
    for (const r of due.rows) { await this.deliver(r.tenant_id, r.message_id).catch(() => undefined); out.retried++; }
    const pend = await this.app.pools.app.query('SELECT * FROM worker_pending_ai(20, $1)', [30]);
    for (const r of pend.rows) { this.enqueueAi(r.tenant_id, r.conversation_id); out.recovered++; }
    if (opts.health !== false) {
      const h = await this.app.pools.app.query('SELECT * FROM worker_health_due(20, 60)');
      for (const r of h.rows) { await this.checkHealth(r.tenant_id, r.channel_id).catch(() => undefined); out.checked++; }
    }
    return out;
  }

  start(): void {
    if (this.timers.length) return;
    const run = (fn: () => Promise<unknown>) => () => void fn().catch((e) => this.app.log.error({ err: e }, 'channel worker error'));
    this.timers.push(setInterval(run(() => this.tick({ health: false })), 10_000), setInterval(run(() => this.tick()), 60_000));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ───────────────────────── website widget ─────────────────────────

  visitorToken(channelId: string, visitorId: string): string {
    return `${visitorId}.${this.registry.vault.sign('widget', `${channelId}:${visitorId}`)}`;
  }

  verifyVisitor(channelId: string, token: string): string | null {
    const [id, sig] = token.split('.');
    if (!id || !sig || id.length > 64) return null;
    return this.registry.vault.verify('widget', `${channelId}:${id}`, sig) ? id : null;
  }

  newVisitorId(): string {
    return randomUUID();
  }
}
