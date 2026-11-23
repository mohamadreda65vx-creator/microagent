import {
  type Connector,
  type ConnectorContext,
  type ConnectResult,
  type HealthResult,
  type OutboundMessage,
  type SendResult,
  type StatusResult,
  type WebhookEvent,
} from './types.js';

/**
 * Website chat has no external service: the visitor's browser talks to our public widget endpoints and the manager
 * stores/serves messages. "Sending" to a visitor therefore means "make it available for the widget to fetch" (the widget polls).
 */
export class WebsiteConnector implements Connector {
  readonly type = 'website' as const;
  readonly provider = 'widget' as const;
  readonly available = true;
  readonly capabilities = { sendFiles: true, deliveryStatus: true, replyWindowHours: null, maxTextLength: 2000 };
  async connect(_i: Record<string, string>, _c: ConnectorContext): Promise<ConnectResult> {
    return { status: 'connected', creds: {} };
  }
  async disconnect(): Promise<void> {}
  async status(): Promise<StatusResult> {
    return { state: 'connected' };
  }
  async health(): Promise<HealthResult> {
    return { status: 'healthy' };
  }
  async parseWebhook(): Promise<WebhookEvent[]> {
    return [{ kind: 'ignored', reason: 'the website widget does not use webhooks' }];
  }
  async send(_c: ConnectorContext, _o: OutboundMessage): Promise<SendResult> {
    return { externalId: null };
  }
}
