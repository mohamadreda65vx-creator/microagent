import type { AiService } from '../ai/service.js';
import { extractJson } from '../ai/context.js';
import { ACTION_TYPES } from './catalog.js';
import { CATEGORY_OF, effectSchema, isEnforced, type Category, type Effect } from './effects.js';
import { normalizeText, parseNumber } from './text.js';

/**
 * Teach & Correct: turn a natural-language instruction into STRUCTURED effects.
 * 1) deterministic patterns (English + Arabic) — fast, free, predictable;
 * 2) optional AI classification, validated against the same schema (an invalid answer is discarded);
 * 3) otherwise an advisory "instruction" (the model is told, the backend cannot enforce it — the UI says so).
 * An instruction can only RESTRICT an employee. Anything that asks to GRANT power is refused here and must be done in the Permissions tab by an owner/admin.
 */
export interface Proposal {
  effect: Effect;
  category: Category;
  enforced: boolean;
  summary: string;
  via: 'pattern' | 'ai' | 'advisory';
}
export interface Classification {
  proposals: Proposal[];
  refused?: { code: 'needs_permission_change'; message: string };
}

const has = (t: string, ...res: RegExp[]) => res.some((r) => r.test(t));

const NEG = String.raw`(?<![\p{L}])(?:no|never|dont|don t|do not|stop|without|not allowed|cannot|can t|mustn t|avoid|ممنوع|مفيش|بلاش|ما?\s?تعمل\S*|ما?\s?تقدم\S*|ما?\s?تدي\S*|لا تقدم|لا تعط\S*|بدون|ايقاف|وقف)(?![\p{L}])`;

const describe = (e: Effect): string => {
  switch (e.type) {
    case 'prohibit_action': return `The employee will never perform "${e.action}".`;
    case 'dialect': return `The employee will answer in the ${e.value} dialect.`;
    case 'language': return `The employee will answer in ${e.value === 'ar' ? 'Arabic' : 'English'}.`;
    case 'tone': return `The employee will use a ${e.value} tone (advisory: wording only).`;
    case 'instruction': return `Advisory guidance for the model: "${e.text}". The backend cannot verify it.`;
    case 'require_approval': return `"${e.action}" will wait for a person's approval.`;
    case 'require_field': return `The employee must have the customer's ${e.field} before "${e.before_action}".`;
    case 'handoff_trigger': return e.trigger === 'angry_customer' ? 'Upset customers are handed to a human immediately.' : 'Customers who ask for a person are handed to a human.';
    case 'require_inventory_check': return 'The employee must check inventory before answering about availability (no inventory source is connected yet, so it will say it needs to check with the team).';
    case 'knowledge_fact': return `Adds the fact "${e.name}"${e.price !== undefined ? ` at ${e.price}${e.currency ? ' ' + e.currency : ''}` : ''} to the confirmed business knowledge.`;
  }
};

function make(effect: Effect, via: Proposal['via']): Proposal {
  return { effect, category: CATEGORY_OF[effect.type], enforced: isEnforced(effect), summary: describe(effect), via };
}

export function classifyByPatterns(instruction: string): Effect[] {
  const t = normalizeText(instruction).replace(/['’]/g, ' ');
  const out: Effect[] = [];
  const push = (e: Effect) => { if (!out.some((x) => JSON.stringify(x) === JSON.stringify(e))) out.push(e); };

  // behaviour: no discounts
  if (has(t, new RegExp(`${NEG}[^.]{0,40}(discount|discounts|offer a discount|خصم|خصومات|تخفيض)`, 'u'), /(discount|خصم|خصومات)[^.]{0,20}(ممنوع|not allowed|forbidden)/)) push({ type: 'prohibit_action', action: 'give_discount' });
  if (has(t, new RegExp(`${NEG}[^.]{0,40}(refund|استرجاع|ارجاع فلوس|ريفند)`, 'u'))) push({ type: 'prohibit_action', action: 'issue_refund' });

  // workflow: phone before order / booking
  const askPhone = has(t, /(collect|get|ask|need|require|take|capture)[^.]{0,30}(phone|number|mobile)/, /(اجمع|خد|اطلب|لازم|محتاج|هات|سجل)[^.]{0,30}(رقم|تليفون|هاتف|موبايل|الهاتف)/);
  if (askPhone && has(t, /(before|prior to|first)[^.]{0,30}(order|orders|booking|reservation)/, /(order|booking)[^.]{0,30}(after|once)/, /قبل[^.]{0,30}(طلب|اوردر|الاوردر|الطلب|حجز|الحجز)/)) {
    push({ type: 'require_field', field: 'phone', before_action: has(t, /(booking|reservation|حجز|الحجز)/) && !has(t, /(order|اوردر|طلب)/) ? 'create_booking' : 'create_order' });
  }
  // workflow: inventory
  if (has(t, /(check|verify|confirm|look up)[^.]{0,30}(inventory|stock|availability)[^.]{0,30}(before|prior)/, /(inventory|stock)[^.]{0,20}(before)/, /(اتاكد|تاكد|راجع|شوف|اتشيك|اشيك)[^.]{0,30}(مخزون|المخزون|المخزن|الكميه|الكميات)[^.]{0,30}قبل/)) push({ type: 'require_inventory_check' });

  // workflow: hand-off
  const angry = /(angry|upset|furious|frustrated|annoyed|rude|irate|عصبي|غضبان|غاضب|زعلان|متضايق|متعصب|مستفز)/;
  const human = /(human|person|agent|staff|manager|real person|موظف|بشري|حد من الفريق|انسان|المدير|مسؤول|مسوول|شخص)/;
  const handing = /(hand|transfer|escalate|route|pass|connect|send|حول|حوّل|سلم|وصل|ابعت|حوله|حولهم)/;
  if (has(t, angry) && has(t, human) && has(t, handing)) push({ type: 'handoff_trigger', trigger: 'angry_customer' });
  else if (has(t, angry) && has(t, handing)) push({ type: 'handoff_trigger', trigger: 'angry_customer' });
  if (has(t, /(asks?|wants?|requests?|needs?|prefers?)[^.]{0,20}(human|person|agent|someone|real person|representative)/, /(عايز|عاوز|طلب|يطلب|بيطلب|محتاج|يحب)[^.]{0,20}(موظف|حد|انسان|بشري|شخص|المدير)/) && has(t, handing)) push({ type: 'handoff_trigger', trigger: 'customer_requests_human' });

  // approvals
  if (has(t, /(approval|approve|confirm with me|ask me before)[^.]{0,40}(order|orders|booking|refund)/, /(order|orders|booking|refund)[^.]{0,40}(approval|approve)/, /(موافق\S*|اوافق|استاذن|استئذان)[^.]{0,30}(طلب|اوردر|حجز|استرجاع)/, /(طلب|اوردر|حجز|استرجاع)[^.]{0,30}(موافق\S*|اوافق)/)) {
    if (has(t, /(refund|استرجاع)/)) push({ type: 'require_approval', action: 'issue_refund' });
    if (has(t, /(booking|حجز)/)) push({ type: 'require_approval', action: 'create_booking' });
    if (has(t, /(order|orders|طلب|اوردر)/) && !has(t, /(booking|حجز)/)) push({ type: 'require_approval', action: 'create_order' });
  }

  // behaviour: dialect / language / tone
  if (has(t, /(egyptian|masri|مصري|مصريه|بالمصري|اللهجه المصريه)/)) push({ type: 'dialect', value: 'egyptian' });
  else if (has(t, /(gulf|khaleeji|خليجي|خليجيه|بالخليجي)/)) push({ type: 'dialect', value: 'gulf' });
  else if (has(t, /(levantine|shami|شامي|شاميه|بالشامي)/)) push({ type: 'dialect', value: 'levantine' });
  else if (has(t, /(maghrebi|moroccan|algerian|tunisian|مغربي|جزائري|تونسي)/)) push({ type: 'dialect', value: 'maghrebi' });
  else if (has(t, /(msa|modern standard|فصحي|فصحه|الفصحي)/)) push({ type: 'dialect', value: 'msa' });
  if (!out.some((e) => e.type === 'dialect')) {
    if (has(t, /(reply|answer|respond|speak|write)[^.]{0,20}in english/, /(رد|جاوب|اكتب|اتكلم)[^.]{0,20}(بالانجليزي|بالانجليزيه|انجليزي)/)) push({ type: 'language', value: 'en' });
    else if (has(t, /(reply|answer|respond|speak|write)[^.]{0,20}in arabic/, /(رد|جاوب|اكتب|اتكلم)[^.]{0,20}(بالعربي|بالعربيه|عربي)/)) push({ type: 'language', value: 'ar' });
  }
  if (has(t, /(formal|رسمي|رسميه)/) && !has(t, /(informal|غير رسمي)/)) push({ type: 'tone', value: 'formal' });
  else if (has(t, /(friendly|warm|ودود|ودوده|لطيف)/)) push({ type: 'tone', value: 'friendly' });
  else if (has(t, /(concise|short answers|brief|مختصر|مختصره|قصير)/)) push({ type: 'tone', value: 'concise' });

  // knowledge: "the cappuccino costs 60 EGP" / "سعر الكابتشينو 60 جنيه"
  if (out.length === 0) {
    const en = /^(?:the\s+|our\s+)?(.{2,80}?)\s+(?:now\s+)?(?:costs?|is priced at|is|price is|are)\s+(\d+(?:\.\d+)?)\s*([a-z]{2,4}|\$|€|£)?\s*$/i.exec(instruction.trim().replace(/[.!]+$/, ''));
    const ar = /^(?:ال)?سعر\s+(.{2,80}?)\s+(?:هو\s+|بقى\s+|بقي\s+|بقا\s+|=|:)?\s*(\d+(?:[.,]\d+)?)\s*(جنيه|ج\.?م|جنيها|ريال|درهم|دولار)?\s*$/.exec(normalizeText(instruction).trim().replace(/[.!؟]+$/, ''));
    const m = en ?? ar;
    if (m) {
      const price = parseNumber(m[2]!);
      const name = m[1]!.trim().replace(/^(the|our|ال)\s+/i, '');
      if (price !== null && name) push({ type: 'knowledge_fact', kind: 'product', name: name.slice(0, 300), price, ...(m[3] ? { currency: m[3].replace(/جنيها|ج\.?م/, 'EGP').toUpperCase().slice(0, 10) } : {}) });
    }
  }
  return out;
}

const PERMISSION_GRANT = [
  /(you can|you may|you re allowed|allowed to|feel free to|go ahead and|always|please)[^.]{0,30}(give|offer|issue|approve|grant)[^.]{0,30}(discount|refund)/,
  /(give|offer|grant)[^.]{0,20}(everyone|customers|them)[^.]{0,20}(discount|refund)/,
  /(مسموح|تقدر|ينفع|اديهم|اعطيهم|قدم)[^.]{0,30}(خصم|استرجاع)/,
];

export function asksToGrantPower(instruction: string): boolean {
  const t = normalizeText(instruction).replace(/['’]/g, ' ');
  if (new RegExp(NEG, 'u').test(t) && /(discount|refund|خصم|استرجاع)/.test(t)) return false;
  return PERMISSION_GRANT.some((r) => r.test(t));
}

const AI_SYSTEM = `Convert the business owner's instruction into zero or more effects. Return ONLY JSON: {"effects":[...]}.
Allowed effect shapes (use exactly these):
{"type":"prohibit_action","action":"${ACTION_TYPES.join('|')}"}
{"type":"require_approval","action":"<action>"}
{"type":"require_field","field":"phone|name|email","before_action":"<action>"}
{"type":"handoff_trigger","trigger":"angry_customer|customer_requests_human"}
{"type":"require_inventory_check"}
{"type":"dialect","value":"egyptian|gulf|levantine|maghrebi|msa"}
{"type":"language","value":"ar|en"}
{"type":"tone","value":"formal|friendly|concise"}
{"type":"knowledge_fact","kind":"product|service|offer|faq|business_info","name":"...","price":number,"currency":"...","text":"..."}
{"type":"instruction","text":"..."}   (use only when nothing else fits)
Never create an effect that GIVES the employee more power. If the instruction grants power, return {"effects":[]}.`;

export async function classify(instruction: string, ai: AiService | null, ctx: { tenantId: string; model?: string }): Promise<Classification> {
  if (asksToGrantPower(instruction)) {
    return { proposals: [], refused: { code: 'needs_permission_change', message: 'Teach & Correct can only add limits. To allow discounts, refunds or orders, change the employee’s Permissions (owner or admin).' } };
  }
  const pattern = classifyByPatterns(instruction);
  if (pattern.length) return { proposals: pattern.map((e) => make(e, 'pattern')) };

  if (ai?.configured) {
    try {
      const res = await ai.complete({ tenantId: ctx.tenantId, purpose: 'classification' }, { model: ctx.model ?? ai.defaultModel, messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: instruction.slice(0, 1000) }], temperature: 0, maxTokens: 500, json: true });
      const j = extractJson(res.text) as { effects?: unknown };
      if (Array.isArray(j.effects)) {
        const ok = j.effects.slice(0, 5).map((e) => effectSchema.safeParse(e)).filter((r) => r.success).map((r) => r.data!);
        if (ok.length) return { proposals: ok.map((e) => make(e, 'ai')) };
      }
    } catch {
      /* AI unavailable or malformed → advisory fallback below */
    }
  }
  const text = instruction.trim().slice(0, 500);
  if (text.length < 3) return { proposals: [] };
  return { proposals: [make({ type: 'instruction', text }, 'advisory')] };
}
