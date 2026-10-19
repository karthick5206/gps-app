import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LiveObject } from '@veetracer/shared';
import { OfflineAlertService } from '../alerts/offline-alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { COMPARE_AND_SET_SCRIPT, RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { parseLive } from '../tracking/live-object';
import { apiMetrics } from '../monitoring/api-metrics';
import { companyThresholds } from '../tracking/thresholds';

const CHUNK = 1000;

/** Marks objects OFFLINE when no data arrived for the company's `offlineAfterSec` (runs every 30 s). */
@Injectable()
export class OfflineSweeperService {
  private readonly logger = new Logger(OfflineSweeperService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() private readonly offlineAlerts?: OfflineAlertService,
  ) {}

  @Interval(30_000)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const marked = await this.sweepAll(Date.now());
      if (marked) this.logger.log(`Marked ${marked} object(s) offline`);
    } catch (error) {
      this.logger.error(`Offline sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
      apiMetrics.sweeperLastRunAt = new Date().toISOString();
    }
  }

  private async sweepAll(now: number): Promise<number> {
    const companyIds = await this.liveCompanies();
    if (!companyIds.length) return 0;
    const companies = await this.prisma.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, settings: true },
    });
    let marked = 0;
    for (const company of companies) {
      const cutoff = now - companyThresholds(company.settings).offlineAfterSec * 1000;
      const objectIds = await this.redis.client.smembers(RedisKeys.liveCompany(company.id));
      for (let i = 0; i < objectIds.length; i += CHUNK) {
        marked += await this.sweepChunk(company.id, objectIds.slice(i, i + CHUNK), cutoff, new Date(now).toISOString());
      }
    }
    return marked;
  }

  private async sweepChunk(companyId: string, objectIds: string[], cutoff: number, nowIso: string): Promise<number> {
    const keys = objectIds.map(RedisKeys.live);
    const values = await this.redis.client.mget(keys);
    const lives = values.map((v) => parseLive(v));
    // A parked tracker may send only heartbeats (no positions) yet stay connected: the gateway refreshes its
    // connection key on any traffic, so an object whose device still has one is not offline.
    const stale = lives.map((live) => !!live?.serverTime && live.status !== 'OFFLINE' && Date.parse(live.serverTime) < cutoff);
    const connectedIds = lives.map((live, i) => (stale[i] && live?.uniqueId ? live.uniqueId : null));
    const probe = connectedIds.filter((id): id is string => id !== null);
    const connected = new Set<string>();
    if (probe.length) {
      const conns = await this.redis.client.mget(probe.map(RedisKeys.connection));
      probe.forEach((id, k) => conns[k] && connected.add(id));
    }
    let marked = 0;
    const offlineNow: LiveObject[] = [];
    for (let i = 0; i < keys.length; i++) {
      const current = values[i];
      const live = lives[i];
      if (!current || !live?.serverTime) continue;
      if (live.status === 'OFFLINE') {
        offlineNow.push(live);
        continue;
      }
      if (!stale[i] || (live.uniqueId && connected.has(live.uniqueId))) continue;
      const offline: LiveObject = { ...live, status: 'OFFLINE', statusSince: nowIso, speedKph: 0 };
      const json = JSON.stringify(offline);
      const swapped = await this.redis.client.eval(COMPARE_AND_SET_SCRIPT, 1, keys[i], current, json);
      if (swapped !== 1) continue;
      await this.redis.client.publish(RedisKeys.liveUpdates, JSON.stringify({ companyId, live: offline }));
      marked++;
      offlineNow.push(offline);
    }
    // DEVICE_OFFLINE alerts (respecting a larger `afterMin` override); never let alerting break the sweep.
    if (this.offlineAlerts && offlineNow.length) {
      await this.offlineAlerts.check(companyId, offlineNow, Date.parse(nowIso)).catch((error: Error) => {
        this.logger.error(`Offline alerts failed: ${error.message}`);
      });
    }
    return marked;
  }

  private async liveCompanies(): Promise<string[]> {
    const ids: string[] = [];
    const prefix = RedisKeys.liveCompany('');
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', RedisKeys.liveCompanyPattern, 'COUNT', 500);
      cursor = next;
      ids.push(...keys.map((k) => k.slice(prefix.length)));
    } while (cursor !== '0');
    return ids;
  }
}
