import { isRoutingStrategy, type RoutePlanExcludedCount, type RoutePlanMetricsDto, type RoutePlanVehicleOccupancy, type TransportDirection } from '@veetracer/shared';
import { routeStops, seatsOf, windowsOf } from './plan-rules';

/**
 * E4 WP-A compare metrics, computed from the stored plan rows only (pure; definitions in shared
 * ROUTE_PLAN_METRIC_DEFINITIONS). Counts, sums and vehicle labels only: no stop, point or passenger name.
 */

export interface MetricsStop {
  id: string;
  ref: string;
  assignmentId: string | null;
  sequence: number | null;
  etaS: number | null;
  stopKind: string | null;
  bookingId: string | null;
  demand: number;
  timeWindows: unknown;
  unassignedReason: string | null;
}

export interface MetricsInput {
  direction: TransportDirection | null;
  options: unknown;
  assignments: { id: string; vehicleLabel: string; capacity: number | null; distanceM: number | null; durationS: number | null }[];
  stops: MetricsStop[];
}

export type ExtendedMetrics = Required<Pick<RoutePlanMetricsDto, 'vehiclesUsed' | 'passengersAssigned' | 'bookingsAssigned' | 'totalDistanceM' | 'totalTravelS' | 'maxRideS' | 'avgRideS' | 'occupancy' | 'avgOccupancy' | 'deadlineCompliance' | 'excluded' | 'excludedBookings' | 'strategy' | 'alternativeOf'>>;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function extendedPlanMetrics(p: MetricsInput, passengerCount: (bookingId: string) => number | undefined): ExtendedMetrics {
  const kind = (s: MetricsStop) => (s.stopKind === 'PICKUP' || s.stopKind === 'DROP' ? s.stopKind : null);
  // The passenger's own end (IN: pickup, OUT: drop; no direction: pickup) and the site end (IN: drop, OUT: pickup).
  const homeKind = p.direction === 'OUT' ? 'DROP' : 'PICKUP';
  const siteKind = p.direction === 'OUT' ? 'PICKUP' : 'DROP';
  const byBooking = new Map<string, { pickup?: MetricsStop; drop?: MetricsStop }>();
  for (const s of p.stops) {
    const k = kind(s);
    if (!s.bookingId || !k) continue;
    const e = byBooking.get(s.bookingId) ?? {};
    if (k === 'PICKUP') e.pickup = s;
    else e.drop = s;
    byBooking.set(s.bookingId, e);
  }
  const seatsOfBooking = (b: string, e: { pickup?: MetricsStop }) => passengerCount(b) ?? Math.max(1, e.pickup?.demand ?? 1);

  const used = p.assignments.filter((a) => p.stops.some((s) => s.assignmentId === a.id));
  const sum = (k: 'distanceM' | 'durationS') => (used.some((a) => a[k] === null) ? null : used.reduce((n, a) => n + (a[k] as number), 0));

  let passengersAssigned = 0;
  let bookingsAssigned = 0;
  const rides: number[] = [];
  let inside = 0;
  let total = 0;
  const excluded = new Map<string, number>();
  for (const [b, e] of byBooking) {
    const home = homeKind === 'PICKUP' ? e.pickup : e.drop;
    const site = siteKind === 'PICKUP' ? e.pickup : e.drop;
    if (!home?.assignmentId) {
      const reason = home?.unassignedReason ?? site?.unassignedReason ?? 'not_optimised';
      excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
      continue;
    }
    bookingsAssigned++;
    passengersAssigned += seatsOfBooking(b, e);
    if (e.pickup && e.drop && e.pickup.assignmentId === e.drop.assignmentId && e.pickup.etaS !== null && e.drop.etaS !== null) rides.push(e.drop.etaS - e.pickup.etaS);
    const win = site ? windowsOf(site.timeWindows) : null;
    if (site && win && site.etaS !== null) {
      total++;
      if (win.some(([lo, hi]) => site.etaS! >= lo && site.etaS! <= hi)) inside++;
    }
  }

  const occupancy: RoutePlanVehicleOccupancy[] = used.map((a) => {
    const passengers = routeStops(p.stops, a.id).reduce((n, s) => n + seatsOf({ stopKind: kind(s), bookingId: s.bookingId, demand: s.demand }, passengerCount), 0);
    return { assignmentId: a.id, vehicleLabel: a.vehicleLabel, passengers, seats: a.capacity, ratio: a.capacity ? round3(passengers / a.capacity) : null };
  });
  const ratios = occupancy.map((o) => o.ratio).filter((r): r is number => r !== null);
  const o = (p.options && typeof p.options === 'object' && !Array.isArray(p.options) ? p.options : {}) as Record<string, unknown>;
  const excludedList: RoutePlanExcludedCount[] = [...excluded].map(([reason, bookings]) => ({ reason, bookings })).sort((a, b) => b.bookings - a.bookings || a.reason.localeCompare(b.reason));
  return {
    vehiclesUsed: used.length,
    passengersAssigned,
    bookingsAssigned,
    totalDistanceM: sum('distanceM'),
    totalTravelS: sum('durationS'),
    maxRideS: rides.length ? Math.max(...rides) : null,
    avgRideS: rides.length ? Math.round(rides.reduce((n, r) => n + r, 0) / rides.length) : null,
    occupancy,
    avgOccupancy: ratios.length ? round3(ratios.reduce((n, r) => n + r, 0) / ratios.length) : null,
    deadlineCompliance: { inside, total, ratio: total ? round3(inside / total) : null },
    excluded: excludedList,
    excludedBookings: excludedList.reduce((n, e) => n + e.bookings, 0),
    strategy: isRoutingStrategy(o.strategy) && o.weightsSource !== 'weights' ? o.strategy : null,
    alternativeOf: typeof o.alternativeOf === 'string' ? o.alternativeOf : null,
  };
}
