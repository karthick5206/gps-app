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
import { roundPath, stopOwner } from './personal-points';

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
  profile: { select: { id: true, displayName: true, employeeCode: true, branchId: true, officePoiId: true, userId: true } },
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

/** WP 3.9 wave 2: sets TransportBookingDto.groupSize (members of each group, whatever is on screen) with one query. */
export async function withGroupSizes<T extends { groupId: string | null; groupSize: number | null; customerCompanyId: string }>(db: { transportBooking: { findMany(args: object): Promise<unknown[]> } }, dtos: T[]): Promise<T[]> {
  const groups = [...new Set(dtos.flatMap((d) => (d.groupId ? [d.groupId] : [])))];
  if (!groups.length) return dtos;
  const rows = (await db.transportBooking.findMany({ where: { groupId: { in: groups }, customerCompanyId: { in: [...new Set(dtos.map((d) => d.customerCompanyId))] } }, select: { groupId: true } })) as { groupId: string | null }[];
  const size = new Map<string, number>();
  for (const r of rows) if (r.groupId) size.set(r.groupId, (size.get(r.groupId) ?? 0) + 1);
  for (const d of dtos) if (d.groupId) d.groupSize = size.get(d.groupId) ?? null;
  return dtos;
}

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
    journey: r.journey,
    // WP 3.9 (D-A1): afterCutoff <=> a dispatcher created or last edited it after its cut-off, which requires a stored
    // late reason (the server refuses a late desk create / edit without one; passengers are refused after the cut-off).
    afterCutoff: r.lateReason !== null,
    lateReason: own ? r.lateReason : null,
    groupId: r.groupId ?? null,
    // Filled by withGroupSizes (one query per page); null when the booking is not in a group.
    groupSize: null,
    purpose: own ? (r.purpose ?? null) : null,
    // Made through a passenger self-service path (the passenger's own login created it).
    requestedByPassenger: !!r.createdById && r.createdById === (r.profile.userId ?? null),
    tripId: seat?.tripId ?? null,
    passengerTripId: seat?.id ?? null,
    customerCompanyId: r.customerCompanyId,
    providerCompanyId: r.providerCompanyId,
    note: own ? r.note : null,
    // R1: only the customer itself changes its bookings (agreement viewers read only).
    // WP 3.9 D-A1: the desk may edit an unseated booking after the cut-off too (with a late reason).
    allowedActions: own ? bookingAllowedActions(r, now, { desk: true }) : [],
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
  booking: { select: { profileId: true, pickupLabel: true, dropLabel: true, pickupPoiId: true, dropPoiId: true, profile: { select: { id: true, displayName: true, employeeCode: true, branchId: true } } } },
} satisfies Prisma.TransportTripPassengerInclude;
export type PassengerDetailRow = Prisma.TransportTripPassengerGetPayload<{ include: typeof PASSENGER_DETAIL_INCLUDE }>;

export function toPassengerDto(p: PassengerDetailRow, stops: { seq: number; status: string }[], tripOpen: boolean, consent = true): TransportTripPassengerDto {
  const pickupStop = stops.find((s) => s.seq === p.pickupSeq);
  // L7: a personal end's label is free text (often an address): shown only while the passenger's routing consent is active.
  return {
    id: p.id,
    bookingId: p.bookingId,
    passenger: { id: p.booking.profile.id, displayName: p.booking.profile.displayName, employeeCode: p.booking.profile.employeeCode },
    pickupSeq: p.pickupSeq,
    dropSeq: p.dropSeq,
    pickupLabel: consent || p.booking.pickupPoiId ? p.booking.pickupLabel : null,
    dropLabel: consent || p.booking.dropPoiId ? p.booking.dropLabel : null,
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

/**
 * What the caller may see of the passengers' personal points on a trip (E3 security review M1, E2 M3): exact for the
 * customer's whole-company roles (`precise`), else 4 decimals; only for owners whose routing consent is active
 * (`consents`) and who are in the caller's branches (`ownerBranch` + `inBranch`).
 */
export interface TripPointView {
  precise: boolean;
  consents: Set<string>;
  /** Branch of each personal-stop owner / passenger profile (profile id → branch id, null = company-wide). */
  ownerBranch: Map<string, string | null>;
  inBranch: (branchId: string | null | undefined) => boolean;
}

/** Owner profile ids of the personal stops of a trip (for the consent / branch lookups of TripPointView). */
export function personalStopOwners(t: Pick<TripRow, 'plannedTrip'>, passengers: PassengerDetailRow[]): string[] {
  const pt = t.plannedTrip;
  if (!pt) return [];
  const owners = (pt.stops ?? []).map((s) => stopOwner(s, passengers, !!pt.routeId));
  return [...new Set(owners.filter((o): o is string => !!o && o !== 'UNKNOWN'))];
}

export function toTripDetail(
  t: TripRow,
  n: TripNames,
  passengers: PassengerDetailRow[],
  events: Prisma.TransportTripEventGetPayload<object>[],
  writable: boolean,
  view: TripPointView,
): TransportTripDto {
  const pt = t.plannedTrip;
  const stops = pt?.stops ?? [];
  const tripOpen = writable && !!pt && ['STARTED', 'IN_PROGRESS', 'COMPLETED', 'INCOMPLETE'].includes(pt.status);
  const inScope = (profileId: string) => view.inBranch(view.ownerBranch.has(profileId) ? view.ownerBranch.get(profileId) : undefined);
  const decimals = view.precise ? 6 : 4;
  let anyHidden = false;
  const stopDtos = stops.map((s) => {
    const owner = stopOwner(s, passengers, !!pt?.routeId);
    const hidden: 'CONSENT_REQUIRED' | 'OUT_OF_SCOPE' | null = !owner ? null : owner === 'UNKNOWN' ? 'CONSENT_REQUIRED' : !inScope(owner) ? 'OUT_OF_SCOPE' : !view.consents.has(owner) ? 'CONSENT_REQUIRED' : null;
    if (hidden) anyHidden = true;
    // The visible label of a personal stop is the owner's own booking label for that end (the stored name is neutral).
    const ownerSeat = owner && owner !== 'UNKNOWN' ? passengers.find((p) => p.booking.profileId === owner && (p.pickupStopId === s.id || p.dropStopId === s.id)) : undefined;
    const ownerLabel = ownerSeat ? (ownerSeat.pickupStopId === s.id ? ownerSeat.booking.pickupLabel : ownerSeat.booking.dropLabel) : null;
    return {
      id: s.id,
      seq: s.seq,
      name: !owner ? s.name : hidden ? `Stop ${s.seq + 1}` : (ownerLabel ?? s.name),
      lat: hidden ? null : owner ? round(s.lat, decimals) : s.lat,
      lng: hidden ? null : owner ? round(s.lng, decimals) : s.lng,
      personal: !!owner,
      pointHidden: hidden,
      plannedArrival: iso(s.plannedArrival),
      plannedDeparture: iso(s.plannedDeparture),
      actualArrival: isoOrNull(s.actualArrival),
      actualDeparture: isoOrNull(s.actualDeparture),
      status: s.status,
      pickups: passengers.filter((p) => p.status !== 'CANCELLED' && p.pickupSeq === s.seq).length,
      drops: passengers.filter((p) => p.status !== 'CANCELLED' && p.dropSeq === s.seq).length,
      outcomesPending: passengers.filter((p) => p.status === 'PENDING' && p.pickupSeq === s.seq).length,
    };
  });
  // The road path runs through every stop: withheld when any stop is hidden, rounded like the stops otherwise.
  const rawPath = pt && Array.isArray(pt.path) ? (pt.path as unknown as RoutePath) : null;
  const path = !rawPath || anyHidden ? null : view.precise ? rawPath : roundPath(rawPath, decimals);
  // The manifest lists only passengers of the caller's branches (seat counts stay whole: occupancy is not personal).
  const manifest = passengers.filter((p) => view.inBranch(p.booking.profile.branchId));
  return {
    ...toTripSummary(t, n),
    path,
    stops: stopDtos,
    passengers: manifest.sort((a, b) => a.pickupSeq - b.pickupSeq || a.createdAt.getTime() - b.createdAt.getTime()).map((p) => toPassengerDto(p, stops, tripOpen, view.consents.has(p.booking.profileId))),
    // Events of passengers outside the caller's branches are left out with them; a seat-less event (STOP_ADDED …) loses
    // the booking id of a booking that is not on the caller's manifest (security re-check N5).
    events: events
      .filter((e) => !e.passengerTripId || manifest.some((p) => p.id === e.passengerTripId))
      .map(toEventDto)
      .map((e) => (typeof e.data.bookingId === 'string' && !manifest.some((p) => p.bookingId === e.data.bookingId) ? { ...e, data: Object.fromEntries(Object.entries(e.data).filter(([k]) => k !== 'bookingId')) } : e)),
    allowedActions: tripAllowedActions(t, writable),
  };
}
