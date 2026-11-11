import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DRIVER_LIMITS as L,
  deriveTripState,
  driverDisplayName,
  driverOutcomeAllowed,
  driverTripActions,
  type DriverDutyDto,
  type DriverDutyTodayDto,
  type DriverErrorCode,
  type DriverMeDto,
  type DriverPassengerDto,
  type DriverStartTripResult,
  type DriverStopDto,
  type DriverSyncDto,
  type DriverTripDetailDto,
  type DriverTripEventBatchResult,
  type DriverTripEventOutcome,
  type DriverTripEventResult,
  type DriverTripHistoryDto,
  type DriverTripOverlayDto,
  type DriverTripSummaryDto,
  type PlannedStopStatus,
  type PlannedTripStatus,
  type TransportPassengerStatus,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { parseLive } from '../../tracking/live-object';
import { TRIP_ENTITY } from '../dispatch/dispatch.service';
import { dayKeyOf, isUniqueViolation } from '../dispatch/e3-common';
import { todayIn } from '../dispatch/service-dates';
import { TripLiveService } from '../dispatch/trip-live';
import { lockTrips } from '../dispatch/trip-ops';
import { TransportNotificationsService } from '../notifications/transport-notifications.service';
import { DRIVER_SELECT, resolveDriver, type MeDriver } from './driver-identity';
import { DriverDutyEndDto, DriverDutyStartDto, DriverStartTripDto, DriverSyncQuery, DriverTripEventBatchDto, DriverTripListDto } from './driver.dto';
import { applyToSnapshot, correctedTime, decide, isDriverEventType, licenceValid, onlineCommandFresh, storedKind, withinStartWindow, type Decision, type TripSnapshot } from './driver-rules';

type Db = Prisma.TransactionClient;
const H = 3_600_000;
const OPEN: readonly PlannedTripStatus[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];
const RUNNING: readonly PlannedTripStatus[] = ['STARTED', 'IN_PROGRESS'];

const err = (status: number, code: DriverErrorCode, message: string) => new HttpException({ message, code }, status);
const conflict = (code: DriverErrorCode, message: string) => new ConflictException({ message, code });
const notFound = () => new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });

const PT_INCLUDE = { stops: true } satisfies Prisma.PlannedTripInclude;
type PtRow = Prisma.PlannedTripGetPayload<{ include: typeof PT_INCLUDE }>;
const TT_INCLUDE = { passengers: true } satisfies Prisma.TransportTripInclude;
type TtRow = Prisma.TransportTripGetPayload<{ include: typeof TT_INCLUDE }>;
interface Mine {
  tt: TtRow;
  pt: PtRow;
}
type DutyRow = Prisma.TransportDriverDutyGetPayload<{ include: { object: { select: { id: true; name: true; plateNumber: true } } } }>;

/**
 * The driver API (`/api/driver/v1`, docs 09 / 05 §2.9; D4, D5). Relationship-scoped: every call first resolves the
 * caller's own active Driver (resolveDriver, 403 otherwise); every trip query is
 * `companyId = ctx.companyId AND driverId = me AND origin = ETMS AND published AND (plannedStart in the window OR
 * running)`, re-checked in code; anything else is 404. Mobile clients never set states: START is an online-only
 * command, everything else is an idempotent event (`clientEventId`) evaluated by the server's state machine
 * (driver-rules.ts) under the trip's row lock, in `seq` order, and stored append-only with its outcome.
 *
 * Privacy (09 §3.4 / §7.1, 10 §2.3; R1): the manifest shows first name + last initial while a passenger's outcome is
 * not recorded, then "Passenger <n>"; counts per stop; a wheelchair flag; never employee codes, addresses, contacts or
 * notes. Once the trip is closed (completed / incomplete / cancelled) the API returns counts only: no names, no stop
 * points. Manifest reads are ACCESS-audited (at most once per trip and hour per driver).
 */
@Injectable()
export class DriverApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly live: TripLiveService,
    private readonly notifications: TransportNotificationsService,
  ) {}

  // ───────────────────────────── Identity and duty ─────────────────────────────

  async me(ctx: AuthContext): Promise<DriverMeDto> {
    const me = await resolveDriver(this.prisma, ctx);
    const [company, duty, unread] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { id: true, name: true, timezone: true } }),
      this.openDuty(me.id),
      this.notifications.unread(ctx, 'DRIVER'),
    ]);
    const now = Date.now();
    return {
      driver: { id: me.id, name: me.name, firstName: me.name.trim().split(/\s+/)[0] ?? me.name, employeeId: me.employeeId },
      company: { id: company.id, name: company.name, timeZone: company.timezone },
      documents: { licenseExpiry: me.licenseExpiry ? dayKeyOf(me.licenseExpiry) : null, licenseValid: licenceValid(me.licenseExpiry, now) },
      duty: duty ? toDuty(duty) : null,
      policy: { windowPastHours: L.windowPastHours, windowFutureHours: L.windowFutureHours, noShowMinWaitMin: L.noShowMinWaitMin, passengerContact: 'NONE_R1', checklistRequired: false, phoneLocation: 'NOT_USED' },
      unreadNotifications: unread,
      serverTime: new Date(now).toISOString(),
    };
  }

  /** Today's duty (company time zone) and today's assigned trips (plus any still running from yesterday). */
  async dutyToday(ctx: AuthContext): Promise<DriverDutyTodayDto> {
    const me = await resolveDriver(this.prisma, ctx);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
    const now = Date.now();
    const today = todayIn(company.timezone, now);
    const [duty, mine] = await Promise.all([this.openDuty(me.id), this.mine(ctx, me, this.window(now))]);
    const trips = mine.filter((m) => dayKeyOf(m.tt.serviceDate) === today || RUNNING.includes(m.pt.status as PlannedTripStatus));
    return { serviceDate: today, timeZone: company.timezone, duty: duty ? toDuty(duty) : null, trips: await this.summaries(ctx, trips), serverTime: new Date(now).toISOString() };
  }

  /** Online only (09 §4.4): a replayed (stale) start is refused, never executed late. */
  async startDuty(ctx: AuthContext, dto: DriverDutyStartDto): Promise<DriverDutyDto> {
    const now = Date.now();
    const me = await resolveDriver(this.prisma, ctx);
    const again = await this.prisma.transportDriverDuty.findFirst({ where: { driverId: me.id, startClientEventId: dto.clientEventId }, include: DUTY_INCLUDE });
    if (again && again.driverId === me.id) return toDuty(again);
    if (!onlineCommandFresh(dto.occurredAt, now)) throw conflict('STALE_COMMAND', 'Starting duty needs a live connection; try again now');
    const open = await this.openDuty(me.id);
    if (open) throw conflict('DUTY_OPEN', 'Your duty has already started');
    let objectId: string | null = null;
    if (dto.objectId) {
      const v = await this.prisma.trackedObject.findFirst({ where: { id: dto.objectId, companyId: ctx.companyId, isActive: true }, select: { id: true, companyId: true } });
      if (!v || v.companyId !== ctx.companyId) throw notFound();
      objectId = v.id;
    }
    try {
      const row = await this.prisma.transportDriverDuty.create({
        data: { companyId: ctx.companyId, driverId: me.id, objectId, startedAt: new Date(now), source: 'DRIVER_APP', startedByUserId: ctx.userId, startClientEventId: dto.clientEventId },
        include: DUTY_INCLUDE,
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'TransportDriverDuty', entityId: row.id, details: { driverId: me.id, objectId, source: 'DRIVER_APP' } });
      return toDuty(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('DUTY_OPEN', 'Your duty has already started');
      throw e;
    }
  }

  async endDuty(ctx: AuthContext, dto: DriverDutyEndDto): Promise<DriverDutyDto> {
    const now = Date.now();
    const me = await resolveDriver(this.prisma, ctx);
    const ended = await this.prisma.transportDriverDuty.findFirst({ where: { driverId: me.id, endClientEventId: dto.clientEventId }, include: DUTY_INCLUDE });
    if (ended && ended.driverId === me.id) return toDuty(ended);
    const open = await this.openDuty(me.id);
    if (!open) throw conflict('NO_OPEN_DUTY', 'No duty is open');
    const at = Date.parse(dto.occurredAt);
    const endedAt = new Date(Math.min(now, Math.max(open.startedAt.getTime(), Number.isFinite(at) ? at : now)));
    const done = await this.prisma.transportDriverDuty.updateMany({ where: { id: open.id, endedAt: null }, data: { endedAt, endClientEventId: dto.clientEventId } });
    if (!done.count) throw conflict('NO_OPEN_DUTY', 'No duty is open');
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'TransportDriverDuty', entityId: open.id, details: { ended: endedAt.toISOString() } });
    return toDuty((await this.prisma.transportDriverDuty.findFirst({ where: { id: open.id }, include: DUTY_INCLUDE }))!);
  }

  // ───────────────────────────── Trips ─────────────────────────────

  async trips(ctx: AuthContext, q: DriverTripListDto): Promise<DriverTripSummaryDto[]> {
    const me = await resolveDriver(this.prisma, ctx);
    const now = Date.now();
    const from = q.from ? Date.parse(q.from) : now - L.windowPastHours * H;
    const to = q.to ? Date.parse(q.to) : now + L.windowFutureHours * H;
    if (!(to >= from) || to - from > L.maxRangeDays * 24 * H) throw err(400, 'VALIDATION_FAILED', `Ask for at most ${L.maxRangeDays} days`);
    return this.summaries(ctx, await this.mine(ctx, me, { from: new Date(from), to: new Date(to) }));
  }

  async trip(ctx: AuthContext, id: string): Promise<DriverTripDetailDto> {
    const me = await resolveDriver(this.prisma, ctx);
    const m = await this.one(ctx, me, id);
    if (!m) throw notFound();
    return this.detail(ctx, me, m, true);
  }

  /** Closed trips, counts only (no names, no points; 09 §5 history). Default the last 7 days. */
  async history(ctx: AuthContext, q: DriverTripListDto): Promise<DriverTripHistoryDto[]> {
    const me = await resolveDriver(this.prisma, ctx);
    const now = Date.now();
    const to = q.to ? Date.parse(q.to) : now;
    const from = q.from ? Date.parse(q.from) : to - L.maxRangeDays * 24 * H;
    if (!(to >= from) || to - from > 31 * 24 * H) throw err(400, 'VALIDATION_FAILED', 'Ask for at most 31 days');
    const pts = await this.prisma.plannedTrip.findMany({
      where: { companyId: ctx.companyId, driverId: me.id, origin: 'ETMS', status: { in: ['COMPLETED', 'INCOMPLETE', 'CANCELLED'] }, plannedStart: { gte: new Date(from), lte: new Date(to) } },
      include: PT_INCLUDE,
      take: 300,
    });
    const rows = await this.headers(ctx, pts.filter((p) => p.driverId === me.id && p.companyId === ctx.companyId));
    return rows
      .sort((a, b) => b.pt.plannedStart.getTime() - a.pt.plannedStart.getTime())
      .map(({ tt, pt }) => ({
        id: tt.id,
        serviceDate: dayKeyOf(tt.serviceDate),
        direction: tt.direction,
        name: pt.routeName,
        plannedTripStatus: pt.status as PlannedTripStatus,
        actualStart: pt.actualStart?.toISOString() ?? null,
        actualEnd: pt.actualEnd?.toISOString() ?? null,
        stopCount: pt.stops.length,
        counts: counts(tt.passengers),
      }));
  }

  // ───────────────────────────── Start (online only) ─────────────────────────────

  async startTrip(ctx: AuthContext, id: string, dto: DriverStartTripDto): Promise<DriverStartTripResult> {
    const now = Date.now();
    const me = await resolveDriver(this.prisma, ctx);
    const m = await this.one(ctx, me, id);
    if (!m) throw notFound();
    const seen = await this.prisma.transportTripEvent.findFirst({ where: { tripId: id, clientEventId: dto.clientEventId }, select: { kind: true, outcome: true, tripId: true } });
    if (seen && seen.tripId === id) {
      if (seen.kind !== 'STARTED') throw err(422, 'IDEMPOTENCY_KEY_REUSED', 'This clientEventId was already used for another event');
      return { outcome: seen.outcome === 'ACCEPTED' ? 'STARTED' : 'ALREADY_STARTED', warnings: [], trip: await this.detail(ctx, me, (await this.one(ctx, me, id)) ?? m, false) };
    }
    if (!onlineCommandFresh(dto.occurredAt, now)) throw conflict('STALE_COMMAND', 'Starting a trip needs a live connection; it is never sent later from the offline queue');
    if (!licenceValid(me.licenseExpiry, now)) throw conflict('DRIVER_DOCUMENTS_EXPIRED', 'Your driving licence has expired; contact your dispatcher');
    const status = m.pt.status as PlannedTripStatus;
    if (RUNNING.includes(status)) return this.alreadyStarted(ctx, me, m, dto);
    if (status !== 'SCHEDULED' || m.tt.cancelledAt) throw conflict('TRIP_CLOSED', 'This trip is closed');
    if (!withinStartWindow(m.pt.plannedStart, m.pt.plannedEnd, now)) throw conflict('OUTSIDE_START_WINDOW', `A trip can be started from ${L.startEarlyMin} minutes before its planned start`);
    const busy = await this.prisma.plannedTrip.findFirst({ where: { objectId: m.pt.objectId, status: { in: ['STARTED', 'IN_PROGRESS'] }, id: { not: m.pt.id } }, select: { id: true } });
    if (busy) throw conflict('VEHICLE_BUSY', 'The vehicle is still on another trip; ask your dispatcher to close it');
    const first = [...m.pt.stops].sort((a, b) => a.seq - b.seq)[0];
    const started = await this.prisma.$transaction(async (tx) => {
      await lockTrips(tx, [id]);
      // Same transition as the v1.8 manual start (SCHEDULED → IN_PROGRESS, compare-and-set), except that the first stop
      // is left PENDING: on an ETMS trip it is the first pickup, which the driver / GPS still has to reach.
      const claimed = await tx.plannedTrip.updateMany({ where: { id: m.pt.id, status: 'SCHEDULED', driverId: me.id }, data: { status: 'IN_PROGRESS', actualStart: new Date(now), nextStopSeq: first ? first.seq : null } });
      if (!claimed.count) return false;
      await tx.transportTrip.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.store(tx, ctx, me, m.tt, { kind: 'STARTED', outcome: 'ACCEPTED', clientEventId: dto.clientEventId, seq: null, occurredAt: new Date(Math.min(now, Date.parse(dto.occurredAt))), data: { reported: 'DRIVER' } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: TRIP_ENTITY, entityId: id, before: { status }, after: { status: 'IN_PROGRESS', by: 'DRIVER_APP' } }, tx);
      return true;
    });
    if (!started) {
      const again = await this.one(ctx, me, id);
      if (again && RUNNING.includes(again.pt.status as PlannedTripStatus)) return this.alreadyStarted(ctx, me, again, dto);
      throw conflict('INVALID_STATE', 'The trip changed meanwhile; reload it');
    }
    await this.live.changed(ctx.companyId, [m.pt.id]);
    const warnings: string[] = [];
    const fix = await this.fix(m.pt.objectId);
    if (!fix || now - fix.at.getTime() > L.telemetryFreshMs) warnings.push('TELEMETRY_STALE');
    return { outcome: 'STARTED', warnings, trip: await this.detail(ctx, me, (await this.one(ctx, me, id))!, false) };
  }

  /** GPS or the dispatcher started it already: 200 ALREADY_STARTED, recorded once for the clientEventId (idempotent). */
  private async alreadyStarted(ctx: AuthContext, me: MeDriver, m: Mine, dto: DriverStartTripDto): Promise<DriverStartTripResult> {
    try {
      await this.store(this.prisma, ctx, me, m.tt, { kind: 'STARTED', outcome: 'DUPLICATE', clientEventId: dto.clientEventId, seq: null, occurredAt: new Date(Math.min(Date.now(), Date.parse(dto.occurredAt))), data: { code: 'ALREADY_STARTED' } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    return { outcome: 'ALREADY_STARTED', warnings: [], trip: await this.detail(ctx, me, m, false) };
  }

  // ───────────────────────────── Events (offline-queueable) ─────────────────────────────

  async events(ctx: AuthContext, id: string, dto: DriverTripEventBatchDto): Promise<DriverTripEventBatchResult> {
    const now = Date.now();
    const me = await resolveDriver(this.prisma, ctx);
    let m = await this.one(ctx, me, id, true);
    let assigned = true;
    if (!m) {
      // A trip that WAS mine (reassigned since): the queued events get a terminal NOT_ASSIGNED and are kept as audit
      // records (09 §3.5). Any other id is a plain 404.
      m = await this.formerlyMine(ctx, me, id);
      if (!m) throw notFound();
      assigned = false;
    }
    const fix = assigned ? await this.fix(m.pt.objectId) : null;
    const events = [...dto.events].sort((a, b) => a.seq - b.seq || Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const results = new Map<string, DriverTripEventResult>();
    let changed = false;

    await this.prisma.$transaction(async (tx) => {
      await lockTrips(tx, [id]);
      const tt = await tx.transportTrip.findFirst({ where: { id, providerCompanyId: ctx.companyId }, include: TT_INCLUDE });
      const pt = tt?.plannedTripId ? await tx.plannedTrip.findFirst({ where: { id: tt.plannedTripId, companyId: ctx.companyId }, include: PT_INCLUDE }) : null;
      if (!tt || !pt) throw notFound();
      const prior = await tx.transportTripEvent.findMany({ where: { tripId: id, clientEventId: { in: events.map((e) => e.clientEventId) } }, select: { clientEventId: true, kind: true, outcome: true, data: true, clientSeq: true, receivedAt: true } });
      const seenIds = new Map(prior.map((p) => [p.clientEventId!, p]));
      const mySeqs = await tx.transportTripEvent.findMany({ where: { tripId: id, actorDriverId: me.id, source: 'DRIVER_APP' }, select: { clientSeq: true } });
      const snap: TripSnapshot = {
        plannedTripStatus: (tt.cancelledAt ? 'CANCELLED' : pt.status) as PlannedTripStatus,
        publishedAt: tt.publishedAt,
        acknowledgedAt: tt.acknowledgedAt,
        assigned: assigned && pt.driverId === me.id,
        plannedStart: pt.plannedStart,
        stops: pt.stops.map((s) => ({ id: s.id, seq: s.seq, status: s.status as PlannedStopStatus, plannedArrival: s.plannedArrival, actualArrival: s.actualArrival, lat: s.lat, lng: s.lng, radiusM: s.radiusM })),
        passengers: tt.passengers.map((p) => ({ id: p.id, status: p.status as TransportPassengerStatus, pickupSeq: p.pickupSeq, dropSeq: p.dropSeq })),
        lastSeq: maxSeq(mySeqs.map((r) => r.clientSeq)),
        fix,
      };
      const accepted: string[] = [];
      for (const e of events) {
        const base = { clientEventId: e.clientEventId, seq: e.seq };
        const prev = seenIds.get(e.clientEventId);
        if (prev) {
          const reused = prev.kind !== kindOf(e.type);
          results.set(e.clientEventId, reused
            ? { ...base, outcome: 'REJECTED', code: 'IDEMPOTENCY_KEY_REUSED', receivedAt: null }
            : { ...base, outcome: 'DUPLICATE', code: ((prev.data as { code?: string } | null)?.code as DriverErrorCode) ?? null, original: prev.outcome as Exclude<DriverTripEventOutcome, 'RETRY'>, receivedAt: prev.receivedAt.toISOString() });
          continue;
        }
        const t = correctedTime(e.occurredAt, e.clockOffsetMs);
        let d: Decision = t ? decide(snap, { seq: e.seq, type: e.type, occurredAt: t.at, stopSeq: e.stopSeq, passengerTripId: e.passengerTripId, reasonCode: e.reasonCode, etaMin: e.etaMin }, now) : { outcome: 'REJECTED', code: 'CLOCK_SKEW' };
        if (d.outcome === 'RETRY') {
          results.set(e.clientEventId, { ...base, outcome: 'RETRY', code: d.code as DriverErrorCode, receivedAt: null });
          continue;
        }
        const at = t?.at ?? new Date(now);
        if (d.outcome === 'ACCEPTED') {
          const ok = await this.apply(tx, ctx, tt, pt, d, at, now);
          if (ok === 'DUPLICATE') d = { outcome: 'DUPLICATE', code: 'ALREADY_RECORDED' };
          else if (ok !== true) d = { outcome: 'REJECTED', code: ok };
          else {
            applyToSnapshot(snap, d.effect, at);
            accepted.push(`${e.seq}:${e.type}`);
            if (d.effect.kind !== 'OVERLAY' || d.effect.overlay === 'BREAKDOWN') changed = true;
          }
        }
        const p = e.passengerTripId ? snap.passengers.find((x) => x.id === e.passengerTripId) : undefined;
        const row = await this.store(tx, ctx, me, tt, {
          kind: kindOf(e.type),
          outcome: d.outcome as Exclude<DriverTripEventOutcome, 'RETRY'>,
          clientEventId: e.clientEventId,
          seq: e.seq,
          occurredAt: at,
          passengerTripId: p ? p.id : null,
          stopSeq: e.stopSeq ?? (p && d.effect?.kind === 'OUTCOME' ? (d.effect.to === 'DROPPED' ? p.dropSeq : p.pickupSeq) : null),
          reasonCode: e.reasonCode ?? null,
          data: {
            ...(d.outcome === 'ACCEPTED' ? {} : { code: d.code }),
            deviceOccurredAt: e.occurredAt,
            clockOffsetMs: t?.offset ?? null,
            ...(e.etaMin !== undefined ? { etaMin: e.etaMin } : {}),
            ...(e.note && (e.type === 'REPORT_DELAY' || e.type === 'REPORT_BREAKDOWN') ? { note: e.note } : {}),
            ...(d.verified ? { verified: d.verified } : {}),
            ...(d.effect?.kind === 'OUTCOME' && d.effect.earlyDrop ? { earlyDrop: true } : {}),
            ...(e.passengerTripId && !p ? { unknownPassengerTripId: e.passengerTripId } : {}),
          },
        });
        snap.lastSeq = Math.max(snap.lastSeq ?? 0, e.seq);
        results.set(e.clientEventId, { ...base, outcome: d.outcome, code: (d.code ?? null) as DriverTripEventResult['code'], verified: d.verified ?? null, receivedAt: row.receivedAt.toISOString() });
      }
      if (accepted.length) await this.audit.record(ctx, { action: 'UPDATE', entity: TRIP_ENTITY, entityId: id, details: { driverEvents: accepted, source: 'DRIVER_APP' } }, tx);
    });
    if (changed) await this.live.changed(ctx.companyId, [m.pt.id]);
    const after = assigned ? await this.one(ctx, me, id, true) : null;
    return {
      results: dto.events.map((e) => results.get(e.clientEventId)!),
      trip: after ? await this.detail(ctx, me, after, false) : null,
      serverTime: new Date().toISOString(),
    };
  }

  /** Apply an accepted effect (compare-and-set; a lost race turns into DUPLICATE or a rejection code). */
  private async apply(tx: Db, ctx: AuthContext, tt: TtRow, pt: PtRow, d: Extract<Decision, { outcome: 'ACCEPTED' }>, at: Date, now: number): Promise<true | 'DUPLICATE' | DriverErrorCode> {
    const e = d.effect;
    switch (e.kind) {
      case 'ACKNOWLEDGE': {
        const r = await tx.transportTrip.updateMany({ where: { id: tt.id, acknowledgedAt: null }, data: { acknowledgedAt: new Date(now), acknowledgedByUserId: ctx.userId, acknowledgedSource: 'DRIVER_APP', version: { increment: 1 } } });
        return r.count ? true : 'DUPLICATE';
      }
      case 'ARRIVE': {
        if (e.confirmOnly) return true;
        const stop = pt.stops.find((s) => s.id === e.stopId)!;
        await tx.plannedTripStop.updateMany({ where: { id: e.stopId, status: 'PENDING' }, data: { status: 'ARRIVED', actualArrival: at, delaySec: Math.round((at.getTime() - stop.plannedArrival.getTime()) / 1000) } });
        return true; // a stop the GPS reached meanwhile stays as it is: the driver's report is a confirmation then
      }
      case 'DEPART': {
        const r = await tx.plannedTripStop.updateMany({ where: { id: e.stopId, status: 'ARRIVED' }, data: { status: 'DEPARTED', actualDeparture: at } });
        return r.count ? true : 'DUPLICATE';
      }
      case 'OUTCOME': {
        const data: Prisma.TransportTripPassengerUpdateManyMutationInput = { status: e.to, outcomeSource: 'DRIVER_APP', outcomeByUserId: ctx.userId, outcomeAt: new Date(now) };
        if (e.to === 'BOARDED') data.boardedAt = at;
        if (e.to === 'DROPPED') data.droppedAt = at;
        if (e.to === 'NO_SHOW') data.noShowAt = at;
        if (!driverOutcomeAllowed(e.from, e.to)) return 'CONFLICT';
        const r = await tx.transportTripPassenger.updateMany({ where: { id: e.passengerTripId, tripId: tt.id, status: e.from }, data });
        return r.count ? true : 'CONFLICT';
      }
      case 'COMPLETE': {
        const r = await tx.plannedTrip.updateMany({ where: { id: pt.id, status: e.from }, data: { status: 'COMPLETED', closedBy: 'MANUAL', actualEnd: new Date(now), nextStopSeq: null } });
        if (!r.count) return 'INVALID_STATE';
        await tx.plannedTripStop.updateMany({ where: { tripId: pt.id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
        await tx.transportTrip.update({ where: { id: tt.id }, data: { version: { increment: 1 } } });
        return true;
      }
      case 'OVERLAY':
        return true;
    }
  }

  // ───────────────────────────── Sync ─────────────────────────────

  async sync(ctx: AuthContext, q: DriverSyncQuery): Promise<DriverSyncDto> {
    const me = await resolveDriver(this.prisma, ctx);
    const now = Date.now();
    const since = q.since ? new Date(q.since) : null;
    const mine = await this.mine(ctx, me, this.window(now), true);
    const trips: DriverSyncDto['trips'] = [];
    for (const { tt, pt } of mine) {
      const stamp = Math.max(tt.updatedAt.getTime(), pt.updatedAt.getTime(), ...tt.passengers.map((p) => p.updatedAt.getTime()));
      if (since && stamp <= since.getTime()) continue;
      const cancelled = !!tt.cancelledAt || pt.status === 'CANCELLED';
      trips.push({ id: tt.id, version: tt.version, change: cancelled ? 'REVOKED' : 'UPSERT', plannedTripStatus: pt.status as PlannedTripStatus });
    }
    // Reassigned away from me since the cursor: REVOKED (the app wipes the cached manifest).
    const moved = await this.prisma.transportTripEvent.findMany({ where: { providerCompanyId: ctx.companyId, kind: 'DRIVER_CHANGED', receivedAt: { gt: since ?? new Date(now - L.windowFutureHours * H) } }, select: { tripId: true, data: true, providerCompanyId: true } });
    const current = new Set(mine.map((m) => m.tt.id));
    for (const ev of moved) {
      if (ev.providerCompanyId !== ctx.companyId || (ev.data as { from?: unknown } | null)?.from !== me.id || current.has(ev.tripId) || trips.some((t) => t.id === ev.tripId)) continue;
      trips.push({ id: ev.tripId, version: 0, change: 'REVOKED', plannedTripStatus: null });
    }
    const evs = await this.prisma.transportTripEvent.findMany({
      where: { providerCompanyId: ctx.companyId, actorDriverId: me.id, source: 'DRIVER_APP', receivedAt: { gt: since ?? new Date(now - L.maxPastHours * H) } },
      select: { tripId: true, clientEventId: true, clientSeq: true, outcome: true, data: true, receivedAt: true, actorDriverId: true },
      take: 500,
    });
    return {
      // Overlap of 10 s: an event committed just after this read is sent again next time (the client is idempotent).
      cursor: new Date(now - 10_000).toISOString(),
      serverTime: new Date(now).toISOString(),
      trips,
      events: evs
        .filter((e) => e.actorDriverId === me.id && e.clientEventId)
        .map((e) => ({ tripId: e.tripId, clientEventId: e.clientEventId!, seq: e.clientSeq, outcome: e.outcome as Exclude<DriverTripEventOutcome, 'RETRY'>, code: ((e.data as { code?: string } | null)?.code as string) ?? null, receivedAt: e.receivedAt.toISOString() })),
      unreadNotifications: await this.notifications.unread(ctx, 'DRIVER'),
    };
  }

  // ───────────────────────────── Queries (relationship-scoped) ─────────────────────────────

  private window(now: number): { from: Date; to: Date } {
    return { from: new Date(now - L.windowPastHours * H), to: new Date(now + L.windowFutureHours * H) };
  }

  /** My published ETMS trips with plannedStart in the range, or running. Re-checked in code (never trust a filter alone). */
  private async mine(ctx: AuthContext, me: MeDriver, range: { from: Date; to: Date }, includeClosed = true): Promise<Mine[]> {
    const pts = await this.prisma.plannedTrip.findMany({
      where: { companyId: ctx.companyId, driverId: me.id, origin: 'ETMS', OR: [{ plannedStart: { gte: range.from, lte: range.to } }, { status: { in: ['STARTED', 'IN_PROGRESS'] } }] },
      include: PT_INCLUDE,
      take: 200,
    });
    const rows = await this.headers(ctx, pts.filter((p) => p.companyId === ctx.companyId && p.driverId === me.id && p.origin === 'ETMS'));
    return rows.filter((r) => includeClosed || OPEN.includes(r.pt.status as PlannedTripStatus)).sort((a, b) => a.pt.plannedStart.getTime() - b.pt.plannedStart.getTime());
  }

  private async headers(ctx: AuthContext, pts: PtRow[]): Promise<Mine[]> {
    if (!pts.length) return [];
    const tts = await this.prisma.transportTrip.findMany({ where: { plannedTripId: { in: pts.map((p) => p.id) }, providerCompanyId: ctx.companyId, publishedAt: { not: null } }, include: TT_INCLUDE });
    const byPt = new Map(pts.map((p) => [p.id, p]));
    return tts.filter((t) => t.providerCompanyId === ctx.companyId && t.publishedAt && t.plannedTripId && byPt.has(t.plannedTripId)).map((tt) => ({ tt, pt: byPt.get(tt.plannedTripId!)! }));
  }

  /**
   * One trip of mine, or null (→ 404): published, assigned to me, of my company, and inside the window or running.
   * `anyAge`: also a closed trip of mine outside the window (late events get LATE instead of 404).
   */
  private async one(ctx: AuthContext, me: MeDriver, id: string, anyAge = false): Promise<Mine | null> {
    const tt = await this.prisma.transportTrip.findFirst({ where: { id, providerCompanyId: ctx.companyId }, include: TT_INCLUDE });
    if (!tt || tt.id !== id || tt.providerCompanyId !== ctx.companyId || !tt.publishedAt || !tt.plannedTripId) return null;
    const pt = await this.prisma.plannedTrip.findFirst({ where: { id: tt.plannedTripId, companyId: ctx.companyId, driverId: me.id }, include: PT_INCLUDE });
    if (!pt || pt.id !== tt.plannedTripId || pt.companyId !== ctx.companyId || pt.driverId !== me.id || pt.origin !== 'ETMS') return null;
    const now = Date.now();
    const inWindow = pt.plannedStart.getTime() >= now - L.windowPastHours * H && pt.plannedStart.getTime() <= now + L.windowFutureHours * H;
    const running = RUNNING.includes(pt.status as PlannedTripStatus);
    const recentEnough = anyAge && pt.plannedStart.getTime() >= now - L.maxPastHours * H && pt.plannedStart.getTime() <= now + L.windowFutureHours * H;
    return inWindow || running || recentEnough ? { tt, pt } : null;
  }

  /** A trip of my company that was assigned to me before (I sent events for it, or it was reassigned away from me). */
  private async formerlyMine(ctx: AuthContext, me: MeDriver, id: string): Promise<Mine | null> {
    const tt = await this.prisma.transportTrip.findFirst({ where: { id, providerCompanyId: ctx.companyId }, include: TT_INCLUDE });
    if (!tt || tt.providerCompanyId !== ctx.companyId || !tt.plannedTripId) return null;
    const pt = await this.prisma.plannedTrip.findFirst({ where: { id: tt.plannedTripId, companyId: ctx.companyId }, include: PT_INCLUDE });
    if (!pt || pt.companyId !== ctx.companyId) return null;
    const mineBefore = await this.prisma.transportTripEvent.findMany({ where: { tripId: id, OR: [{ actorDriverId: me.id }, { kind: { in: ['DRIVER_CHANGED', 'PUBLISHED'] } }] }, select: { tripId: true, kind: true, actorDriverId: true, data: true } });
    const was = mineBefore.some((e) => e.tripId === id && (e.actorDriverId === me.id || (e.data as { from?: unknown; driverId?: unknown } | null)?.from === me.id || (e.kind === 'PUBLISHED' && (e.data as { driverId?: unknown } | null)?.driverId === me.id)));
    return was ? { tt, pt } : null;
  }

  private openDuty(driverId: string): Promise<DutyRow | null> {
    return this.prisma.transportDriverDuty.findFirst({ where: { driverId, endedAt: null }, include: DUTY_INCLUDE });
  }

  private async fix(objectId: string): Promise<TripSnapshot['fix']> {
    const live = parseLive(await this.redis.client.get(RedisKeys.live(objectId)).catch(() => null));
    if (!live || live.lat === null || live.lng === null || live.licenceLocked) return null;
    const at = Date.parse(live.fixTime ?? '');
    return Number.isFinite(at) ? { lat: live.lat, lng: live.lng, at: new Date(at) } : null;
  }

  private async store(
    db: Pick<Db, 'transportTripEvent'>,
    ctx: AuthContext,
    me: MeDriver,
    tt: Pick<TtRow, 'id' | 'providerCompanyId' | 'customerCompanyId'>,
    e: { kind: string; outcome: Exclude<DriverTripEventOutcome, 'RETRY'>; clientEventId: string; seq: number | null; occurredAt: Date; passengerTripId?: string | null; stopSeq?: number | null; reasonCode?: string | null; data: Record<string, unknown> },
  ) {
    return db.transportTripEvent.create({
      data: {
        tripId: tt.id,
        providerCompanyId: tt.providerCompanyId,
        customerCompanyId: tt.customerCompanyId,
        passengerTripId: e.passengerTripId ?? null,
        kind: e.kind,
        actorType: 'DRIVER',
        actorUserId: ctx.userId,
        actorDriverId: me.id,
        source: 'DRIVER_APP',
        outcome: e.outcome,
        clientEventId: e.clientEventId,
        clientSeq: e.seq,
        stopSeq: e.stopSeq ?? null,
        reasonCode: e.reasonCode ?? null,
        occurredAt: e.occurredAt,
        data: e.data as Prisma.InputJsonValue,
      },
      select: { receivedAt: true },
    });
  }

  // ───────────────────────────── Projections ─────────────────────────────

  private async summaries(ctx: AuthContext, rows: Mine[]): Promise<DriverTripSummaryDto[]> {
    const vehicles = await this.vehicles(ctx, rows.map((r) => r.pt.objectId));
    return rows.map((r) => summary(r, vehicles.get(r.pt.objectId) ?? null));
  }

  private async vehicles(ctx: AuthContext, ids: string[]) {
    const list = [...new Set(ids)];
    const rows = list.length ? await this.prisma.trackedObject.findMany({ where: { id: { in: list }, companyId: ctx.companyId }, select: { id: true, name: true, plateNumber: true, companyId: true } }) : [];
    return new Map(rows.filter((r) => r.companyId === ctx.companyId).map((r) => [r.id, { id: r.id, name: r.name, plateNumber: r.plateNumber }]));
  }

  private async detail(ctx: AuthContext, me: MeDriver, m: Mine, auditRead: boolean): Promise<DriverTripDetailDto> {
    const { tt, pt } = m;
    const status = pt.status as PlannedTripStatus;
    const hidden = !OPEN.includes(status) || !!tt.cancelledAt;
    const active = tt.passengers.filter((p) => p.status !== 'CANCELLED').sort((a, b) => a.pickupSeq - b.pickupSeq || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const [vehicles, profiles, overlays, mySeqs] = await Promise.all([
      this.vehicles(ctx, [pt.objectId]),
      hidden ? Promise.resolve(new Map<string, { displayName: string; accessibility: unknown }>()) : this.profiles(active.map((p) => p.bookingId), tt.customerCompanyId),
      this.overlays(tt.id),
      this.prisma.transportTripEvent.findMany({ where: { tripId: tt.id, actorDriverId: me.id, source: 'DRIVER_APP' }, select: { clientSeq: true } }),
    ]);
    const stops = [...pt.stops].sort((a, b) => a.seq - b.seq);
    const stopDtos: DriverStopDto[] = stops.map((s) => {
      const up = active.filter((p) => p.pickupSeq === s.seq);
      const down = active.filter((p) => p.dropSeq === s.seq);
      return {
        seq: s.seq,
        label: hidden ? null : s.name,
        lat: hidden ? null : s.lat,
        lng: hidden ? null : s.lng,
        radiusM: s.radiusM,
        plannedArrival: s.plannedArrival.toISOString(),
        actualArrival: s.actualArrival?.toISOString() ?? null,
        actualDeparture: s.actualDeparture?.toISOString() ?? null,
        status: s.status as PlannedStopStatus,
        pickups: up.length,
        drops: down.length,
        boarded: up.filter((p) => p.status === 'BOARDED' || p.status === 'DROPPED').length,
        noShow: up.filter((p) => p.status === 'NO_SHOW').length,
        dropped: down.filter((p) => p.status === 'DROPPED').length,
        pending: up.filter((p) => p.status === 'PENDING').length,
      };
    });
    const running = RUNNING.includes(status);
    const passengers: DriverPassengerDto[] = hidden
      ? []
      : active.map((p, i) => {
          const prof = profiles.get(p.bookingId);
          const st = p.status as Exclude<TransportPassengerStatus, 'CANCELLED'>;
          const allowed: DriverPassengerDto['allowedEvents'] = running ? (['BOARDED', 'NO_SHOW', 'DROPPED'] as const).filter((o) => driverOutcomeAllowed(st, o)) : [];
          return {
            passengerTripId: p.id,
            number: i + 1,
            displayName: st === 'PENDING' && prof ? driverDisplayName(prof.displayName) : `Passenger ${i + 1}`,
            pickupSeq: p.pickupSeq,
            dropSeq: p.dropSeq,
            seats: p.seats,
            status: st,
            accessibility: (prof?.accessibility as { wheelchair?: unknown } | null)?.wheelchair === true,
            contact: null,
            contactPolicy: 'NONE_R1',
            allowedEvents: allowed,
          };
        });
    if (auditRead && !hidden && passengers.length) await this.auditManifestRead(ctx, tt.id, passengers.length);
    return {
      ...summary(m, vehicles.get(pt.objectId) ?? null),
      stops: stopDtos,
      passengers,
      manifestHidden: hidden ? 'TRIP_CLOSED' : null,
      counts: counts(tt.passengers),
      overlays,
      lastSeq: maxSeq(mySeqs.map((r) => r.clientSeq)),
      serverTime: new Date().toISOString(),
    };
  }

  /** Display name + wheelchair flag of the passengers, by booking (the customer's rows only). */
  private async profiles(bookingIds: string[], customerCompanyId: string | null) {
    const out = new Map<string, { displayName: string; accessibility: unknown }>();
    if (!bookingIds.length || !customerCompanyId) return out;
    const rows = await this.prisma.transportBooking.findMany({ where: { id: { in: bookingIds }, customerCompanyId }, select: { id: true, customerCompanyId: true, profile: { select: { displayName: true, accessibility: true } } } });
    for (const r of rows) if (r.customerCompanyId === customerCompanyId && r.profile) out.set(r.id, { displayName: r.profile.displayName, accessibility: r.profile.accessibility });
    return out;
  }

  private async overlays(tripId: string): Promise<DriverTripOverlayDto[]> {
    const rows = await this.prisma.transportTripEvent.findMany({ where: { tripId, outcome: 'ACCEPTED', kind: { in: ['REPORT_DELAY', 'REPORT_BREAKDOWN'] } }, select: { tripId: true, kind: true, reasonCode: true, data: true, receivedAt: true, outcome: true } });
    const latest = new Map<string, DriverTripOverlayDto>();
    for (const r of rows.filter((x) => x.tripId === tripId && x.outcome === 'ACCEPTED').sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())) {
      const kind = r.kind === 'REPORT_DELAY' ? 'DELAY' : 'BREAKDOWN';
      const eta = (r.data as { etaMin?: unknown } | null)?.etaMin;
      latest.set(kind, { kind, reasonCode: r.reasonCode, etaMin: typeof eta === 'number' ? eta : null, reportedAt: r.receivedAt.toISOString() });
    }
    return [...latest.values()];
  }

  /** "Audit sensitive access" (plan §10, 05 §6.1): a driver's manifest read, at most once per trip and hour. */
  private async auditManifestRead(ctx: AuthContext, tripId: string, passengers: number): Promise<void> {
    try {
      const first = (await this.redis.client.set(`vt:etms:driver:manifest:${ctx.userId}:${tripId}`, '1', 'EX', 3600, 'NX')) === 'OK';
      if (first) await this.audit.record(ctx, { action: 'ACCESS', entity: TRIP_ENTITY, entityId: tripId, details: { what: 'driver-manifest', passengers } });
    } catch {
      /* best effort: never fail the read */
    }
  }
}

const DUTY_INCLUDE = { object: { select: { id: true, name: true, plateNumber: true } } } satisfies Prisma.TransportDriverDutyInclude;

function toDuty(d: DutyRow): DriverDutyDto {
  return { id: d.id, status: d.endedAt ? 'ENDED' : 'OPEN', startedAt: d.startedAt.toISOString(), endedAt: d.endedAt?.toISOString() ?? null, vehicle: d.object ? { id: d.object.id, name: d.object.name, plateNumber: d.object.plateNumber } : null };
}

function kindOf(type: string): string {
  return isDriverEventType(type) || type === 'START_TRIP' ? storedKind(type) : 'UNKNOWN';
}

function maxSeq(seqs: (number | null)[]): number | null {
  const s = seqs.filter((x): x is number => typeof x === 'number');
  return s.length ? Math.max(...s) : null;
}

function counts(ps: { status: string }[]) {
  const active = ps.filter((p) => p.status !== 'CANCELLED');
  return {
    passengers: active.length,
    boarded: active.filter((p) => p.status === 'BOARDED' || p.status === 'DROPPED').length,
    noShow: active.filter((p) => p.status === 'NO_SHOW').length,
    dropped: active.filter((p) => p.status === 'DROPPED').length,
    pending: active.filter((p) => p.status === 'PENDING').length,
  };
}

function summary({ tt, pt }: Mine, vehicle: { id: string; name: string; plateNumber: string | null } | null): DriverTripSummaryDto {
  const status = (tt.cancelledAt ? 'CANCELLED' : pt.status) as PlannedTripStatus;
  const arrived = new Set(pt.stops.filter((s) => s.status === 'ARRIVED').map((s) => s.seq));
  return {
    id: tt.id,
    version: tt.version,
    serviceDate: dayKeyOf(tt.serviceDate),
    direction: tt.direction,
    name: pt.routeName,
    derivedState: deriveTripState({ plannedTripStatus: status, publishedAt: tt.publishedAt, acknowledgedAt: tt.acknowledgedAt, stopWithPendingOutcome: tt.passengers.some((p) => p.status === 'PENDING' && arrived.has(p.pickupSeq)) }),
    plannedTripStatus: status,
    plannedStart: pt.plannedStart.toISOString(),
    plannedEnd: pt.plannedEnd.toISOString(),
    actualStart: pt.actualStart?.toISOString() ?? null,
    actualEnd: pt.actualEnd?.toISOString() ?? null,
    vehicle,
    stopCount: pt.stops.length,
    passengerCount: tt.passengers.filter((p) => p.status !== 'CANCELLED').length,
    acknowledgedAt: tt.acknowledgedAt?.toISOString() ?? null,
    allowedActions: driverTripActions({ plannedTripStatus: status, publishedAt: tt.publishedAt, acknowledgedAt: tt.acknowledgedAt }),
  };
}

export { DRIVER_SELECT };
