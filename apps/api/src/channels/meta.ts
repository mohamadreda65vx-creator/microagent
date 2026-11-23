import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.js';
import { http, providerBody } from './http.js';
import {
  ChannelError,
  type AttachmentMeta,
  type ChannelType,
  type Connector,
  type ConnectorContext,
  type ConnectResult,
  type HealthResult,
  type OutboundMessage,
  type SendResult,
  type StatusResult,
  type WebhookEvent,
  type WebhookRequest,
} from './types.js';

export interface MetaConfig { appId?: string; appSecret?: string; verifyToken?: string; graphBase: string; version: string }

/**
 * Official Meta integration for Messenger and Instagram (Facebook Login OAuth + Graph API + one app-level webhook).
 *
 * STATUS: PREPARED, NOT VERIFIED AGAINST META. It has been exercised only against a local stand-in of the Graph API.
 * Meta requires, before it works for real customers: a Meta app, the permissions below approved through App Review
 * (Advanced Access) and Business Verification, plus a public HTTPS callback. Until a REAL message from Meta arrives,
 * a channel is never shown as "connected": it stays in "awaiting_approval".
 */
export const META_SCOPES: Record<'messenger' | 'instagram', string[]> = {
  messenger: ['pages_show_list', 'pages_manage_metadata', 'pages_messaging', 'pages_read_engagement'],
  instagram: ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_messages'],
};

export interface MetaPage { id: string; name: string; igId?: string; igUsername?: string; token: string }

export class MetaPlatform {
  constructor(readonly cfg: MetaConfig) {}

  get configured(): boolean {
    return !!(this.cfg.appId && this.cfg.appSecret && this.cfg.verifyToken);
  }

  graph(path: string) {
    return `${this.cfg.graphBase}/${this.cfg.version}${path}`;
  }

  need() {
    if (!this.configured) throw new ChannelError('provider_not_configured', 'Meta is not configured on this server. Set META_APP_ID, META_APP_SECRET and META_VERIFY_TOKEN after creating a Meta app.', { status: 503 });
    return { appId: this.cfg.appId!, appSecret: this.cfg.appSecret!, verifyToken: this.cfg.verifyToken! };
  }

  oauthUrl(type: 'messenger' | 'instagram', redirectUri: string, state: string): string {
    const { appId } = this.need();
    const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, response_type: 'code', scope: META_SCOPES[type].join(',') });
    return `https://www.facebook.com/${this.cfg.version}/dialog/oauth?${q}`;
  }

  /** code -> long-lived user token -> the Pages the user manages (with their page tokens). */
  async pagesFromCode(code: string, redirectUri: string): Promise<MetaPage[]> {
    const { appId, appSecret } = this.need();
    const secrets = [appSecret, code];
    const short = await this.guard(() => http<{ access_token: string }>(`${this.graph('/oauth/access_token')}?${new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })}`, { secrets }));
    const long = await this.guard(() => http<{ access_token: string }>(`${this.graph('/oauth/access_token')}?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.data.access_token })}`, { secrets: [...secrets, short.data.access_token] }));
    const userToken = long.data.access_token;
    const r = await this.guard(() => http<{ data: Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }> }>(`${this.graph('/me/accounts')}?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '50' })}`, { headers: { authorization: `Bearer ${userToken}` }, secrets: [userToken] }));
    return (r.data.data ?? []).map((p) => ({ id: p.id, name: p.name, token: p.access_token, igId: p.instagram_business_account?.id, igUsername: p.instagram_business_account?.username }));
  }

  async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw mapGraphError(e);
    }
  }

  /** Meta signs every webhook POST with the APP secret: X-Hub-Signature-256 = sha256=HMAC(rawBody). */
  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    const { appSecret } = this.need();
    const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    return safeEqual(header, expected);
  }
}

function mapGraphError(e: unknown): unknown {
  if (!(e instanceof ChannelError)) return e;
  const err = (providerBody(e) as { error?: { code?: number; error_subcode?: number; message?: string } } | undefined)?.error;
  if (!err) return e;
  const msg = err.message ?? e.message;
  if (err.code === 190) return new ChannelError('auth_expired', 'Meta says the access token is no longer valid. Reconnect the page.', { retryable: false, status: 401 });
  if (err.code === 551 || err.code === 10 || err.error_subcode === 2018278) return new ChannelError('outside_messaging_window', 'Meta only allows replying within 24 hours of the customer’s last message.', { retryable: false });
  if ([4, 17, 32, 613].includes(err.code ?? 0)) return new ChannelError('rate_limited', `Meta rate limit: ${msg}`, { retryable: true });
  if (err.code === 2 || err.code === 1) return new ChannelError('provider_temporary', `Meta temporary error: ${msg}`, { retryable: true });
  if (err.code === 200 || err.code === 299) return new ChannelError('permission_denied', `Meta denied the permission: ${msg}`, { retryable: false });
  if (err.code === 100) return new ChannelError('recipient_not_found', `Meta could not find that recipient: ${msg}`, { retryable: false });
  return new ChannelError(`meta_${err.code ?? 'error'}`, msg, { retryable: e.retryable });
}

export class MetaConnector implements Connector {
  readonly provider = 'meta' as const;
  readonly available = true;
  readonly capabilities = { sendFiles: false, deliveryStatus: true, replyWindowHours: 24, maxTextLength: 1900 };

  constructor(readonly type: Extract<ChannelType, 'messenger' | 'instagram'>, private readonly platform: MetaPlatform) {}

  /** `input` = { pageId, pageToken, igId? } chosen after OAuth. Subscribes the Page to our app's webhook. */
  async connect(input: Record<string, string>, _ctx: ConnectorContext): Promise<ConnectResult> {
    this.platform.need();
    const pageId = input.pageId;
    const token = input.pageToken;
    if (!pageId || !token) throw new ChannelError('invalid_input', 'Missing page', { status: 400 });
    const account = this.type === 'instagram' ? input.igId : pageId;
    if (!account) throw new ChannelError('no_instagram_account', 'This Facebook Page has no Instagram professional account linked.', { status: 400 });
    await this.platform.guard(() =>
      http(this.platform.graph(`/${pageId}/subscribed_apps`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        json: { subscribed_fields: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads'].join(',') },
        secrets: [token],
      }),
    );
    return {
      status: 'awaiting_approval',
      creds: { pageId, pageToken: token },
      externalAccountId: account,
      config: { pageName: input.pageName ?? null, igUsername: input.igUsername ?? null, verified: false },
      message: 'Connected to Meta. It is NOT verified yet: it becomes active when the first real message arrives (Meta app review is required for customers outside your team).',
    };
  }

  async disconnect(ctx: ConnectorContext): Promise<void> {
    const { pageId, pageToken } = ctx.creds;
    if (!pageId || !pageToken) return;
    await this.platform
      .guard(() => http(this.platform.graph(`/${pageId}/subscribed_apps`), { method: 'DELETE', headers: { authorization: `Bearer ${pageToken}` }, secrets: [pageToken] }))
      .catch(() => undefined);
  }

  async status(ctx: ConnectorContext): Promise<StatusResult> {
    const h = await this.health(ctx);
    return { state: h.status === 'down' ? 'disconnected' : 'connected', detail: h.detail };
  }

  async health(ctx: ConnectorContext): Promise<HealthResult> {
    const token = ctx.creds.pageToken;
    if (!token) return { status: 'down', detail: 'No page token', needsReconnect: true };
    try {
      await this.platform.guard(() => http(this.platform.graph('/me'), { headers: { authorization: `Bearer ${token}` }, secrets: [token] }));
      return { status: 'healthy' };
    } catch (e) {
      const code = (e as ChannelError).code;
      return { status: 'down', detail: (e as Error).message, needsReconnect: code === 'auth_expired' };
    }
  }

  /** The signature was already verified for the whole request by the webhook route; `req.body` here is ONE entry. */
  async parseWebhook(_ctx: ConnectorContext, req: WebhookRequest): Promise<WebhookEvent[]> {
    const body = req.body as { entry?: Array<{ id?: string; messaging?: any[] }> } | undefined;
    const events: WebhookEvent[] = [];
    for (const entry of body?.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        const sender = String(ev.sender?.id ?? '');
        if (ev.message) {
          const m = ev.message;
          if (m.is_echo) { events.push({ kind: 'ignored', reason: 'echo of our own message' }); continue; }
          if (!sender || !m.mid) { events.push({ kind: 'ignored', reason: 'message without sender or id' }); continue; }
          const atts: AttachmentMeta[] = (m.attachments ?? []).map((a: any): AttachmentMeta => ({
            kind: a.type === 'image' ? 'image' : a.type === 'video' ? 'video' : a.type === 'audio' ? 'audio' : a.type === 'file' ? 'document' : 'other',
            ref: a.payload?.url,
          }));
          const text = String(m.text ?? '').trim();
          events.push({
            kind: 'message',
            message: { externalId: String(m.mid), contactExternalId: sender, text: text || (atts.length ? '' : '[unsupported message type]'), attachments: atts.length || text ? atts : [{ kind: 'other' }], at: new Date(Number(ev.timestamp) || Date.now()) },
          });
        } else if (ev.delivery?.mids) {
          for (const mid of ev.delivery.mids) events.push({ kind: 'status', externalId: String(mid), status: 'delivered' });
        } else if (ev.read) {
          if (ev.read.mid) events.push({ kind: 'status', externalId: String(ev.read.mid), status: 'read' });
          else if (ev.read.watermark && sender) events.push({ kind: 'read_until', contactExternalId: sender, at: new Date(Number(ev.read.watermark)) });
        } else events.push({ kind: 'ignored', reason: 'event type not used' });
      }
    }
    return events.length ? events : [{ kind: 'ignored', reason: 'no messaging events' }];
  }

  async send(ctx: ConnectorContext, out: OutboundMessage): Promise<SendResult> {
    const { pageId, pageToken } = ctx.creds;
    if (!pageId || !pageToken) throw new ChannelError('not_connected', 'This channel has no page token');
    if (out.files.length) throw new ChannelError('attachments_not_supported', 'Sending files over Messenger/Instagram is not implemented yet', { retryable: false });
    const r = await this.platform.guard(() =>
      http<{ message_id?: string }>(this.platform.graph(`/${pageId}/messages`), {
        method: 'POST',
        headers: { authorization: `Bearer ${pageToken}` },
        json: { recipient: { id: out.contactExternalId }, messaging_type: 'RESPONSE', message: { text: out.text } },
        secrets: [pageToken],
      }),
    );
    return { externalId: r.data?.message_id ?? null };
  }

  async profile(ctx: ConnectorContext, id: string): Promise<{ name?: string }> {
    const token = ctx.creds.pageToken;
    if (!token) return {};
    try {
      const r = await this.platform.guard(() => http<{ name?: string; first_name?: string; last_name?: string; username?: string }>(`${this.platform.graph(`/${id}`)}?fields=${this.type === 'instagram' ? 'name,username' : 'name'}`, { headers: { authorization: `Bearer ${token}` }, secrets: [token] }));
      return { name: r.data.name ?? r.data.username };
    } catch {
      return {};
    }
  }
}
