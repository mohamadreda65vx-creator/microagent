import type { Config } from '../config/env.js';
import { AiError, type LlmProvider, type LlmRequest, type LlmResult, type ModelInfo } from './types.js';

type AiConfig = Config['ai'];

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; error?: { code?: number | string; message?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  error?: { code?: number | string; message?: string };
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const MAX_RETRY_AFTER_MS = 8_000;

function mapStatus(status: number): AiError['aiCode'] {
  if (status === 401 || status === 403) return 'ai_auth';
  if (status === 402) return 'ai_insufficient_credits';
  if (status === 408 || status === 504) return 'ai_timeout';
  if (status === 429) return 'ai_rate_limited';
  if (status >= 500) return 'ai_unavailable';
  return 'ai_bad_request';
}

export interface OpenRouterOptions {
  fetchImpl?: typeof fetch;
  appUrl: string;
  sleep?: (ms: number) => Promise<void>;
  log?: { warn: (o: unknown, m?: string) => void };
}

/**
 * OpenRouter client (OpenAI-compatible chat completions).
 *  - hard timeout per attempt
 *  - retries with exponential backoff + jitter on timeouts, network errors, 408/409/425/429/5xx (honours Retry-After)
 *  - never retries auth / credit / bad-request errors (retrying cannot fix them)
 *  - reads tokens and the provider-reported cost; never invents a cost
 */
export class OpenRouterProvider implements LlmProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: AiConfig,
    private readonly opts: OpenRouterOptions,
  ) {
    if (!cfg.apiKey) throw new AiError('ai_not_configured');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.opts.appUrl,
      'X-Title': 'MicroAgent',
    };
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const header = retryAfter ? Number(retryAfter) * 1000 : NaN;
    if (Number.isFinite(header) && header >= 0) return Math.min(header, MAX_RETRY_AFTER_MS);
    const base = this.cfg.retryBaseMs * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * Math.max(1, this.cfg.retryBaseMs / 2));
  }

  async chat(req: LlmRequest): Promise<LlmResult> {
    const started = Date.now();
    const maxAttempts = this.cfg.maxRetries + 1;
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 1200,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      usage: { include: true },
    });

    let last: AiError = new AiError('ai_unavailable');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let retryAfter: string | null = null;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body, signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) {
          const parsed = this.parse((await res.json().catch(() => null)) as ChatResponse | null, req.model, started, attempt);
          if (!(parsed instanceof AiError)) return parsed;
          last = parsed;
        } else {
          retryAfter = res.headers.get('retry-after');
          const detail = (await res.text().catch(() => '')).slice(0, 300);
          last = new AiError(mapStatus(res.status), attempt, `HTTP ${res.status} ${detail}`, RETRYABLE_STATUS.has(res.status));
        }
      } catch (err) {
        const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        last = new AiError(aborted ? 'ai_timeout' : 'ai_unavailable', attempt, err instanceof Error ? err.message : 'network error', true);
      }
      if (!last.retryable) throw last;
      if (attempt < maxAttempts) {
        this.opts.log?.warn({ attempt, code: last.aiCode }, 'ai provider call failed, retrying');
        await this.sleep(this.backoff(attempt, retryAfter));
      }
    }
    throw new AiError(last.aiCode, maxAttempts, last.detail, true);
  }

  private parse(data: ChatResponse | null, requestedModel: string, started: number, attempt: number): LlmResult | AiError {
    if (!data) return new AiError('ai_bad_response', attempt, 'empty body', true);
    const inner = data.error ?? data.choices?.[0]?.error;
    if (inner) {
      // OpenRouter can return HTTP 200 with an error object inside. Retry only when the code looks transient.
      const code = Number(inner.code);
      const known = Number.isFinite(code);
      return new AiError(known ? mapStatus(code) : 'ai_unavailable', attempt, `provider error ${inner.code ?? ''} ${inner.message ?? ''}`.slice(0, 300), known ? RETRYABLE_STATUS.has(code) : true);
    }
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') return new AiError('ai_bad_response', attempt, 'empty completion', true);
    const u = data.usage ?? {};
    const prompt = Number(u.prompt_tokens) || 0;
    const completion = Number(u.completion_tokens) || 0;
    return {
      text,
      model: data.model ?? requestedModel,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: Number(u.total_tokens) || prompt + completion,
      costUsd: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null,
      latencyMs: Date.now() - started,
      attempts: attempt,
      requestId: data.id,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(this.cfg.timeoutMs, 10_000));
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/models`, { headers: this.headers(), signal: ctrl.signal });
      if (!res.ok) throw new AiError(mapStatus(res.status), 1);
      const data = (await res.json()) as { data?: Array<{ id?: string; name?: string; context_length?: number }> };
      return (data.data ?? [])
        .filter((m): m is { id: string; name?: string; context_length?: number } => typeof m.id === 'string')
        .map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length }));
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError('ai_unavailable', 1, err instanceof Error ? err.message : 'network error');
    } finally {
      clearTimeout(timer);
    }
  }
}
