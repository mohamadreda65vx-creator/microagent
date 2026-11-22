import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** Is this address one we must never contact from the server (loopback, LAN, link-local/cloud metadata, etc.)? */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateIp(mapped[1]!);
    return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('ff');
  }
  return true;
}

export class FetchError extends Error {
  constructor(public readonly code: 'blocked_address' | 'bad_url' | 'timeout' | 'too_large' | 'http_error' | 'network' | 'too_many_redirects' | 'unsupported_type', message: string) {
    super(message);
  }
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

interface Opts {
  allowPrivate: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Fetches a public web page for Business Discovery. The server must not become a proxy into private networks (SSRF):
 * only http/https, the DNS answer is checked at connection time (so DNS rebinding cannot swap in a private address),
 * redirects are re-checked, size and time are capped.
 */
export async function fetchPage(rawUrl: string, o: Opts, redirects = 0): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError('bad_url', 'That is not a valid web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('bad_url', 'Only http and https addresses are allowed.');
  if (url.username || url.password) throw new FetchError('bad_url', 'Addresses with a username or password are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!o.allowPrivate && net.isIP(host) && isPrivateIp(host)) throw new FetchError('blocked_address', 'That address is not allowed.');

  const maxBytes = o.maxBytes ?? 1_500_000;
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return (cb as (e: Error | null, ...r: unknown[]) => void)(err);
      if (!o.allowPrivate && addrs.some((a) => isPrivateIp(a.address))) return (cb as (e: Error | null) => void)(new FetchError('blocked_address', 'That address is not allowed.'));
      const first = addrs[0]!;
      if ((options as { all?: boolean }).all) return (cb as (e: null, a: unknown) => void)(null, addrs);
      return (cb as (e: null, a: string, f: number) => void)(null, first.address, first.family);
    });
  };

  const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'GET', lookup, headers: { 'user-agent': 'MicroAgentBot/1.0 (+business discovery)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' }, timeout: o.timeoutMs ?? 10_000 }, (r) => {
      const chunks: Buffer[] = [];
      let size = 0;
      r.on('data', (d: Buffer) => {
        size += d.length;
        if (size > maxBytes) {
          req.destroy(new FetchError('too_large', 'The page is too large.'));
          return;
        }
        chunks.push(d);
      });
      r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FetchError('timeout', 'The website took too long to answer.')));
    req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError('network', 'Could not reach the website.')));
    req.end();
  });

  if (res.status >= 300 && res.status < 400 && res.headers.location) {
    if (redirects >= (o.maxRedirects ?? 3)) throw new FetchError('too_many_redirects', 'The website redirected too many times.');
    return fetchPage(new URL(res.headers.location, url).toString(), o, redirects + 1);
  }
  if (res.status < 200 || res.status >= 300) throw new FetchError('http_error', `The website answered with status ${res.status}.`);
  const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
  if (contentType && !/text\/|html|xml|json/.test(contentType)) throw new FetchError('unsupported_type', 'That address is not a web page.');
  return { url: url.toString(), status: res.status, contentType, body: res.body.toString('utf8') };
}
