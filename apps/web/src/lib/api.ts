export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Message for a specific form field coming from server-side validation. */
  fieldError(path: string): string | undefined {
    return this.details?.find((d) => d.path === path)?.message;
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/** Endpoints where a 401 is an expected answer and must not trigger the "session expired" flow. */
const AUTH_PROBES = ['/auth/me', '/auth/login', '/auth/signup', '/auth/logout', '/auth/forgot-password', '/auth/reset-password', '/auth/accept-invitation'];

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? (hasBody ? 'POST' : 'GET'),
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: { error?: { code?: string; message?: string; details?: Array<{ path: string; message: string }> } } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    const code = data?.error?.code ?? 'error';
    if (res.status === 401 && !AUTH_PROBES.some((p) => path.startsWith(p))) window.dispatchEvent(new Event('auth:expired'));
    if (res.status === 403 && code === 'tenant_suspended') window.dispatchEvent(new Event('auth:refresh'));
    throw new ApiError(res.status, code, data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  }
  return data as T;
}
