import { ChannelError, type Connector, type ConnectorContext, type ConnectResult } from './types.js';

/** TikTok is planned for a later part. Declared so the platform list is complete; it cannot be created or used. */
export class TikTokConnector implements Connector {
  readonly type = 'tiktok' as const;
  readonly provider = 'meta' as const; // never used: the channel cannot be created
  readonly available = false;
  readonly unavailableReason = 'TikTok is planned for a later release.';
  readonly capabilities = { sendFiles: false, deliveryStatus: false, replyWindowHours: null, maxTextLength: 1000 };
  private nope(): never {
    throw new ChannelError('not_implemented', this.unavailableReason, { status: 501 });
  }
  connect(_i: Record<string, string>, _c: ConnectorContext): Promise<ConnectResult> { return this.nope(); }
  disconnect(): Promise<void> { return this.nope(); }
  status(): never { return this.nope(); }
  health(): never { return this.nope(); }
  parseWebhook(): never { return this.nope(); }
  send(): never { return this.nope(); }
}
