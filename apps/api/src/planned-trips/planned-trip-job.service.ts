import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PlannedTrip, Prisma } from '@prisma/client';
import { PLANNED_TRIP_TIMING } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PlannedTripsService } from './planned-trips.service';
import { missingOccurrences, SAME_OCCURRENCE_MS, scheduleOccurrences } from './schedule-occurrences';
import { incompleteCutoff, notStartedCutoff, OPEN_TRIP_STATUSES } from './trip-rules';

export const PLANNED_TRIP_LOCK_KEY = 'vt:plannedtrips:generator:lock';
/** Marker so the "not started" hook fires once per trip. */
export const plannedTripNotStartedKey = (tripId: string) => `vt:plannedtrips:notstarted:${tripId}`;
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const TICK_MS = 5 * 60_000;
const SWEEP_BATCH = 500;
const H = 3_600_000;

export interface JobResult {
  generated: number;
  timedOut: number;
  notStarted: number;
}

/**
 * Planned-trip generator + sweeper (SPEC §4.2 / §4.3), every 5 minutes in the API process. A Valkey `SET NX` lock
 * keeps it to one instance. Kill switch PLANNED_TRIP_JOB=off.
 *  1. Generate: for each active schedule with a vehicle on an active route, the trips whose planned start falls in
 *     the next 24 h (company timezone). Idempotent: an existing trip of the schedule within ±12 h of a slot counts,
 *     and @@unique([scheduleId, plannedStart]) guards races.
 *  2. Timeout: open trips (SCHEDULED / STARTED / IN_PROGRESS) past plannedEnd + 120 min → INCOMPLETE (TIMEOUT), PENDING
 *     stops → SKIPPED.
 *  3. Not started: SCHEDULED trips past plannedStart + 30 min → onTripNotStarted(trip) once (stage 2 raises the alert).
 */
@Injectable()
export class PlannedTripJobService {
  private readonly logger = new Logger('PlannedTripJob');
  private readonly instance = randomUUID();
  private readonly enabled = (process.env.PLANNED_TRIP_JOB ?? 'on').toLowerCase() !== 'off';
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly trips: PlannedTripsService,
  ) {}

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(PLANNED_TRIP_LOCK_KEY, this.instance, 'PX', 10 * 60_000, 'NX')) === 'OK';
      if (!locked) return;
      const r = await this.run(Date.now());
      if (r.generated || r.timedOut || r.notStarted) this.logger.log(`Generated ${r.generated}, timed out ${r.timedOut}, not started ${r.notStarted}`);
    } catch (error) {
      this.logger.error(`Planned-trip job failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, PLANNED_TRIP_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  async run(now: number): Promise<JobResult> {
    const generated = await this.generate(now);
    const timedOut = await this.sweepIncomplete(now);
    const notStarted = await this.sweepNotStarted(now);
    return { generated, timedOut, notStarted };
  }

  /**
   * Creates the missing trips of the next 24 h. `scheduleIds` limits it to some schedules (called right after a
   * schedule is saved so its trips appear without waiting for the next tick). Returns the number created.
   */
  async generate(now: number, scheduleIds?: string[]): Promise<number> {
    if (!this.enabled) return 0;
    const until = now + PLANNED_TRIP_TIMING.generateAheadHours * H;
    const schedules = await this.prisma.routeSchedule.findMany({
      where: { isActive: true, objectId: { not: null }, route: { isActive: true }, ...(scheduleIds ? { id: { in: scheduleIds } } : {}) },
      include: { route: { include: { stops: { orderBy: { seq: 'asc' } } } } },
    });
    if (!schedules.length) return 0;

    const companyIds = [...new Set(schedules.map((s) => s.companyId))];
    const objectIds = [...new Set(schedules.map((s) => s.objectId!))];
    const [companies, objects, existing] = await Promise.all([
      this.prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, timezone: true, status: true } }),
      this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, companyId: true, branchId: true, isActive: true } }),
      this.prisma.plannedTrip.findMany({
        where: { scheduleId: { in: schedules.map((s) => s.id) }, plannedStart: { gte: new Date(now - SAME_OCCURRENCE_MS), lt: new Date(until + SAME_OCCURRENCE_MS) } },
        select: { scheduleId: true, plannedStart: true },
      }),
    ]);
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const objectById = new Map(objects.map((o) => [o.id, o]));
    const startsBySchedule = new Map<string, number[]>();
    for (const t of existing) {
      const list = startsBySchedule.get(t.scheduleId!) ?? [];
      list.push(t.plannedStart.getTime());
      startsBySchedule.set(t.scheduleId!, list);
    }

    let created = 0;
    const touched = new Set<string>();
    for (const s of schedules) {
      const company = companyById.get(s.companyId);
      const object = objectById.get(s.objectId!);
      if (!company || company.status !== 'ACTIVE') continue;
      if (!object || !object.isActive || object.companyId !== s.companyId) continue;
      if (s.route.stops.length < 2 || s.route.companyId !== s.companyId) continue;
      const slots = missingOccurrences(scheduleOccurrences(s, company.timezone, now, until), startsBySchedule.get(s.id) ?? []);
      for (const slot of slots) {
        try {
          await this.trips.insertTrip({
            companyId: s.companyId,
            routeId: s.routeId,
            route: s.route,
            objectId: object.id,
            branchId: object.branchId,
            driverId: s.driverId,
            scheduleId: s.id,
            plannedStartMs: slot,
            createdById: null,
          });
          created++;
          touched.add(s.companyId);
        } catch (error) {
          // Another instance / call created it first.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
          this.logger.warn(`Schedule ${s.id}: could not create the trip at ${new Date(slot).toISOString()}: ${(error as Error).message}`);
        }
      }
    }
    for (const companyId of touched) await this.trips.invalidate(companyId);
    return created;
  }

  /** Open trips past plannedEnd + 120 min → INCOMPLETE (closedBy TIMEOUT); their PENDING stops → SKIPPED. */
  async sweepIncomplete(now: number): Promise<number> {
    const due = await this.prisma.plannedTrip.findMany({
      where: { status: { in: OPEN_TRIP_STATUSES }, plannedEnd: { lt: incompleteCutoff(now) } },
      orderBy: { plannedEnd: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true, companyId: true, status: true },
    });
    let closed = 0;
    const touched = new Set<string>();
    for (const t of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.plannedTrip.updateMany({ where: { id: t.id, status: t.status }, data: { status: 'INCOMPLETE', closedBy: 'TIMEOUT', nextStopSeq: null } });
        if (!claimed.count) return false;
        await tx.plannedTripStop.updateMany({ where: { tripId: t.id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
        return true;
      });
      if (done) {
        closed++;
        touched.add(t.companyId);
      }
    }
    for (const companyId of touched) await this.trips.invalidate(companyId);
    return closed;
  }

  /** SCHEDULED trips not started by plannedStart + 30 min: calls onTripNotStarted once per trip (Valkey marker). */
  async sweepNotStarted(now: number): Promise<number> {
    const due = await this.prisma.plannedTrip.findMany({
      where: { status: 'SCHEDULED', plannedStart: { lte: notStartedCutoff(now) }, plannedEnd: { gte: incompleteCutoff(now) } },
      orderBy: { plannedStart: 'asc' },
      take: SWEEP_BATCH,
    });
    let fired = 0;
    for (const trip of due) {
      const ttlSec = Math.max(3600, Math.ceil((trip.plannedEnd.getTime() - now) / 1000) + 3 * 3600);
      const first = (await this.redis.client.set(plannedTripNotStartedKey(trip.id), '1', 'EX', ttlSec, 'NX')) === 'OK';
      if (!first) continue;
      fired++;
      await this.onTripNotStarted(trip).catch((error) => this.logger.warn(`Not-started hook failed for trip ${trip.id}: ${(error as Error).message}`));
    }
    return fired;
  }

  /**
   * Hook for a SCHEDULED trip with no start by plannedStart + grace (SPEC §4.3 "Not started"). Called once per trip.
   * Stage 2 raises the TRIP_NOT_STARTED alert here (and may use the alert setting's graceMin instead of 30).
   */
  protected async onTripNotStarted(trip: PlannedTrip): Promise<void> {
    this.logger.debug(`Trip ${trip.id} (${trip.routeName}) not started by ${trip.plannedStart.toISOString()} + ${PLANNED_TRIP_TIMING.notStartedGraceMin} min`);
  }
}
