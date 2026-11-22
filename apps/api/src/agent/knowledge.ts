import type { Client } from '../db/pool.js';
import { numbersIn } from './guards.js';
import { normalizeText, tokenize } from './text.js';
import { visibleSql, type EmployeeProfile } from './employee.js';

export interface KnowledgeItem {
  id: string;
  kind: 'product' | 'service' | 'offer' | 'faq' | 'business_info' | 'audience';
  name: string;
  data: Record<string, unknown>;
  evidence: string;
  sourceDate: string | null;
  origin: string;
}

/** Only CONFIRMED items, only those this employee may see. Rejected, outdated and unconfirmed facts never reach the model. */
export async function loadKnowledge(c: Client, e: EmployeeProfile): Promise<KnowledgeItem[]> {
  const { rows } = await c.query(
    `SELECT id, kind, name, data, evidence, source_date AS "sourceDate", origin FROM knowledge_items
     WHERE status = 'confirmed' AND ${visibleSql('$1', e.knowledgeMode)} ORDER BY kind, name LIMIT 2000`,
    [e.id],
  );
  return rows as KnowledgeItem[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const itemPrice = (i: KnowledgeItem): number | null => num(i.data.price);

export function knowledgePrices(items: KnowledgeItem[]): number[] {
  const out: number[] = [];
  for (const i of items) {
    const p = itemPrice(i);
    if (p !== null) out.push(p);
    // prices written in free text (e.g. an FAQ answer "delivery costs 30 EGP") count as known too
    if (i.kind === 'faq' || i.kind === 'business_info') out.push(...numbersIn(String(i.data.answer ?? i.data.text ?? i.data.description ?? '')));
    const tiers = i.data.prices;
    if (Array.isArray(tiers)) for (const t of tiers) if (t && typeof t === 'object') { const v = num((t as Record<string, unknown>).price); if (v !== null) out.push(v); }
  }
  return out;
}

export function knowledgePercents(items: KnowledgeItem[]): number[] {
  const out: number[] = [];
  for (const i of items) {
    if (i.kind !== 'offer') continue;
    const p = num(i.data.percent);
    if (p !== null) out.push(p);
    out.push(...[...normalizeText(`${i.name} ${String(i.data.description ?? '')}`).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|٪|percent|بالمية)/g)].map((m) => Number(m[1])));
  }
  return out;
}

function searchText(i: KnowledgeItem): string {
  const d = i.data;
  return [i.name, d.description, d.question, d.answer, d.text, d.category].filter((x) => typeof x === 'string').join(' ');
}

/** Items whose words actually match the customer's message (no fallback overview). Totals may only be derived from these. */
export function retrieveMatched(items: KnowledgeItem[], query: string): KnowledgeItem[] {
  const q = new Set(tokenize(query));
  return items.filter((i) => tokenize(`${i.name} ${searchText(i)}`).some((t) => q.has(t)));
}

/** Select the facts relevant to the customer's message (keyword overlap). Business info and offers are always kept short-listed. */
export function retrieve(items: KnowledgeItem[], query: string, limit = 14): KnowledgeItem[] {
  const q = new Set(tokenize(query));
  const scored = items.map((i) => {
    const toks = tokenize(searchText(i));
    let score = 0;
    for (const t of toks) if (q.has(t)) score += 1;
    for (const t of tokenize(i.name)) if (q.has(t)) score += 2;
    return { i, score };
  });
  const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.i);
  const always = items.filter((i) => i.kind === 'business_info' || i.kind === 'offer').slice(0, 6);
  const out = new Map<string, KnowledgeItem>();
  for (const i of matched.slice(0, limit)) out.set(i.id, i);
  for (const i of always) if (out.size < limit + 6) out.set(i.id, i);
  // nothing matched: give a small overview of the catalogue so the model can still ground a general answer
  if (matched.length === 0) for (const i of items.filter((x) => x.kind === 'product' || x.kind === 'service' || x.kind === 'faq').slice(0, 8)) out.set(i.id, i);
  return [...out.values()];
}

export function describeItem(i: KnowledgeItem): string {
  const d = i.data;
  const parts: string[] = [`[${i.kind}] ${i.name}`];
  const p = itemPrice(i);
  if (p !== null) parts.push(`price: ${p}${typeof d.currency === 'string' ? ' ' + d.currency : ''}`);
  if (typeof d.description === 'string' && d.description) parts.push(d.description);
  if (typeof d.question === 'string') parts.push(`Q: ${d.question}`);
  if (typeof d.answer === 'string') parts.push(`A: ${d.answer}`);
  if (typeof d.text === 'string') parts.push(d.text);
  return parts.join(' | ').slice(0, 600);
}
