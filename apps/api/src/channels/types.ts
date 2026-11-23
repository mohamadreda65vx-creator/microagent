/**
 * Channel Manager contracts.
 *
 * A Connector knows ONE external service. It never touches the database and never calls the AI Engine:
 * it only (1) manages the remote connection, (2) turns provider payloads into the normalized shapes below,
 * and (3) sends normalized outbound messages. Storage, idempotency, retries, hand-off and AI live in the manager.
 */
export const CHANNEL_TYPES = ['whatsapp', 'messenger', 'instagram', 'telegram', 'website', 'tiktok'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const PROVIDERS = ['evolution', 'whatsapp_cloud', 'telegram_bot', 'meta', 'widget'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type ChannelStatus = 'pending' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'awaiting_approval' | 'not_configured';

export class ChannelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  constructor(code: string, message: string, opts: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? 502;
  }
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';
export interface AttachmentMeta {
  kind: AttachmentKind;
  name?: string;
  mime?: string;
  size?: number;
  /** Provider reference used to download it on demand (Telegram file_id, WhatsApp message id...). */
  ref?: string;
  /** Our own stored file (outbound uploads). */
  fileId?: string;
}

export interface InboundMessage {
  /** Unique PER CHANNEL. Replays of the same webhook must produce the same id (this is the idempotency key). */
  externalId: string;
  contactExternalId: string;
  contactName?: string;
  contactPhone?: string;
  text: string;
  attachments: AttachmentMeta[];
  at: Date;
}

export type WebhookEvent =
  | { kind: 'message'; message: InboundMessage }
  | { kind: 'status'; externalId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  /** Everything the contact has been sent before this moment is now read (Messenger/Instagram watermark). */
  | { kind: 'read_until'; contactExternalId: string; at: Date }
  | { kind: 'connection'; state: 'connected' | 'connecting' | 'disconnected'; detail?: string }
  | { kind: 'qr'; qr: string }
  | { kind: 'ignored'; reason: string };

export interface WebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
  rawBody: Buffer;
}

export interface OutboundFile {
  kind: AttachmentKind;
  name: string;
  mime: string;
  data: Buffer;
}
export interface OutboundMessage {
  contactExternalId: string;
  text: string;
  files: OutboundFile[];
}
export interface SendResult {
  externalId: string | null;
}

/** Everything a connector may need about the channel. `creds` is decrypted in memory only. */
export interface ConnectorContext {
  channel: { id: string; tenantId: string; type: ChannelType; provider: Provider; name: string; publicKey: string; externalAccountId: string | null; config: Record<string, unknown> };
  creds: Record<string, string>;
  /** Public URL the provider must call for this channel. */
  webhookUrl: string;
}

export interface ConnectResult {
  status: ChannelStatus;
  creds: Record<string, string>;
  externalAccountId?: string;
  config?: Record<string, unknown>;
  qr?: string;
  message?: string;
}

export interface StatusResult {
  state: 'connected' | 'connecting' | 'disconnected';
  qr?: string;
  detail?: string;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'down';
  detail?: string;
  /** Set when the remote account says the credentials/session are no longer valid. */
  needsReconnect?: boolean;
}

export interface Capabilities {
  sendFiles: boolean;
  deliveryStatus: boolean;
  /** Provider limits when a customer can be messaged (e.g. Meta 24h window). Informational. */
  replyWindowHours: number | null;
  maxTextLength: number;
}

export interface Connector {
  readonly type: ChannelType;
  readonly provider: Provider;
  /** false = declared but cannot be used yet (TikTok, WhatsApp Cloud API). */
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly capabilities: Capabilities;
  /** Validate input and return the remote account id BEFORE anything is created remotely (to refuse accounts already used by another company). */
  identify?(input: Record<string, string>, ctx: ConnectorContext): Promise<{ externalAccountId: string; config?: Record<string, unknown> }>;
  connect(input: Record<string, string>, ctx: ConnectorContext): Promise<ConnectResult>;
  /** Start a new pairing/login (WhatsApp QR). */
  reconnect?(ctx: ConnectorContext): Promise<ConnectResult>;
  disconnect(ctx: ConnectorContext): Promise<void>;
  status(ctx: ConnectorContext): Promise<StatusResult>;
  health(ctx: ConnectorContext): Promise<HealthResult>;
  /** Verify authenticity (signature/secret) and normalize. Throws ChannelError('invalid_signature') when not authentic. */
  parseWebhook(ctx: ConnectorContext, req: WebhookRequest): Promise<WebhookEvent[]>;
  send(ctx: ConnectorContext, out: OutboundMessage): Promise<SendResult>;
  /** Best-effort display name for a new contact (Messenger/Instagram only expose an opaque id in webhooks). */
  profile?(ctx: ConnectorContext, contactExternalId: string): Promise<{ name?: string }>;
  /** Fetch an inbound attachment on demand. */
  download?(ctx: ConnectorContext, att: AttachmentMeta): Promise<{ data: Buffer; mime: string; name: string }>;
}
