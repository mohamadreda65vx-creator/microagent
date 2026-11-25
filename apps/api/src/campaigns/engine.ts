/**
 * Campaign Engine: previews, approval, launch and the background sender.
 * Separate from the conversation system: it only talks to customers through ChannelManager.sendCampaignMessage().
 *
 * Safety rules enforced here (not in the UI):
 *  - nothing is sent before an explicit approval that is bound to a hash of (channel, message, audience filter, exact recipient list);
 *  - if anything changed between approval and launch, the approval is void (409) and the owner must look again;
 *  - every recipient is re-checked for eligibility at the moment of sending (opt-out, window, blocked...);
 *  - one row per (campaign, customer) and one message per row: the same customer is never messaged twice by one campaign.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../agent/employee.js';
import type { ChannelRecord } from '../channels/manager.js';
import { withTenant } from '../db/tx.js';
import type { Client } from '../db/pool.js';
import { AppError, notFound } from '../shared/errors.js';
import {
  CAMPAIGN_PLATFORMS, MAX_AUDIENCE, PLATFORM_LIMITS, REASON_LABEL, audienceSchema, audienceSql, evaluate, normalizeFilter, renderMessage,
  type AudienceFilter, type CampaignPlatform, type ExclusionReason,
} from './audience.js';

export const CAMPAIGN_COLS = `id, name, channel_id AS "channelId", platform, brief, message, optout_footer AS "optoutFooter", audience, status, created_by_ai AS "createdByAi",
  ai_notes AS "aiNotes", rate_per_minute AS "ratePerMinute", ack_unofficial AS "ackUnofficial", approved_hash AS "approvedHash", approved_by AS "approvedBy", approved_at AS "approvedAt",
  approved_eligible AS "approvedEligible", scheduled_at AS "scheduledAt", launched_at AS "launchedAt", started_at AS "startedAt", finished_at AS "finishedAt", snapshot,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface CampaignRow {
  id: string; name: string; channelId: string; platform: CampaignPlatform; brief: string | null; message: string; optoutFooter: boolean; audience: AudienceFilter;
  status: 'draft' | 'approved' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled'; createdByAi: boolean; aiNotes: Record<string, unknown>; ratePerMinute: number | null;
  ackUnofficial: boolean; approvedHash: string | null; approvedBy: string | null; approvedAt: string | null; approvedEligible: number | null; scheduledAt: string | null;
  launchedAt: string | null; startedAt: string | null; finishedAt: string | null; snapshot: Record<string, any>; createdBy: string | null; createdAt: string; updatedAt: string;
}

interface Verdicts { id: string; name: string | null; verdict: ReturnType<typeof evaluate> | { eligible: false; reason: ExclusionReason } }
export interface Preview {
  total: number;
  eligible: number;
  excluded: Array<{ reason: ExclusionReason; label: string; count: number }>;
  sample: Array<{ contactId: string; name: string | null; text: string }>;
  blockers: Array<{ code: string; text: string }>;
  warnings: string[];
  requiresUnofficialAck: boolean;
  estimatedMinutes: number;
  ratePerMinute: number;
  hash: string;
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const BATCH = 25;
const STUCK_SENDING_MINUTES = 5;

export class CampaignEngine {
  /** Tests change these. */
  limits: Record<CampaignPlatform, { perMinute: number; perDay: number | null }> = structuredClone(PLATFORM_LIMITS);
  intervalSeconds = 5;
  smooth = true;
  private readonly busy = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly app: FastifyInstance) {}
  private tx<T>(tenantId: string, fn: (c: Client) => Promise<T>) { return withTenant(this.app.pools.app, tenantId, fn); }

  async load(c: Client, id: string): Promise<CampaignRow> {
    const { rows } = await c.query(`SELECT ${CAMPAIGN_COLS} FROM campaigns WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('Campaign not found');
    return rows[0] as CampaignRow;
  }
  async event(c: Client, tenantId: string, campaignId: string, kind: string, actor: string | null, detail: Record<string, unknown> = {}) {
    await c.query(`INSERT INTO campaign_events (tenant_id, campaign_id, kind, detail, actor_user_id) VALUES ($1, $2, $3, $4, $5)`, [tenantId, campaignId, kind, JSON.stringify(detail), actor]);
  }

  effectiveRate(camp: Pick<CampaignRow, 'platform' | 'ratePerMinute'>): number {
    const max = this.limits[camp.platform].perMinute;
    return Math.min(camp.ratePerMinute ?? max, max);
  }

  // ───────────────────────── audience preview ─────────────────────────
  async evaluateAudience(c: Client, camp: CampaignRow, ch: ChannelRecord, now = new Date()): Promise<{ all: Verdicts[]; rows: Array<{ id: string; name: string | null }> }> {
    const filter = audienceSchema.parse(camp.audience ?? {});
    const q = audienceSql(filter);
    const { rows } = await c.query(
      `SELECT ct.id, ct.name, ct.consent_status AS "consentStatus", ct.last_inbound_at AS "lastInboundAt", ct.unreachable_at AS "unreachableAt"
         FROM contacts ct WHERE ${q.where} ORDER BY ct.id LIMIT ${MAX_AUDIENCE + 1}`,
      [camp.channelId, ...q.params],
    );
    if (rows.length > MAX_AUDIENCE) throw new AppError(400, 'audience_too_large', `This audience has more than ${MAX_AUDIENCE} people. Narrow it (for example by date or tag) and split the campaign.`);
    const connected = ch.status === 'connected';
    const all: Verdicts[] = rows.map((r) => ({
      id: r.id, name: r.name,
      verdict: connected ? evaluate({ consentStatus: r.consentStatus, lastInboundAt: r.lastInboundAt, unreachableAt: r.unreachableAt }, { type: ch.type, provider: ch.provider }, now) : { eligible: false as const, reason: 'channel_not_connected' as const },
    }));
    return { all, rows: rows.map((r) => ({ id: r.id, name: r.name })) };
  }

  async computePreview(c: Client, camp: CampaignRow): Promise<{ preview: Preview; all: Verdicts[] }> {
    const ch = await this.app.channels.load(c, camp.channelId);
    const connector = this.app.channels.connectorOf(ch);
    const { all } = await this.evaluateAudience(c, camp, ch);
    const eligible = all.filter((v) => v.verdict.eligible);
    const counts = new Map<ExclusionReason, number>();
    for (const v of all) if (!v.verdict.eligible) counts.set(v.verdict.reason, (counts.get(v.verdict.reason) ?? 0) + 1);
    const rate = this.effectiveRate(camp);
    const blockers: Preview['blockers'] = [];
    const warnings: string[] = [];
    if (ch.status !== 'connected') blockers.push({ code: 'channel_not_connected', text: ch.status === 'awaiting_approval' ? 'This channel has not received a real message yet, so it is not verified. Campaigns can only use a connected channel.' : `The channel is ${ch.status}. Reconnect it first.` });
    if (!camp.message.trim()) blockers.push({ code: 'empty_message', text: 'Write the message first.' });
    const sampleText = renderMessage(camp.message, 'Sample', camp.optoutFooter);
    if (sampleText.length > connector.capabilities.maxTextLength) blockers.push({ code: 'message_too_long', text: `The message (with the opt-out line) is longer than ${connector.capabilities.maxTextLength} characters.` });
    if (eligible.length === 0 && ch.status === 'connected') blockers.push({ code: 'no_eligible_recipients', text: 'Nobody in this audience can be messaged right now.' });
    const unofficial = ch.type === 'whatsapp' && ch.provider === 'evolution';
    if (unofficial) warnings.push('WhatsApp through QR is unofficial. WhatsApp can restrict or ban a number that sends bulk messages. Sending is slow and capped per day on purpose.');
    if (!connector.capabilities.deliveryStatus) warnings.push(`${ch.type === 'telegram' ? 'Telegram' : 'This channel'} does not report delivery. You will see "Sent" but never "Delivered".`);
    if (ch.type === 'messenger' || ch.type === 'instagram') warnings.push('Messenger and Instagram allow messages only within 24 hours of the customer’s last message. Everyone else is excluded.');
    if (camp.optoutFooter === false) warnings.push('The opt-out line is turned off. People can still opt out by writing STOP, but they will not be told how.');
    const preview: Preview = {
      total: all.length,
      eligible: eligible.length,
      excluded: [...counts].map(([reason, count]) => ({ reason, label: REASON_LABEL[reason], count })).sort((a, b) => b.count - a.count),
      sample: eligible.slice(0, 5).map((v) => ({ contactId: v.id, name: v.name, text: renderMessage(camp.message, v.name, camp.optoutFooter) })),
      blockers, warnings,
      requiresUnofficialAck: unofficial,
      estimatedMinutes: Math.ceil(eligible.length / rate),
      ratePerMinute: rate,
      hash: sha({ ch: camp.channelId, m: camp.message, f: camp.optoutFooter, a: normalizeFilter(audienceSchema.parse(camp.audience ?? {})), ids: eligible.map((v) => v.id).sort() }),
    };
    return { preview, all };
  }

  async preview(tenantId: string, campaignId: string): Promise<Preview> {
    return this.tx(tenantId, async (c) => (await this.computePreview(c, await this.load(c, campaignId))).preview);
  }

  // ───────────────────────── approval & launch ─────────────────────────
  async approve(tenantId: string, userId: string, campaignId: string, input: { hash: string; confirmRecipients: number; acknowledgeUnofficialRisk?: boolean }) {
    return this.tx(tenantId, async (c) => {
      const camp = await this.load(c, campaignId);
      if (!['draft', 'approved'].includes(camp.status)) throw new AppError(409, 'campaign_not_editable', `A ${camp.status} campaign cannot be approved.`);
      const { preview } = await this.computePreview(c, camp);
      if (preview.blockers.length) throw new AppError(409, 'campaign_blocked', preview.blockers.map((b) => b.text).join(' '));
      if (preview.hash !== input.hash) throw new AppError(409, 'preview_changed', 'The audience or the message changed since you looked at the preview. Review it again.', { preview });
      if (input.confirmRecipients !== preview.eligible) throw new AppError(400, 'confirm_count_mismatch', `Type the number of people who will receive this message (${preview.eligible}) to approve.`);
      if (preview.requiresUnofficialAck && !input.acknowledgeUnofficialRisk) throw new AppError(400, 'unofficial_risk_ack_required', 'Confirm that you understand the risk of bulk messaging through unofficial WhatsApp.');
      await c.query(`UPDATE campaigns SET status = 'approved', approved_hash = $2, approved_by = $3, approved_at = now(), approved_eligible = $4, ack_unofficial = $5, updated_at = now() WHERE id = $1`, [campaignId, preview.hash, userId, preview.eligible, !!input.acknowledgeUnofficialRisk]);
      await this.event(c, tenantId, campaignId, 'approved', userId, { eligible: preview.eligible, total: preview.total });
      await audit(c, tenantId, userId, 'campaign.approved', 'campaign', campaignId, { eligible: preview.eligible });
      return { approved: true, eligible: preview.eligible };
    });
  }

  async launch(tenantId: string, userId: string, campaignId: string, input: { scheduleAt?: Date | null }) {
    const res = await this.tx(tenantId, async (c) => {
      const camp = await this.load(c, campaignId);
      if (camp.status !== 'approved' || !camp.approvedHash) throw new AppError(409, 'not_approved', 'Approve the campaign first. Nothing is sent without an explicit approval.');
      const now = Date.now();
      if (input.scheduleAt && (input.scheduleAt.getTime() < now + 30_000 || input.scheduleAt.getTime() > now + 90 * 86400_000)) throw new AppError(400, 'invalid_schedule', 'Choose a time between 1 minute and 90 days from now.');
      const { preview, all } = await this.computePreview(c, camp);
      if (preview.blockers.length) throw new AppError(409, 'campaign_blocked', preview.blockers.map((b) => b.text).join(' '));
      if (preview.hash !== camp.approvedHash) return { voided: true as const, preview };
      const ids: string[] = [], statuses: string[] = [], reasons: Array<string | null> = [], texts: Array<string | null> = [];
      for (const v of all) {
        ids.push(v.id);
        if (v.verdict.eligible) { statuses.push('queued'); reasons.push(null); texts.push(renderMessage(camp.message, v.name, camp.optoutFooter)); }
        else { statuses.push('excluded'); reasons.push(v.verdict.reason); texts.push(null); }
      }
      await c.query(
        `INSERT INTO campaign_recipients (tenant_id, campaign_id, channel_id, contact_id, status, reason, rendered, queued_at)
         SELECT $1, $2, $3, x.contact_id, x.status, x.reason, x.rendered, CASE WHEN x.status = 'queued' THEN now() END
           FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[]) AS x(contact_id, status, reason, rendered)
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [tenantId, campaignId, camp.channelId, ids, statuses, reasons, texts],
      );
      const snapshot = { total: preview.total, eligible: preview.eligible, excluded: Object.fromEntries(preview.excluded.map((e) => [e.reason, e.count])) };
      const scheduled = !!input.scheduleAt;
      await c.query(
        `UPDATE campaigns SET status = $2, launched_at = now(), scheduled_at = $3, started_at = CASE WHEN $2 = 'running' THEN now() END, snapshot = $4, updated_at = now() WHERE id = $1`,
        [campaignId, scheduled ? 'scheduled' : 'running', input.scheduleAt ?? null, JSON.stringify(snapshot)],
      );
      await this.event(c, tenantId, campaignId, scheduled ? 'scheduled' : 'launched', userId, { ...snapshot, scheduleAt: input.scheduleAt ?? null });
      await audit(c, tenantId, userId, scheduled ? 'campaign.scheduled' : 'campaign.launched', 'campaign', campaignId, snapshot);
      return { voided: false as const, status: scheduled ? ('scheduled' as const) : ('running' as const), ...snapshot };
    });
    if (res.voided) {
      // Committed on purpose (not inside the failed request): the old approval must really be gone.
      await this.tx(tenantId, async (c) => {
        await c.query(`UPDATE campaigns SET status = 'draft', approved_hash = NULL, approved_by = NULL, approved_at = NULL, approved_eligible = NULL, updated_at = now() WHERE id = $1 AND status = 'approved'`, [campaignId]);
        await this.event(c, tenantId, campaignId, 'approval_voided', userId, { reason: 'audience_or_message_changed' });
      });
      throw new AppError(409, 'audience_changed', 'The audience changed since you approved it (for example someone opted out). Review the new preview and approve again.', { preview: res.preview });
    }
    const { voided: _v, ...out } = res;
    return out;
  }

  // ───────────────────────── pause / resume / cancel ─────────────────────────
  async control(tenantId: string, userId: string, campaignId: string, action: 'pause' | 'resume' | 'cancel') {
    return this.tx(tenantId, async (c) => {
      const camp = await this.load(c, campaignId);
      const bad = () => new AppError(409, 'invalid_state', `You cannot ${action} a ${camp.status} campaign.`);
      let next: string;
      if (action === 'pause') { if (!['running', 'scheduled'].includes(camp.status)) throw bad(); next = 'paused'; }
      else if (action === 'resume') { if (camp.status !== 'paused') throw bad(); next = camp.startedAt ? 'running' : 'scheduled'; }
      else { if (!['approved', 'scheduled', 'running', 'paused'].includes(camp.status)) throw bad(); next = 'cancelled'; }
      await c.query(`UPDATE campaigns SET status = $2, finished_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE finished_at END, updated_at = now() WHERE id = $1`, [campaignId, next]);
      let cancelled = 0;
      if (action === 'cancel') cancelled = (await c.query(`UPDATE campaign_recipients SET status = 'cancelled', reason = 'campaign_cancelled' WHERE campaign_id = $1 AND status = 'queued'`, [campaignId])).rowCount ?? 0;
      await this.event(c, tenantId, campaignId, action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'cancelled', userId, { cancelled });
      await audit(c, tenantId, userId, `campaign.${action}`, 'campaign', campaignId, {});
      return { status: next, cancelledRecipients: cancelled };
    });
  }

  // ───────────────────────── background sender ─────────────────────────
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.app.log.error({ err: e }, 'campaign engine error')), this.intervalSeconds * 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One pass over all due campaigns. Tests call this directly. */
  async tick(): Promise<{ campaigns: number; sent: number; failed: number; skipped: number }> {
    const out = { campaigns: 0, sent: 0, failed: 0, skipped: 0 };
    const due = await this.app.pools.app.query('SELECT * FROM worker_campaigns_due(20)');
    for (const r of due.rows) {
      if (this.busy.has(r.campaign_id)) continue;
      this.busy.add(r.campaign_id);
      try { const s = await this.runCampaign(r.tenant_id, r.campaign_id); out.campaigns++; out.sent += s.sent; out.failed += s.failed; out.skipped += s.skipped; }
      catch (e) { this.app.log.error({ err: e, campaign: r.campaign_id }, 'campaign run failed'); }
      finally { this.busy.delete(r.campaign_id); }
    }
    return out;
  }

  private async runCampaign(tenantId: string, campaignId: string) {
    const res = { sent: 0, failed: 0, skipped: 0 };
    const ctx = await this.tx(tenantId, async (c) => {
      let camp = await this.load(c, campaignId);
      if (camp.status === 'scheduled') {
        if (!camp.scheduledAt || new Date(camp.scheduledAt) > new Date()) return null;
        await c.query(`UPDATE campaigns SET status = 'running', started_at = now(), updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [campaignId]);
        await this.event(c, tenantId, campaignId, 'started', null);
        camp = await this.load(c, campaignId);
      }
      if (camp.status !== 'running') return null;
      // Messages that were retrying have a final answer now.
      await c.query(
        `UPDATE campaign_recipients r SET status = CASE WHEN m.status = 'failed' THEN 'failed' ELSE 'sent' END, reason = CASE WHEN m.status = 'failed' THEN m.error_code END, detail = CASE WHEN m.status = 'failed' THEN left(m.error, 300) END,
           sent_at = CASE WHEN m.status <> 'failed' THEN COALESCE(r.sent_at, m.sent_at, now()) ELSE r.sent_at END
           FROM messages m WHERE r.message_id = m.id AND r.campaign_id = $1 AND r.status = 'retrying' AND m.status IN ('sent', 'delivered', 'read', 'failed')`,
        [campaignId],
      );
      // A crash between "claimed" and "sent": adopt the message if it exists, otherwise put the customer back in the queue.
      await c.query(
        `UPDATE campaign_recipients r SET message_id = m.id, status = CASE WHEN m.status = 'failed' THEN 'failed' WHEN m.status IN ('sent', 'delivered', 'read') THEN 'sent' ELSE 'retrying' END, sent_at = COALESCE(r.sent_at, m.sent_at)
           FROM messages m WHERE m.direction = 'out' AND m.meta ->> 'campaignRecipientId' = r.id::text AND r.campaign_id = $1 AND r.status = 'sending' AND r.queued_at < now() - make_interval(mins => $2)`,
        [campaignId, STUCK_SENDING_MINUTES],
      );
      await c.query(`UPDATE campaign_recipients SET status = 'queued' WHERE campaign_id = $1 AND status = 'sending' AND queued_at < now() - make_interval(mins => $2)`, [campaignId, STUCK_SENDING_MINUTES]);
      const ch = await this.app.channels.load(c, camp.channelId);
      const lim = this.limits[camp.platform];
      const perMinute = Math.min(camp.ratePerMinute ?? lim.perMinute, lim.perMinute);
      const used = (await c.query(
        `SELECT count(*) FILTER (WHERE sent_at > now() - interval '1 minute' OR status = 'sending')::int AS minute, count(*) FILTER (WHERE sent_at > now() - interval '24 hours' OR status = 'sending')::int AS day
           FROM campaign_recipients WHERE channel_id = $1`, [camp.channelId])).rows[0];
      let quota = perMinute - used.minute;
      if (lim.perDay !== null) quota = Math.min(quota, lim.perDay - used.day);
      const perTick = this.smooth ? Math.max(1, Math.ceil((perMinute * this.intervalSeconds) / 60)) : BATCH;
      const take = Math.max(0, Math.min(quota, perTick, BATCH));
      const claimed = take === 0 ? [] : (await c.query(
        `WITH picked AS MATERIALIZED (
           SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued' ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE campaign_recipients r SET status = 'sending', queued_at = now() FROM picked WHERE r.id = picked.id
         RETURNING r.id, r.contact_id AS "contactId", r.rendered`, [campaignId, take])).rows as Array<{ id: string; contactId: string; rendered: string }>;
      return { camp, ch, claimed };
    });
    if (!ctx) return res;
    const { camp, ch, claimed } = ctx;
    for (let i = 0; i < claimed.length; i++) {
      const r = claimed[i]!;
      const stillRunning = await this.tx(tenantId, async (c) => (await c.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId])).rows[0]?.status === 'running');
      if (!stillRunning) { await this.tx(tenantId, (c) => c.query(`UPDATE campaign_recipients SET status = 'queued' WHERE id = ANY($1::uuid[]) AND status = 'sending'`, [claimed.slice(i).map((x) => x.id)])); break; }
      // Re-check the rules at the moment of sending (opt-out, window, blocked) with fresh data.
      const fresh = await this.tx(tenantId, async (c) => {
        const chNow = await this.app.channels.load(c, camp.channelId);
        const ct = (await c.query(`SELECT consent_status AS "consentStatus", last_inbound_at AS "lastInboundAt", unreachable_at AS "unreachableAt" FROM contacts WHERE id = $1`, [r.contactId])).rows[0];
        return { chNow, v: ct ? evaluate(ct, { type: chNow.type, provider: chNow.provider }) : ({ eligible: false, reason: 'no_longer_matches' } as const) };
      });
      if (fresh.chNow.status !== 'connected') {
        await this.tx(tenantId, (c) => c.query(`UPDATE campaign_recipients SET status = 'queued' WHERE id = ANY($1::uuid[]) AND status = 'sending'`, [claimed.slice(i).map((x) => x.id)]));
        await this.tx(tenantId, async (c) => { await c.query(`UPDATE campaigns SET status = 'paused', updated_at = now() WHERE id = $1 AND status = 'running'`, [campaignId]); await this.event(c, tenantId, campaignId, 'auto_paused', null, { reason: 'channel_not_connected' }); });
        break;
      }
      if (!fresh.v.eligible) {
        await this.tx(tenantId, (c) => c.query(`UPDATE campaign_recipients SET status = 'skipped', reason = $2 WHERE id = $1`, [r.id, fresh.v.eligible ? null : fresh.v.reason]));
        res.skipped++;
        continue;
      }
      try {
        const sent = await this.app.channels.sendCampaignMessage(tenantId, { campaignId, campaignName: camp.name, recipientId: r.id, contactId: r.contactId, channelId: camp.channelId, text: r.rendered });
        const ok = ['sent', 'delivered', 'read'].includes(sent.status);
        const retry = sent.status === 'retry' || sent.status === 'sending' || sent.status === 'queued';
        await this.tx(tenantId, async (c) => {
          await c.query(`UPDATE campaign_recipients SET message_id = $2, status = $3, reason = $4, detail = $5, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`, [r.id, sent.messageId, ok ? 'sent' : retry ? 'retrying' : 'failed', ok || retry ? null : sent.errorCode ?? 'send_failed', ok || retry ? null : (sent.error ?? '').slice(0, 300)]);
          if (ok) await c.query(`INSERT INTO customer_events (tenant_id, channel_id, contact_id, kind, detail) VALUES ($1, $2, $3, 'campaign_sent', $4)`, [tenantId, camp.channelId, r.contactId, JSON.stringify({ campaignId, name: camp.name })]);
        });
        if (ok) res.sent++; else if (!retry) res.failed++;
      } catch (e) {
        await this.tx(tenantId, (c) => c.query(`UPDATE campaign_recipients SET status = 'failed', reason = 'send_failed', detail = $2 WHERE id = $1`, [r.id, (e as Error).message.slice(0, 300)]));
        res.failed++;
      }
    }
    await this.tx(tenantId, async (c) => {
      const left = (await c.query(`SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('queued', 'sending', 'retrying')`, [campaignId])).rows[0].n;
      if (left === 0) {
        const done = await c.query(`UPDATE campaigns SET status = 'completed', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running' RETURNING id`, [campaignId]);
        if (done.rows[0]) await this.event(c, tenantId, campaignId, 'completed', null, await this.counts(c, campaignId));
      }
    });
    return res;
  }

  // ───────────────────────── analytics ─────────────────────────
  async counts(c: Client, campaignId: string) {
    const a = (await c.query(
      `SELECT count(*)::int AS "totalAudience", count(*) FILTER (WHERE r.status <> 'excluded')::int AS eligible,
              count(*) FILTER (WHERE r.status = 'queued')::int AS queued, count(*) FILTER (WHERE r.status IN ('sending', 'retrying'))::int AS "inFlight",
              count(*) FILTER (WHERE r.status = 'skipped')::int AS skipped, count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE r.status = 'failed' OR m.status = 'failed')::int AS failed,
              count(*) FILTER (WHERE m.status IN ('sent', 'delivered', 'read'))::int AS sent,
              count(*) FILTER (WHERE m.status IN ('delivered', 'read'))::int AS delivered, count(*) FILTER (WHERE m.status = 'read')::int AS read
         FROM campaign_recipients r LEFT JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = $1`, [campaignId])).rows[0];
    const attr = (await c.query(
      `SELECT
         (SELECT count(DISTINCT r.id)::int FROM campaign_recipients r JOIN messages m ON m.id = r.message_id AND m.sent_at IS NOT NULL
            JOIN messages inb ON inb.conversation_id = m.conversation_id AND inb.direction = 'in' AND inb.created_at > m.sent_at AND inb.created_at <= m.sent_at + interval '7 days' AND NOT COALESCE((inb.meta ->> 'optOut')::boolean, false)
           WHERE r.campaign_id = $1) AS replies,
         (SELECT count(DISTINCT r.id)::int FROM campaign_recipients r JOIN messages m ON m.id = r.message_id AND m.sent_at IS NOT NULL
            JOIN customer_events e ON e.contact_id = r.contact_id AND e.kind = 'status_changed' AND e.detail ->> 'to' = 'lead' AND e.created_at > m.sent_at AND e.created_at <= m.sent_at + interval '14 days'
           WHERE r.campaign_id = $1) AS leads,
         (SELECT count(DISTINCT r.id)::int FROM campaign_recipients r JOIN messages m ON m.id = r.message_id AND m.sent_at IS NOT NULL
            JOIN customer_events e ON e.contact_id = r.contact_id AND e.kind = 'status_changed' AND e.detail ->> 'to' = 'customer' AND e.created_at > m.sent_at AND e.created_at <= m.sent_at + interval '14 days'
           WHERE r.campaign_id = $1) AS conversions,
         (SELECT count(DISTINCT r.id)::int FROM campaign_recipients r JOIN messages m ON m.id = r.message_id AND m.sent_at IS NOT NULL
            JOIN customer_events e ON e.contact_id = r.contact_id AND e.kind = 'consent_changed' AND e.detail ->> 'to' = 'opted_out' AND e.created_at > m.sent_at AND e.created_at <= m.sent_at + interval '7 days'
           WHERE r.campaign_id = $1) AS "optOuts"`, [campaignId])).rows[0];
    return { ...a, ...attr };
  }

  async analytics(tenantId: string, campaignId: string) {
    return this.tx(tenantId, async (c) => {
      const camp = await this.load(c, campaignId);
      const counts = await this.counts(c, campaignId);
      const excluded = (await c.query(`SELECT reason, count(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1 AND status = 'excluded' GROUP BY reason ORDER BY count DESC`, [campaignId])).rows
        .map((r: { reason: ExclusionReason; count: number }) => ({ ...r, label: REASON_LABEL[r.reason] ?? r.reason }));
      const skipped = (await c.query(`SELECT reason, count(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('skipped', 'failed') GROUP BY reason ORDER BY count DESC`, [campaignId])).rows
        .map((r: { reason: string; count: number }) => ({ ...r, label: REASON_LABEL[r.reason as ExclusionReason] ?? r.reason }));
      const ch = await this.app.channels.load(c, camp.channelId).catch(() => null);
      return {
        counts, excluded, skippedOrFailed: skipped,
        deliveryReported: ch ? this.app.channels.connectorOf(ch).capabilities.deliveryStatus : false,
        definitions: {
          sent: 'The platform accepted the message.',
          delivered: 'The platform confirmed delivery (only counted after the channel reports it; Telegram never does).',
          replies: 'Customers who wrote back within 7 days after the message (STOP requests are not replies).',
          leads: 'Recipients whose status was set to "lead" within 14 days after the message.',
          conversions: 'Recipients whose status was set to "customer" within 14 days after the message. Statuses are set by your team: there is no order system connected yet.',
          optOuts: 'Recipients who opted out within 7 days after the message.',
        },
      };
    });
  }
}

export { CAMPAIGN_PLATFORMS };
