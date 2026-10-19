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
}

/** M1 mailer: renders through nodemailer's stream transport and writes the HTML body to var/mail/. */
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
    const info = (await this.transport.sendMail({ from: this.from, replyTo: this.replyTo, ...message })) as { message?: Buffer };
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
    if (this.zoho) await sendZohoMail(this.zoho, { from: this.from, replyTo: this.replyTo, ...message });
    else if (this.smtp) await this.smtp.sendMail({ from: this.from, replyTo: this.replyTo, ...message });
    const extra = message.attachments?.length ? ` (+${message.attachments.length} attachment(s), ${stem}.eml)` : '';
    this.logger.log(`Mail "${message.subject}" to ${message.to} written to ${file}${extra}`);
    return file;
  }
}
