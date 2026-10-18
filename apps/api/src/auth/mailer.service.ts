import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTransport, Transporter } from 'nodemailer';
import { APP_ROOT } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** M1 mailer: renders through nodemailer's stream transport and writes the HTML body to var/mail/. */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport: Transporter = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  private readonly outDir = join(APP_ROOT, 'var', 'mail');

  async send(message: MailMessage): Promise<string> {
    await this.transport.sendMail({ from: 'VeeTracer <no-reply@veetracer.local>', ...message });
    await mkdir(this.outDir, { recursive: true });
    const file = join(this.outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
    await writeFile(file, message.html, 'utf8');
    this.logger.log(`Mail "${message.subject}" to ${message.to} written to ${file}`);
    return file;
  }
}
