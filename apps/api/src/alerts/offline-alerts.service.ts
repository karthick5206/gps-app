import { Injectable, Logger } from '@nestjs/common';
import { LiveObject } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { pendingToDto } from '../processor/rules/rules-engine';
import { emptyAlertState, canEmit } from '../processor/rules/evaluate';
import { NOTIFY_STREAM_MAXLEN } from './alert-dto';
import { formatDuration } from './logic/time-window';
import { RulesRepository } from './rules-data';

/** Only alert while the offline period is fresh, so restarts after long downtime don't flood notifications. */
const MAX_LATE_ALERT_MS = 30 * 60_000;
const EPISODE_KEY_TTL_SEC = 90 * 24 * 3600;

interface OfflineMark {
  episode: string; // serverTime of the last data before going offline
  at: number; // when the alert was raised
}

const offlineKey = (objectId: string) => `${RedisKeys.alertState(objectId)}:offline`;

/**
 * DEVICE_OFFLINE alerts, driven by the API's offline sweeper. An object alerts once per offline episode, when it has
 * been silent for max(company offline threshold, the setting's `afterMin`).
 */
@Injectable()
export class OfflineAlertService {
  private readonly logger = new Logger(OfflineAlertService.name);
  private readonly repo: RulesRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.repo = new RulesRepository(prisma);
    redis.subscribe([RedisKeys.rulesInvalidate, RedisKeys.cacheInvalidate], (channel, message) => {
      if (channel === RedisKeys.cacheInvalidate) return this.repo.invalidate();
      try {
        this.repo.invalidate((JSON.parse(message) as { companyId?: string }).companyId ?? null);
      } catch {
        this.repo.invalidate();
      }
    });
  }

  /** `lives` are OFFLINE objects of one company (newly marked or already offline). Returns the number of alerts raised. */
  async check(companyId: string, lives: LiveObject[], now: number): Promise<number> {
    if (!lives.length) return 0;
    const rules = await this.repo.get(companyId);
    const due: { live: LiveObject; offlineMs: number }[] = [];
    for (const live of lives) {
      if (!live.serverTime) continue;
      const setting = rules.effective(live.objectId).get('DEVICE_OFFLINE');
      if (!setting?.enabled) continue;
      const afterMin = typeof setting.params.afterMin === 'number' ? setting.params.afterMin : null;
      const thresholdMs = Math.max(rules.offlineAfterSec * 1000, (afterMin ?? 0) * 60_000);
      const offlineMs = now - Date.parse(live.serverTime);
      if (offlineMs < thresholdMs || offlineMs > thresholdMs + MAX_LATE_ALERT_MS) continue;
      due.push({ live, offlineMs });
    }
    if (!due.length) return 0;

    const marks = await this.redis.client.mget(due.map((d) => offlineKey(d.live.objectId)));
    let raised = 0;
    for (const [i, { live, offlineMs }] of due.entries()) {
      let mark: OfflineMark | null = null;
      try {
        mark = marks[i] ? (JSON.parse(marks[i]!) as OfflineMark) : null;
      } catch {
        mark = null;
      }
      if (mark?.episode === live.serverTime) continue;
      const setting = rules.effective(live.objectId).get('DEVICE_OFFLINE');
      const state = emptyAlertState();
      if (mark) state.cd.DEVICE_OFFLINE = mark.at;
      const allowed = canEmit(setting, state, 'DEVICE_OFFLINE', now, rules.timezone);
      // Claim the episode atomically (SET … GET) so two API instances never alert twice for it.
      const next: OfflineMark = { episode: live.serverTime!, at: allowed ? now : (mark?.at ?? 0) };
      const previous = (await this.redis.client.call(
        'SET',
        offlineKey(live.objectId),
        JSON.stringify(next),
        'EX',
        String(EPISODE_KEY_TTL_SEC),
        'GET',
      )) as string | null;
      if (previous && previous.includes(`"episode":"${live.serverTime}"`)) continue;
      if (!allowed) continue;
      try {
        await this.raise(live, setting.severity, offlineMs, now);
        raised++;
      } catch (error) {
        this.logger.error(`DEVICE_OFFLINE alert for ${live.objectId} failed: ${(error as Error).message}`);
      }
    }
    if (raised) this.logger.log(`Raised ${raised} DEVICE_OFFLINE alert(s)`);
    return raised;
  }

  private async raise(live: LiveObject, severity: 'INFO' | 'WARNING' | 'CRITICAL', offlineMs: number, now: number): Promise<void> {
    const durationSec = Math.round(offlineMs / 1000);
    const pending = {
      id: randomUUID(),
      type: 'DEVICE_OFFLINE' as const,
      severity,
      message: `No data for ${formatDuration(durationSec)}`,
      occurredAt: now,
      lat: live.lat,
      lng: live.lng,
      geofenceId: null,
      geofenceName: null,
      data: { durationSec, lastSeen: live.serverTime },
      object: {
        objectId: live.objectId,
        companyId: live.companyId,
        branchId: live.branchId,
        name: live.name,
        plateNumber: live.plateNumber,
        deviceId: live.deviceId,
        speedLimitKph: live.speedLimitKph,
      },
    };
    await this.prisma.alert.create({
      data: {
        id: pending.id,
        companyId: live.companyId,
        objectId: live.objectId,
        deviceId: live.deviceId,
        type: pending.type,
        severity,
        message: pending.message,
        lat: live.lat,
        lng: live.lng,
        data: pending.data,
        occurredAt: new Date(now),
      },
    });
    await this.redis.client
      .pipeline()
      .publish(RedisKeys.alertsChannel, JSON.stringify({ companyId: live.companyId, alert: pendingToDto(pending) }))
      .xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', pending.id, 'companyId', live.companyId)
      .exec();
  }
}
