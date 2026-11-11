import { Prisma } from '@prisma/client';
import {
  allowedPassengerOutcomes,
  bookingAllowedActions,
  deriveTripState,
  type GeoPoint,
  type PlannedTripOrigin,
  type PlannedTripStatus,
  type RoutePath,
  type TransportBookingDto,
  type TransportOutcomeSource,
  type TransportShiftDto,
  type TransportTripAction,
  type TransportTripDerivedState,
  type TransportTripDto,
  type TransportTripEventDto,
  type TransportTripPassengerCounts,
  type TransportTripPassengerDto,
  type TransportTripSummaryDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { iso, isoOrNull } from '../../common/dto';
import { dayKeyOf, round } from './e3-common';

/** Row shapes and DTO mappers of the E3 module (no database access here). */

// ───────────────────────────── Shifts ─────────────────────────────

export const SHIFT_INCLUDE = {
  sitePoi: { select: { id: true, name: true, lat: true, lng: true } },
  _count: { select: { schedules: { where: { isActive: true } } } },
} satisfies Prisma.TransportShiftInclude;
export type ShiftRow = Prisma.TransportShiftGetPayload<{ include: typeof SHIFT_INCLUDE }>;

export function toShiftDto(r: ShiftRow): TransportShiftDto {
  return {
    id: r.id,
    name: r.name,
    site: r.sitePoi ? { id: r.sitePoi.id, name: r.sitePoi.name, lat: r.sitePoi.lat, lng: r.sitePoi.lng } : null,
    startMin: r.startMin,
    endMin: r.endMin,
    overnight: r.overnight,
    days: [...r.days].sort((a, b) => a - b),
    timeZone: r.timeZone,
    isActive: r.isActive,
    scheduleCount: r._count?.schedules ?? 0,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

// ───────────────────────────── Bookings ─────────────────────────────

export const BOOKING_INCLUDE = {
  profile: { select: { id: true, displayName: true, employeeCode: true, branchId: true } },
  shift: { select: { name: true } },
  passengers: { select: { id: true, tripId: true, status: true, createdAt: true } },
} satisfies Prisma.TransportBookingInclude;
export type BookingRow = Prisma.TransportBookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;

/** Exact coordinates for the customer's whole-company roles; 4 decimals (≈ 11 m) for everyone else (doc 02 §7.2). */
export function preciseFor(ctx: Pick<AuthContext, 'companyId' | 'dataScope'>, customerCompanyId: string | null): boolean {
  return ctx.dataScope === 'COMPANY' && customerCompanyId === ctx.companyId;
}

function point(lat: number | null, lng: number | null, label: string | null, poiId: string | null, precise: boolean): GeoPoint | null {
  if (lat === null || lng === null) return null;
  // Places (Poi) are company sites, never personal: always exact. Home points are rounded unless precise.
  const d = precise || poiId ? 6 : 4;
  return { lat: round(lat, d), lng: round(lng, d), label, poiId };
}

/** The current (non-cancelled) seat of a booking, else the latest one. */
export function currentSeat(passengers: { id: string; tripId: string; status: string; createdAt: Date }[] | undefined) {
  const list = [...(passengers ?? [])].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return list.find((p) => p.status !== 'CANCELLED') ?? list[0] ?? null;
}

/**
 * How a booking is shown (E2 security review M3 applied to E3): `list` = list / export rows, never a personal point;
 * `detail` = booking detail and dispatch board, personal points only while the passenger's routing consent is active
 * (`consent`). Company sites (poiId) are not personal and always shown.
 */
export interface BookingView {
  view: 'list' | 'detail';
  consent: boolean;
}
export const LIST_VIEW: BookingView = { view: 'list', consent: false };

export function toBookingDto(r: BookingRow, ctx: Pick<AuthContext, 'companyId' | 'dataScope'>, show: BookingView, now: number = Date.now()): TransportBookingDto {
  const precise = preciseFor(ctx, r.customerCompanyId);
  const seat = currentSeat(r.passengers);
  const personalOk = show.view === 'detail' && show.consent;
  const shown = (lat: number | null, lng: number | null, label: string | null, poiId: string | null) => (poiId || personalOk ? point(lat, lng, label, poiId, precise) : null);
  const pickup = shown(r.pickupLat, r.pickupLng, r.pickupLabel, r.pickupPoiId);
  const drop = shown(r.dropLat, r.dropLng, r.dropLabel, r.dropPoiId);
  const withheld = (r.pickupLat !== null && !pickup) || (r.dropLat !== null && !drop);
  const own = r.customerCompanyId === ctx.companyId;
  return {
    id: r.id,
    version: r.version,
    status: r.status,
    statusReason: r.statusReason,
    source: r.source,
    passenger: { id: r.profile.id, displayName: r.profile.displayName, employeeCode: r.profile.employeeCode },
    scheduleId: r.scheduleId,
    shiftId: r.shiftId,
    shiftName: r.shift?.name ?? null,
    serviceDate: dayKeyOf(r.serviceDate),
    direction: r.direction,
    timeZone: r.timeZone,
    pickup,
    drop,
    pickupLabel: r.pickupLabel,
    dropLabel: r.dropLabel,
    pointsHidden: withheld ? (show.view === 'list' ? 'LIST_VIEW' : 'CONSENT_REQUIRED') : null,
    // From the stored points, not from what this view shows.
    needsLocation: r.pickupLat === null || r.dropLat === null,
    windowStart: iso(r.windowStart),
    windowEnd: iso(r.windowEnd),
    passengerCount: r.passengerCount,
    cutoffAt: isoOrNull(r.cutoffAt),
    tripId: seat?.tripId ?? null,
    passengerTripId: seat?.id ?? null,
    customerCompanyId: r.customerCompanyId,
    providerCompanyId: r.providerCompanyId,
    note: own ? r.note : null,
    // R1: only the customer itself changes its bookings (agreement viewers read only).
    allowedActions: own ? bookingAllowedActions(r, now) : [],
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

// ───────────────────────────── Trips ─────────────────────────────

export const TRIP_INCLUDE = {
  plannedTrip: { include: { stops: { orderBy: { seq: 'asc' as const } } } },
  shift: { select: { name: true } },
  passengers: { select: { id: true, status: true, seats: true, pickupSeq: true, dropSeq: true } },
} satisfies Prisma.TransportTripInclude;
export type TripRow = Prisma.TransportTripGetPayload<{ include: typeof TRIP_INCLUDE }>;

export interface TripNames {
  vehicles: Map<string, { name: string; plateNumber: string | null }>;
  drivers: Map<string, string>;
}

export function passengerCounts(ps: { status: string }[]): TransportTripPassengerCounts {
  const c: TransportTripPassengerCounts = { pending: 0, boarded: 0, noShow: 0, dropped: 0, cancelled: 0 };
  for (const p of ps) {
    if (p.status === 'PENDING') c.pending++;
    else if (p.status === 'BOARDED') c.boarded++;
    else if (p.status === 'NO_SHOW') c.noShow++;
    else if (p.status === 'DROPPED') c.dropped++;
    else if (p.status === 'CANCELLED') c.cancelled++;
  }
  return c;
}

/** A stop the vehicle is at (ARRIVED) with an active passenger picked up there whose outcome is not recorded. */
export function stopWithPendingOutcome(stops: { seq: number; status: string }[], ps: { status: string; pickupSeq: number }[]): boolean {
  return stops.some((s) => s.status === 'ARRIVED' && ps.some((p) => p.status === 'PENDING' && p.pickupSeq === s.seq));
}

export function derivedStateOf(t: Pick<TripRow, 'publishedAt' | 'acknowledgedAt' | 'plannedTrip' | 'passengers'>): TransportTripDerivedState {
  const pt = t.plannedTrip;
  return deriveTripState({
    plannedTripStatus: (pt?.status as PlannedTripStatus | undefined) ?? null,
    publishedAt: t.publishedAt,
    acknowledgedAt: t.acknowledgedAt,
    stopWithPendingOutcome: pt ? stopWithPendingOutcome(pt.stops ?? [], t.passengers ?? []) : false,
  });
}

export function toTripSummary(t: TripRow, n: TripNames): TransportTripSummaryDto {
  const pt = t.plannedTrip;
  const vehicle = pt ? n.vehicles.get(pt.objectId) : undefined;
  return {
    id: t.id,
    version: t.version,
    plannedTripId: t.plannedTripId,
    serviceDate: dayKeyOf(t.serviceDate),
    direction: t.direction,
    derivedState: derivedStateOf(t),
    plannedTripStatus: (pt?.status as PlannedTripStatus | undefined) ?? null,
    origin: ((pt?.origin as PlannedTripOrigin | undefined) ?? 'ETMS') as PlannedTripOrigin,
    routeId: pt?.routeId ?? null,
    name: pt?.routeName ?? 'Transport trip',
    objectId: pt?.objectId ?? null,
    vehicleName: vehicle?.name ?? null,
    plateNumber: vehicle?.plateNumber ?? null,
    driverId: pt?.driverId ?? null,
    driverName: pt?.driverId ? (n.drivers.get(pt.driverId) ?? null) : null,
    plannedStart: pt ? iso(pt.plannedStart) : null,
    plannedEnd: pt ? iso(pt.plannedEnd) : null,
    actualStart: isoOrNull(pt?.actualStart),
    actualEnd: isoOrNull(pt?.actualEnd),
    seatCapacity: t.seatCapacity,
    occupiedSeats: t.occupiedSeats,
    passengerCounts: passengerCounts(t.passengers ?? []),
    nextStopSeq: pt?.nextStopSeq ?? null,
    etaNextStop: isoOrNull(pt?.etaNextStop),
    delaySec: pt?.delaySec ?? null,
    shiftId: t.shiftId,
    shiftName: t.shift?.name ?? null,
    siteId: t.sitePoiId,
    publishedAt: isoOrNull(t.publishedAt),
    acknowledgedAt: isoOrNull(t.acknowledgedAt),
    cancelledAt: isoOrNull(t.cancelledAt),
    cancelReason: t.cancelReason,
    customerCompanyId: t.customerCompanyId,
    providerCompanyId: t.providerCompanyId,
  };
}

/** Commands the dispatcher may run now (R1). */
export function tripAllowedActions(t: Pick<TripRow, 'publishedAt' | 'acknowledgedAt' | 'plannedTrip'>, writable: boolean): TransportTripAction[] {
  if (!writable || !t.plannedTrip) return [];
  const s = t.plannedTrip.status;
  const out: TransportTripAction[] = [];
  if (s === 'SCHEDULED') out.push('start');
  if (s === 'STARTED' || s === 'IN_PROGRESS') out.push('arrive', 'complete');
  if (s === 'SCHEDULED' || s === 'STARTED' || s === 'IN_PROGRESS') out.push('cancel');
  if (t.publishedAt && !t.acknowledgedAt && (s === 'SCHEDULED' || s === 'STARTED' || s === 'IN_PROGRESS')) out.push('acknowledge');
  out.push('repeat');
  return out;
}

export const PASSENGER_DETAIL_INCLUDE = {
  booking: { select: { pickupLabel: true, dropLabel: true, profile: { select: { id: true, displayName: true, employeeCode: true } } } },
} satisfies Prisma.TransportTripPassengerInclude;
export type PassengerDetailRow = Prisma.TransportTripPassengerGetPayload<{ include: typeof PASSENGER_DETAIL_INCLUDE }>;

export function toPassengerDto(p: PassengerDetailRow, stops: { seq: number; status: string }[], tripOpen: boolean): TransportTripPassengerDto {
  const pickupStop = stops.find((s) => s.seq === p.pickupSeq);
  return {
    id: p.id,
    bookingId: p.bookingId,
    passenger: { id: p.booking.profile.id, displayName: p.booking.profile.displayName, employeeCode: p.booking.profile.employeeCode },
    pickupSeq: p.pickupSeq,
    dropSeq: p.dropSeq,
    pickupLabel: p.booking.pickupLabel,
    dropLabel: p.booking.dropLabel,
    seats: p.seats,
    status: p.status,
    boardedAt: isoOrNull(p.boardedAt),
    droppedAt: isoOrNull(p.droppedAt),
    noShowAt: isoOrNull(p.noShowAt),
    noShowReason: p.noShowReason,
    cancelReason: p.cancelReason,
    outcomeSource: (p.outcomeSource as TransportOutcomeSource | null) ?? null,
    outcomeAt: isoOrNull(p.outcomeAt),
    // GPS reached the stop, nobody recorded what happened: shown as "outcome not recorded", never as boarded (02 §5.3).
    outcomeMissing: p.status === 'PENDING' && !!pickupStop && (pickupStop.status === 'ARRIVED' || pickupStop.status === 'DEPARTED' || pickupStop.status === 'SKIPPED'),
    allowedOutcomes: tripOpen ? allowedPassengerOutcomes(p.status) : [],
  };
}

export function toEventDto(e: Prisma.TransportTripEventGetPayload<object>): TransportTripEventDto {
  return {
    id: e.id,
    kind: e.kind,
    actorType: e.actorType as TransportTripEventDto['actorType'],
    actorUserId: e.actorUserId,
    source: e.source as TransportTripEventDto['source'],
    outcome: e.outcome as TransportTripEventDto['outcome'],
    passengerTripId: e.passengerTripId,
    stopSeq: e.stopSeq,
    reasonCode: e.reasonCode,
    occurredAt: iso(e.occurredAt),
    receivedAt: iso(e.receivedAt),
    data: e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {},
  };
}

export function toTripDetail(
  t: TripRow,
  n: TripNames,
  passengers: PassengerDetailRow[],
  events: Prisma.TransportTripEventGetPayload<object>[],
  writable: boolean,
): TransportTripDto {
  const pt = t.plannedTrip;
  const stops = pt?.stops ?? [];
  const tripOpen = writable && !!pt && ['STARTED', 'IN_PROGRESS', 'COMPLETED', 'INCOMPLETE'].includes(pt.status);
  return {
    ...toTripSummary(t, n),
    path: pt && Array.isArray(pt.path) ? (pt.path as unknown as RoutePath) : null,
    stops: stops.map((s) => ({
      id: s.id,
      seq: s.seq,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      plannedArrival: iso(s.plannedArrival),
      plannedDeparture: iso(s.plannedDeparture),
      actualArrival: isoOrNull(s.actualArrival),
      actualDeparture: isoOrNull(s.actualDeparture),
      status: s.status,
      pickups: passengers.filter((p) => p.status !== 'CANCELLED' && p.pickupSeq === s.seq).length,
      drops: passengers.filter((p) => p.status !== 'CANCELLED' && p.dropSeq === s.seq).length,
      outcomesPending: passengers.filter((p) => p.status === 'PENDING' && p.pickupSeq === s.seq).length,
    })),
    passengers: [...passengers].sort((a, b) => a.pickupSeq - b.pickupSeq || a.createdAt.getTime() - b.createdAt.getTime()).map((p) => toPassengerDto(p, stops, tripOpen)),
    events: events.map(toEventDto),
    allowedActions: tripAllowedActions(t, writable),
  };
}
