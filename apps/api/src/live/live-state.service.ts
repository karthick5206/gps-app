import { Injectable } from '@nestjs/common';
import { LiveObject } from '@veetracer/shared';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { parseLive } from '../tracking/live-object';

const MGET_CHUNK = 1000;

/** Reads live object state written by the processor. */
@Injectable()
export class LiveStateService {
  constructor(private readonly redis: RedisService) {}

  async read(objectIds: string[]): Promise<Map<string, LiveObject>> {
    const result = new Map<string, LiveObject>();
    for (let i = 0; i < objectIds.length; i += MGET_CHUNK) {
      const ids = objectIds.slice(i, i + MGET_CHUNK);
      const values = await this.redis.client.mget(ids.map(RedisKeys.live));
      values.forEach((json, idx) => {
        const live = parseLive(json);
        if (live) result.set(ids[idx], live);
      });
    }
    return result;
  }
}
