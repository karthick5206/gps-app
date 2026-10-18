import { Injectable, Logger } from '@nestjs/common';
import { NotifyChannel } from '@prisma/client';
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

  constructor(private readonly prisma: PrismaService) {
    this.renderer = new TemplateRenderer(prisma);
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
