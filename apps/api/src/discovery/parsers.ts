import * as cheerio from 'cheerio';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export interface ParsedContent {
  ref: string;
  title: string;
  content: string;
  publishedAt?: Date | null;
}

const MAX_CONTENT = 250_000;
const clean = (s: string) => s.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CONTENT);

export function htmlToText(html: string, baseUrl: string): { title: string; text: string; links: string[] } {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, nav, footer, form').remove();
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  const links = new Set<string>();
  const base = new URL(baseUrl);
  $('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href')!, base);
      if (u.origin === base.origin && /^https?:$/.test(u.protocol)) {
        u.hash = '';
        links.add(u.toString());
      }
    } catch {
      /* ignore malformed links */
    }
  });
  const meta = $('meta[name="description"]').attr('content') ?? '';
  // keep line breaks between blocks so prices stay next to their product names
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article').each((_, el) => { $(el).append('\n'); });
  const text = clean(`${meta}\n${$('body').text()}`);
  return { title, text, links: [...links] };
}

export async function pdfToText(buf: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return clean(text);
}

export async function docxToText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return clean(value);
}

/* ───────── tables (CSV / Excel) ───────── */
export type Table = { headers: string[]; rows: string[][] };

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const t = text.replace(/^﻿/, '');
  const delim = (t.split('\n', 1)[0] ?? '').includes(';') && !(t.split('\n', 1)[0] ?? '').includes(',') ? ';' : ',';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > 5000) break;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export async function excelToRows(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n > 5000) return;
    const vals: string[] = [];
    r.eachCell({ includeEmpty: true }, (cell, col) => {
      const v = cell.value as unknown;
      let s = '';
      if (v === null || v === undefined) s = '';
      else if (typeof v === 'object' && v !== null && 'result' in v) s = String((v as { result: unknown }).result ?? '');
      else if (typeof v === 'object' && v !== null && 'text' in v) s = String((v as { text: unknown }).text ?? '');
      else if (v instanceof Date) s = v.toISOString();
      else s = String(v);
      vals[col - 1] = s;
    });
    rows.push(Array.from(vals, (x) => x ?? ''));
  });
  return rows;
}

export const toTable = (rows: string[][]): Table => ({ headers: (rows[0] ?? []).map((h) => h.trim()), rows: rows.slice(1) });

/** Plain text view of a table (used as source content so the evidence of each product is a real row). */
export const tableToText = (t: Table): string => t.rows.map((r) => t.headers.map((h, i) => `${h}: ${(r[i] ?? '').trim()}`).join(' | ')).join('\n');

/* ───────── social posts pasted/imported by the owner ───────── */
export interface Post { text: string; date: Date | null; url: string | null }

export function parsePosts(input: string): Post[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(j) ? j : Array.isArray((j as { posts?: unknown }).posts) ? (j as { posts: unknown[] }).posts : [];
      return arr
        .map((p): Post | null => {
          if (typeof p === 'string') return { text: p, date: null, url: null };
          if (!p || typeof p !== 'object') return null;
          const o = p as Record<string, unknown>;
          const text = String(o.text ?? o.message ?? o.caption ?? o.content ?? '');
          const d = o.date ?? o.created_time ?? o.created_at ?? o.timestamp ?? null;
          const date = d ? new Date(String(d)) : null;
          return { text, date: date && !Number.isNaN(date.getTime()) ? date : null, url: typeof o.url === 'string' ? o.url : typeof o.permalink === 'string' ? o.permalink : null };
        })
        .filter((p): p is Post => !!p && p.text.trim().length > 0);
    } catch {
      /* fall through to plain text */
    }
  }
  // plain text: posts separated by a line with --- (or two blank lines). An optional first line "date: YYYY-MM-DD" gives the date.
  return trimmed
    .split(/\n\s*-{3,}\s*\n|\n\s*\n\s*\n/)
    .map((block) => {
      const m = /^\s*(?:date|التاريخ)\s*:\s*(\d{4}-\d{2}-\d{2}(?:[T ][\d:]+Z?)?)\s*\n/i.exec(block);
      const date = m ? new Date(m[1]!) : null;
      return { text: (m ? block.slice(m[0].length) : block).trim(), date: date && !Number.isNaN(date.getTime()) ? date : null, url: null };
    })
    .filter((p) => p.text.length > 0);
}
