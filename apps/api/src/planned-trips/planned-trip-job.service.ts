import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PlannedTrip, Prisma } from '@prisma/client';
import { ackRequiredFor, PLANNED_TRIP_TIMING } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { NOTIFY_STREAM_MAXLEN } from '../alerts/alert-dto';
import { RulesRepository } from '../alerts/rules-data';
import { PrismaService } from '../prisma/prisma.service';
import { canEmit, emptyAlertState } from '../processor/rules/evaluate';
import { pendingToDto } from '../processor/rules/rules-engine';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { parseLive } from '../tracking/live-object';
import { PlannedTripsService } from './planned-trips.service';
import { missingOccurrences, SAME_OCCURRENCE_MS, scheduleOccurrences } from './schedule-occurrences';
import { incompleteCutoff, notStartedCutoff, OPEN_TRIP_STATUSES } from './trip-rules';

export const PLANNED_TRIP_LOCK_KEY = 'vt:plannedtrips:generator:lock';
/** Marker so the "not started" hook fires once per trip. */
export const plannedTripNotStartedKey = (tripId: string) => `vt:plannedtrips:notstarted:${tripId}`;
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const TICK_MS = 5 * 60_000;
const SWEEP_BATCH = 500;
/** Smallest TRIP_NOT_STARTED grace (the setting's `graceMin` minimum). */
const NOT_STARTED_MIN_GRACE_MIN = 5;
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
 *  3. Not started: SCHEDULED trips past plannedStart + grace (TRIP_NOT_STARTED setting `graceMin`, default 30 min)
 *     → onTripNotStarted(trip) once, which raises the TRIP_NOT_STARTED alert.
 */
@Injectable()
export class PlannedTripJobService {
  private readonly logger = new Logger('PlannedTripJob');
  private readonly instance = randomUUID();
  private readonly enabled = (process.env.PLANNED_TRIP_JOB ?? 'on').toLowerCase() !== 'off';
  private running = false;
  /** Alert settings per company (60 s TTL is enough for a 5-minute job; no pub/sub needed). */
  private readonly rules: RulesRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly trips: PlannedTripsService,
  ) {
    this.rules = new RulesRepository(prisma);
  }

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

  /**
   * SCHEDULED trips not started by plannedStart + grace: calls onTripNotStarted once per trip (Valkey marker). The grace
   * is the vehicle's TRIP_NOT_STARTED `graceMin` (default 30, at least NOT_STARTED_MIN_GRACE_MIN).
   */
  async sweepNotStarted(now: number): Promise<number> {
    const due = await this.prisma.plannedTrip.findMany({
      where: { status: 'SCHEDULED', plannedStart: { lte: notStartedCutoff(now, NOT_STARTED_MIN_GRACE_MIN) }, plannedEnd: { gte: incompleteCutoff(now) } },
      orderBy: { plannedStart: 'asc' },
      take: SWEEP_BATCH,
    });
    let fired = 0;
    for (const trip of due) {
      if (now < trip.plannedStart.getTime() + (await this.graceMin(trip)) * 60_000) continue;
      const ttlSec = Math.max(3600, Math.ceil((trip.plannedEnd.getTime() - now) / 1000) + 3 * 3600);
      const first = (await this.redis.client.set(plannedTripNotStartedKey(trip.id), '1', 'EX', ttlSec, 'NX')) === 'OK';
      if (!first) continue;
      fired++;
      await this.onTripNotStarted(trip, now).catch((error) => this.logger.warn(`Not-started hook failed for trip ${trip.id}: ${(error as Error).message}`));
    }
    return fired;
  }

  /** TRIP_NOT_STARTED `graceMin` of the trip's vehicle; the catalogue default when settings can't be read. */
  private async graceMin(trip: Pick<PlannedTrip, 'companyId' | 'objectId'>): Promise<number> {
    try {
      const v = (await this.rules.get(trip.companyId)).effective(trip.objectId).get('TRIP_NOT_STARTED')?.params.graceMin;
      return typeof v === 'number' && Number.isFinite(v) ? Math.max(NOT_STARTED_MIN_GRACE_MIN, v) : PLANNED_TRIP_TIMING.notStartedGraceMin;
    } catch {
      return PLANNED_TRIP_TIMING.notStartedGraceMin;
    }
  }

  /**
   * A SCHEDULED trip with no start by plannedStart + grace (SPEC §4.3 "Not started"), called once per trip: raises
   * TRIP_NOT_STARTED through the normal alert pipeline (Alert row, realtime publish, notification job) when the
   * vehicle's Alert Settings allow it (enabled, schedule, snooze; vehicles in maintenance raise nothing).
   */
  protected async onTripNotStarted(trip: PlannedTrip, now: number = Date.now()): Promise<void> {
    const rules = await this.rules.get(trip.companyId);
    const setting = rules.effective(trip.objectId).get('TRIP_NOT_STARTED');
    if (!canEmit(setting, emptyAlertState(), 'TRIP_NOT_STARTED', now, rules.timezone)) return;
    const object = await this.prisma.trackedObject.findUnique({
      where: { id: trip.objectId },
      select: { id: true, companyId: true, name: true, plateNumber: true, branchId: true, speedLimitKph: true, maintenanceSince: true, assignments: { where: { toTime: null }, select: { deviceId: true }, take: 1 } },
    });
    if (!object || object.companyId !== trip.companyId || object.maintenanceSince) return;
    const live = parseLive(await this.redis.client.get(RedisKeys.live(object.id)).catch(() => null));
    const lat = live?.lat ?? null;
    const lng = live?.lng ?? null;
    const delayMin = Math.max(0, Math.round((now - trip.plannedStart.getTime()) / 60_000));
    const message = `Trip ${trip.routeName} not started: ${delayMin} min after its planned start`;
    const data = { tripId: trip.id, routeName: trip.routeName, delayMin, plannedStart: trip.plannedStart.toISOString() };
    const ackRequired = ackRequiredFor(setting, 'TRIP_NOT_STARTED', setting.severity);
    const deviceId = object.assignments[0]?.deviceId ?? null;
    const id = randomUUID();
    await this.prisma.alert.create({
      data: { id, companyId: trip.companyId, objectId: object.id, deviceId, type: 'TRIP_NOT_STARTED', severity: setting.severity, message, data, occurredAt: new Date(now), lat, lng, ackRequired },
    });
    const dto = pendingToDto({
      id,
      type: 'TRIP_NOT_STARTED',
      severity: setting.severity,
      message,
      occurredAt: now,
      lat,
      lng,
      geofenceId: null,
      geofenceName: null,
      data,
      ackRequired,
      object: { objectId: object.id, companyId: trip.companyId, branchId: object.branchId, name: object.name, plateNumber: object.plateNumber, deviceId, speedLimitKph: object.speedLimitKph },
    });
    await this.redis.client
      .pipeline()
      .publish(RedisKeys.alertsChannel, JSON.stringify({ companyId: trip.companyId, alert: dto }))
      .xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', id, 'companyId', trip.companyId)
      .exec();
  }
}
