import { Injectable, Logger } from '@nestjs/common';
import { AlertsReadEvent } from '@veetracer/shared';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';

/** Above this many ids an event carries none and clients refetch (keeps socket payloads small). */
export const SYNC_MAX_IDS = 200;

/** Messages on `vt:alerts:state`, fanned out by every API instance's LiveGateway to its own sockets. */
export type AlertStateMessage =
  | { kind: 'read'; userId: string; event: AlertsReadEvent }
  | { kind: 'acked'; companyId: string; items: { id: string; objectId: string }[] | null; ackByName: string | null; ackAt: string };

/**
 * Tells open sessions (web tabs, phones) that alerts were read or acknowledged, through Valkey pub/sub so it works
 * with several API instances. Best effort: a failed publish never fails the request (clients also poll the count).
 */
@Injectable()
export class AlertSyncService {
  private readonly logger = new Logger(AlertSyncService.name);

  constructor(private readonly redis: RedisService) {}

  /** The user's own sockets: these alerts (or all of them) are now read for that user. */
  read(userId: string, event: AlertsReadEvent): Promise<void> {
    const small = event.ids && event.ids.length > SYNC_MAX_IDS ? {} : event;
    return this.publish({ kind: 'read', userId, event: small });
  }

  /** In-scope sockets of the company: these alerts were acknowledged; `items` null = many (refetch). */
  acked(companyId: string, items: { id: string; objectId: string }[] | null, ackByName: string | null, ackAt: string): Promise<void> {
    return this.publish({ kind: 'acked', companyId, items: items && items.length > SYNC_MAX_IDS ? null : items, ackByName, ackAt });
  }

  private async publish(message: AlertStateMessage): Promise<void> {
    try {
      await this.redis.client.publish(RedisKeys.alertsState, JSON.stringify(message));
    } catch (error) {
      this.logger.warn(`Could not publish alert state: ${(error as Error).message}`);
    }
  }
}
