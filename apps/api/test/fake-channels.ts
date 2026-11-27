import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local stand-ins for Telegram, Evolution API and the Meta Graph API. USED ONLY BY AUTOMATED TESTS.
 * None of the real services is reachable from the build environment (no tokens, no network), so these speak the same
 * wire formats as far as the connectors use them. They prove OUR code is right against that format; they do not prove
 * the real services behave identically.
 */
export interface Call { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any; raw: Buffer }
export interface Planned { status: number; body: unknown }

abstract class FakeServer {
  server!: http.Server;
  url = '';
  calls: Call[] = [];
  /** One-shot failures keyed by a substring of `METHOD path`. */
  private failures: Array<{ match: string; reply: Planned }> = [];
  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const u = new URL(req.url ?? '/', 'http://x');
        let body: any = undefined;
        const ct = req.headers['content-type'] ?? '';
        if (ct.includes('json') && raw.length) { try { body = JSON.parse(raw.toString()); } catch { body = undefined; } }
        const call: Call = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body, raw };
        this.calls.push(call);
        const key = `${call.method} ${call.path}`;
        const i = this.failures.findIndex((f) => key.includes(f.match));
        if (i >= 0) {
          const f = this.failures.splice(i, 1)[0]!;
          res.writeHead(f.reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(f.reply.body));
          return;
        }
        const respond = () => {
        if (this.failRate && Math.random() < this.failRate) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, description: 'simulated failure' })); return; }
        const out = this.route(call);
        if (out.raw) res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/octet-stream' }).end(out.raw);
        else res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
        };
        if (this.latencyMs) setTimeout(respond, this.latencyMs); else respond();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  /** Load tests: simulated provider latency and random 500s (retryable) on a fraction of calls. */
  latencyMs = 0; failRate = 0;
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }
  failNext(match: string, status: number, body: unknown = {}) { this.failures.push({ match, reply: { status, body } }); }
  callsTo(substr: string) { return this.calls.filter((c) => `${c.method} ${c.path}`.includes(substr)); }
  reset() { this.calls = []; this.failures = []; }
  abstract route(c: Call): { status: number; body?: unknown; raw?: Buffer; contentType?: string };
}

export class FakeTelegram extends FakeServer {
  /** token -> bot */
  bots = new Map<string, { id: number; username: string }>();
  webhooks = new Map<string, { url: string; secret: string }>();
  sentIds = 1000;
  addBot(token: string, id: number, username: string) { this.bots.set(token, { id, username }); }
  route(c: Call) {
    const m = c.path.match(/^\/bot([^/]+)\/(\w+)$/);
    if (c.path.startsWith('/file/bot')) return { status: 200, raw: Buffer.from('FILEDATA'), contentType: 'image/jpeg' };
    if (!m) return { status: 404, body: { ok: false, description: 'Not Found' } };
    const [, token, method] = m as unknown as [string, string, string];
    const bot = this.bots.get(token);
    if (!bot) return { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };
    switch (method) {
      case 'getMe': return { status: 200, body: { ok: true, result: { id: bot.id, is_bot: true, first_name: 'Shop Bot', username: bot.username } } };
      case 'setWebhook': this.webhooks.set(token, { url: c.body.url, secret: c.body.secret_token }); return { status: 200, body: { ok: true, result: true } };
      case 'deleteWebhook': this.webhooks.delete(token); return { status: 200, body: { ok: true, result: true } };
      case 'getWebhookInfo': return { status: 200, body: { ok: true, result: { url: this.webhooks.get(token)?.url ?? '', pending_update_count: 0 } } };
      case 'getFile': return { status: 200, body: { ok: true, result: { file_id: c.body.file_id, file_path: 'photos/p1.jpg', file_size: 8 } } };
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument': return { status: 200, body: { ok: true, result: { message_id: ++this.sentIds } } };
      default: return { status: 404, body: { ok: false, description: 'unknown method' } };
    }
  }
}

export class FakeEvolution extends FakeServer {
  key = 'evo-global-key';
  instances = new Map<string, { state: 'open' | 'connecting' | 'close' }>();
  sent = 0;
  route(c: Call) {
    if (c.headers.apikey !== this.key) return { status: 401, body: { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } } };
    let m: RegExpMatchArray | null;
    if (c.method === 'POST' && c.path === '/instance/create') {
      this.instances.set(c.body.instanceName, { state: 'connecting' });
      return { status: 201, body: { instance: { instanceName: c.body.instanceName, status: 'created' }, qrcode: { base64: 'data:image/png;base64,QR1' } } };
    }
    if ((m = c.path.match(/^\/instance\/connect\/(.+)$/))) {
      const i = this.instances.get(m[1]!);
      if (!i) return { status: 404, body: { status: 404, response: { message: 'not found' } } };
      return i.state === 'open' ? { status: 200, body: { instance: { state: 'open' } } } : { status: 200, body: { base64: 'data:image/png;base64,QR2', code: 'x' } };
    }
    if ((m = c.path.match(/^\/instance\/connectionState\/(.+)$/))) {
      const i = this.instances.get(m[1]!);
      return i ? { status: 200, body: { instance: { instanceName: m[1], state: i.state } } } : { status: 404, body: { status: 404, response: { message: 'not found' } } };
    }
    if ((m = c.path.match(/^\/instance\/(logout|delete)\/(.+)$/))) {
      if (m[1] === 'delete') this.instances.delete(m[2]!); else { const i = this.instances.get(m[2]!); if (i) i.state = 'close'; }
      return { status: 200, body: { status: 'SUCCESS' } };
    }
    if ((m = c.path.match(/^\/message\/(sendText|sendMedia)\/(.+)$/))) {
      const i = this.instances.get(m[2]!);
      if (!i || i.state !== 'open') return { status: 400, body: { status: 400, response: { message: ['Instance not connected'] } } };
      return { status: 201, body: { key: { remoteJid: `${c.body.number}@s.whatsapp.net`, fromMe: true, id: `EVO-OUT-${++this.sent}` }, status: 'PENDING' } };
    }
    if (c.path.startsWith('/chat/getBase64FromMediaMessage')) return { status: 200, body: { base64: Buffer.from('WAMEDIA').toString('base64'), mimetype: 'image/jpeg', fileName: 'wa.jpg' } };
    return { status: 404, body: { message: 'unknown' } };
  }
  setState(instance: string, state: 'open' | 'connecting' | 'close') { const i = this.instances.get(instance); if (i) i.state = state; }
}

export class FakeGraph extends FakeServer {
  pages = [{ id: 'PAGE1', name: 'Shop Page', access_token: 'PAGE-TOKEN-1', instagram_business_account: { id: 'IG1', username: 'shop_ig' } }];
  sent = 0;
  validTokens = new Set(['PAGE-TOKEN-1']);
  route(c: Call) {
    const p = c.path.replace(/^\/v[\d.]+/, '');
    const bearer = String(c.headers.authorization ?? '').replace('Bearer ', '');
    if (p === '/oauth/access_token') {
      if (c.query.get('grant_type') === 'fb_exchange_token') return { status: 200, body: { access_token: 'LONG-USER-TOKEN' } };
      return c.query.get('code') === 'GOOD-CODE' ? { status: 200, body: { access_token: 'SHORT-USER-TOKEN' } } : { status: 400, body: { error: { message: 'Invalid verification code', code: 100 } } };
    }
    if (p === '/me/accounts') return bearer === 'LONG-USER-TOKEN' ? { status: 200, body: { data: this.pages } } : { status: 401, body: { error: { message: 'bad', code: 190 } } };
    if (!this.validTokens.has(bearer)) return { status: 401, body: { error: { message: 'Error validating access token', code: 190 } } };
    if (p === '/me') return { status: 200, body: { id: 'PAGE1', name: 'Shop Page' } };
    if (/^\/[^/]+\/subscribed_apps$/.test(p)) return { status: 200, body: { success: true } };
    if (/^\/[^/]+\/messages$/.test(p)) {
      if (c.body?.recipient?.id === 'OUTSIDE') return { status: 400, body: { error: { message: 'This message is sent outside of allowed window.', code: 10, error_subcode: 2018278 } } };
      return { status: 200, body: { recipient_id: c.body.recipient.id, message_id: `m_out_${++this.sent}` } };
    }
    const prof = p.match(/^\/([^/]+)$/);
    if (prof) return { status: 200, body: { name: `User ${prof[1]}` } };
    return { status: 404, body: { error: { message: 'unknown', code: 100 } } };
  }
}
