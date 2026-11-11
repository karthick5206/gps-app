/** Route → planned-trip snapshot (SPEC §4.2). Pure: no I/O. */

export interface SnapshotRouteStop {
  seq: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  offsetMin: number;
  waitMin: number;
}

export interface SnapshotRoute {
  name: string;
  corridorM: number;
  /** [[lng, lat], ...] or null. */
  path: unknown;
  stops: SnapshotRouteStop[];
}

export interface SnapshotStop {
  seq: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  plannedArrival: Date;
  plannedDeparture: Date;
}

export interface TripSnapshot {
  routeName: string;
  corridorM: number;
  path: [number, number][] | null;
  plannedStart: Date;
  plannedEnd: Date;
  stops: SnapshotStop[];
}

const MIN = 60_000;

/** A stored path only if it is a usable [[lng, lat], ...] line; anything else is null (straight lines). */
export function cleanPath(path: unknown): [number, number][] | null {
  if (!Array.isArray(path) || path.length < 2) return null;
  const ok = path.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return ok ? (path.map((p) => [p[0], p[1]]) as [number, number][]) : null;
}

/**
 * Copies the route into a trip planned to start at `plannedStartMs`: name, corridor, path and one stop per route stop
 * with plannedArrival = start + offset, plannedDeparture = arrival + wait. plannedEnd = last stop's planned arrival.
 */
export function buildTripSnapshot(route: SnapshotRoute, plannedStartMs: number): TripSnapshot {
  if (route.stops.length < 2) throw new Error('A route needs at least 2 stops');
  const stops = [...route.stops]
    .sort((a, b) => a.seq - b.seq)
    .map((s, i) => {
      const arrival = plannedStartMs + s.offsetMin * MIN;
      return {
        seq: i,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        radiusM: s.radiusM,
        plannedArrival: new Date(arrival),
        plannedDeparture: new Date(arrival + s.waitMin * MIN),
      };
    });
  return {
    routeName: route.name,
    corridorM: route.corridorM,
    path: cleanPath(route.path),
    plannedStart: new Date(plannedStartMs),
    plannedEnd: stops[stops.length - 1].plannedArrival,
    stops,
  };
}

/** New planned times when a SCHEDULED trip's start moves: every stop shifts by the same amount. */
export function shiftTripTimes<T extends { plannedArrival: Date; plannedDeparture: Date }>(
  trip: { plannedStart: Date; plannedEnd: Date },
  stops: T[],
  newStartMs: number,
): { plannedStart: Date; plannedEnd: Date; stops: (T & { plannedArrival: Date; plannedDeparture: Date })[] } {
  const delta = newStartMs - trip.plannedStart.getTime();
  return {
    plannedStart: new Date(newStartMs),
    plannedEnd: new Date(trip.plannedEnd.getTime() + delta),
    stops: stops.map((s) => ({
      ...s,
      plannedArrival: new Date(s.plannedArrival.getTime() + delta),
      plannedDeparture: new Date(s.plannedDeparture.getTime() + delta),
    })),
  };
}
