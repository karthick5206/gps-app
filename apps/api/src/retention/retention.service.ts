import { Injectable, Logger } from '@nestjs/common';
import { Interval, Timeout } from '@nestjs/schedule';
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, WEBHOOK_LOG_RETENTION_DAYS } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { purgeDriverEvents, sweepIncoming } from '../driver-events/media-retention';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export const RETENTION_LOCK_KEY = 'vt:retention:lock';
export const RETENTION_LAST_RUN_KEY = 'vt:retention:last';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const DAY_MS = 86_400_000;

/** Rows deleted per statement: small enough to keep locks short on a busy positions table. */
const BATCH = 5_000;
/** One run stops after this long and continues next hour, so cleanup never competes with live traffic for long. */
const RUN_BUDGET_MS = 4 * 60_000;

/** Global retention for operational logs (days). */
const LIMITS = {
  rawPackets: Number(process.env.RAW_PACKET_RETENTION_DAYS ?? 7),
  notificationLogs: Number(process.env.NOTIFICATION_LOG_RETENTION_DAYS ?? 90),
  unknownDevices: 30,
  webhookDeliveries: Number(process.env.WEBHOOK_LOG_RETENTION_DAYS ?? WEBHOOK_LOG_RETENTION_DAYS),
  expiredAuth: 7,
};

export interface RetentionRunStats {
  startedAt: string;
  finishedAt: string;
  complete: boolean;
  deleted: Record<string, number>;
}

/** Clamp a company's retention to the supported range. */
export function effectiveRetentionDays(days: number | null | undefined): number {
  const d = Number.isFinite(days) ? Math.round(days as number) : 90;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, d));
}

/**
 * Hourly data cleanup (DATA-04: per-company retention 30–180 days, automatic deletion).
 * - Positions, trips, stops, fuel events, closed geofence visits and alerts older than the company's `retentionDays`.
 *   Daily summaries are kept, so long-range reports stay available.
 * - Raw packets (7 d), notification logs (90 d), unknown devices not seen for 30 d, expired sessions/OTPs/reset links.
 * Deletes run in small batches within a time budget; a Valkey lock ensures one api instance works at a time.
 * Disable with RETENTION=off.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');
  private readonly instance = randomUUID();
  private readonly enabled = (process.env.RETENTION ?? 'on').toLowerCase() !== 'off';
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Timeout(2 * 60_000)
  initial(): Promise<void> {
    return this.tick();
  }

  @Interval(60 * 60_000)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(RETENTION_LOCK_KEY, this.instance, 'PX', RUN_BUDGET_MS + 60_000, 'NX')) === 'OK';
      if (!locked) return;
      const stats = await this.run(Date.now());
      const total = Object.values(stats.deleted).reduce((s, n) => s + n, 0);
      if (total) this.logger.log(`Deleted ${total} rows ${JSON.stringify(stats.deleted)}${stats.complete ? '' : ' (time budget reached, continuing next run)'}`);
      await this.redis.client.set(RETENTION_LAST_RUN_KEY, JSON.stringify(stats));
    } catch (error) {
      this.logger.error(`Retention run failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, RETENTION_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  async run(now: number): Promise<RetentionRunStats> {
    const startedAt = new Date(now).toISOString();
    const deadline = now + RUN_BUDGET_MS;
    const deleted: Record<string, number> = {};
    const add = (k: string, n: number) => (deleted[k] = (deleted[k] ?? 0) + n);
    /** Repeat a batched delete until nothing is left or the time budget is used up. */
    const drain = async (key: string, batch: () => Promise<number>): Promise<boolean> => {
      for (;;) {
        if (Date.now() > deadline) return false;
        const n = await batch();
        add(key, n);
        if (n < BATCH) return true;
      }
    };
    const ago = (days: number) => new Date(now - days * DAY_MS);

    let complete = true;
    const companies = await this.prisma.company.findMany({ select: { id: true, retentionDays: true, settings: true } });
    const maxDays = Math.max(RETENTION_MIN_DAYS, ...companies.map((c) => effectiveRetentionDays(c.retentionDays)));

    for (const c of companies) {
      const cutoff = ago(effectiveRetentionDays(c.retentionDays));
      const steps: [string, () => Promise<number>][] = [
        [
          'positions',
          () => this.prisma.$executeRaw`
            DELETE FROM "Position" WHERE ("deviceId", "fixTime") IN (
              SELECT p."deviceId", p."fixTime" FROM "Position" p JOIN "TrackedObject" o ON o.id = p."objectId"
              WHERE o."companyId" = ${c.id}::uuid AND p."fixTime" < ${cutoff} LIMIT ${BATCH})`,
        ],
        ['trips', () => this.prisma.$executeRaw`DELETE FROM "Trip" WHERE id IN (SELECT id FROM "Trip" WHERE "companyId" = ${c.id}::uuid AND "startTime" < ${cutoff} LIMIT ${BATCH})`],
        ['stops', () => this.prisma.$executeRaw`DELETE FROM "Stop" WHERE id IN (SELECT id FROM "Stop" WHERE "companyId" = ${c.id}::uuid AND "startTime" < ${cutoff} LIMIT ${BATCH})`],
        ['fuelEvents', () => this.prisma.$executeRaw`DELETE FROM "FuelEvent" WHERE id IN (SELECT id FROM "FuelEvent" WHERE "companyId" = ${c.id}::uuid AND "startTime" < ${cutoff} LIMIT ${BATCH})`],
        [
          'geofenceVisits',
          () => this.prisma.$executeRaw`DELETE FROM "GeofenceVisit" WHERE id IN (SELECT id FROM "GeofenceVisit" WHERE "companyId" = ${c.id}::uuid AND "exitTime" IS NOT NULL AND "exitTime" < ${cutoff} LIMIT ${BATCH})`,
        ],
        // Notification logs point at alerts without a foreign key; remove them first so none are left dangling.
        [
          'notificationLogs',
          () => this.prisma.$executeRaw`DELETE FROM "NotificationLog" WHERE id IN (
            SELECT n.id FROM "NotificationLog" n JOIN "Alert" a ON a.id = n."alertId"
            WHERE a."companyId" = ${c.id}::uuid AND a."occurredAt" < ${cutoff} LIMIT ${BATCH})`,
        ],
        ['alerts', () => this.prisma.$executeRaw`DELETE FROM "Alert" WHERE id IN (SELECT id FROM "Alert" WHERE "companyId" = ${c.id}::uuid AND "occurredAt" < ${cutoff} LIMIT ${BATCH})`],
      ];
      for (const [key, step] of steps) if (!(await drain(key, step))) complete = false;
      if (!complete) break;
    }

    // Driver events and their photos / clips (own retention setting, files deleted from disk first).
    if (complete) {
      const p = this.prisma;
      complete = await purgeDriverEvents(
        {
          oldMedia: (companyId, cutoff, take) =>
            p.driverEventMedia.findMany({ where: { companyId, event: { occurredAt: { lt: cutoff } } }, select: { id: true, filePath: true }, take }),
          deleteMedia: async (ids) => (await p.driverEventMedia.deleteMany({ where: { id: { in: ids } } })).count,
          deleteEvents: (companyId, cutoff, take) =>
            p.$executeRaw`DELETE FROM "DriverEvent" WHERE id IN (SELECT id FROM "DriverEvent" WHERE "companyId" = ${companyId}::uuid AND "occurredAt" < ${cutoff} LIMIT ${take})`,
        },
        companies,
        now,
        deadline,
        add,
      );
      add('driverMediaIncomingDays', await sweepIncoming(now).catch(() => 0));
    }

    if (complete) {
      const global: [string, () => Promise<number>][] = [
        // Points of devices with no vehicle assigned belong to no company: keep them as long as the longest retention.
        [
          'positions',
          () => this.prisma.$executeRaw`DELETE FROM "Position" WHERE ("deviceId", "fixTime") IN (
            SELECT "deviceId", "fixTime" FROM "Position" WHERE "objectId" IS NULL AND "fixTime" < ${ago(maxDays)} LIMIT ${BATCH})`,
        ],
        ['rawPackets', () => this.prisma.$executeRaw`DELETE FROM "RawPacket" WHERE id IN (SELECT id FROM "RawPacket" WHERE "receivedAt" < ${ago(LIMITS.rawPackets)} LIMIT ${BATCH})`],
        [
          'notificationLogs',
          () => this.prisma.$executeRaw`DELETE FROM "NotificationLog" WHERE id IN (SELECT id FROM "NotificationLog" WHERE "createdAt" < ${ago(LIMITS.notificationLogs)} LIMIT ${BATCH})`,
        ],
        ['unknownDevices', () => this.prisma.$executeRaw`DELETE FROM "UnknownDevice" WHERE "lastSeenAt" < ${ago(LIMITS.unknownDevices)}`],
        [
          'sessions',
          () => this.prisma.$executeRaw`DELETE FROM "Session" WHERE "expiresAt" < ${ago(LIMITS.expiredAuth)} OR ("revokedAt" IS NOT NULL AND "revokedAt" < ${ago(LIMITS.expiredAuth)})`,
        ],
        [
          'webhookDeliveries',
          () => this.prisma.$executeRaw`DELETE FROM "WebhookDelivery" WHERE id IN (SELECT id FROM "WebhookDelivery" WHERE "createdAt" < ${ago(LIMITS.webhookDeliveries)} LIMIT ${BATCH})`,
        ],
        ['otpCodes',() => this.prisma.$executeRaw`DELETE FROM "OtpCode" WHERE "expiresAt" < ${ago(1)}`],
        ['passwordResets', () => this.prisma.$executeRaw`DELETE FROM "PasswordReset" WHERE "expiresAt" < ${ago(LIMITS.expiredAuth)}`],
      ];
      for (const [key, step] of global) if (!(await drain(key, step))) complete = false;
    }

    return { startedAt, finishedAt: new Date().toISOString(), complete, deleted };
  }
}
