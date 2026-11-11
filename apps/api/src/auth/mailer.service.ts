import { Injectable, Logger } from '@nestjs/common';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { createTransport, Transporter } from 'nodemailer';
import { APP_ROOT } from '../config/env';
import { sendZohoMail, zohoMailConfig } from './zoho-mail';

/** File attached to an e-mail: a path on disk or in-memory content. */
export interface MailAttachment {
  filename: string;
  path?: string;
  content?: Buffer | string;
  contentType?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
  /**
   * D6 G2: stable Message-ID (e.g. "<hash@veetrax.notify>") so a resend of the same notification carries the same id
   * and receiving systems that deduplicate by Message-ID can drop it. SMTP only; Zoho has no equivalent field.
   */
  messageId?: string;
}

/** What happened to one mail (D6 G3). */
export interface MailResult {
  /** Real delivery channel used ('zoho' | 'smtp'), or null when the mail was only written to var/mail / withheld. */
  provider: string | null;
  /** Provider id: SMTP Message-ID or Zoho request_id. */
  messageId: string | null;
  /** Development / opt-in copy written to var/mail, or '' when none. */
  file: string;
}

/**
 * Whether a full copy of each mail (body, attachments) is written to var/mail. Always in development; in production
 * (R-28) only with the explicit opt-in MAIL_KEEP_COPIES=true, because copies hold password-reset links, invoices and
 * customer data.
 */
export function keepMailCopies(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.MAIL_KEEP_COPIES === 'true';
}

/**
 * Subject for log lines: every run of 4+ digits is masked, so sign-in / activation / reset codes (e.g. "483920 is your
 * VeeTrax sign-in code") and phone numbers in subjects never reach journald; a link (a company template could put
 * {{reset_link}} in the subject) is replaced by [link].
 */
export function logSubject(subject: string): string {
  return subject.replace(/https?:\/\/\S+/gi, '[link]').replace(/\d{4,}/g, '******');
}

/** M1 mailer: renders through nodemailer's stream transport and writes the HTML body to var/mail/ (dev / opt-in). */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport: Transporter = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  private readonly outDir = join(APP_ROOT, 'var', 'mail');
  /** Real delivery when SMTP_URL is set (e.g. smtps://user:pass@smtp.example.com:465); var/mail copies are kept either way. */
  private readonly smtp: Transporter | null = process.env.SMTP_URL ? createTransport(process.env.SMTP_URL) : null;
  /** Zoho CPaaS e-mail API when ZOHO_MAIL_KEY is set (takes precedence over SMTP_URL). */
  private readonly zoho = zohoMailConfig();
  private readonly from = process.env.MAIL_FROM ?? 'VeeTrax <no-reply@veetracer.local>';
  private readonly replyTo = process.env.MAIL_REPLY_TO?.trim() || undefined;

  /** Name of the real delivery channel, or null when mails are only written to var/mail. */
  get provider(): string | null {
    return this.zoho ? 'zoho' : this.smtp ? 'smtp' : null;
  }

  async send(message: MailMessage): Promise<string> {
    return (await this.sendWithResult(message)).file;
  }

  /** Like send(), but reports the provider and its message id (notifier status, D6 G3). */
  async sendWithResult(message: MailMessage): Promise<MailResult> {
    if (!keepMailCopies()) {
      // Production: deliver through the real channel only; never store content on disk.
      const messageId = await this.deliver(message);
      if (!this.provider) this.logger.warn(`Mail "${logSubject(message.subject)}" to ${message.to} NOT DELIVERED: no mail provider configured (content withheld in production)`);
      else this.logger.log(`Mail "${logSubject(message.subject)}" to ${message.to} sent via ${this.provider}`);
      return { provider: this.provider, messageId, file: '' };
    }
    const { messageId: _stable, ...copy } = message;
    const info = (await this.transport.sendMail({ from: this.from, replyTo: this.replyTo, ...copy })) as { message?: Buffer };
    await mkdir(this.outDir, { recursive: true });
    // Random suffix: concurrent sends (notifier) within the same millisecond must not overwrite each other.
    const stem = join(this.outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`);
    const file = `${stem}.html`;
    await writeFile(file, message.html, 'utf8');
    if (message.attachments?.length) {
      // Dev transport: keep the complete MIME message (with attachments) and a plain copy of each attachment.
      if (info.message) await writeFile(`${stem}.eml`, info.message);
      for (const a of message.attachments) {
        const target = `${stem}-${basename(a.filename)}`;
        if (a.path) await copyFile(a.path, target);
        else if (a.content !== undefined) await writeFile(target, a.content);
      }
    }
    const messageId = await this.deliver(message);
    const extra = message.attachments?.length ? ` (+${message.attachments.length} attachment(s), ${stem}.eml)` : '';
    this.logger.log(`Mail "${logSubject(message.subject)}" to ${message.to} written to ${file}${extra}`);
    return { provider: this.provider, messageId, file };
  }

  /** Real delivery (Zoho first, then SMTP); returns the provider id, or null when no provider is configured. */
  private async deliver(message: MailMessage): Promise<string | null> {
    const { messageId, ...rest } = message;
    if (this.zoho) return sendZohoMail(this.zoho, { from: this.from, replyTo: this.replyTo, ...rest });
    if (this.smtp) {
      const info = (await this.smtp.sendMail({ from: this.from, replyTo: this.replyTo, ...rest, ...(messageId ? { messageId } : {}) })) as { messageId?: string };
      return info?.messageId ?? messageId ?? null;
    }
    return null;
  }
}
