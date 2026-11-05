import { Injectable, Logger } from '@nestjs/common';
import { ackRequiredFor, LiveObject, MOBILE_TRACKER_PROTOCOL, sanitizeTrackerHealth, trackerHealthIssues } from '@veetracer/shared';
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
const NO_FIX_CAUSE_MS = 10 * 60_000;

interface OfflineMark {
  episode: string; // serverTime of the last data before going offline
  at: number; // when the alert was raised
}

const offlineKey = (objectId: string) => `${RedisKeys.alertState(objectId)}:offline`;

/**
 * DEVICE_OFFLINE alerts, driven by the API's offline sweeper. An object alerts once per offline episode, when it has
 * been silent for max(company offline threshold, the setting's `afterMin`).
 */
interface TrackerAlertTarget {
  companyId: string;
  deviceId: string;
  object: { id: string; name: string; branchId: string | null; plateNumber: string | null; speedLimitKph: number | null };
}

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
      if (!live.serverTime || live.inMaintenance) continue;
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
        // Parking mode: a tracker going quiet while armed (power cut, jammer) rings as an alarm.
        const armed = rules.parkingWindow(live.objectId, now);
        const alarm = !!armed?.alarmAllAlerts;
        await this.raise(live, setting.severity, alarm || ackRequiredFor(setting, 'DEVICE_OFFLINE', setting.severity), offlineMs, now, alarm);
        raised++;
      } catch (error) {
        this.logger.error(`DEVICE_OFFLINE alert for ${live.objectId} failed: ${(error as Error).message}`);
      }
    }
    if (raised) this.logger.log(`Raised ${raised} DEVICE_OFFLINE alert(s)`);
    return raised;
  }

  /**
   * Tracker app phones report their health with every upload: the most serious problem in the last report is the
   * likely reason the phone went quiet (e.g. location only while using the app, Data Saver).
   */
  private async phoneCause(deviceId: string | null): Promise<{ text: string; codes: string[] } | null> {
    if (!deviceId) return null;
    const d = await this.prisma.device
      .findUnique({ where: { id: deviceId }, select: { trackerHealth: true, trackerHealthAt: true, model: { select: { protocol: true } } } })
      .catch(() => null);
    if (!d || d.model.protocol !== MOBILE_TRACKER_PROTOCOL) return null;
    const health = sanitizeTrackerHealth(d.trackerHealth);
    // Tracking was switched off, so settings on the phone aren't the reason (app 1.3.4+ reports this right after a stop).
    if (health?.wanted === false) return { text: `tracking was switched off on the phone${health.stop?.why ? ` (${health.stop.why})` : ''}`, codes: ['SWITCHED_OFF'] };
    const issues = trackerHealthIssues(health);
    // App 1.3.4+ keeps reporting without points, so a live phone with no location no longer looks like a dead phone.
    const lastFix = health?.lastFixAt;
    if (health?.running && lastFix && d.trackerHealthAt && d.trackerHealthAt.getTime() - lastFix > NO_FIX_CAUSE_MS) return { text: 'the phone is on and tracking, but is getting no location', codes: ['NO_LOCATION', ...issues.map((i) => i.code)] };
    if (issues.length) return { text: issues[0].text, codes: issues.map((i) => i.code) };
    if (health?.stop?.why === 'killed while tracking') return { text: 'the phone stopped the tracking app (check Autostart / battery settings)', codes: ['KILLED'] };
    return null;
  }

  /** The tracker app was activated on another phone: raised at once (no offline episode or cooldown involved). */
  async trackerDeviceChanged(
    change: TrackerAlertTarget & { mobile: string; from: string | null; to: string | null },
    now: number,
  ): Promise<void> {
    const message = `Tracker device changed: ${change.mobile} moved from ${change.from ?? 'the previous phone'} to ${change.to ?? 'another phone'}`;
    await this.raiseTrackerAlert('TRACKER_DEVICE_CHANGED', change, message, { mobile: change.mobile, fromDevice: change.from, toDevice: change.to }, now, null);
  }

  /** The same phone came back: reinstalled or activated again. Raised at once, the message says which. */
  async trackerReactivated(change: TrackerAlertTarget & { mobile: string; how: string; message: string }, now: number): Promise<void> {
    await this.raiseTrackerAlert('TRACKER_REACTIVATED', change, change.message, { mobile: change.mobile, how: change.how, whatHappened: change.message.charAt(0).toLowerCase() + change.message.slice(1) }, now, null);
  }

  /** Tracking switched off or on at the phone. `at` is the phone's time, shown with where it last was. */
  async trackerSwitched(
    change: TrackerAlertTarget & { mobile: string; on: boolean; why: string },
    at: number,
  ): Promise<void> {
    const position = await this.prisma.position.findFirst({
      where: { deviceId: change.deviceId, fixTime: { lte: new Date(at) }, valid: true },
      orderBy: { fixTime: 'desc' },
      select: { lat: true, lng: true },
    });
    const message = `Tracking switched ${change.on ? 'on' : 'off'} on ${change.mobile}${change.why ? ` (${change.why})` : ''}`;
    await this.raiseTrackerAlert(change.on ? 'TRACKER_STARTED' : 'TRACKER_STOPPED', change, message, { mobile: change.mobile, why: change.why }, at, position);
  }

  /** Raised at once (no offline episode or cooldown involved). */
  private async raiseTrackerAlert(
    type: 'TRACKER_DEVICE_CHANGED' | 'TRACKER_REACTIVATED' | 'TRACKER_STOPPED' | 'TRACKER_STARTED',
    change: TrackerAlertTarget,
    message: string,
    data: Record<string, string | null>,
    now: number,
    position: { lat: number; lng: number } | null,
  ): Promise<void> {
    const rules = await this.repo.get(change.companyId);
    const setting = rules.effective(change.object.id).get(type);
    if (!setting?.enabled) return;
    const ackRequired = ackRequiredFor(setting, type, setting.severity);
    const id = randomUUID();
    await this.prisma.alert.create({
      data: { id, companyId: change.companyId, objectId: change.object.id, deviceId: change.deviceId, type, severity: setting.severity, message, data, occurredAt: new Date(now), lat: position?.lat ?? null, lng: position?.lng ?? null, ackRequired },
    });
    const dto = pendingToDto({
      id,
      type,
      severity: setting.severity,
      message,
      occurredAt: now,
      lat: position?.lat ?? null,
      lng: position?.lng ?? null,
      geofenceId: null,
      geofenceName: null,
      data,
      ackRequired,
      object: { objectId: change.object.id, companyId: change.companyId, branchId: change.object.branchId, name: change.object.name, plateNumber: change.object.plateNumber, deviceId: change.deviceId, speedLimitKph: change.object.speedLimitKph },
    });
    await this.redis.client
      .pipeline()
      .publish(RedisKeys.alertsChannel, JSON.stringify({ companyId: change.companyId, alert: dto }))
      .xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', id, 'companyId', change.companyId)
      .exec();
  }

  private async raise(live: LiveObject, severity: 'INFO' | 'WARNING' | 'CRITICAL', ackRequired: boolean, offlineMs: number, now: number, parkingAlarm = false): Promise<void> {
    const durationSec = Math.round(offlineMs / 1000);
    const cause = await this.phoneCause(live.deviceId);
    const pending = {
      id: randomUUID(),
      type: 'DEVICE_OFFLINE' as const,
      severity,
      message: cause ? `No data for ${formatDuration(durationSec)} · likely: ${cause.text}` : `No data for ${formatDuration(durationSec)}`,
      occurredAt: now,
      lat: live.lat,
      lng: live.lng,
      geofenceId: null,
      geofenceName: null,
      data: { durationSec, lastSeen: live.serverTime, ...(cause ? { cause: cause.codes } : {}), ...(parkingAlarm ? { parkingAlarm: true } : {}) },
      ackRequired,
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
        ackRequired,
      },
    });
    await this.redis.client
      .pipeline()
      .publish(RedisKeys.alertsChannel, JSON.stringify({ companyId: live.companyId, alert: pendingToDto(pending) }))
      .xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', pending.id, 'companyId', live.companyId)
      .exec();
  }
}
