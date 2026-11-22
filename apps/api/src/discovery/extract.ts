import { createHash } from 'node:crypto';
import type { AiService } from '../ai/service.js';
import { extractJson } from '../ai/context.js';
import type { Client } from '../db/pool.js';
import { numbersIn } from '../agent/guards.js';
import { normKey, normalizeText, parseNumber } from '../agent/text.js';
import type { Table } from './parsers.js';

export const KINDS = ['product', 'service', 'offer', 'faq', 'business_info', 'audience'] as const;
export type Kind = (typeof KINDS)[number];

export interface Candidate {
  kind: Kind;
  name: string;
  data: Record<string, unknown>;
  evidence: string;
  contentIndex: number;
}

export const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/* ───────── deterministic extraction from a table (no AI, nothing invented) ───────── */
const HEADERS: Record<string, string[]> = {
  name: ['name', 'product', 'item', 'title', 'service', 'اسم', 'الاسم', 'المنتج', 'منتج', 'الصنف', 'صنف', 'الخدمه', 'خدمه', 'البند', 'اسم المنتج', 'اسم الصنف', 'اسم الخدمه', 'اسم البند', 'product name', 'item name', 'service name'],
  price: ['price', 'cost', 'amount', 'سعر', 'السعر', 'ثمن', 'التكلفه', 'الاجمالي'],
  currency: ['currency', 'عمله', 'العمله'],
  category: ['category', 'type', 'group', 'قسم', 'القسم', 'الفئه', 'فئه', 'التصنيف', 'تصنيف'],
  description: ['description', 'details', 'desc', 'وصف', 'الوصف', 'تفاصيل', 'التفاصيل'],
  sku: ['sku', 'code', 'كود', 'الكود', 'رقم الصنف'],
};

function mapHeaders(headers: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  headers.forEach((h, i) => {
    const n = normalizeText(h);
    for (const [field, names] of Object.entries(HEADERS)) if (!(field in out) && names.some((x) => n === normalizeText(x))) out[field] = i;
  });
  return out;
}

export function extractFromTable(table: Table, defaultKind: 'product' | 'service' = 'product'): { candidates: Candidate[]; skipped: number; problem?: string } {
  const map = mapHeaders(table.headers);
  if (map.name === undefined) return { candidates: [], skipped: table.rows.length, problem: 'No name column found. Use a header like "name", "product" or "اسم المنتج".' };
  const candidates: Candidate[] = [];
  let skipped = 0;
  table.rows.forEach((r, idx) => {
    const name = (r[map.name!] ?? '').trim();
    if (!name) { skipped++; return; }
    const data: Record<string, unknown> = {};
    if (map.price !== undefined) {
      const raw = (r[map.price] ?? '').trim();
      const p = raw ? parseNumber(normalizeText(raw).replace(/\b(?:egp|usd|sar|aed|eur|kwd|qar|l\.?e\.?)\b|[$€£]|جنيه[اات]*|ج\.م|ريال|درهم|دولار|دينار/gi, '').trim()) : null; // a range like "10-20" stays unparsed (no guessing)
      if (p !== null && p >= 0) data.price = p; // unparseable or empty price → NO price (never guessed)
    }
    for (const f of ['currency', 'category', 'description', 'sku'] as const) if (map[f] !== undefined && (r[map[f]!] ?? '').trim()) data[f] = (r[map[f]!] ?? '').trim().slice(0, 500);
    const evidence = table.headers.map((h, i) => `${h}: ${(r[i] ?? '').trim()}`).join(' | ').slice(0, 1000);
    candidates.push({ kind: defaultKind, name: name.slice(0, 300), data, evidence, contentIndex: idx });
  });
  return { candidates, skipped };
}

/* ───────── AI extraction with evidence validation ───────── */
const SYSTEM = `You extract structured business facts from text written by a business (website, social posts, documents).
Return ONLY JSON: {"items":[{"kind":"product|service|offer|faq|business_info|audience","name":"...","price":number|null,"currency":"..."|null,"percent":number|null,"description":"..."|null,"question":"..."|null,"answer":"..."|null,"text":"..."|null,"evidence":"exact quote from the text","post":number}]}
Rules:
- "evidence" MUST be copied word for word from the text. If you cannot quote it, do not output the item.
- NEVER invent or estimate a price, discount or stock. Set price to null unless the text states it next to the item.
- Do not output stock or availability.
- kind=business_info is for hours, address, phone, delivery, payment methods (name = the label, text = the value).
- kind=audience is for who the business serves. kind=offer is for promotions (set percent only if the text says it).
- "post" is the number of the [#n] block the quote comes from.`;

export function validate(raw: unknown, texts: string[]): { items: Candidate[]; rejected: number; pricesDropped: number } {
  const items: Candidate[] = [];
  let rejected = 0;
  let pricesDropped = 0;
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items) : [];
  const normTexts = texts.map(normalizeText);
  for (const r of list.slice(0, 200)) {
    if (!r || typeof r !== 'object') { rejected++; continue; }
    const o = r as Record<string, unknown>;
    const kind = o.kind as Kind;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 300) : '';
    const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
    if (!KINDS.includes(kind) || !name || evidence.length < 3) { rejected++; continue; }
    const ne = normalizeText(evidence);
    // The quote must really exist in the source. This is what stops the model from inventing facts.
    let idx = typeof o.post === 'number' && normTexts[o.post] !== undefined && normTexts[o.post]!.includes(ne) ? o.post : normTexts.findIndex((t) => t.includes(ne));
    if (idx < 0) { rejected++; continue; }
    const data: Record<string, unknown> = {};
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    if (str(o.description, 600)) data.description = str(o.description, 600);
    if (str(o.currency, 10)) data.currency = str(o.currency, 10);
    if (typeof o.price === 'number' && o.price > 0) {
      // a price is kept only if that number is literally in the quote
      if (numbersIn(evidence).some((n) => Math.abs(n - (o.price as number)) < 0.005)) data.price = o.price;
      else pricesDropped++;
    }
    if (typeof o.percent === 'number' && numbersIn(evidence).includes(o.percent)) data.percent = o.percent;
    if (kind === 'faq') {
      const q = str(o.question, 400), a = str(o.answer, 1000);
      if (!q || !a) { rejected++; continue; }
      data.question = q; data.answer = a;
    }
    if (kind === 'business_info' || kind === 'audience') {
      const t = str(o.text, 600) ?? str(o.description, 600);
      if (!t) { rejected++; continue; }
      data.text = t;
    }
    items.push({ kind, name, data, evidence: evidence.slice(0, 1000), contentIndex: idx });
  }
  return { items, rejected, pricesDropped };
}

export async function extractWithAi(ai: AiService, ctx: { tenantId: string; model?: string }, texts: string[]): Promise<{ items: Candidate[]; rejected: number; pricesDropped: number }> {
  const body = texts.map((t, i) => `[#${i}]\n${t.slice(0, 5000)}`).join('\n\n');
  const res = await ai.complete(
    { tenantId: ctx.tenantId, purpose: 'extraction' },
    { model: ctx.model ?? ai.defaultModel, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: body }], temperature: 0, maxTokens: 2500, json: true },
  );
  let parsed: unknown;
  try {
    parsed = extractJson(res.text);
  } catch {
    return { items: [], rejected: 0, pricesDropped: 0 };
  }
  return validate(parsed, texts.map((t) => t.slice(0, 5000)));
}

/** Split long text into chunks on line boundaries. */
export function chunkText(text: string, size = 5000, maxChunks = 6): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size && cur) { out.push(cur); cur = ''; if (out.length >= maxChunks) return out; }
    cur += (cur ? '\n' : '') + line.slice(0, size);
  }
  if (cur && out.length < maxChunks) out.push(cur);
  return out;
}

/* ───────── saving ───────── */
export interface SaveMeta { sourceId: string; sourceRef: string; sourceDate: Date | null }

/** Store candidates as UNCONFIRMED items. Never recreates something the owner already rejected or that already exists. */
export async function saveCandidates(c: Client, tenantId: string, cands: Array<Candidate & SaveMeta>): Promise<{ created: number; duplicates: number }> {
  let created = 0, duplicates = 0;
  for (const k of cands) {
    const nk = normKey(k.name);
    if (!nk) continue;
    const price = typeof k.data.price === 'number' ? k.data.price : null;
    const dup = await c.query(
      `SELECT 1 FROM knowledge_items WHERE kind = $1 AND norm_key = $2
         AND ($3::numeric IS NULL AND NOT (data ? 'price') OR (data->>'price')::numeric = $3::numeric)
         AND ($1 NOT IN ('faq','business_info','audience') OR data = $4::jsonb) LIMIT 1`,
      [k.kind, nk, price, JSON.stringify(k.data)],
    );
    if (dup.rowCount) { duplicates++; continue; }
    await c.query(
      `INSERT INTO knowledge_items (tenant_id, source_id, kind, name, norm_key, data, evidence, source_ref, source_date, origin, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'extracted','unconfirmed')`,
      [tenantId, k.sourceId, k.kind, k.name, nk, JSON.stringify(k.data), k.evidence, k.sourceRef.slice(0, 1000), k.sourceDate],
    );
    created++;
  }
  return { created, duplicates };
}
