import { Prisma } from '@prisma/client';
import type { ChangeSetChangeView, ChangeSetStopView, DispatchChangeOp, DispatchChangeSetInput, GeoPoint, TransportBookingStatus, TransportChangeSetDetailDto, TransportChangeSetSummaryDto, TransportPassengerRef } from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { driverScopeWhere } from '../../drivers/drivers.service';
import { PrismaService } from '../../prisma/prisma.service';
import { activeRoutingConsents } from '../people/people.service';
import { parseChangeOps } from './change-ops';
import { bookingReadWhere, inProfileBranch, notFound, round, tripReadWhere } from './e3-common';
import { preciseFor } from './e3-mapping';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const near = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lng - b.lng) < 1e-4;

/**
 * GET /api/transport/dispatch/change-sets/:id (E3 gap 2): a saved change set with the names a dispatcher needs to decide
 * whether to publish it. Dispatcher-scoped: own company, and every vehicle, driver, trip and booking it names must be
 * visible to the caller (branch-scoped dispatchers), else 404 like any foreign row. Stop points follow the E2 M3 rules:
 * sites exact; personal points rounded for branch scope and withheld when a passenger of the draft has no active
 * routing consent at that point.
 */
export async function changeSetDetail(
  prisma: PrismaService,
  ctx: AuthContext,
  id: string,
  summary: (r: Prisma.TransportChangeSetGetPayload<object>) => TransportChangeSetSummaryDto,
  scopedObjectIds: string[] | null,
): Promise<TransportChangeSetDetailDto> {
  const row = await prisma.transportChangeSet.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!row) throw notFound();
  const base: TransportChangeSetDetailDto = { ...summary(row), reason: null, expectedVersions: {}, changes: [], issues: [] };
  if (row.status !== 'DRAFT' || !row.draft) return base;
  const draft = row.draft as unknown as DispatchChangeSetInput;
  const issues: string[] = [];
  let ops: DispatchChangeOp[] = [];
  try {
    ops = parseChangeOps((draft.changes ?? []) as unknown[]);
  } catch (e) {
    issues.push(`The saved changes are no longer valid: ${(e as Error).message}`);
  }

  const objectIds = [...new Set(ops.flatMap((o) => (o.op === 'CREATE_TRIP' || o.op === 'REASSIGN_VEHICLE' ? [o.objectId] : [])))];
  const driverIds = [...new Set(ops.flatMap((o) => (o.op === 'CREATE_TRIP' && o.driverId ? [o.driverId] : o.op === 'REASSIGN_DRIVER' && o.driverId ? [o.driverId] : [])))];
  const bookingIds = [...new Set(ops.flatMap((o) => (o.op === 'ADD_PASSENGER' || o.op === 'ADD_STOP' ? [o.bookingId] : [])))];
  const seatIds = [...new Set(ops.flatMap((o) => (o.op === 'REMOVE_PASSENGER' ? [o.passengerTripId] : [])))];

  const [vehicles, drivers, bookings, seats] = await Promise.all([
    objectIds.length ? prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds }, companyId: ctx.companyId }] }, select: { id: true, name: true } }) : [],
    driverIds.length ? prisma.driver.findMany({ where: { AND: [driverScopeWhere(ctx), { id: { in: driverIds } }] }, select: { id: true, name: true } }) : [],
    bookingIds.length
      ? prisma.transportBooking.findMany({
          where: { AND: [bookingReadWhere(ctx), { id: { in: bookingIds }, customerCompanyId: ctx.companyId }] },
          select: { id: true, status: true, profileId: true, pickupLat: true, pickupLng: true, pickupPoiId: true, dropLat: true, dropLng: true, dropPoiId: true, profile: { select: { id: true, displayName: true, employeeCode: true, branchId: true } } },
        })
      : [],
    seatIds.length ? prisma.transportTripPassenger.findMany({ where: { id: { in: seatIds }, providerCompanyId: ctx.companyId }, select: { id: true, tripId: true, booking: { select: { profile: { select: { id: true, displayName: true, employeeCode: true, branchId: true } } } } } }) : [],
  ]);
  // Dispatcher scope: anything the caller cannot see makes the whole change set invisible (no partial disclosure). The
  // branch checks are repeated in code (not only in the where) so the rule never depends on a relation filter.
  const inScope = (objectId: string | null | undefined) => scopedObjectIds === null || !objectId || scopedObjectIds.includes(objectId);
  if (vehicles.length !== objectIds.length || drivers.length !== driverIds.length || bookings.length !== bookingIds.length || seats.length !== seatIds.length) throw notFound();
  if (!objectIds.every(inScope) || !bookings.every((b) => inProfileBranch(ctx, b.profile.branchId)) || !seats.every((s) => inProfileBranch(ctx, s.booking.profile.branchId))) throw notFound();
  const tripIds = [...new Set([...ops.flatMap((o) => ('tripId' in o && UUID.test(o.tripId) ? [o.tripId] : [])), ...seats.map((s) => s.tripId)])];
  const trips = tripIds.length
    ? await prisma.transportTrip.findMany({ where: { AND: [tripReadWhere(ctx, scopedObjectIds), { id: { in: tripIds } }] }, include: { plannedTrip: { select: { routeName: true, objectId: true, status: true } } } })
    : [];
  if (trips.length !== tripIds.length || !trips.every((t) => t.providerCompanyId === ctx.companyId && inScope(t.plannedTrip?.objectId))) throw notFound();
  const tripVehicleIds = [...new Set(trips.flatMap((t) => (t.plannedTrip ? [t.plannedTrip.objectId] : [])))].filter((x) => !objectIds.includes(x));
  const tripVehicles = tripVehicleIds.length ? await prisma.trackedObject.findMany({ where: { id: { in: tripVehicleIds } }, select: { id: true, name: true } }) : [];

  const vehicleName = new Map([...vehicles, ...tripVehicles].map((v) => [v.id, v.name]));
  const driverName = new Map(drivers.map((d) => [d.id, d.name]));
  const booking = new Map(bookings.map((b) => [b.id, b]));
  const consents = await activeRoutingConsents(prisma, bookings.map((b) => b.profileId));
  const ref = (p: { id: string; displayName: string; employeeCode: string } | undefined): TransportPassengerRef | null => (p ? { id: p.id, displayName: p.displayName, employeeCode: p.employeeCode } : null);

  const tempLabel = new Map(ops.flatMap((o) => (o.op === 'CREATE_TRIP' ? [[o.tempId, `${vehicleName.get(o.objectId) ?? 'Vehicle'} · new trip`] as const] : [])));
  const tripLabel = (tid: string) => {
    if (tempLabel.has(tid)) return tempLabel.get(tid)!;
    const t = trips.find((x) => x.id === tid);
    return t?.plannedTrip ? [vehicleName.get(t.plannedTrip.objectId), t.plannedTrip.routeName].filter(Boolean).join(' · ') : 'Trip';
  };

  // Personal points of passengers without an active consent: a stop at such a point is shown without coordinates.
  const withheld: { lat: number; lng: number }[] = [];
  for (const b of bookings) {
    if (consents.has(b.profileId)) continue;
    if (b.pickupLat !== null && b.pickupLng !== null && !b.pickupPoiId) withheld.push({ lat: b.pickupLat, lng: b.pickupLng });
    if (b.dropLat !== null && b.dropLng !== null && !b.dropPoiId) withheld.push({ lat: b.dropLat, lng: b.dropLng });
  }
  const precise = preciseFor(ctx, ctx.companyId);
  const stopView = (s: { seq: number; point: GeoPoint; plannedArrival: string }): ChangeSetStopView => {
    const p = s.point;
    if (p.poiId) return { seq: s.seq, label: p.label ?? null, point: p, plannedArrival: s.plannedArrival };
    if (withheld.some((w) => near(w, p))) return { seq: s.seq, label: p.label ?? null, point: null, plannedArrival: s.plannedArrival };
    const d = precise ? 6 : 4;
    return { seq: s.seq, label: p.label ?? null, point: { lat: round(p.lat, d), lng: round(p.lng, d), label: p.label ?? null, poiId: null }, plannedArrival: s.plannedArrival };
  };

  const changes: ChangeSetChangeView[] = ops.map((o): ChangeSetChangeView => {
    switch (o.op) {
      case 'CREATE_TRIP':
        return { op: o.op, tempId: o.tempId, objectId: o.objectId, vehicleName: vehicleName.get(o.objectId) ?? null, driverId: o.driverId ?? null, driverName: o.driverId ? (driverName.get(o.driverId) ?? null) : null, plannedStart: o.plannedStart, routeId: o.routeId ?? null, name: o.name ?? null, stops: (o.stops ?? []).map(stopView) };
      case 'ADD_PASSENGER': {
        const b = booking.get(o.bookingId);
        return { op: o.op, tripId: o.tripId, tripLabel: tripLabel(o.tripId), bookingId: o.bookingId, passenger: ref(b?.profile), bookingStatus: (b?.status as TransportBookingStatus | undefined) ?? null, pickupSeq: o.pickupSeq, dropSeq: o.dropSeq };
      }
      case 'ADD_STOP':
        return { op: o.op, tripId: o.tripId, tripLabel: tripLabel(o.tripId), bookingId: o.bookingId, passenger: ref(booking.get(o.bookingId)?.profile), end: o.end, afterSeq: o.afterSeq, plannedArrival: o.plannedArrival ?? null };
      case 'REMOVE_PASSENGER': {
        const s = seats.find((x) => x.id === o.passengerTripId);
        return { op: o.op, passengerTripId: o.passengerTripId, tripId: s?.tripId ?? null, tripLabel: s ? tripLabel(s.tripId) : 'Trip', passenger: ref(s?.booking.profile), reason: o.reason };
      }
      case 'REASSIGN_VEHICLE':
        return { op: o.op, tripId: o.tripId, tripLabel: tripLabel(o.tripId), objectId: o.objectId, vehicleName: vehicleName.get(o.objectId) ?? null };
      case 'REASSIGN_DRIVER':
        return { op: o.op, tripId: o.tripId, tripLabel: tripLabel(o.tripId), driverId: o.driverId, driverName: o.driverId ? (driverName.get(o.driverId) ?? null) : null };
    }
  });

  // What publishing would refuse as things stand (it is validated again in full on publish).
  for (const b of bookings) {
    const who = b.profile.displayName;
    if (b.status !== 'PENDING_ASSIGNMENT') issues.push(`${who}: the booking is ${b.status.toLowerCase().replace('_', ' ')}, no longer waiting for a seat`);
    if (!consents.has(b.profileId)) issues.push(`${who}: no active routing consent`);
  }
  const expected = draft.expectedVersions ?? {};
  for (const t of trips) {
    if (expected[t.id] !== undefined && expected[t.id] !== t.version) issues.push(`${tripLabel(t.id)}: changed since the draft was saved`);
    if (t.plannedTrip && t.plannedTrip.status !== 'SCHEDULED') issues.push(`${tripLabel(t.id)}: already ${t.plannedTrip.status.toLowerCase().replace('_', ' ')}`);
  }
  return { ...base, reason: draft.reason ?? null, expectedVersions: expected, changes, issues };
}
