import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { ChannelError } from './types.js';

/**
 * Credentials (bot tokens, page tokens, API keys) are stored AES-256-GCM encrypted with a key that lives only in the server environment.
 * A database dump alone therefore does not reveal them. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
export class Vault {
  private readonly key: Buffer | null;
  constructor(secret: Buffer | undefined) {
    if (secret && secret.length !== 32) throw new Error('CHANNEL_SECRET_KEY must be 32 bytes, base64 encoded (e.g. `openssl rand -base64 32`)');
    this.key = secret ?? null;
  }

  get configured(): boolean {
    return this.key !== null;
  }

  private need(): Buffer {
    if (!this.key) throw new ChannelError('vault_not_configured', 'CHANNEL_SECRET_KEY is not configured on the server, so channel credentials cannot be stored safely.', { retryable: false, status: 503 });
    return this.key;
  }

  encrypt(data: Record<string, string>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.need(), iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(blob: string | null | undefined): Record<string, string> {
    if (!blob) return {};
    const [v, iv, tag, ct] = blob.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new ChannelError('credentials_unreadable', 'Stored credentials are in an unknown format', { retryable: false });
    try {
      const d = createDecipheriv('aes-256-gcm', this.need(), Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
    } catch (e) {
      if (e instanceof ChannelError) throw e;
      throw new ChannelError('credentials_unreadable', 'Stored credentials could not be decrypted (was CHANNEL_SECRET_KEY changed?)', { retryable: false });
    }
  }

  /** Purpose-bound HMAC (widget visitor tokens, OAuth state). Different purposes never validate each other's tokens. */
  sign(purpose: string, payload: string): string {
    const k = Buffer.from(hkdfSync('sha256', this.need(), Buffer.alloc(0), `microagent:${purpose}`, 32));
    return createHmac('sha256', k).update(payload).digest('base64url');
  }

  verify(purpose: string, payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(purpose, payload));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomKey = (bytes = 24) => randomBytes(bytes).toString('base64url');
