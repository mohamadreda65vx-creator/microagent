import { ChannelError } from './types.js';

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  headers?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
  /** Strings that must never appear in error messages (tokens). */
  secrets?: string[];
}

export interface HttpResult<T = any> {
  status: number;
  data: T;
  buffer?: Buffer;
  contentType: string;
}

export function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length > 5) out = out.split(s).join('***');
  return out.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot***').replace(/access_token=[^&\s"]+/g, 'access_token=***').slice(0, 500);
}

/**
 * fetch with a timeout and errors classified for the retry logic:
 * network/timeout/429/5xx => retryable, other 4xx => permanent. Tokens are scrubbed from every message.
 * Returns the response for 2xx and for statuses listed in `okStatuses`.
 */
export async function http<T = any>(url: string, opts: HttpOptions & { raw?: boolean; okStatuses?: number[] } = {}): Promise<HttpResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | FormData | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) body = opts.form;
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: ctrl.signal, redirect: 'error' });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    throw new ChannelError(aborted ? 'provider_timeout' : 'provider_unreachable', aborted ? 'The provider did not answer in time' : `Could not reach the provider (${scrub((e as Error).message, opts.secrets)})`, { retryable: true, status: 504 });
  } finally {
    clearTimeout(timer);
  }
  const contentType = res.headers.get('content-type') ?? '';
  let data: any;
  let buffer: Buffer | undefined;
  if (opts.raw) {
    buffer = Buffer.from(await res.arrayBuffer());
    data = undefined;
  } else {
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
  }
  const ok = res.ok || (opts.okStatuses ?? []).includes(res.status);
  if (!ok) {
    const detail = typeof data === 'string' ? data : (data?.description ?? data?.message ?? data?.error?.message ?? (Array.isArray(data?.response?.message) ? data.response.message.join(', ') : data?.response?.message) ?? JSON.stringify(data ?? {}));
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    const err = new ChannelError(`provider_http_${res.status}`, scrub(String(detail), opts.secrets) || `Provider answered ${res.status}`, { retryable, status: res.status === 401 || res.status === 403 ? res.status : 502 });
    (err as ChannelError & { providerStatus?: number; providerBody?: unknown }).providerStatus = res.status;
    (err as ChannelError & { providerBody?: unknown }).providerBody = data;
    throw err;
  }
  return { status: res.status, data, buffer, contentType };
}

export const providerStatus = (e: unknown): number | undefined => (e as { providerStatus?: number }).providerStatus;
export const providerBody = (e: unknown): any => (e as { providerBody?: unknown }).providerBody;
