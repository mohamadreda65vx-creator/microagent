import { arabicRatio, normalizeText, parseNumber, type Lang } from './text.js';

/**
 * Output guards: deterministic checks on what the employee is about to SAY.
 * The model's answer is never trusted blindly: an invented price, a stock claim or an unapproved discount is
 * caught here and replaced by a safe answer. These are heuristics over text (documented limits in docs/ARCHITECTURE.md),
 * layered on top of the Policy Engine which governs actions.
 */
export interface GuardFinding {
  code: 'price_not_in_knowledge' | 'stock_claim' | 'unapproved_discount' | 'language_mismatch';
  severity: 'block' | 'warn';
  message: string;
  evidence?: string;
}

/* ───────── prices ───────── */
const CUR = String.raw`(?:egp|usd|sar|aed|eur|gbp|kwd|qar|bhd|omr|(?<![a-z])l\.?e\.?(?![a-z])|\$|€|£|جنيه(?:ا|ات)?|ج\.م|ريال|ر\.س|درهم|دولار|دينار)`;
const NUM = String.raw`(\d{1,3}(?:[,٬]\d{3})+(?:[.٫]\d+)?|\d+(?:[.٫]\d+)?)`;
const PRICE_AFTER = new RegExp(`${NUM}\\s*${CUR}`, 'giu');
const PRICE_BEFORE = new RegExp(`${CUR}\\s*${NUM}`, 'giu');

export function findPriceClaims(text: string): number[] {
  const t = normalizeText(text);
  const out: number[] = [];
  for (const re of [PRICE_AFTER, PRICE_BEFORE]) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const n = parseNumber(m[1] ?? '');
      if (n !== null) out.push(n);
    }
  }
  return out;
}

export function numbersIn(text: string): number[] {
  return [...normalizeText(text).matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => parseNumber(m[0])).filter((n): n is number => n !== null);
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * A price in a reply is acceptable if it is a confirmed price, a number the customer said, or a TOTAL derived from the facts
 * used in this very answer: quantity × price (the quantity must come from the customer) or a sum of two of those prices.
 */
export function priceIsKnown(value: number, known: number[], customerNumbers: number[], derivedFrom: number[] = known): boolean {
  if (customerNumbers.some((n) => close(n, value))) return true;
  if (known.some((k) => close(k, value))) return true;
  const base = [...new Set(derivedFrom)].slice(0, 40);
  for (const k of base) for (const q of customerNumbers) if (Number.isInteger(q) && q >= 2 && q <= 50 && close(k * q, value)) return true;
  for (let i = 0; i < base.length; i++) for (let j = i; j < base.length; j++) if (close(base[i]! + base[j]!, value)) return true;
  return false;
}

/* ───────── stock ───────── */
const STOCK_EN = /\b(in stock|out of stock|sold out|back in stock|limited stock|currently available|available now|only \d+ (?:left|remaining)|\d+ (?:units?|pieces?|items?) (?:left|available|in stock|remaining))\b/;
const STOCK_AR = /(متوفر|متوفره|نفذت الكميه|نفذ المخزون|خلصت الكميه|خلصت من|مخزون|متاح حاليا|متاحه حاليا)/;

export function claimsStock(text: string): string | null {
  const t = normalizeText(text);
  return STOCK_EN.exec(t)?.[0] ?? STOCK_AR.exec(t)?.[0] ?? null;
}

/* ───────── discounts ───────── */
const DISCOUNT_WORDS = /(discount|\boff\b|deal|promo|coupon|voucher|خصم|تخفيض|عرض|كوبون|بروموكود)/;
const PERCENT = /(\d+(?:[.,]\d+)?)\s*(?:%|٪|percent|بالمية|في المية|بالمائه)/g;
const DISCOUNT_NUMBER = /(?:discount|خصم|تخفيض)\s*(?:of|بقيمه|قدره)?\s*(\d+(?:[.,]\d+)?)/g;

export function discountPercentClaims(text: string): number[] {
  const out: number[] = [];
  for (const sentence of normalizeText(text).split(/[.!?؟\n]+/)) {
    if (!DISCOUNT_WORDS.test(sentence)) continue;
    for (const re of [PERCENT, DISCOUNT_NUMBER]) {
      re.lastIndex = 0;
      for (const m of sentence.matchAll(re)) {
        const n = parseNumber(m[1] ?? '');
        if (n !== null) out.push(n);
      }
    }
  }
  return out;
}

export interface ReplyCheckOptions {
  knownPrices: number[];
  /** Prices of the facts used in THIS answer (totals may be derived from these). */
  derivedFrom?: number[];
  customerNumbers: number[];
  /** Percentages that appear in CONFIRMED offers (so quoting a real offer is fine). */
  knownPercents: number[];
  /** Highest discount % the employee may state (0 when discounts are denied or need approval). */
  maxDiscountPercent: number;
  inventoryConnected: boolean;
  expectedLanguage?: Lang | null;
}

export function checkReply(reply: string, o: ReplyCheckOptions): GuardFinding[] {
  const findings: GuardFinding[] = [];

  for (const price of findPriceClaims(reply)) {
    if (!priceIsKnown(price, o.knownPrices, o.customerNumbers, o.derivedFrom ?? o.knownPrices)) {
      findings.push({ code: 'price_not_in_knowledge', severity: 'block', message: `The reply states a price (${price}) that is not in the confirmed business knowledge.`, evidence: String(price) });
    }
  }

  for (const pct of discountPercentClaims(reply)) {
    if (pct > o.maxDiscountPercent && !o.knownPercents.some((k) => close(k, pct))) {
      findings.push({ code: 'unapproved_discount', severity: 'block', message: `The reply offers a ${pct}% discount, which this employee is not allowed to give.`, evidence: `${pct}%` });
    }
  }

  if (!o.inventoryConnected) {
    const hit = claimsStock(reply);
    if (hit) findings.push({ code: 'stock_claim', severity: 'block', message: 'The reply makes a statement about stock or availability, but no inventory source is connected.', evidence: hit });
  }

  if (o.expectedLanguage && reply.replace(/[^\p{L}]/gu, '').length >= 12) {
    const ratio = arabicRatio(reply);
    if ((o.expectedLanguage === 'ar' && ratio < 0.3) || (o.expectedLanguage === 'en' && ratio > 0.3)) {
      findings.push({ code: 'language_mismatch', severity: 'warn', message: `The reply is not written in the required language (${o.expectedLanguage}).` });
    }
  }
  return findings;
}

/* ───────── customer intent detection (used to enforce hand-off rules in code) ───────── */
const ANGRY_EN = /\b(angry|furious|outraged|unacceptable|ridiculous|terrible|horrible|disgusting|worst|scam|fraud|rip.?off|waste of (?:time|money)|sick of|fed up|never again|complaint|complain|lawsuit|useless)\b/;
const ANGRY_AR = /(غاضب|مستفز|غير مقبول|مش مقبول|مش معقول|اسوا|سيء|وحش|قرف|نصب|نصابين|حرامي|حراميه|هرفع شكوي|شكوي|زهقت|كارثه|زباله|ضحك عليا|بتضحكوا عليا|عايز اشتكي|عاوز اشتكي)/;
const HUMAN_EN = /\b(human|real person|live agent|representative|manager|(?:speak|talk) (?:to|with) (?:a |an |the )?(?:person|agent|someone|human|manager))\b/;
const HUMAN_AR = /(موظف|شخص حقيقي|بشري|المدير|مسوول|ممثل خدمه|كلم حد|اكلم حد|اتكلم مع|عايز اكلم|عاوز اكلم|حد من الفريق)/;

export const detectAngry = (text: string): boolean => {
  const t = normalizeText(text);
  return ANGRY_EN.test(t) || ANGRY_AR.test(t);
};
export const asksForHuman = (text: string): boolean => {
  const t = normalizeText(text);
  return HUMAN_EN.test(t) || HUMAN_AR.test(t);
};

/* ───────── safe replies (used when the model's own text must not be sent) ───────── */
export type SafeKind = 'discount_denied' | 'approval_pending' | 'missing_field' | 'handoff_upset' | 'handoff_request' | 'price_unknown' | 'stock_unknown' | 'action_denied' | 'invalid_request';

const FIELD_LABEL: Record<string, Record<'ar' | 'en', string>> = {
  phone: { ar: 'رقم هاتفك', en: 'your phone number' },
  name: { ar: 'اسمك', en: 'your name' },
  email: { ar: 'بريدك الإلكتروني', en: 'your email' },
};

export function safeReply(kind: SafeKind, lang: Lang, egyptian = false, field = 'phone'): string {
  const f = FIELD_LABEL[field] ?? FIELD_LABEL.phone!;
  const T: Record<SafeKind, { en: string; msa: string; egy: string }> = {
    discount_denied: {
      en: "I'm sorry, I'm not able to offer discounts. Is there anything else I can help with?",
      msa: 'عذرًا، لا أستطيع تقديم خصومات. هل أستطيع مساعدتك في أمر آخر؟',
      egy: 'للأسف مقدرش أقدم خصومات. تحب أساعدك في حاجة تانية؟',
    },
    approval_pending: {
      en: "I've sent your request to the team for confirmation and we'll get back to you shortly.",
      msa: 'تم إرسال طلبك إلى الفريق للتأكيد وسنعود إليك قريبًا.',
      egy: 'تمام، بعتّ طلبك للفريق للتأكيد وهنرجعلك قريب.',
    },
    missing_field: {
      en: `To continue I need ${f.en}. Could you share it?`,
      msa: `لإكمال الطلب أحتاج إلى ${f.ar}. هل يمكنك إرساله؟`,
      egy: `عشان أكمّل الطلب محتاج ${f.ar}. ممكن تبعته؟`,
    },
    handoff_upset: {
      en: "I'm sorry about this experience. I'm connecting you with a member of our team now.",
      msa: 'نعتذر عن ذلك، سأحوّلك الآن إلى أحد أفراد فريقنا ليساعدك.',
      egy: 'حقك علينا، هحولك لحد من فريقنا دلوقتي عشان يساعدك.',
    },
    handoff_request: {
      en: "Sure, I'm connecting you with a member of our team now.",
      msa: 'حسنًا، سأحوّلك الآن إلى أحد أفراد فريقنا.',
      egy: 'تمام، هحولك لحد من فريقنا دلوقتي.',
    },
    price_unknown: {
      en: "I'm not sure about that price right now. I'll check with the team and get back to you.",
      msa: 'لست متأكدًا من السعر حاليًا، سأراجعه مع الفريق وأعود إليك.',
      egy: 'مش متأكد من السعر ده دلوقتي، هراجعه مع الفريق وأرجعلك.',
    },
    stock_unknown: {
      en: "I can't confirm availability right now. I'll check with the team and get back to you.",
      msa: 'لا أستطيع تأكيد التوفر حاليًا، سأراجع الأمر مع الفريق وأعود إليك.',
      egy: 'مش أقدر أأكد التوافر دلوقتي، هراجع مع الفريق وأرجعلك.',
    },
    action_denied: {
      en: "I'm sorry, I can't do that myself. I can connect you with a member of our team if you like.",
      msa: 'عذرًا، لا أستطيع تنفيذ ذلك بنفسي. يمكنني تحويلك إلى أحد أفراد الفريق إن أردت.',
      egy: 'للأسف مقدرش أنفذ ده بنفسي. ممكن أحولك لحد من الفريق لو تحب.',
    },
    invalid_request: {
      en: 'Could you tell me a bit more about what you need?',
      msa: 'هل يمكنك توضيح طلبك أكثر؟',
      egy: 'ممكن توضحلي طلبك أكتر؟',
    },
  };
  const row = T[kind];
  return lang === 'en' ? row.en : egyptian ? row.egy : row.msa;
}
