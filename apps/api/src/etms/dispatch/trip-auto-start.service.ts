import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { etmsServerEnabled } from '../transport-feature.guard';
import { recordTripEvent } from './trip-ops';
import { TripLiveService } from './trip-live';

export const TRIP_AUTO_START_LOCK_KEY = 'vt:etms:autostart:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const TICK_MS = 60_000;
/** Trips whose planned start is older than this are left alone (a missed trip is the dispatcher's call, not a job's). */
const MAX_LATE_MS = 2 * 3_600_000;

/**
 * Auto-start at the planned time (Transport settings → "Start trips automatically", `etms.autoStart`, default off).
 * Every minute (one API instance, Valkey lock): published, not cancelled ETMS trips still SCHEDULED whose planned start
 * has come (at most 2 h ago) are started like the dispatcher's Start: PlannedTrip → IN_PROGRESS with actualStart now,
 * the first pickup stays PENDING (QA B5), a STARTED trip event (actor SYSTEM) and a system audit row. GPS start (the
 * planned-trip tracker) keeps working whether this is on or off; a vehicle already on another active trip is skipped.
 * Kill switch: ETMS_AUTO_START=off.
 */
@Injectable()
export class TripAutoStartService {
  private readonly logger = new Logger('EtmsTripAutoStart');
  private readonly instance = randomUUID();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly live: TripLiveService,
  ) {}

  get enabled(): boolean {
    return etmsServerEnabled() && (process.env.ETMS_AUTO_START ?? 'on').toLowerCase() !== 'off';
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(TRIP_AUTO_START_LOCK_KEY, this.instance, 'PX', 5 * 60_000, 'NX')) === 'OK';
      if (!locked) return;
      const started = await this.run(new Date());
      if (started) this.logger.log(`Trips started at their planned time: ${started}`);
    } catch (error) {
      this.logger.error(`Auto-start failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, TRIP_AUTO_START_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  /** Starts the due trips of companies with auto-start on; returns how many. */
  async run(now: Date): Promise<number> {
    const companies = await this.prisma.company.findMany({ where: { settings: { path: ['etms', 'autoStart'], equals: true } }, select: { id: true } });
    if (!companies.length) return 0;
    const due = await this.prisma.transportTrip.findMany({
      where: {
        providerCompanyId: { in: companies.map((c) => c.id) },
        publishedAt: { not: null },
        cancelledAt: null,
        plannedTrip: { status: 'SCHEDULED', plannedStart: { lte: now, gte: new Date(now.getTime() - MAX_LATE_MS) } },
      },
      select: { id: true, providerCompanyId: true, customerCompanyId: true, plannedTrip: { select: { id: true, objectId: true, stops: { orderBy: { seq: 'asc' }, take: 1, select: { seq: true } } } } },
      take: 200,
    });
    let count = 0;
    for (const t of due) {
      const pt = t.plannedTrip;
      if (!pt) continue;
      try {
        const busy = await this.prisma.plannedTrip.findFirst({ where: { objectId: pt.objectId, status: { in: ['STARTED', 'IN_PROGRESS'] }, id: { not: pt.id } }, select: { id: true } });
        if (busy) continue;
        const ok = await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.plannedTrip.updateMany({ where: { id: pt.id, status: 'SCHEDULED' }, data: { status: 'IN_PROGRESS', actualStart: now, nextStopSeq: pt.stops[0]?.seq ?? null } });
          if (!claimed.count) return false;
          await recordTripEvent(tx, { userId: null as unknown as string }, { tripId: t.id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'STARTED', actorType: 'SYSTEM', source: 'SYSTEM', data: { auto: 'PLANNED_TIME' } });
          await tx.transportTrip.update({ where: { id: t.id }, data: { version: { increment: 1 } } });
          return true;
        });
        if (!ok) continue;
        count++;
        await this.audit
          .recordSystem({ companyId: t.providerCompanyId, userId: null, ip: null }, { action: 'UPDATE', entity: 'planned_trip', entityId: pt.id, details: { autoStart: 'planned time' } })
          .catch((e: Error) => this.logger.warn(`Auto-start audit for trip ${t.id} failed: ${e.message}`));
        await this.live.changed(t.providerCompanyId, [pt.id]);
      } catch (e) {
        this.logger.warn(`Auto-start of trip ${t.id} failed: ${(e as Error).message}`);
      }
    }
    return count;
  }
}
