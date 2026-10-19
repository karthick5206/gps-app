import { Injectable, Logger } from '@nestjs/common';
import { Alert, Prisma } from '@prisma/client';
import { driverEventSettings, isDriverEventType, snapshotChannel } from '@veetracer/shared';
import { hostname } from 'node:os';
import { asRecord } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { driverAt, MEDIA_MATCH_AFTER_MS, MEDIA_MATCH_BEFORE_MS, MEDIA_RETRY_ATTEMPTS, MEDIA_RETRY_DELAY_MS, mediaRejection, pickEvent } from './driver-event-logic';
import { DriverMediaMessage, linkIncoming, removeMedia, SnapshotRequest } from './media-store';

const READ_COUNT = 20;
const BLOCK_MS = 2000;
const CLAIM_IDLE_MS = 60_000;
const SNAPSHOT_POLL_MS = 3000;

type RawEntry = [id: string, fields: string[] | null];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type MediaOutcome = 'linked' | 'retry' | 'dropped';

/**
 * Driver events, inside the notifier process: creates the DriverEvent for an ADAS / DMS / crash alert and asks the
 * dashcam's gateway for a snapshot; consumes `vt:driver-media` (consumer group `driver-media`) to link stored photos
 * and clips to their events, enforcing the per-event limits and the company quota.
 */
@Injectable()
export class DriverEventWorkerService {
  private readonly logger = new Logger('DriverEvents');
  private readonly consumer = `${process.env.NOTIFIER_CONSUMER ?? `notifier-${hostname()}`}-dm`;
  private stopping = false;
  private readonly retries = new Set<NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  stop(): void {
    this.stopping = true;
    for (const t of this.retries) clearTimeout(t);
    this.retries.clear();
  }

  /** Creates (once) the driver event of an alert and requests the snapshot; returns the event id, or null. */
  async onAlert(alert: Alert): Promise<string | null> {
    if (!isDriverEventType(alert.type)) return null;
    const existing = await this.prisma.driverEvent.findUnique({ where: { alertId: alert.id }, select: { id: true } });
    if (existing) return existing.id;
    const data = asRecord(alert.data);
    const assignments = await this.prisma.driverAssignment.findMany({
      where: { objectId: alert.objectId, fromTime: { lte: alert.occurredAt }, OR: [{ toTime: null }, { toTime: { gt: alert.occurredAt } }] },
      orderBy: { fromTime: 'desc' },
      take: 3,
      select: { driverId: true, fromTime: true, toTime: true },
    });
    let id: string;
    try {
      const row = await this.prisma.driverEvent.create({
        data: {
          companyId: alert.companyId,
          objectId: alert.objectId,
          deviceId: alert.deviceId,
          driverId: driverAt(assignments, alert.occurredAt),
          alertId: alert.id,
          type: alert.type,
          level: num(data.level),
          speedKph: num(data.speedKph),
          lat: alert.lat,
          lng: alert.lng,
          address: alert.address,
          occurredAt: alert.occurredAt,
        },
        select: { id: true },
      });
      id = row.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return (await this.prisma.driverEvent.findUnique({ where: { alertId: alert.id }, select: { id: true } }))?.id ?? null;
      }
      throw error;
    }
    await this.requestSnapshot(alert, id).catch((e: Error) => this.logger.warn(`Snapshot request for ${id} failed: ${e.message}`));
    return id;
  }

  private async requestSnapshot(alert: Alert, eventId: string): Promise<void> {
    if (!alert.deviceId) return;
    const [company, device] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: alert.companyId }, select: { settings: true } }),
      this.prisma.device.findUnique({ where: { id: alert.deviceId }, select: { uniqueId: true, model: { select: { protocol: true, capabilities: true } } } }),
    ]);
    const s = driverEventSettings(asRecord(company?.settings).driverEvents);
    if (!s.snapshot || !device || device.model.protocol.toLowerCase() !== 'jt808') return;
    if (!device.model.capabilities.some((c) => c === 'video' || c === 'adas' || c === 'dms')) return;
    const gatewayId = await this.redis.client.get(RedisKeys.connection(device.uniqueId));
    if (!gatewayId) return;
    const req: SnapshotRequest = { uniqueId: device.uniqueId, eventId, channel: snapshotChannel(alert.type, s) };
    await this.redis.client.publish(RedisKeys.snapshotChannel(gatewayId), JSON.stringify(req));
  }

  /** First photo of an event, waiting up to `waitMs` for it to arrive (e-mail notifications). */
  async photoFor(eventId: string, waitMs: number): Promise<{ filePath: string; mime: string } | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const m = await this.prisma.driverEventMedia.findFirst({ where: { eventId, kind: 'PHOTO' }, orderBy: { createdAt: 'asc' }, select: { filePath: true, mime: true } });
      if (m || Date.now() + SNAPSHOT_POLL_MS > until || this.stopping) return m;
      await sleep(SNAPSHOT_POLL_MS);
    }
  }

  /** Links one stored file to its event (or deletes it); media that beat its event is retried a few times. */
  async handleMedia(msg: DriverMediaMessage, attempt = 0): Promise<MediaOutcome> {
    const drop = async (why: string): Promise<MediaOutcome> => {
      this.logger.log(`Dropped ${msg.source.toLowerCase()} ${msg.kind.toLowerCase()} from ${msg.uniqueId}: ${why}`);
      await removeMedia(msg.path).catch(() => undefined);
      return 'dropped';
    };
    const device = await this.prisma.device.findUnique({ where: { uniqueId: msg.uniqueId }, select: { id: true, companyId: true } });
    if (!device?.companyId) return drop('unknown device');
    const at = msg.capturedAt ? new Date(msg.capturedAt) : new Date();
    const companyId = device.companyId;
    let event: { id: string; occurredAt: Date } | null = null;
    if (msg.eventId) event = await this.prisma.driverEvent.findFirst({ where: { id: msg.eventId, companyId }, select: { id: true, occurredAt: true } });
    if (!event) {
      const candidates = await this.prisma.driverEvent.findMany({
        where: { deviceId: device.id, occurredAt: { gte: new Date(at.getTime() - MEDIA_MATCH_AFTER_MS), lte: new Date(at.getTime() + MEDIA_MATCH_BEFORE_MS) } },
        select: { id: true, occurredAt: true },
        take: 20,
      });
      event = pickEvent(candidates, at);
    }
    if (!event) {
      if (attempt + 1 >= MEDIA_RETRY_ATTEMPTS || this.stopping) return drop('no driver event at that time');
      const timer = setTimeout(() => {
        this.retries.delete(timer);
        void this.handleMedia(msg, attempt + 1).catch((e: Error) => this.logger.error(`Media retry failed: ${e.message}`));
      }, MEDIA_RETRY_DELAY_MS);
      timer.unref();
      this.retries.add(timer);
      return 'retry';
    }
    const [company, counts, used] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } }),
      this.prisma.driverEventMedia.groupBy({ by: ['kind'], where: { eventId: event.id }, _count: { _all: true } }),
      this.prisma.driverEventMedia.aggregate({ where: { companyId }, _sum: { fileSize: true } }),
    ]);
    const s = driverEventSettings(asRecord(company?.settings).driverEvents);
    const count = (k: 'PHOTO' | 'VIDEO') => counts.find((c) => c.kind === k)?._count._all ?? 0;
    const reason = mediaRejection({ kind: msg.kind, size: msg.size, photos: count('PHOTO'), videos: count('VIDEO'), usedBytes: used._sum.fileSize ?? 0 }, s);
    if (reason) return drop(reason);
    const filePath = await linkIncoming(msg.path, companyId, event.id, msg.mime, at);
    await this.prisma.driverEventMedia.create({
      data: { eventId: event.id, companyId, kind: msg.kind, source: msg.source, channel: msg.channel, filePath, fileSize: msg.size, mime: msg.mime, capturedAt: at },
    });
    return 'linked';
  }

  async run(): Promise<void> {
    const stream = RedisKeys.driverMediaStream;
    const group = RedisKeys.driverMediaGroup;
    try {
      await this.redis.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
    let backlog = true;
    let lastClaim = 0;
    while (!this.stopping) {
      try {
        let entries: RawEntry[] = [];
        if (Date.now() - lastClaim > CLAIM_IDLE_MS) {
          lastClaim = Date.now();
          const [, raw] = (await this.redis.client.xautoclaim(stream, group, this.consumer, CLAIM_IDLE_MS, '0-0', 'COUNT', READ_COUNT)) as [string, RawEntry[]];
          entries = raw;
        }
        if (!entries.length) {
          const args = ['GROUP', group, this.consumer, 'COUNT', READ_COUNT] as const;
          const reply = (backlog
            ? await this.redis.client.xreadgroup(...args, 'STREAMS', stream, '0')
            : await this.redis.client.xreadgroup(...args, 'BLOCK', BLOCK_MS, 'STREAMS', stream, '>')) as [string, RawEntry[]][] | null;
          entries = reply?.[0]?.[1] ?? [];
          if (backlog && !entries.length) backlog = false;
        }
        for (const [id, fields] of entries) {
          const at = fields?.indexOf('data') ?? -1;
          const json = at >= 0 ? fields![at + 1] : undefined;
          if (json) {
            try {
              await this.handleMedia(JSON.parse(json) as DriverMediaMessage);
            } catch (error) {
              this.logger.error(`Media ${id} failed: ${(error as Error).message}`);
            }
          }
          await this.redis.client.xack(stream, group, id);
        }
      } catch (error) {
        this.logger.error(`Driver media loop error: ${(error as Error).message}`);
        await sleep(1000);
      }
    }
  }
}
