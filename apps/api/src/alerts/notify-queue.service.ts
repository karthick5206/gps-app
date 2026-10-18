import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotifyChannel } from '@veetracer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { NOTIFY_STREAM_MAXLEN } from './alert-dto';

export interface QueuedMessage {
  channel: NotifyChannel;
  recipient: string;
  templateId: string | null;
  subject: string | null;
  body: string;
  alertId?: string | null;
}

/**
 * Pre-rendered messages (tests) are stored as QUEUED NotificationLog rows and handed to the notifier by id, so the
 * caller gets the log ids immediately. Alert jobs (`alertId`) are queued by the processor / offline sweeper.
 */
@Injectable()
export class NotifyQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async enqueueMessages(companyId: string, messages: QueuedMessage[]): Promise<string[]> {
    if (!messages.length) return [];
    const rows = await this.prisma.$transaction(
      messages.map((m) =>
        this.prisma.notificationLog.create({
          data: {
            companyId,
            alertId: m.alertId ?? null,
            channel: m.channel,
            recipient: m.recipient,
            templateId: m.templateId,
            subject: m.subject,
            body: m.body,
            status: 'QUEUED',
          } satisfies Prisma.NotificationLogUncheckedCreateInput,
          select: { id: true },
        }),
      ),
    );
    const ids = rows.map((r) => r.id);
    await this.redis.client.xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'logIds', JSON.stringify(ids), 'companyId', companyId);
    return ids;
  }

  async enqueueAlert(companyId: string, alertId: string): Promise<void> {
    await this.redis.client.xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', alertId, 'companyId', companyId);
  }
}
