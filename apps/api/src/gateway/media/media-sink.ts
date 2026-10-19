import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { DriverMediaMessage, writeIncoming } from '../../driver-events/media-store';
import { RedisKeys } from '../../redis/keys';
import { DecodedMedia } from '../protocol';

const STREAM_MAXLEN = 20_000;
/** Media written per minute at most (a misbehaving device must not fill the disk). */
const MAX_PER_MINUTE = 600;

/**
 * Stores photos / clips from devices under var/driver-media/incoming/ and announces them on `vt:driver-media`; the
 * notifier links them to driver events (or deletes them when nothing matches).
 */
export class MediaSink {
  private readonly logger = new Logger('Media');
  private windowStart = Date.now();
  private inWindow = 0;
  readonly stats = { stored: 0, dropped: 0 };

  constructor(
    private readonly redis: Redis,
    private readonly write: (data: Buffer, mime: string) => Promise<string> = writeIncoming,
  ) {}

  accept(items: DecodedMedia[]): void {
    for (const m of items) void this.store(m);
  }

  async store(m: DecodedMedia): Promise<DriverMediaMessage | null> {
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    if (++this.inWindow > MAX_PER_MINUTE) {
      this.stats.dropped++;
      return null;
    }
    try {
      const path = await this.write(m.data, m.mime);
      const msg: DriverMediaMessage = {
        path,
        uniqueId: m.uniqueId,
        source: m.source,
        kind: m.kind,
        mime: m.mime,
        size: m.data.length,
        channel: m.channel,
        capturedAt: m.capturedAt,
        lat: m.lat,
        lng: m.lng,
        eventId: m.eventId,
        ref: m.ref,
      };
      await this.redis.xadd(RedisKeys.driverMediaStream, 'MAXLEN', '~', STREAM_MAXLEN, '*', 'data', JSON.stringify(msg));
      this.stats.stored++;
      this.logger.log(`${m.source.toLowerCase()} ${m.kind.toLowerCase()} from ${m.uniqueId} ch${m.channel ?? '-'} (${m.data.length} bytes)`);
      return msg;
    } catch (error) {
      this.stats.dropped++;
      this.logger.error(`Storing media from ${m.uniqueId} failed: ${(error as Error).message}`);
      return null;
    }
  }
}
