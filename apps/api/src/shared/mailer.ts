import nodemailer from 'nodemailer';
import type { Config } from '../config/env.js';
import type { Pools } from '../db/pool.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** 'smtp' when SMTP_HOST is configured, otherwise 'outbox' (development only — nothing is delivered). */
  readonly mode: 'smtp' | 'outbox';
  send(mail: Mail): Promise<void>;
}

export function createMailer(config: Config, pools: Pools, log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }): Mailer {
  if (config.smtp.host) {
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
    return {
      mode: 'smtp',
      async send(mail) {
        await transport.sendMail({ from: config.smtp.from, to: mail.to, subject: mail.subject, text: mail.text });
      },
    };
  }

  if (config.nodeEnv === 'production') {
    log.warn({}, 'SMTP is not configured: password reset and invitation emails are NOT delivered. Set SMTP_* in .env.');
  }
  return {
    mode: 'outbox',
    async send(mail) {
      await pools.app.query('INSERT INTO email_outbox (to_email, subject, body) VALUES ($1, $2, $3)', [mail.to, mail.subject, mail.text]);
      // The body contains one-time links. Printing them is a development convenience only.
      if (config.nodeEnv === 'development') {
        log.info({ to: mail.to, subject: mail.subject }, `[dev email outbox]\n${mail.text}`);
      }
    },
  };
}
