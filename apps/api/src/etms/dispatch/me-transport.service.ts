import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ME_VEHICLE_WINDOW, TRANSPORT_E3_LIMITS, transportSettingsOf, type EtaValue, type MeBookingDto, type MeTripDto, type MeVehicleDto, type PlannedStopStatus } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { iso } from '../../common/dto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { addDays } from '../../summarizer/tz';
import { parseLive } from '../../tracking/live-object';
import { PeopleService, activeRoutingConsents } from '../people/people.service';
import { FixedWindowLimiter } from '../directory/lookup-rate-limit';
import { dateOnly, dayKeyOf, e3Error, invalid, notFound, serviceDate } from './e3-common';
import { derivedStateOf } from './e3-mapping';
import { MeRangeQuery } from './e3.dto';
import { todayIn } from './service-dates';

const MIN = 60_000;
/**
 * L2: an open trip's window never runs past planned end + the v1.8 timeout (120 min, when the sweep closes it as
 * INCOMPLETE) + the grace, even if the sweep job is disabled.
 */
const OPEN_TRIP_MAX_AFTER_END_MIN = 120;

const SEAT_INCLUDE = {
  booking: { select: { id: true, profileId: true, windowStart: true, windowEnd: true, timeZone: true, pickupLabel: true, dropLabel: true, pickupLat: true, pickupLng: true, dropLat: true, dropLng: true } },
  trip: {
    include: {
      plannedTrip: { include: { stops: { orderBy: { seq: 'asc' as const } } } },
      passengers: { select: { id: true, status: true, seats: true, pickupSeq: true, dropSeq: true } },
    },
  },
} satisfies Prisma.TransportTripPassengerInclude;
type SeatRow = Prisma.TransportTripPassengerGetPayload<{ include: typeof SEAT_INCLUDE }>;

/**
 * Vehicle-visibility window of one passenger on one trip (pure; 05 §2.8, 10 §4.3): from planned start − 30 min (or
 * the actual start if earlier) until the passenger is dropped / the trip ended, + 10 min grace. Null = never visible
 * (cancelled trip, passenger no-show / cancelled, trip detached).
 */
export function vehicleWindow(
  pt: { status: string; plannedStart: Date; plannedEnd: Date; actualStart: Date | null; actualEnd: Date | null } | null,
  seat: { status: string; droppedAt: Date | null },
): { start: number; end: number } | null {
  if (!pt || pt.status === 'CANCELLED') return null;
  if (seat.status === 'NO_SHOW' || seat.status === 'CANCELLED') return null;
  const start = Math.min(pt.plannedStart.getTime() - ME_VEHICLE_WINDOW.beforeStartMin * MIN, pt.actualStart?.getTime() ?? Infinity);
  const closed = pt.status === 'COMPLETED' || pt.status === 'INCOMPLETE';
  const hardEnd = pt.plannedEnd.getTime() + OPEN_TRIP_MAX_AFTER_END_MIN * MIN;
  const endBase = seat.droppedAt?.getTime() ?? (closed ? (pt.actualEnd ?? pt.plannedEnd).getTime() : Math.min(Math.max(pt.plannedEnd.getTime(), Date.now()), hardEnd));
  return { start, end: endBase + ME_VEHICLE_WINDOW.afterEndMin * MIN };
}

/**
 * The passenger's own trips and bookings (05 §2.8; D5 relationship guard): only rows of the caller's own active
 * profile (403 NOT_A_PASSENGER otherwise), other ids 404. Narrow DTOs: vehicle name / plate, the driver's first name,
 * own stop only, co-rider count. The vehicle position is served only inside the window, by polling this API — never
 * through the company-wide /live socket (docs 08 / 10).
 */
@Injectable()
export class MeTransportService {
  private readonly vehicleLimiter: FixedWindowLimiter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PeopleService,
    private readonly redis: RedisService,
  ) {
    this.vehicleLimiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:rl:me-vehicle', TRANSPORT_E3_LIMITS.meVehiclePerMinute, 60_000);
  }

  async trips(ctx: AuthContext, q: MeRangeQuery): Promise<MeTripDto[]> {
    const me = await this.people.myProfileRow(ctx);
    const { from, to } = await this.range(ctx, q);
    const seats = await this.prisma.transportTripPassenger.findMany({
      where: { customerCompanyId: ctx.companyId, booking: { profileId: me.id }, status: { not: 'CANCELLED' }, trip: { serviceDate: { gte: dateOnly(from), lte: dateOnly(to) } } },
      include: SEAT_INCLUDE,
      take: 200,
    });
    const mine = seats.filter((s) => s.booking.profileId === me.id);
    const names = await this.names(mine);
    const consent = (await activeRoutingConsents(this.prisma, [me.id])).has(me.id);
    return mine.map((s) => this.toMeTrip(s, names, consent)).sort((a, b) => a.window.start.localeCompare(b.window.start));
  }

  async trip(ctx: AuthContext, tripId: string): Promise<MeTripDto> {
    const seat = await this.seat(ctx, tripId);
    const consent = (await activeRoutingConsents(this.prisma, [seat.booking.profileId])).has(seat.booking.profileId);
    return this.toMeTrip(seat, await this.names([seat]), consent);
  }

  /** The trip's vehicle, only inside the window (`{ visible: false }` outside); own trip only. */
  async vehicle(ctx: AuthContext, tripId: string): Promise<MeVehicleDto> {
    // L2: at most meVehiclePerMinute polls per user and trip (the app polls every 15 s).
    const rl = await this.vehicleLimiter.hit(`${ctx.userId}:${tripId}`);
    if (!rl.allowed) throw e3Error(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', `Too many requests; try again in ${rl.retryAfterSec} s`, { retryAfterSec: rl.retryAfterSec });
    const seat = await this.seat(ctx, tripId);
    const pt = seat.trip.plannedTrip;
    const w = vehicleWindow(pt, seat);
    const now = Date.now();
    if (!pt || !w || now < w.start || now > w.end) return { visible: false, reason: 'OUTSIDE_WINDOW' };
    const live = parseLive(await this.redis.client.get(RedisKeys.live(pt.objectId)).catch(() => null));
    if (!live || live.lat === null || live.lng === null || live.licenceLocked) return { visible: false, reason: 'NO_FIX' };
    return {
      visible: true,
      lat: live.lat,
      lng: live.lng,
      heading: Number.isFinite(live.course) ? live.course : null,
      speedKph: Number.isFinite(live.speedKph) ? live.speedKph : null,
      fixAt: live.fixTime ?? live.serverTime ?? new Date(now).toISOString(),
      eta: this.myEta(seat),
    };
  }

  async bookings(ctx: AuthContext, q: MeRangeQuery): Promise<MeBookingDto[]> {
    const me = await this.people.myProfileRow(ctx);
    const { from, to } = await this.range(ctx, q);
    const rows = await this.prisma.transportBooking.findMany({
      where: { customerCompanyId: ctx.companyId, profileId: me.id, serviceDate: { gte: dateOnly(from), lte: dateOnly(to) } },
      include: { passengers: { select: { tripId: true, status: true } } },
      orderBy: [{ windowStart: 'asc' }],
      take: 200,
    });
    return rows.filter((r) => r.profileId === me.id).map(toMeBooking);
  }

  async booking(ctx: AuthContext, id: string): Promise<MeBookingDto> {
    const me = await this.people.myProfileRow(ctx);
    const row = await this.prisma.transportBooking.findFirst({ where: { id, customerCompanyId: ctx.companyId, profileId: me.id }, include: { passengers: { select: { tripId: true, status: true } } } });
    if (!row || row.profileId !== me.id) throw notFound();
    return toMeBooking(row);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async seat(ctx: AuthContext, tripId: string): Promise<SeatRow> {
    const me = await this.people.myProfileRow(ctx);
    const seat = await this.prisma.transportTripPassenger.findFirst({
      where: { tripId, customerCompanyId: ctx.companyId, booking: { profileId: me.id }, status: { not: 'CANCELLED' } },
      include: SEAT_INCLUDE,
    });
    if (!seat || seat.booking.profileId !== me.id || seat.status === 'CANCELLED') throw notFound();
    return seat;
  }

  private async range(ctx: AuthContext, q: MeRangeQuery): Promise<{ from: string; to: string }> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
    const today = todayIn(company.timezone);
    const from = q.from ? serviceDate(q.from, 'from') : addDays(today, -TRANSPORT_E3_LIMITS.meDefaultPastDays);
    const to = q.to ? serviceDate(q.to, 'to') : addDays(today, TRANSPORT_E3_LIMITS.meDefaultFutureDays);
    if (to < from || to > addDays(from, TRANSPORT_E3_LIMITS.meMaxRangeDays)) throw invalid(`Ask for at most ${TRANSPORT_E3_LIMITS.meMaxRangeDays} days`);
    return { from, to };
  }

  private async names(seats: SeatRow[]) {
    const objectIds = [...new Set(seats.flatMap((s) => (s.trip.plannedTrip ? [s.trip.plannedTrip.objectId] : [])))];
    const driverIds = [...new Set(seats.flatMap((s) => (s.trip.plannedTrip?.driverId ? [s.trip.plannedTrip.driverId] : [])))];
    const operatorIds = [...new Set(seats.map((s) => s.trip.providerCompanyId))];
    const [objects, drivers, operators] = await Promise.all([
      objectIds.length ? this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true, plateNumber: true } }) : [],
      driverIds.length ? this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true } }) : [],
      operatorIds.length ? this.prisma.company.findMany({ where: { id: { in: operatorIds } }, select: { id: true, settings: true } }) : [],
    ]);
    // E5: the operator's transport desk phone (Company.settings.etms.deskPhone) for "call the desk".
    const phones = new Map(operators.map((c) => [c.id, transportSettingsOf(c.settings).deskPhone ?? null]));
    return { objects: new Map(objects.map((o) => [o.id, o])), drivers: new Map(drivers.map((d) => [d.id, d.name])), phones };
  }

  /** ETA to my stop from the v1.8 tracker, only when my pickup is the trip's next stop; else none (never invented). */
  private myEta(seat: SeatRow): EtaValue {
    const pt = seat.trip.plannedTrip;
    if (!pt || seat.status !== 'PENDING') return { at: null, model: null };
    if (pt.nextStopSeq === seat.pickupSeq && pt.etaNextStop) return { at: iso(pt.etaNextStop), model: 'TRACKER' };
    return { at: null, model: null };
  }

  /**
   * `consent`: the caller's own routing consent (E2 final model). Their own pickup / drop point is shown only with it
   * (doc 02 §7, doc 10: a passenger may see their own location); the seat row is always the caller's own (seat()).
   */
  private toMeTrip(s: SeatRow, n: Awaited<ReturnType<MeTransportService['names']>>, consent: boolean): MeTripDto {
    const own = (lat: number | null, lng: number | null) => (consent && lat !== null && lng !== null ? { lat, lng } : null);
    const hasPoint = s.booking.pickupLat !== null || s.booking.dropLat !== null;
    const pt = s.trip.plannedTrip;
    const pick = pt?.stops.find((x) => x.seq === s.pickupSeq);
    const drop = pt?.stops.find((x) => x.seq === s.dropSeq);
    const w = vehicleWindow(pt, s);
    const now = Date.now();
    const o = pt ? n.objects.get(pt.objectId) : undefined;
    const driver = pt?.driverId ? n.drivers.get(pt.driverId) : undefined;
    return {
      id: s.tripId,
      passengerTripId: s.id,
      serviceDate: dayKeyOf(s.trip.serviceDate),
      direction: s.trip.direction,
      timeZone: s.booking.timeZone,
      window: { start: iso(s.booking.windowStart), end: iso(s.booking.windowEnd) },
      derivedState: derivedStateOf(s.trip),
      myStatus: s.status,
      vehicle: o ? { name: o.name, plate: o.plateNumber } : null,
      driverFirstName: driver ? driver.trim().split(/\s+/)[0] : null,
      myStop: pick ? { seq: pick.seq, label: s.booking.pickupLabel ?? pick.name, plannedAt: iso(pick.plannedArrival), status: pick.status as PlannedStopStatus, eta: this.myEta(s) } : null,
      myDrop: drop ? { seq: drop.seq, label: s.booking.dropLabel ?? drop.name, plannedAt: iso(drop.plannedArrival) } : null,
      plannedStart: pt ? iso(pt.plannedStart) : null,
      plannedEnd: pt ? iso(pt.plannedEnd) : null,
      myPickupPoint: own(s.booking.pickupLat, s.booking.pickupLng),
      myDropPoint: own(s.booking.dropLat, s.booking.dropLng),
      pointsHidden: !consent && hasPoint ? 'CONSENT_REQUIRED' : null,
      coRiders: s.trip.passengers.filter((p) => p.id !== s.id && p.status !== 'CANCELLED').length,
      liveVisible: !!w && now >= w.start && now <= w.end,
      deskPhone: n.phones.get(s.trip.providerCompanyId) ?? null,
    };
  }
}

function toMeBooking(r: Prisma.TransportBookingGetPayload<{ include: { passengers: { select: { tripId: true; status: true } } } }>): MeBookingDto {
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    serviceDate: dayKeyOf(r.serviceDate),
    direction: r.direction,
    timeZone: r.timeZone,
    windowStart: iso(r.windowStart),
    windowEnd: iso(r.windowEnd),
    pickupLabel: r.pickupLabel,
    dropLabel: r.dropLabel,
    tripId: r.passengers.find((p) => p.status !== 'CANCELLED')?.tripId ?? null,
    cutoffAt: r.cutoffAt ? iso(r.cutoffAt) : null,
  };
}
