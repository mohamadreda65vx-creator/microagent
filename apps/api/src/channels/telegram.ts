import { randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';
import { http, providerBody, providerStatus } from './http.js';
import {
  ChannelError,
  type AttachmentMeta,
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

interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }
interface TgMessage {
  message_id: number;
  date: number;
  from?: TgUser;
  chat: { id: number; type: string; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string };
}

const TEXT_LIMIT = 4096;

export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Telegram Bot connector (official Bot API). The tenant pastes the token from @BotFather;
 * we validate it (getMe), register the webhook with a per-channel secret_token, and verify that secret on every update.
 */
export class TelegramConnector implements Connector {
  readonly type = 'telegram' as const;
  readonly provider = 'telegram_bot' as const;
  readonly available = true;
  readonly capabilities = { sendFiles: true, deliveryStatus: false, replyWindowHours: null, maxTextLength: 8000 }; // long texts are split into 4096-character parts by send()

  constructor(private readonly apiBase: string) {}

  private url(token: string, method: string) {
    return `${this.apiBase}/bot${token}/${method}`;
  }

  private async call<T = any>(token: string, method: string, json?: unknown, form?: FormData): Promise<T> {
    try {
      const r = await http<{ ok: boolean; result: T; description?: string }>(this.url(token, method), { method: 'POST', json, form, secrets: [token] });
      if (!r.data?.ok) throw new ChannelError('telegram_error', r.data?.description ?? 'Telegram refused the request', { retryable: false });
      return r.data.result;
    } catch (e) {
      if (e instanceof ChannelError) {
        const st = providerStatus(e);
        const body = providerBody(e) as { description?: string; parameters?: { retry_after?: number } } | undefined;
        if (st === 401) throw new ChannelError('invalid_token', 'Telegram rejected this bot token. Copy it again from @BotFather.', { retryable: false, status: 400 });
        if (st === 403) throw new ChannelError('recipient_blocked', body?.description ?? 'The customer blocked the bot or never started it', { retryable: false });
        if (st === 400 && /chat not found/i.test(body?.description ?? '')) throw new ChannelError('recipient_not_found', 'Telegram cannot find this chat', { retryable: false });
        if (st === 429) throw new ChannelError('rate_limited', `Telegram rate limit (retry after ${body?.parameters?.retry_after ?? '?'}s)`, { retryable: true });
      }
      throw e;
    }
  }

  async identify(input: Record<string, string>, _ctx?: ConnectorContext): Promise<{ externalAccountId: string; config: Record<string, unknown> }> {
    const token = (input.botToken ?? '').trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new ChannelError('invalid_token', 'That does not look like a Telegram bot token (expected 123456789:ABC...).', { status: 400 });
    const me = await this.call<TgUser & { is_bot: boolean }>(token, 'getMe');
    if (!me.is_bot) throw new ChannelError('invalid_token', 'This token does not belong to a bot', { status: 400 });
    return { externalAccountId: String(me.id), config: { username: me.username ?? null, botName: me.first_name ?? null } };
  }

  async connect(input: Record<string, string>, ctx: ConnectorContext): Promise<ConnectResult> {
    const token = (input.botToken ?? '').trim();
    const ident = await this.identify({ botToken: token }, ctx);
    if (!/^https:\/\//i.test(ctx.webhookUrl)) {
      throw new ChannelError('public_https_required', 'Telegram only sends updates to a public HTTPS address. Set APP_URL to your real https:// domain (not localhost) and try again.', { status: 400 });
    }
    const secret = randomBytes(24).toString('base64url');
    await this.call(token, 'setWebhook', { url: ctx.webhookUrl, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false });
    return { status: 'connected', creds: { botToken: token, webhookSecret: secret }, externalAccountId: ident.externalAccountId, config: ident.config };
  }

  async reconnect(ctx: ConnectorContext): Promise<ConnectResult> {
    // Re-register the webhook with a NEW secret (used after "webhook broken" or a rotated URL).
    const token = ctx.creds.botToken!;
    const secret = randomBytes(24).toString('base64url');
    await this.call(token, 'setWebhook', { url: ctx.webhookUrl, secret_token: secret, allowed_updates: ['message'] });
    return { status: 'connected', creds: { ...ctx.creds, webhookSecret: secret } };
  }

  async disconnect(ctx: ConnectorContext): Promise<void> {
    if (ctx.creds.botToken) await this.call(ctx.creds.botToken, 'deleteWebhook', { drop_pending_updates: false });
  }

  async status(ctx: ConnectorContext): Promise<StatusResult> {
    const h = await this.health(ctx);
    return { state: h.status === 'down' ? 'disconnected' : 'connected', detail: h.detail };
  }

  async health(ctx: ConnectorContext): Promise<HealthResult> {
    const token = ctx.creds.botToken;
    if (!token) return { status: 'down', detail: 'No token stored', needsReconnect: true };
    try {
      await this.call(token, 'getMe');
    } catch (e) {
      const code = (e as ChannelError).code;
      return { status: 'down', detail: (e as Error).message, needsReconnect: code === 'invalid_token' };
    }
    const info = await this.call<{ url?: string; last_error_date?: number; last_error_message?: string; pending_update_count?: number }>(token, 'getWebhookInfo');
    if (info.url !== ctx.webhookUrl) return { status: 'down', detail: 'Webhook is not registered (or points somewhere else). Use Reconnect.', needsReconnect: true };
    if (info.last_error_date && Date.now() / 1000 - info.last_error_date < 600) return { status: 'degraded', detail: `Telegram could not deliver an update: ${info.last_error_message ?? 'unknown error'}` };
    if ((info.pending_update_count ?? 0) > 50) return { status: 'degraded', detail: `${info.pending_update_count} updates are waiting to be delivered` };
    return { status: 'healthy' };
  }

  async parseWebhook(ctx: ConnectorContext, req: WebhookRequest): Promise<WebhookEvent[]> {
    const given = req.headers['x-telegram-bot-api-secret-token'];
    if (!safeEqual(Array.isArray(given) ? given[0] : given, ctx.creds.webhookSecret)) throw new ChannelError('invalid_signature', 'Bad Telegram secret token', { status: 401 });
    const update = req.body as { update_id?: number; message?: TgMessage; edited_message?: unknown };
    if (!update || typeof update !== 'object') return [{ kind: 'ignored', reason: 'empty body' }];
    const m = update.message;
    if (!m) return [{ kind: 'ignored', reason: 'not a new message (edits, reactions, members...)' }];
    if (m.chat.type !== 'private') return [{ kind: 'ignored', reason: `chat type ${m.chat.type} is not supported (private chats only)` }];
    if (m.from && (m.from as { is_bot?: boolean }).is_bot) return [{ kind: 'ignored', reason: 'message from a bot' }];

    const atts: AttachmentMeta[] = [];
    if (m.photo?.length) {
      const p = m.photo[m.photo.length - 1]!;
      atts.push({ kind: 'image', ref: p.file_id, mime: 'image/jpeg', size: p.file_size, name: 'photo.jpg' });
    }
    if (m.document) atts.push({ kind: 'document', ref: m.document.file_id, name: m.document.file_name, mime: m.document.mime_type, size: m.document.file_size });
    if (m.voice) atts.push({ kind: 'audio', ref: m.voice.file_id, mime: m.voice.mime_type, size: m.voice.file_size, name: 'voice.ogg' });
    if (m.audio) atts.push({ kind: 'audio', ref: m.audio.file_id, name: m.audio.file_name, mime: m.audio.mime_type, size: m.audio.file_size });
    if (m.video) atts.push({ kind: 'video', ref: m.video.file_id, name: m.video.file_name, mime: m.video.mime_type, size: m.video.file_size });
    if (m.sticker) atts.push({ kind: 'sticker', ref: m.sticker.file_id });
    const text = (m.text ?? m.caption ?? '').trim();
    if (!text && atts.length === 0) return [{ kind: 'message', message: this.build(m, '[unsupported message type]', [{ kind: 'other' }]) }];
    return [{ kind: 'message', message: this.build(m, text, atts) }];
  }

  private build(m: TgMessage, text: string, attachments: AttachmentMeta[]) {
    const name = [m.chat.first_name ?? m.from?.first_name, m.chat.last_name ?? m.from?.last_name].filter(Boolean).join(' ') || m.chat.username || m.from?.username;
    return {
      // message_id is only unique INSIDE one chat, so the chat id is part of the idempotency key.
      externalId: `${m.chat.id}:${m.message_id}`,
      contactExternalId: String(m.chat.id),
      contactName: name || undefined,
      text,
      attachments,
      at: new Date(m.date * 1000),
    };
  }

  async send(ctx: ConnectorContext, out: OutboundMessage): Promise<SendResult> {
    const token = ctx.creds.botToken;
    if (!token) throw new ChannelError('not_connected', 'This channel has no bot token', { retryable: false });
    const chat = out.contactExternalId;
    let lastId: string | null = null;
    // Files first (the text becomes the caption of the first file when it fits), then any remaining text.
    let text = out.text;
    for (const [i, f] of out.files.entries()) {
      const form = new FormData();
      form.append('chat_id', chat);
      const method = f.kind === 'image' ? 'sendPhoto' : 'sendDocument';
      form.append(f.kind === 'image' ? 'photo' : 'document', new Blob([new Uint8Array(f.data)], { type: f.mime }), f.name);
      if (i === 0 && text && text.length <= 1000) {
        form.append('caption', text);
        text = '';
      }
      const r = await this.call<{ message_id: number }>(token, method, undefined, form);
      lastId = `${chat}:${r.message_id}`;
    }
    for (const part of text ? splitText(text) : []) {
      const r = await this.call<{ message_id: number }>(token, 'sendMessage', { chat_id: chat, text: part });
      lastId = `${chat}:${r.message_id}`;
    }
    return { externalId: lastId };
  }

  async download(ctx: ConnectorContext, att: AttachmentMeta) {
    const token = ctx.creds.botToken;
    if (!token || !att.ref) throw new ChannelError('not_available', 'This attachment cannot be downloaded', { status: 404 });
    const f = await this.call<{ file_path?: string; file_size?: number }>(token, 'getFile', { file_id: att.ref });
    if (!f.file_path) throw new ChannelError('not_available', 'Telegram no longer has this file', { status: 404 });
    if ((f.file_size ?? 0) > 20 * 1024 * 1024) throw new ChannelError('too_large', 'File is larger than 20 MB', { status: 413 });
    const r = await http(`${this.apiBase}/file/bot${token}/${f.file_path}`, { raw: true, secrets: [token], timeoutMs: 30_000 });
    return { data: r.buffer!, mime: att.mime ?? r.contentType ?? 'application/octet-stream', name: att.name ?? f.file_path.split('/').pop() ?? 'file' };
  }
}
