/** Text helpers shared by retrieval, guards and the Teach & Correct classifier. Arabic-aware. */

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String(AR_DIGITS.includes(d) ? AR_DIGITS.indexOf(d) : FA_DIGITS.indexOf(d)));
}

/** For MATCHING only (never shown to users): lowercase, no diacritics/tatweel, unified alef/yaa/taa-marbuta/hamza forms, ASCII digits. */
export function normalizeText(s: string): string {
  return normalizeDigits(s)
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

export function arabicRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const ar = s.match(/[؀-ۿ]/g) ?? [];
  return ar.length / letters.length;
}

export type Lang = 'ar' | 'en';
export const detectLang = (s: string): Lang => (arabicRatio(s) >= 0.4 ? 'ar' : 'en');

export const normKey = (name: string): string =>
  normalizeText(name)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'for', 'in', 'on', 'is', 'are', 'do', 'you', 'have', 'how', 'much', 'what', 'with', 'your', 'can', 'i', 'me', 'my', 'it', 'this', 'that',
  'في', 'من', 'على', 'الي', 'عن', 'هل', 'ما', 'ماذا', 'كم', 'ايه', 'ازاي', 'عندكم', 'عندك', 'انا', 'هذا', 'هذه', 'ده', 'دي', 'لو', 'مع', 'او', 'و',
]);

/** Tokens for keyword retrieval. Strips the Arabic definite article so "القهوة" matches "قهوه". */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(s).split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    let t = raw;
    if (t.length > 4 && t.startsWith('ال')) t = t.slice(2);
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

export function normalizePhone(raw: string): string | null {
  const digits = normalizeDigits(raw).replace(/[^\d+]/g, '');
  const plain = digits.replace(/^\+/, '');
  return /^\d{8,15}$/.test(plain) ? digits : null;
}

/** Find a phone number inside free text (customer message). */
export function findPhone(text: string): string | null {
  const m = normalizeDigits(text).match(/\+?\d[\d\s\-()]{6,18}\d/);
  return m ? normalizePhone(m[0]) : null;
}

export function parseNumber(raw: string): number | null {
  const cleaned = normalizeDigits(raw).replace(/[,٬\s]/g, '').replace(/٫/g, '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
