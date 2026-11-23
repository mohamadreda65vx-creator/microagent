import type { Config } from '../config/env.js';
import { Vault } from './crypto.js';
import { MetaConnector, MetaPlatform } from './meta.js';
import { TelegramConnector } from './telegram.js';
import { TikTokConnector } from './tiktok.js';
import { ChannelError, type ChannelType, type Connector, type Provider } from './types.js';
import { WebsiteConnector } from './website.js';
import { EvolutionConnector } from './whatsapp-evolution.js';
import { WhatsAppCloudConnector } from './whatsapp-cloud.js';

/** Which provider each platform uses by default, and which alternatives exist. Switching WhatsApp to the Cloud API = change the provider here. */
export const DEFAULT_PROVIDER: Record<ChannelType, Provider> = {
  whatsapp: 'evolution',
  messenger: 'meta',
  instagram: 'meta',
  telegram: 'telegram_bot',
  website: 'widget',
  tiktok: 'meta',
};

export class ConnectorRegistry {
  readonly vault: Vault;
  readonly meta: MetaPlatform;
  private readonly all: Connector[];

  constructor(config: Config) {
    this.vault = new Vault(config.channels.secretKey);
    this.meta = new MetaPlatform(config.channels.meta);
    this.all = [
      new TelegramConnector(config.channels.telegramApiBase),
      new EvolutionConnector(config.channels.evolution),
      new WhatsAppCloudConnector(),
      new MetaConnector('messenger', this.meta),
      new MetaConnector('instagram', this.meta),
      new WebsiteConnector(),
      new TikTokConnector(),
    ];
  }

  get(type: ChannelType, provider: Provider): Connector {
    const c = this.all.find((x) => x.type === type && x.provider === provider);
    if (!c) throw new ChannelError('unknown_connector', `No connector for ${type}/${provider}`, { status: 400 });
    return c;
  }

  forType(type: ChannelType): Connector {
    return this.get(type, DEFAULT_PROVIDER[type]);
  }

  list(): Connector[] {
    return this.all;
  }
}
