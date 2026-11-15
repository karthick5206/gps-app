import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { etmsServerEnabled } from '../transport-feature.guard';
import { LIVE_DISPATCH_STATE_KEY, LiveDispatchService } from './live-dispatch.service';
import { liveDispatchKilled } from './pooling-settings';

const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
export const LIVE_DISPATCH_SCAN_LOCK = 'vt:etms:dispatch:scan';
export const liveDispatchCompanyLock = (companyId: string) => `vt:etms:dispatch:lock:${companyId}`;
const TICK_MS = 5_000;
const LOCK_MS = 60_000;

/**
 * Live dispatch worker (doc 20 §5.1, §5.4), in the API process. Every 5 s: (1) delay / breakdown reports since the
 * high-water mark become evaluation requests (one instance, Valkey lock); (2) QUEUED / retryable FAILED requests are
 * decided company by company under a per-company Valkey lock (one decision per company at a time; the publish
 * transaction's advisory locks per vehicle / driver still serialise against dispatchers). Recovery is natural: the
 * requests are rows, so a restart re-reads them. Kill switch: ETMS_LIVE_DISPATCH=off (and ETMS=off). Health: the last
 * completed pass in Valkey (System Health check pipeline.etms-dispatch).
 */
@Injectable()
export class LiveDispatchWorker {
  private readonly logger = new Logger('EtmsLiveDispatchWorker');
  private readonly instance = randomUUID();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly live: LiveDispatchService,
  ) {}

  get enabled(): boolean {
    return etmsServerEnabled() && !liveDispatchKilled();
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      await this.withLock(LIVE_DISPATCH_SCAN_LOCK, async () => {
        await this.live.scanReports();
        // Review fix 2: unacknowledged live route changes past ACK_OVERDUE_MS become dispatcher proposals.
        await this.live.escalateOverdueAcks();
      });
      const queued = await this.prisma.transportDispatchRequest.findMany({ where: { status: { in: ['QUEUED', 'FAILED'] }, attempts: { lt: 3 } }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, companyId: true } });
      const byCompany = new Map<string, string[]>();
      for (const q of queued) byCompany.set(q.companyId, [...(byCompany.get(q.companyId) ?? []), q.id]);
      for (const [companyId, ids] of byCompany) {
        await this.withLock(liveDispatchCompanyLock(companyId), async () => {
          for (const id of ids) await this.live.process(id);
        });
      }
      await this.redis.client.set(LIVE_DISPATCH_STATE_KEY, JSON.stringify({ at: Date.now(), processed: queued.length }), 'PX', 24 * 3_600_000).catch(() => undefined);
    } catch (error) {
      this.logger.error(`Live dispatch pass failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    const ok = (await this.redis.client.set(key, this.instance, 'PX', LOCK_MS, 'NX').catch(() => null)) === 'OK';
    if (!ok) return null;
    try {
      return await fn();
    } finally {
      await this.redis.client.eval(RELEASE_LOCK, 1, key, this.instance).catch(() => undefined);
    }
  }
}
