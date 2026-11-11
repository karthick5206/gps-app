import type { Prisma } from '@prisma/client';
import {
  driverDisplayName,
  ROUTE_PLAN_EDITABLE,
  routePlanLocks,
  type EtaModel,
  type LatLng,
  type LineStringGeometry,
  type RoutePlanAssignmentViewDto,
  type RoutePlanDetailDto,
  type RoutePlanPointHidden,
  type RoutePlanStatus,
  type RoutePlanStopViewDto,
  type RoutePlanSummaryDto,
  type RoutePlanVersionSnapshot,
  type RoutingProfile,
  type TransportDirection,
} from '@veetracer/shared';
import { weightsOf } from '../../routing-jobs/prisma-plan-gateway';
import { round } from '../dispatch/e3-common';
import { PERSONAL_STOP_NAME } from '../dispatch/personal-points';
import { routeStops, routeViolations, windowsOf, type RuleStop } from './plan-rules';

/** What a plan read loads (detail, edits, publish). */
export const PLAN_INCLUDE = {
  assignments: true,
  stops: true,
  transportTrips: { select: { id: true, plannedTripId: true, routeAssignmentId: true } },
} satisfies Prisma.RoutePlanInclude;
export type PlanRow = Prisma.RoutePlanGetPayload<{ include: typeof PLAN_INCLUDE }>;
export type StopRow = PlanRow['stops'][number];
export type AssignmentRow = PlanRow['assignments'][number];

/** The booking facts a plan view needs (seats, owner, the owner's own labels, branch). */
export interface ViewBooking {
  id: string;
  passengerCount: number;
  profileId: string;
  pickupLabel: string | null;
  dropLabel: string | null;
  branchId: string | null;
  /** Passenger's full name (only turned into "First L." for callers that may see names). */
  displayName?: string | null;
}

export interface PlanPointView {
  precise: boolean;
  consents: Set<string>;
  bookings: Map<string, ViewBooking>;
  /** Branch of every personal-stop owner (profile id → branch id; null = company-wide). */
  ownerBranch: Map<string, string | null>;
  inBranch: (branchId: string | null | undefined) => boolean;
  names: { vehicles: Map<string, { name: string; plateNumber: string | null }>; drivers: Map<string, string> };
  /** The caller may see passenger names (dispatch / bookings / passengers view): stops then carry "First L.". */
  showNames?: boolean;
}

export const toRuleStop = (s: StopRow): RuleStop => ({
  id: s.id,
  ref: s.ref,
  assignmentId: s.assignmentId,
  sequence: s.sequence,
  etaS: s.etaS,
  serviceS: s.serviceS,
  demand: s.demand,
  timeWindows: windowsOf(s.timeWindows),
  stopKind: s.stopKind === 'PICKUP' || s.stopKind === 'DROP' ? s.stopKind : null,
  bookingId: s.bookingId,
  profileId: s.profileId,
  poiId: s.poiId,
  lat: s.lat,
  lng: s.lng,
  name: s.name,
});

/** Owner (profile id) of a personal plan stop, or null for a company place / generic stop. */
export function planStopOwner(s: Pick<StopRow, 'profileId' | 'poiId' | 'bookingId'>, bookings: Map<string, Pick<ViewBooking, 'profileId'>>): string | null {
  if (s.profileId) return s.profileId;
  if (s.poiId) return null;
  return s.bookingId ? (bookings.get(s.bookingId)?.profileId ?? null) : null;
}

/** Profile ids owning personal stops of a plan. */
export function personalOwners(stops: StopRow[], bookings: Map<string, Pick<ViewBooking, 'profileId'>>): string[] {
  return [...new Set(stops.flatMap((s) => planStopOwner(s, bookings) ?? []))];
}

/** Why the point of a personal stop is withheld from this caller (E3 trip-detail rules), or null. */
export function hiddenReason(owner: string | null, view: Pick<PlanPointView, 'consents' | 'ownerBranch' | 'inBranch'>): RoutePlanPointHidden | null {
  if (!owner) return null;
  if (!view.inBranch(view.ownerBranch.has(owner) ? view.ownerBranch.get(owner) : undefined)) return 'OUT_OF_SCOPE';
  return view.consents.has(owner) ? null : 'CONSENT_REQUIRED';
}

/**
 * A stop that belongs to a passenger outside the caller's branches (its personal point, or a site stop of their
 * booking): anonymous for that caller (no booking / profile id, neutral ref) and never editable by them (404).
 */
export function outOfScope(s: Pick<StopRow, 'profileId' | 'poiId' | 'bookingId'>, view: Pick<PlanPointView, 'bookings' | 'ownerBranch' | 'inBranch'>): boolean {
  const owner = planStopOwner(s, view.bookings);
  if (owner && !view.inBranch(view.ownerBranch.has(owner) ? view.ownerBranch.get(owner) : undefined)) return true;
  const b = s.bookingId ? view.bookings.get(s.bookingId) : undefined;
  return !!b && !view.inBranch(b.branchId);
}

/** GeoJSON line of an assignment (stored as [[lng, lat], …] or as a LineString object). */
function lineOf(json: unknown): [number, number][] | null {
  const coords = Array.isArray(json) ? json : json && typeof json === 'object' ? (json as { coordinates?: unknown }).coordinates : null;
  if (!Array.isArray(coords)) return null;
  const out = coords.filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number').map((c) => [c[0], c[1]] as [number, number]);
  return out.length > 1 ? out : null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function seatsLookup(bookings: Map<string, { passengerCount: number }>) {
  return (id: string) => bookings.get(id)?.passengerCount;
}

/**
 * The plan as this caller may see it: personal points only with active routing consent and inside the caller's
 * branches (4 decimals unless whole-company), another branch's passenger anonymised (no booking / profile id), a
 * route's geometry only when none of its stops is hidden. Returns the profile ids whose points were shown (L1 audit).
 */
export function toPlanDetail(p: PlanRow, view: PlanPointView): { dto: RoutePlanDetailDto; shown: string[]; named: string[] } {
  const locks = routePlanLocks(p.options);
  const decimals = view.precise ? 6 : 4;
  const seats = seatsLookup(view.bookings);
  const shown = new Set<string>();
  /** Profiles whose (short) name this read returned (ACCESS audit, with `shown`). */
  const named = new Set<string>();
  const hiddenOn = new Set<string>();
  const stops: RoutePlanStopViewDto[] = [...p.stops]
    .sort((a, b) => (a.assignmentId ?? '~').localeCompare(b.assignmentId ?? '~') || (a.sequence ?? 1e9) - (b.sequence ?? 1e9) || a.ref.localeCompare(b.ref))
    .map((s) => {
      const owner = planStopOwner(s, view.bookings);
      const hidden = hiddenReason(owner, view);
      if (hidden && s.assignmentId) hiddenOn.add(s.assignmentId);
      if (owner && !hidden) shown.add(owner);
      const b = s.bookingId ? view.bookings.get(s.bookingId) : undefined;
      const kind = s.stopKind === 'PICKUP' || s.stopKind === 'DROP' ? s.stopKind : null;
      const ownLabel = b && kind ? (kind === 'PICKUP' ? b.pickupLabel : b.dropLabel) : null;
      const pt = (v: number | null) => (v === null ? null : hidden ? null : owner ? round(v, decimals) : v);
      const anonymous = hidden === 'OUT_OF_SCOPE' || outOfScope(s, view);
      // "First L." as on the driver manifest, only for callers that may see names and never for an anonymised stop.
      const passengerName = view.showNames && !anonymous && b?.displayName ? driverDisplayName(b.displayName) : null;
      if (passengerName && b) named.add(b.profileId);
      return {
        id: s.id,
        ref: anonymous ? `stop-${s.id.slice(0, 8)}` : s.ref,
        name: !owner ? s.name : hidden ? (kind ? PERSONAL_STOP_NAME[kind] : 'Stop') : (ownLabel ?? (kind ? PERSONAL_STOP_NAME[kind] : s.name)),
        lat: pt(s.lat),
        lng: pt(s.lng),
        snappedLat: pt(s.snappedLat),
        snappedLng: pt(s.snappedLng),
        snapDistanceM: hidden ? null : s.snapDistanceM,
        demand: s.demand,
        serviceS: s.serviceS,
        timeWindows: windowsOf(s.timeWindows),
        assignmentId: s.assignmentId,
        sequence: s.sequence,
        etaS: s.etaS,
        unassignedReason: s.unassignedReason,
        stopKind: kind,
        bookingId: anonymous ? null : s.bookingId,
        profileId: anonymous ? null : (s.profileId ?? null),
        poiId: s.poiId,
        customerCompanyId: s.customerCompanyId,
        personal: !!owner,
        pointHidden: hidden,
        pinned: locks.pinnedStopIds.has(s.id),
        plannedArrival: p.planStartAt && s.etaS !== null ? new Date(p.planStartAt.getTime() + s.etaS * 1000).toISOString() : null,
        seats: s.bookingId ? (s.stopKind === 'PICKUP' ? (seats(s.bookingId) ?? 1) : 0) : s.demand,
        passengerName,
      };
    });
  const rule = p.stops.map(toRuleStop);
  const published = new Map(p.transportTrips.filter((t) => t.routeAssignmentId).map((t) => [t.routeAssignmentId!, t]));
  const assignments: RoutePlanAssignmentViewDto[] = [...p.assignments]
    .sort((a, b) => a.seq - b.seq)
    .map((a) => {
      const list = routeStops(rule, a.id);
      const line = hiddenOn.has(a.id) ? null : lineOf(a.geometry);
      const geometry: LineStringGeometry | null = line ? { type: 'LineString', coordinates: view.precise ? line : line.map(([x, y]) => [round(x, decimals), round(y, decimals)] as [number, number]) } : null;
      const trip = published.get(a.id);
      const vehicle = a.objectId ? view.names.vehicles.get(a.objectId) : undefined;
      return {
        id: a.id,
        seq: a.seq,
        vehicleLabel: a.vehicleLabel,
        objectId: a.objectId,
        driverId: a.driverId,
        capacity: a.capacity,
        distanceM: a.distanceM,
        durationS: a.durationS,
        adjustedDurationS: a.adjustedDurationS,
        startS: a.startS,
        endS: a.endS,
        geometry,
        eta: (a.etaModel as EtaModel | null) ?? null,
        transportTripId: trip?.id ?? null,
        plannedTripId: trip?.plannedTripId ?? null,
        locked: locks.lockedAssignmentIds.has(a.id),
        vehicleName: vehicle?.name ?? null,
        plateNumber: vehicle?.plateNumber ?? null,
        driverName: a.driverId ? (view.names.drivers.get(a.driverId) ?? null) : null,
        passengers: new Set(list.flatMap((s) => (s.bookingId ? [s.bookingId] : []))).size,
        seats: list.reduce((n, s) => n + (s.bookingId ? (s.stopKind === 'PICKUP' ? (seats(s.bookingId) ?? 1) : 0) : s.demand), 0),
        violations: routeViolations(list, a.capacity, seats),
      };
    });
  const dto: RoutePlanDetailDto = {
    id: p.id,
    name: p.name,
    planDate: p.planDate.toISOString().slice(0, 10),
    planStartAt: iso(p.planStartAt),
    status: p.status as RoutePlanStatus,
    profile: p.profile as RoutingProfile,
    branchId: p.branchId,
    graphVersion: p.graphVersion,
    depot: (p.depot as LatLng | null) ?? null,
    direction: (p.direction as TransportDirection | null) ?? null,
    shiftId: p.shiftId,
    sitePoiId: p.sitePoiId,
    version: p.version,
    publishedAt: iso(p.publishedAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    stops,
    assignments,
    precise: view.precise,
    editable: (ROUTE_PLAN_EDITABLE as readonly string[]).includes(p.status),
    violations: assignments.flatMap((a) => a.violations),
    unassigned: p.stops.filter((s) => !s.assignmentId).length,
    // T2-L4: the weights the last optimisation ran with (options.weights), for re-optimise to prefill; never invented.
    weights: weightsOf((p.options as { weights?: unknown } | null)?.weights) ?? null,
  };
  return { dto, shown: [...shown], named: [...named] };
}

export function toPlanSummary(p: Pick<PlanRow, 'id' | 'name' | 'planDate' | 'status' | 'direction' | 'version' | 'updatedAt'> & { stops: { assignmentId: string | null }[]; assignments: unknown[] }): RoutePlanSummaryDto {
  return {
    id: p.id,
    name: p.name,
    planDate: p.planDate.toISOString().slice(0, 10),
    status: p.status as RoutePlanStatus,
    direction: (p.direction as TransportDirection | null) ?? null,
    stops: p.stops.length,
    assignments: p.assignments.length,
    unassigned: p.stops.filter((s) => !s.assignmentId).length,
    version: p.version,
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** RoutePlanVersion.snapshot: ids, sequences and times only (no coordinates, no names of stops). */
export function planSnapshot(status: RoutePlanStatus, assignments: Pick<AssignmentRow, 'id' | 'vehicleLabel' | 'objectId' | 'driverId' | 'seq'>[], stops: Pick<RuleStop, 'id' | 'ref' | 'assignmentId' | 'sequence' | 'etaS'>[] & { unassignedReason?: string | null }[]): RoutePlanVersionSnapshot {
  return {
    status,
    assignments: [...assignments]
      .sort((a, b) => a.seq - b.seq)
      .map((a) => ({ id: a.id, vehicleLabel: a.vehicleLabel, objectId: a.objectId, driverId: a.driverId, stopIds: routeStops(stops as RuleStop[], a.id).map((s) => s.id) })),
    stops: stops.map((s) => ({ id: s.id, ref: s.ref, assignmentId: s.assignmentId, sequence: s.sequence, etaS: s.etaS, unassignedReason: (s as { unassignedReason?: string | null }).unassignedReason ?? null })),
  };
}
