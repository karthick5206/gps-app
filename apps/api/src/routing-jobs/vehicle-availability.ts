import type { Prisma, PrismaClient } from '@prisma/client';
import type { OptimizeUnusableVehicle } from '@veetracer/shared';

/**
 * E4 WP-A: vehicle / driver availability for the optimiser. A plan vehicle (RouteAssignment.objectId) or its driver may
 * already be planned on another trip that day (PlannedTrip of any origin, which every E3 TransportTrip has as its
 * header). The optimiser gets the vehicle's free time as `timeWindow` (seconds after planStartAt), so it never plans a
 * route the publish check would refuse (VEHICLE_BUSY / DRIVER_BUSY); a vehicle with no free time that can serve the
 * plan's site window is left out of the solve and reported in the job result (`unusableVehicles`).
 *
 * The publish-time check (DispatchService.assertFree) stays the binding one; this is the early, solver-side view.
 */

/** PlannedTrip statuses that occupy a vehicle / driver (as DispatchService.assertFree). */
export const BUSY_TRIP_STATUSES = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'] as const;

/** Busy interval [start, end) in plan seconds. */
export type Interval = [number, number];

/** One vehicle's availability: [from, to] (to null = open until the horizon), or why it cannot be used. */
export type Availability = { window: [number, number | null] } | { unusable: 'VEHICLE_BUSY' | 'DRIVER_BUSY' };

/** Free intervals of [0, ∞) after removing `busy` (sorted, merged). The last one is open (end null). */
export function freeIntervals(busy: Interval[]): [number, number | null][] {
  const sorted = busy.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number | null][] = [];
  let t = 0;
  for (const [a, b] of sorted) {
    if (b <= t) continue;
    if (a > t) out.push([t, a]);
    t = Math.max(t, b);
  }
  out.push([t, null]);
  return out;
}

/**
 * The free interval the vehicle should use, given the plan's site span [lo, hi] (IN: allowed site arrivals; OUT: allowed
 * site departures; generic: none):
 * - IN: an interval that reaches into the span (end ≥ lo, start ≤ hi), with the most time before the latest arrival;
 * - OUT: an interval that starts by the span's end and ends after its start, with the most time after the departure;
 * - generic: the longest interval.
 * null when none qualifies (the vehicle is busy across the whole usable time). No busy interval → [0, null].
 */
export function chooseWindow(busy: Interval[], direction: 'IN' | 'OUT' | null, span: Interval | null): [number, number | null] | null {
  const free = freeIntervals(busy);
  const INF = Number.MAX_SAFE_INTEGER;
  const end = (f: [number, number | null]) => f[1] ?? INF;
  let best: [number, number | null] | null = null;
  let score = -1;
  for (const f of free) {
    let s: number;
    if (span && direction === 'IN') {
      if (end(f) < span[0] || f[0] > span[1]) continue;
      s = Math.min(end(f), span[1]) - f[0];
    } else if (span && direction === 'OUT') {
      if (f[0] > span[1] || end(f) < span[0]) continue;
      s = end(f) - Math.max(f[0], span[0]);
    } else {
      s = end(f) - f[0];
    }
    if (s > score) {
      score = s;
      best = f;
    }
  }
  return best;
}

export interface AvailabilityVehicle {
  assignmentId: string;
  objectId: string | null;
  driverId: string | null;
}

/** Busy trips of the vehicles / drivers around the plan (ids and times only). */
export interface BusyTrip {
  objectId: string;
  driverId: string | null;
  plannedStart: Date;
  plannedEnd: Date;
}

/**
 * Pure part: each vehicle's availability from the busy trips. A vehicle without busy trips (or without planStartAt to
 * relate times to) gets no entry (unchanged: whole horizon). Busy vehicle time and busy driver time both count;
 * `unusable` names the vehicle when its own trips leave no usable window, the driver otherwise.
 */
export function availabilityOf(vehicles: AvailabilityVehicle[], trips: BusyTrip[], plan: { planStartMs: number | null; direction: 'IN' | 'OUT' | null; siteSpan: Interval | null }): Map<string, Availability> {
  const out = new Map<string, Availability>();
  if (plan.planStartMs === null) return out;
  const rel = (d: Date) => Math.round((d.getTime() - (plan.planStartMs as number)) / 1000);
  for (const v of vehicles) {
    const own = trips.filter((t) => v.objectId && t.objectId === v.objectId).map((t) => [rel(t.plannedStart), rel(t.plannedEnd)] as Interval);
    const driver = trips.filter((t) => v.driverId && t.driverId === v.driverId).map((t) => [rel(t.plannedStart), rel(t.plannedEnd)] as Interval);
    if (!own.length && !driver.length) continue;
    const w = chooseWindow([...own, ...driver], plan.direction, plan.siteSpan);
    if (w) {
      out.set(v.assignmentId, { window: [Math.max(0, w[0]), w[1]] });
      continue;
    }
    out.set(v.assignmentId, { unusable: chooseWindow(own, plan.direction, plan.siteSpan) ? 'DRIVER_BUSY' : 'VEHICLE_BUSY' });
  }
  return out;
}

/** The plan's site span from its site stops' windows (union), or null. */
export function siteSpanOf(siteWindows: ([number, number][] | null)[]): Interval | null {
  const ws = siteWindows.flatMap((w) => w ?? []);
  if (!ws.length) return null;
  return [Math.min(...ws.map((w) => w[0])), Math.max(...ws.map((w) => w[1]))];
}

/** How far around planStartAt busy trips are looked for (a plan's times are within its horizon, at most ~36 h). */
const LOOK_BEFORE_MS = 6 * 3_600_000;
const LOOK_AFTER_MS = 48 * 3_600_000;

/**
 * DB part: the active planned trips of the plan's vehicles / drivers around planStartAt (any company: a shared vehicle
 * is physically busy; only times are read), excluding the trips published from this plan's own routes.
 */
export async function loadBusyTrips(db: Pick<PrismaClient | Prisma.TransactionClient, 'plannedTrip'>, vehicles: AvailabilityVehicle[], planStartMs: number | null, ownPlannedTripIds: string[] = []): Promise<BusyTrip[]> {
  if (planStartMs === null) return [];
  const objectIds = [...new Set(vehicles.map((v) => v.objectId).filter((x): x is string => !!x))];
  const driverIds = [...new Set(vehicles.map((v) => v.driverId).filter((x): x is string => !!x))];
  if (!objectIds.length && !driverIds.length) return [];
  const rows = await db.plannedTrip.findMany({
    where: {
      status: { in: [...BUSY_TRIP_STATUSES] },
      plannedStart: { lt: new Date(planStartMs + LOOK_AFTER_MS) },
      plannedEnd: { gt: new Date(planStartMs - LOOK_BEFORE_MS) },
      OR: [...(objectIds.length ? [{ objectId: { in: objectIds } }] : []), ...(driverIds.length ? [{ driverId: { in: driverIds } }] : [])],
      ...(ownPlannedTripIds.length ? { id: { notIn: ownPlannedTripIds } } : {}),
    },
    select: { objectId: true, driverId: true, plannedStart: true, plannedEnd: true },
  });
  return rows;
}

/** Vehicles to keep (with their window) and the ones reported unusable. */
export function applyAvailability<V extends { assignmentId: string }>(vehicles: V[], avail: Map<string, Availability>): { vehicles: (V & { availability?: [number, number | null] })[]; unusable: OptimizeUnusableVehicle[] } {
  const kept: (V & { availability?: [number, number | null] })[] = [];
  const unusable: OptimizeUnusableVehicle[] = [];
  for (const v of vehicles) {
    const a = avail.get(v.assignmentId);
    if (!a) kept.push(v);
    else if ('window' in a) kept.push({ ...v, availability: a.window });
    else unusable.push({ vehicleId: v.assignmentId, reason: a.unusable });
  }
  return { vehicles: kept, unusable };
}
