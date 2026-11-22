import type { ChatMessage } from './types.js';

/**
 * Context management. Models have limited context windows and cost money per token, so we:
 *  - estimate tokens (Arabic and mixed text are heavier than English: use a conservative 3 chars/token),
 *  - keep the system prompt and the newest turns, dropping the oldest turns first,
 *  - cap any single message so one huge paste cannot crowd everything else out.
 */
export const CHARS_PER_TOKEN = 3;
export const DEFAULT_INPUT_BUDGET_TOKENS = 12_000;
export const MAX_MESSAGE_CHARS = 4_000;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export function truncate(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface FitResult {
  messages: ChatMessage[];
  droppedTurns: number;
  estimatedTokens: number;
}

/** `system` is always kept. `history` is oldest→newest and its last item (the customer's newest message) is always kept. */
export function fitConversation(system: string, history: ChatMessage[], budgetTokens = DEFAULT_INPUT_BUDGET_TOKENS): FitResult {
  const sys = estimateTokens(system);
  const clipped = history.map((m) => ({ ...m, content: truncate(m.content) }));
  const kept: ChatMessage[] = [];
  let used = sys;
  for (let i = clipped.length - 1; i >= 0; i--) {
    const cost = estimateTokens(clipped[i]!.content) + 4;
    if (kept.length > 0 && used + cost > budgetTokens) break;
    kept.unshift(clipped[i]!);
    used += cost;
  }
  return { messages: [{ role: 'system', content: system }, ...kept], droppedTurns: clipped.length - kept.length, estimatedTokens: used };
}

/** Pull one JSON object out of a model answer (handles ```json fences and chatter around the object). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no_json_object');
  return JSON.parse(candidate.slice(start, end + 1));
}
