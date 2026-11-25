/**
 * AI Campaign Builder. Turns "send my new offer to everyone who wrote to us on Messenger" into a DRAFT campaign.
 *
 * The model only proposes. Its answer is parsed and validated like any other untrusted input, the audience is computed by SQL
 * (never by the model), eligibility is decided by evaluate(), and nothing can be launched from here: a person must approve the preview.
 * The model may not invent facts: numbers (prices, percentages, dates) it writes must appear in the owner's own words.
 */
import { z } from 'zod';
import { extractJson } from '../ai/context.js';
import type { AiService } from '../ai/service.js';
import { withTenant } from '../db/tx.js';
import type { Pools } from '../db/pool.js';
import { AppError } from '../shared/errors.js';
import { CAMPAIGN_PLATFORMS, audienceSchema, normalizeFilter, type AudienceFilter, type CampaignPlatform } from './audience.js';

const specSchema = z.object({
  name: z.string().trim().min(1).max(160).catch('New campaign'),
  platform: z.enum(CAMPAIGN_PLATFORMS).nullable().catch(null),
  audience: z.record(z.string(), z.unknown()).catch({}),
  message: z.string().trim().max(1500).catch(''),
  improvements: z.array(z.string().trim().max(300)).max(5).catch([]),
  questions: z.array(z.string().trim().max(300)).max(5).catch([]),
});

export interface Draft {
  name: string;
  platform: CampaignPlatform | null;
  audience: AudienceFilter;
  message: string;
  improvements: string[];
  questions: string[];
  warnings: string[];
}

const ALLOWED_KEYS = ['lastInteraction', 'dateRange', 'tagsAny', 'tagsAll', 'excludeTags', 'statuses', 'purchased', 'interestsAny', 'optedInOnly'] as const;
const nums = (t: string) => (t.match(/\d+(?:[.,٫]\d+)?/g) ?? []).map((n) => n.replace(/[,٫]/g, '.').replace(/\.0+$/, ''));
const arabicDigits = (t: string) => t.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

/** Numbers in the message that the owner never wrote (a price, a percentage, a date made up by the model). */
export function inventedNumbers(message: string, ownerText: string): string[] {
  const known = new Set(nums(arabicDigits(ownerText)));
  return [...new Set(nums(arabicDigits(message.replace(/\{\{[^}]*\}\}/g, ''))))].filter((n) => !known.has(n));
}

const SYSTEM = (ctx: { today: string; tags: string[]; platforms: string[] }) => `You help a business owner prepare a marketing message to people who ALREADY wrote to their business. Return ONLY one JSON object:
{"name": short campaign name,
 "platform": "whatsapp"|"messenger"|"instagram"|"telegram"|null (null if the owner did not say),
 "audience": {all keys optional:
   "lastInteraction": {"withinDays": n} or {"olderThanDays": n}   (the customer's last message),
   "dateRange": {"field":"first_interaction"|"last_interaction","from":"YYYY-MM-DD","to":"YYYY-MM-DD"},
   "tagsAny":[...], "tagsAll":[...], "excludeTags":[...],
   "statuses":["new"|"lead"|"customer"|"inactive"],
   "purchased": true|false   (false = people who did NOT buy),
   "interestsAny":[...], "optedInOnly": true},
 "message": the text to send,
 "improvements": up to 3 short suggestions to make the offer work better,
 "questions": things you need from the owner (missing offer details, end date, link...)}
Rules:
- "everyone who contacted us before on X" means audience {} (no filters) and platform X.
- Never invent facts. Do not write prices, discounts, dates, links or product details the owner did not give. If something is missing, put it in "questions" and keep the message generic.
- Write the message in the owner's language and dialect (Egyptian Arabic if they write that way). Keep it short, friendly, one clear call to action. You may use {{first_name}} once. Do not add an unsubscribe line (the system adds it).
- Never promise that the message will be delivered. Never change who is eligible: the platform rules are applied by the system.
- Use only tags from this list: ${JSON.stringify(ctx.tags)}. If the owner names a tag that is not in the list, leave it out and add a question.
- Connected platforms: ${JSON.stringify(ctx.platforms)}. Today is ${ctx.today}.`;

export async function buildDraft(
  ai: AiService | null,
  pools: Pools,
  tenantId: string,
  input: { prompt: string; current?: { name: string; platform: string; audience: unknown; message: string } },
): Promise<Draft> {
  if (!ai?.configured) throw new AppError(503, 'ai_not_configured', 'The AI is not configured on this server, so the assistant cannot draft campaigns. You can still create a campaign by hand.');
  const ctx = await withTenant(pools.app, tenantId, async (c) => ({
    tags: (await c.query(`SELECT DISTINCT unnest(tags) AS t FROM contacts ORDER BY 1 LIMIT 60`)).rows.map((r) => r.t as string),
    platforms: [...new Set((await c.query(`SELECT type FROM channels WHERE status = 'connected' AND type = ANY($1::text[])`, [[...CAMPAIGN_PLATFORMS]])).rows.map((r) => r.type as string))],
  }));
  const user = input.current ? `Current draft:\n${JSON.stringify(input.current)}\n\nOwner's change request:\n${input.prompt}` : input.prompt;
  const res = await ai.complete({ tenantId, purpose: 'campaign_builder' }, {
    model: ai.defaultModel,
    messages: [{ role: 'system', content: SYSTEM({ today: new Date().toISOString().slice(0, 10), ...ctx }) }, { role: 'user', content: user.slice(0, 3000) }],
    temperature: 0.4, maxTokens: 900, json: true,
  });
  let raw: unknown;
  try { raw = extractJson(res.text); } catch { throw new AppError(502, 'ai_bad_response', 'The assistant did not return a usable draft. Try rephrasing, or create the campaign by hand.'); }
  const spec = specSchema.parse(raw ?? {});
  const warnings: string[] = [];
  const picked: Record<string, unknown> = {};
  for (const k of ALLOWED_KEYS) if (spec.audience[k] !== undefined && spec.audience[k] !== null) picked[k] = spec.audience[k];
  let audience: AudienceFilter = {};
  const parsed = audienceSchema.safeParse(picked);
  if (parsed.success) audience = normalizeFilter(parsed.data);
  else warnings.push('I could not fully understand the audience filter, so I left it open. Check the audience before approving.');
  // Tags must exist: a made-up tag would silently select nobody.
  const known = new Set(ctx.tags);
  for (const key of ['tagsAny', 'tagsAll'] as const) {
    const bad = audience[key]?.filter((t) => !known.has(t));
    if (bad?.length) { warnings.push(`The tag "${bad[0]}" does not exist yet, so I removed it from the audience.`); audience[key] = audience[key]!.filter((t) => known.has(t)); if (!audience[key]!.length) delete audience[key]; }
  }
  const ownerText = [input.prompt, input.current?.message ?? ''].join(' ');
  const invented = inventedNumbers(spec.message, ownerText);
  if (invented.length) warnings.push(`The draft contains numbers you did not mention (${invented.join(', ')}). Remove or confirm them before approving.`);
  return { name: spec.name, platform: spec.platform, audience, message: spec.message, improvements: spec.improvements, questions: spec.questions, warnings };
}
