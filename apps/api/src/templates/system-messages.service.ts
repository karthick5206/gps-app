import { Injectable, Logger } from '@nestjs/common';
import { NotifyChannel } from '@prisma/client';
import { ArattaiOtp } from '../notifier/arattai';
import { createSmsProvider, SmsProvider } from '../notifier/sms';
import { PrismaService } from '../prisma/prisma.service';
import { Rendered, TemplateChannel, TemplateRenderer } from './template-renderer';

/**
 * Renders SYSTEM_* templates (company override → system) for the API's own messages (password reset, OTP) and
 * records them in NotificationLog. Secrets in bodies are masked before logging.
 */
@Injectable()
export class SystemMessagesService {
  private readonly logger = new Logger(SystemMessagesService.name);
  private readonly renderer: TemplateRenderer;
  readonly sms: SmsProvider = createSmsProvider();
  /** Arattai Business verification codes (Platform Settings → Arattai switch). */
  readonly arattai: ArattaiOtp;

  constructor(private readonly prisma: PrismaService) {
    this.renderer = new TemplateRenderer(prisma);
    this.arattai = new ArattaiOtp(prisma);
  }

  /** A verification code by Arattai when switched on; logged like the SMS (provider "arattai", code masked). */
  async sendArattaiOtp(companyId: string | null, mobile: string, code: string, validityMinutes: number): Promise<boolean> {
    const r = await this.arattai.sendOtp(mobile, code, validityMinutes);
    if (companyId && (r.sent || r.error)) {
      await this.log({ companyId, channel: 'SMS', recipient: mobile, templateId: null, subject: null, body: `Arattai verification code ${code} (valid ${validityMinutes} min)`, status: r.sent ? 'SENT' : 'FAILED', error: r.error, provider: 'arattai', secrets: [code] });
    }
    return r.sent;
  }

  render(companyId: string | null, purpose: string, channel: TemplateChannel, vars: Record<string, unknown>): Promise<Rendered | null> {
    return this.renderer.render(companyId, purpose, channel, vars);
  }

  async log(entry: {
    companyId: string;
    channel: NotifyChannel;
    recipient: string;
    templateId: string | null;
    subject: string | null;
    body: string;
    status: 'SENT' | 'FAILED';
    error?: string | null;
    provider: string;
    secrets?: string[];
  }): Promise<void> {
    let body = entry.body;
    for (const s of entry.secrets ?? []) if (s) body = body.split(s).join('******');
    try {
      await this.prisma.notificationLog.create({
        data: {
          companyId: entry.companyId,
          channel: entry.channel,
          recipient: entry.recipient,
          templateId: entry.templateId,
          subject: entry.subject,
          body,
          status: entry.status,
          error: entry.error ?? null,
          provider: entry.provider,
          sentAt: entry.status === 'SENT' ? new Date() : null,
        },
      });
    } catch (error) {
      this.logger.warn(`NotificationLog write failed: ${(error as Error).message}`);
    }
  }
}
