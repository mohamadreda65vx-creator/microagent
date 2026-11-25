/**
 * Campaign audience + sending eligibility.
 *
 * Two separate questions, never mixed:
 *  1. WHO matches the owner's filter?            -> audienceSql()  (database)
 *  2. MAY we message each of them right now?     -> evaluate()     (pure function, unit-tested, re-run at send time)
 *
 * Having talked to us once is NOT permission to send marketing. Every rule below is a deliberate, conservative reading of the
 * platform policies; the reasons are shown to the owner and nothing here tries to get around a platform rule.
 */
import { z } from 'zod';
import type { ChannelType, Provider } from '../channels/types.js';

export const CAMPAIGN_PLATFORMS = ['whatsapp', 'messenger', 'instagram', 'telegram'] as const;
export type CampaignPlatform = (typeof CAMPAIGN_PLATFORMS)[number];
export const CUSTOMER_STATUSES = ['new', 'lead', 'customer', 'inactive'] as const;
export const MAX_AUDIENCE = 10_000;

const tag = z.string().trim().min(1).max(40);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const audienceSchema = z
  .object({
    /** Last time the CUSTOMER wrote to us. */
    lastInteraction: z.object({ withinDays: z.number().int().min(1).max(3650).optional(), olderThanDays: z.number().int().min(1).max(3650).optional() }).strict().optional(),
    /** Calendar range on the first or last interaction. */
    dateRange: z.object({ field: z.enum(['first_interaction', 'last_interaction']).default('last_interaction'), from: day.optional(), to: day.optional() }).strict().optional(),
    tagsAny: z.array(tag).max(20).optional(),
    tagsAll: z.array(tag).max(20).optional(),
    excludeTags: z.array(tag).max(20).optional(),
    statuses: z.array(z.enum(CUSTOMER_STATUSES)).max(4).optional(),
    /** true = status "customer"; false = everybody who is not. There is no order system yet: this is what staff recorded. */
    purchased: z.boolean().optional(),
    interestsAny: z.array(tag).max(20).optional(),
    /** Previous campaign interaction: people who were sent that campaign and did / did not write back afterwards. */
    previousCampaign: z.object({ campaignId: z.uuid(), replied: z.boolean() }).strict().optional(),
    /** Only people who explicitly opted in to marketing. */
    optedInOnly: z.boolean().optional(),
  })
  .strict();
export type AudienceFilter = z.infer<typeof audienceSchema>;

export function normalizeFilter(f: AudienceFilter): AudienceFilter {
  const clean = (a?: string[]) => (a?.length ? [...new Set(a.map((x) => x.toLowerCase()))].sort() : undefined);
  const out: AudienceFilter = { ...f, tagsAny: clean(f.tagsAny), tagsAll: clean(f.tagsAll), excludeTags: clean(f.excludeTags), interestsAny: clean(f.interestsAny) };
  for (const k of Object.keys(out) as (keyof AudienceFilter)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** The part of the filter as SQL over `contacts ct` of ONE channel. `$1` is always the channel id. */
export function audienceSql(f: AudienceFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length + 1}`; };
  const w: string[] = [`ct.channel_id = $1`, `ct.last_inbound_at IS NOT NULL`]; // must have written to us at least once
  const last = `COALESCE(ct.last_inbound_at, ct.last_seen_at)`;
  if (f.lastInteraction?.withinDays) w.push(`${last} >= now() - make_interval(days => ${p(f.lastInteraction.withinDays)}::int)`);
  if (f.lastInteraction?.olderThanDays) w.push(`${last} < now() - make_interval(days => ${p(f.lastInteraction.olderThanDays)}::int)`);
  if (f.dateRange) {
    const col = f.dateRange.field === 'first_interaction' ? 'ct.first_seen_at' : last;
    if (f.dateRange.from) w.push(`${col} >= ${p(f.dateRange.from)}::date`);
    if (f.dateRange.to) w.push(`${col} < (${p(f.dateRange.to)}::date + 1)`);
  }
  if (f.tagsAny?.length) w.push(`ct.tags && ${p(f.tagsAny)}::text[]`);
  if (f.tagsAll?.length) w.push(`ct.tags @> ${p(f.tagsAll)}::text[]`);
  if (f.excludeTags?.length) w.push(`NOT (ct.tags && ${p(f.excludeTags)}::text[])`);
  if (f.statuses?.length) w.push(`ct.status = ANY(${p(f.statuses)}::text[])`);
  if (f.purchased === true) w.push(`ct.status = 'customer'`);
  if (f.purchased === false) w.push(`ct.status <> 'customer'`);
  if (f.interestsAny?.length) w.push(`ct.interests && ${p(f.interestsAny)}::text[]`);
  if (f.optedInOnly) w.push(`ct.consent_status = 'opted_in'`);
  if (f.previousCampaign) {
    const id = p(f.previousCampaign.campaignId);
    const replied = `EXISTS (SELECT 1 FROM campaign_recipients r JOIN messages m ON m.id = r.message_id JOIN messages inb ON inb.conversation_id = m.conversation_id AND inb.direction = 'in' AND inb.created_at > m.created_at AND NOT COALESCE((inb.meta ->> 'optOut')::boolean, false)
                      WHERE r.campaign_id = ${id}::uuid AND r.contact_id = ct.id)`;
    const was = `EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = ${id}::uuid AND r.contact_id = ct.id AND r.status IN ('sent', 'retrying'))`;
    w.push(f.previousCampaign.replied ? replied : `(${was} AND NOT ${replied})`);
  }
  return { where: w.join(' AND '), params };
}

// ───────────────────────── eligibility ─────────────────────────
/** Meta's standard messaging window is 24 hours; we stop 10 minutes early so a message cannot cross the line while queued. */
export const WINDOW_MS = 24 * 3600_000 - 10 * 60_000;

export type ExclusionReason =
  | 'opted_out'
  | 'unreachable'
  | 'no_previous_conversation'
  | 'outside_messaging_window'
  | 'marketing_messages_not_supported'
  | 'no_marketing_consent'
  | 'template_required'
  | 'platform_not_supported'
  | 'channel_not_connected'
  | 'no_longer_matches';

export const REASON_LABEL: Record<ExclusionReason, string> = {
  opted_out: 'Asked not to receive messages (opted out)',
  unreachable: 'Platform says this person cannot be reached (blocked the bot / not found)',
  no_previous_conversation: 'Never wrote to this channel',
  outside_messaging_window: 'Last message is older than 24 hours: the platform only allows replies inside that window',
  marketing_messages_not_supported: 'Outside the 24-hour window. Meta Marketing Messages need approval and are not implemented yet',
  no_marketing_consent: 'Outside the 24-hour window and the customer has not opted in to marketing',
  template_required: 'Outside the 24-hour window: WhatsApp requires an approved template (Cloud API not connected)',
  platform_not_supported: 'This platform cannot receive campaigns',
  channel_not_connected: 'The channel is not connected',
  no_longer_matches: 'No longer matches the audience or changed since approval',
};

export interface ContactFacts { consentStatus: 'unknown' | 'opted_in' | 'opted_out'; lastInboundAt: Date | string | null; unreachableAt: Date | string | null }
export interface ChannelFacts { type: ChannelType; provider: Provider }
export type Verdict = { eligible: true; basis: 'inside_window' | 'opted_in' | 'bot_chat' } | { eligible: false; reason: ExclusionReason };

export function evaluate(contact: ContactFacts, channel: ChannelFacts, now: Date = new Date()): Verdict {
  if (!(CAMPAIGN_PLATFORMS as readonly string[]).includes(channel.type)) return { eligible: false, reason: 'platform_not_supported' };
  if (contact.consentStatus === 'opted_out') return { eligible: false, reason: 'opted_out' };
  if (contact.unreachableAt) return { eligible: false, reason: 'unreachable' };
  if (!contact.lastInboundAt) return { eligible: false, reason: 'no_previous_conversation' };
  const inside = now.getTime() - new Date(contact.lastInboundAt).getTime() <= WINDOW_MS;
  switch (channel.type) {
    case 'telegram':
      // A bot can only write to people who started it; Telegram itself refuses the rest (we then mark them unreachable).
      return { eligible: true, basis: 'bot_chat' };
    case 'messenger':
    case 'instagram':
      if (inside) return { eligible: true, basis: 'inside_window' };
      return { eligible: false, reason: contact.consentStatus === 'opted_in' ? 'marketing_messages_not_supported' : 'outside_messaging_window' };
    case 'whatsapp':
      if (inside) return { eligible: true, basis: 'inside_window' };
      if (channel.provider === 'whatsapp_cloud') return { eligible: false, reason: 'template_required' };
      return contact.consentStatus === 'opted_in' ? { eligible: true, basis: 'opted_in' } : { eligible: false, reason: 'no_marketing_consent' };
    default:
      return { eligible: false, reason: 'platform_not_supported' };
  }
}

/** Conservative per-channel sending limits (messages). WhatsApp via QR is unofficial, so it is deliberately slow and capped per day. */
export const PLATFORM_LIMITS: Record<CampaignPlatform, { perMinute: number; perDay: number | null }> = {
  telegram: { perMinute: 300, perDay: null },
  messenger: { perMinute: 120, perDay: null },
  instagram: { perMinute: 60, perDay: null },
  whatsapp: { perMinute: 10, perDay: 300 },
};

// ───────────────────────── message text ─────────────────────────
export const OPT_OUT_FOOTER = '\n\n— للإيقاف ابعت: إيقاف | To stop messages reply: STOP';
export function renderMessage(template: string, name: string | null, footer: boolean): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  const body = template.replace(/\s*\{\{\s*first_name\s*\}\}/gi, (m) => (first ? (/^\s/.test(m) ? m[0]! : '') + first : '')).trim();
  return footer ? body + OPT_OUT_FOOTER : body;
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, '').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const OPT_OUT = new Set(['stop', 'stop messages', 'unsubscribe', 'opt out', 'optout', 'ايقاف', 'وقف', 'ايقاف الرسايل', 'ايقاف الرسائل', 'وقف الرسايل', 'وقف الرسائل', 'الغاء الاشتراك', 'الغ الاشتراك', 'لا تراسلني', 'متراسلنيش']);
/** Only a message that IS an opt-out request counts ("stop the order" does not). */
export const isOptOut = (text: string): boolean => OPT_OUT.has(fold(text));
