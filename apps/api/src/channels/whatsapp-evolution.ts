import { randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';
import { http, providerStatus } from './http.js';
import {
  ChannelError,
  type AttachmentMeta,
  type Connector,
  type ConnectorContext,
  type ConnectResult,
  type HealthResult,
  type InboundMessage,
  type OutboundMessage,
  type SendResult,
  type StatusResult,
  type WebhookEvent,
  type WebhookRequest,
} from './types.js';

const EVENTS = ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE'];
const SECRET_HEADER = 'x-microagent-secret';

/**
 * WhatsApp through Evolution API (UNOFFICIAL: it drives a WhatsApp Web session, so the number can be banned by WhatsApp
 * and it is not suitable as a final production channel). Each channel gets its OWN Evolution instance (= its own WhatsApp session);
 * sessions are never shared between companies.
 *
 * To move to the official WhatsApp Cloud API later, add another Connector with provider 'whatsapp_cloud'
 * (see whatsapp-cloud.ts): nothing else in the system changes.
 */
export class EvolutionConnector implements Connector {
  readonly type = 'whatsapp' as const;
  readonly provider = 'evolution' as const;
  readonly available = true;
  readonly capabilities = { sendFiles: true, deliveryStatus: true, replyWindowHours: null, maxTextLength: 4000 };

  constructor(private readonly cfg: { url?: string; key?: string }) {}

  private need() {
    if (!this.cfg.url || !this.cfg.key) {
      throw new ChannelError('provider_not_configured', 'WhatsApp (Evolution API) is not configured on this server. Set EVOLUTION_API_URL and EVOLUTION_API_KEY.', { status: 503 });
    }
    return { url: this.cfg.url, key: this.cfg.key };
  }

  private async call<T = any>(path: string, opts: { method?: 'GET' | 'POST' | 'DELETE'; json?: unknown; okStatuses?: number[] } = {}) {
    const { url, key } = this.need();
    try {
      return await http<T>(`${url}${path}`, { ...opts, headers: { apikey: key }, secrets: [key] });
    } catch (e) {
      if (e instanceof ChannelError && providerStatus(e) === 401) throw new ChannelError('provider_auth', 'Evolution API rejected the server API key', { retryable: false, status: 503 });
      throw e;
    }
  }

  private webhookConfig(ctx: ConnectorContext, secret: string) {
    return { enabled: true, url: ctx.webhookUrl, byEvents: false, base64: false, headers: { [SECRET_HEADER]: secret }, events: EVENTS };
  }

  async connect(_input: Record<string, string>, ctx: ConnectorContext): Promise<ConnectResult> {
    const instance = `ma_${randomBytes(9).toString('hex')}`; // unguessable, one per channel
    const secret = randomBytes(24).toString('base64url');
    const r = await this.call<{ qrcode?: { base64?: string } }>('/instance/create', {
      method: 'POST',
      json: { instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS', webhook: this.webhookConfig(ctx, secret) },
    });
    let qr = r.data?.qrcode?.base64;
    if (!qr) qr = (await this.fetchQr(instance)).qr;
    return { status: 'connecting', creds: { instance, webhookSecret: secret }, externalAccountId: instance, config: { unofficial: true }, qr };
  }

  private async fetchQr(instance: string): Promise<{ qr?: string; connected: boolean }> {
    const r = await this.call<{ base64?: string; instance?: { state?: string } }>(`/instance/connect/${encodeURIComponent(instance)}`);
    if (r.data?.instance?.state === 'open') return { connected: true };
    return { qr: r.data?.base64, connected: false };
  }

  async reconnect(ctx: ConnectorContext): Promise<ConnectResult> {
    const instance = ctx.creds.instance;
    if (!instance) return this.connect({}, ctx);
    try {
      const st = await this.status(ctx);
      if (st.state === 'connected') return { status: 'connected', creds: ctx.creds };
      const q = await this.fetchQr(instance);
      return { status: 'connecting', creds: ctx.creds, qr: q.qr };
    } catch (e) {
      // The instance vanished on the Evolution side: create it again under the same name and secret.
      if (providerStatus(e) === 404) {
        const secret = ctx.creds.webhookSecret ?? randomBytes(24).toString('base64url');
        const r = await this.call<{ qrcode?: { base64?: string } }>('/instance/create', {
          method: 'POST',
          json: { instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS', webhook: this.webhookConfig(ctx, secret) },
        });
        return { status: 'connecting', creds: { ...ctx.creds, webhookSecret: secret }, qr: r.data?.qrcode?.base64 };
      }
      throw e;
    }
  }

  async disconnect(ctx: ConnectorContext): Promise<void> {
    const instance = ctx.creds.instance;
    if (!instance) return;
    // Logging out may fail when the phone is already unlinked; deleting the instance is what matters.
    await this.call(`/instance/logout/${encodeURIComponent(instance)}`, { method: 'DELETE' }).catch(() => undefined);
    await this.call(`/instance/delete/${encodeURIComponent(instance)}`, { method: 'DELETE', okStatuses: [404] });
  }

  async status(ctx: ConnectorContext): Promise<StatusResult> {
    const instance = ctx.creds.instance;
    if (!instance) return { state: 'disconnected', detail: 'No WhatsApp session yet' };
    const r = await this.call<{ instance?: { state?: string } }>(`/instance/connectionState/${encodeURIComponent(instance)}`);
    const state = r.data?.instance?.state;
    if (state === 'open') return { state: 'connected' };
    if (state === 'connecting') {
      const q = await this.fetchQr(instance).catch(() => ({ qr: undefined, connected: false }));
      return { state: 'connecting', qr: q.qr };
    }
    return { state: 'disconnected', detail: 'The phone is not linked. Scan a new QR code.' };
  }

  async health(ctx: ConnectorContext): Promise<HealthResult> {
    try {
      const s = await this.status(ctx);
      if (s.state === 'connected') return { status: 'healthy' };
      if (s.state === 'connecting') return { status: 'degraded', detail: 'Waiting for the QR code to be scanned' };
      return { status: 'down', detail: s.detail ?? 'Session closed', needsReconnect: true };
    } catch (e) {
      const code = (e as ChannelError).code;
      if (providerStatus(e) === 404) return { status: 'down', detail: 'WhatsApp session not found on the provider', needsReconnect: true };
      return { status: 'down', detail: code === 'provider_not_configured' ? (e as Error).message : `Evolution API: ${(e as Error).message}` };
    }
  }

  async parseWebhook(ctx: ConnectorContext, req: WebhookRequest): Promise<WebhookEvent[]> {
    const given = req.headers[SECRET_HEADER];
    if (!safeEqual(Array.isArray(given) ? given[0] : given, ctx.creds.webhookSecret)) throw new ChannelError('invalid_signature', 'Bad webhook secret', { status: 401 });
    const body = req.body as { event?: string; instance?: string; data?: any } | undefined;
    if (!body || typeof body.event !== 'string') return [{ kind: 'ignored', reason: 'no event' }];
    // The payload names the instance: it must be THIS channel's instance (a second guard besides the secret).
    if (body.instance && ctx.creds.instance && body.instance !== ctx.creds.instance) throw new ChannelError('invalid_signature', 'Instance does not belong to this channel', { status: 401 });
    const event = body.event.toUpperCase().replace(/\./g, '_');
    const data = body.data;
    switch (event) {
      case 'QRCODE_UPDATED': {
        const qr = data?.qrcode?.base64 ?? data?.base64;
        return qr ? [{ kind: 'qr', qr }] : [{ kind: 'ignored', reason: 'qr without image' }];
      }
      case 'CONNECTION_UPDATE': {
        const state = data?.state;
        if (state === 'open') return [{ kind: 'connection', state: 'connected' }];
        if (state === 'connecting') return [{ kind: 'connection', state: 'connecting' }];
        if (state === 'close') return [{ kind: 'connection', state: 'disconnected', detail: data?.statusReason ? `closed (${data.statusReason})` : 'closed' }];
        return [{ kind: 'ignored', reason: `connection state ${String(state)}` }];
      }
      case 'MESSAGES_UPSERT': {
        const items: any[] = Array.isArray(data) ? data : data?.messages ?? [data];
        return items.filter(Boolean).map((d) => this.parseMessage(d));
      }
      case 'MESSAGES_UPDATE': {
        const items: any[] = Array.isArray(data) ? data : [data];
        return items.filter(Boolean).map((d): WebhookEvent => {
          const id = d.keyId ?? d.key?.id;
          const status = mapStatus(d.status);
          return id && status ? { kind: 'status', externalId: String(id), status } : { kind: 'ignored', reason: 'status update not mapped' };
        });
      }
      default:
        return [{ kind: 'ignored', reason: `event ${event} not used` }];
    }
  }

  private parseMessage(d: any): WebhookEvent {
    const key = d.key ?? {};
    const jid: string = String(key.remoteJid ?? '');
    if (key.fromMe) return { kind: 'ignored', reason: 'message sent from our own side' };
    if (!jid || jid.endsWith('@g.us') || jid.startsWith('status@') || jid.endsWith('@broadcast')) return { kind: 'ignored', reason: 'group or broadcast (not supported)' };
    if (!key.id) return { kind: 'ignored', reason: 'no message id' };
    const m = d.message ?? {};
    const atts: AttachmentMeta[] = [];
    const media = (field: string, kind: AttachmentMeta['kind']) => {
      const x = m[field];
      if (x) atts.push({ kind, ref: String(key.id), mime: x.mimetype, name: x.fileName ?? x.title, size: x.fileLength ? Number(x.fileLength) : undefined });
    };
    media('imageMessage', 'image');
    media('videoMessage', 'video');
    media('audioMessage', 'audio');
    media('documentMessage', 'document');
    media('stickerMessage', 'sticker');
    const text = String(m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption ?? '').trim();
    const digits = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0]!.replace(/\D/g, '') : '';
    const message: InboundMessage = {
      externalId: String(key.id),
      contactExternalId: jid,
      contactName: d.pushName || undefined,
      contactPhone: digits ? `+${digits}` : undefined,
      text: text || (atts.length ? '' : '[unsupported message type]'),
      attachments: atts.length || text ? atts : [{ kind: 'other' }],
      at: d.messageTimestamp ? new Date(Number(d.messageTimestamp) * 1000) : new Date(),
    };
    return { kind: 'message', message };
  }

  async send(ctx: ConnectorContext, out: OutboundMessage): Promise<SendResult> {
    const instance = ctx.creds.instance;
    if (!instance) throw new ChannelError('not_connected', 'No WhatsApp session for this channel');
    const number = out.contactExternalId.endsWith('@s.whatsapp.net') ? out.contactExternalId.split('@')[0]! : out.contactExternalId;
    let lastId: string | null = null;
    let text = out.text;
    for (const [i, f] of out.files.entries()) {
      const mediatype = f.kind === 'image' ? 'image' : f.kind === 'video' ? 'video' : 'document';
      const r = await this.call<{ key?: { id?: string } }>(`/message/sendMedia/${encodeURIComponent(instance)}`, {
        method: 'POST',
        json: { number, mediatype, mimetype: f.mime, caption: i === 0 ? text : '', media: f.data.toString('base64'), fileName: f.name },
      });
      if (i === 0) text = '';
      lastId = r.data?.key?.id ?? lastId;
    }
    if (text) {
      const r = await this.call<{ key?: { id?: string } }>(`/message/sendText/${encodeURIComponent(instance)}`, { method: 'POST', json: { number, text } });
      lastId = r.data?.key?.id ?? lastId;
    }
    return { externalId: lastId };
  }

  async download(ctx: ConnectorContext, att: AttachmentMeta) {
    const instance = ctx.creds.instance;
    if (!instance || !att.ref) throw new ChannelError('not_available', 'This attachment cannot be downloaded', { status: 404 });
    const r = await this.call<{ base64?: string; mimetype?: string; fileName?: string }>(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
      method: 'POST',
      json: { message: { key: { id: att.ref } }, convertToMp4: false },
    });
    if (!r.data?.base64) throw new ChannelError('not_available', 'The media is no longer available', { status: 404 });
    return { data: Buffer.from(r.data.base64, 'base64'), mime: r.data.mimetype ?? att.mime ?? 'application/octet-stream', name: r.data.fileName ?? att.name ?? 'file' };
  }
}

function mapStatus(s: unknown): 'sent' | 'delivered' | 'read' | 'failed' | null {
  switch (String(s ?? '').toUpperCase()) {
    case 'SERVER_ACK':
    case 'SENT':
      return 'sent';
    case 'DELIVERY_ACK':
    case 'DELIVERED':
      return 'delivered';
    case 'READ':
    case 'PLAYED':
      return 'read';
    case 'ERROR':
    case 'FAILED':
      return 'failed';
    default:
      return null;
  }
}
