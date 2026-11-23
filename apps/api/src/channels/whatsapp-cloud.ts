import { ChannelError, type Connector, type ConnectorContext, type ConnectResult } from './types.js';

/**
 * Placeholder for the OFFICIAL WhatsApp Cloud API connector.
 * It is registered (so the provider switch is a one-line change) but NOT implemented and not usable.
 *
 * To implement: copy the shape of whatsapp-evolution.ts. Differences to handle:
 *  - connect(): OAuth / Embedded Signup + phone_number_id + permanent token instead of a QR code;
 *  - parseWebhook(): X-Hub-Signature-256 (app secret) + the `entry[].changes[].value.messages/statuses` payload;
 *  - send(): POST /{phone_number_id}/messages (free-text only inside the 24h window, templates outside it).
 * Because storage, retries, hand-off and the AI are in the manager, nothing else changes.
 */
export class WhatsAppCloudConnector implements Connector {
  readonly type = 'whatsapp' as const;
  readonly provider = 'whatsapp_cloud' as const;
  readonly available = false;
  readonly unavailableReason = 'WhatsApp Cloud API (official) is not implemented yet. Use the QR connection for now.';
  readonly capabilities = { sendFiles: false, deliveryStatus: true, replyWindowHours: 24, maxTextLength: 4096 };
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
