/**
 * Pooling C2 (doc 20 §3.6): an AREA plan's vehicle route holds several trips; RoutePlanStop.tripIndex marks where the
 * load returns to 0. At publish each (route, tripIndex) becomes its own CREATE_TRIP through the normal E3 publish. Pure.
 */
export interface SplitStop {
  id: string;
  sequence: number | null;
  tripIndex?: number | null;
  bookingId: string | null;
  stopKind: string | null;
}

export interface RouteTrip<T> {
  tripIndex: number;
  stops: T[];
}

/**
 * Splits one route's stops (already in route order) into trips by tripIndex. Refused (problem text) when trip indexes
 * go back along the route, or a booking's pickup and drop are on different trips, or its drop comes before its pickup.
 */
export function splitRouteTrips<T extends SplitStop>(stops: readonly T[]): { trips: RouteTrip<T>[]; problem: string | null } {
  const trips: RouteTrip<T>[] = [];
  for (const s of stops) {
    const k = s.tripIndex ?? 0;
    const last = trips[trips.length - 1];
    if (last && k < last.tripIndex) return { trips: [], problem: 'The trips of the route are out of order; re-optimise the plan' };
    if (last && last.tripIndex === k) last.stops.push(s);
    else trips.push({ tripIndex: k, stops: [s] });
  }
  const tripOf = new Map<string, { pickup?: number; drop?: number; pickupPos?: number; dropPos?: number }>();
  trips.forEach((t, ti) =>
    t.stops.forEach((s, pos) => {
      if (!s.bookingId) return;
      const e = tripOf.get(s.bookingId) ?? {};
      if (s.stopKind === 'DROP') Object.assign(e, { drop: ti, dropPos: pos });
      else Object.assign(e, { pickup: ti, pickupPos: pos });
      tripOf.set(s.bookingId, e);
    }),
  );
  for (const [bookingId, e] of tripOf) {
    if (e.pickup !== undefined && e.drop !== undefined && e.pickup !== e.drop) return { trips: [], problem: `The pickup and drop of booking ${bookingId} are on different trips of the route` };
    if (e.pickup !== undefined && e.drop !== undefined && (e.pickupPos as number) > (e.dropPos as number)) return { trips: [], problem: `The drop of booking ${bookingId} comes before its pickup` };
  }
  return { trips, problem: null };
}

/** Planned span of each trip of a route (epoch ms), from its stops' ETAs (seconds after planStartAt). */
export function tripSpans(planStartMs: number, trips: readonly RouteTrip<{ etaS: number | null; serviceS?: number }>[]): { tripIndex: number; start: number; end: number }[] {
  return trips.flatMap((t) => {
    const etas = t.stops.map((s) => s.etaS).filter((x): x is number => x !== null);
    if (!etas.length) return [];
    const last = t.stops[t.stops.length - 1];
    return [{ tripIndex: t.tripIndex, start: planStartMs + Math.min(...etas) * 1000, end: planStartMs + (Math.max(...etas) + (last.serviceS ?? 0)) * 1000 }];
  });
}
