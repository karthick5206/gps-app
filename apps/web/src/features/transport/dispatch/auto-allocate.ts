/**
 * Quick auto-allocate (pure, `node --test`): proposes new trips on free vehicles for waiting bookings, without a road
 * engine. The result goes into the dispatcher's draft (nothing is published), where it can be moved, reordered or
 * removed before Review & publish. When the road optimiser is available the same button can use it instead.
 *
 * Rules:
 * - Bookings ride together only when they share the shift, the time window and the office end (IN: the drop point,
 *   OUT: the pickup point, within ~100 m): one "batch" per combination.
 * - A group ride (same groupId) stays in one vehicle when any free vehicle can hold it.
 * - As few vehicles as possible: the smallest vehicle that holds the whole batch, else the largest ones first, and the
 *   last vehicle downsized to the smallest that still holds the rest.
 * - Never more seats than the vehicle has; vehicles without seats, busy in the batch's window (any planned trip) or
 *   already used by the draft in that window are not used.
 * - Neighbours share a vehicle: single passengers are swept by their bearing from the office.
 * - Stop order (straight line, approximate): IN picks up the farthest first, OUT drops the nearest first.
 */
import type { GeoPoint, TransportDirection } from '@veetracer/shared';
import type { DraftBooking } from './dispatch-draft';

export interface AllocBooking extends DraftBooking {
  shiftId: string | null;
  groupId: string | null;
}

export interface AllocVehicle {
  objectId: string;
  label: string;
  seats: number | null;
  busy: { plannedStart: string; plannedEnd: string }[];
}

/** A vehicle already used (by the draft or an earlier batch) between these times. */
export interface AllocTaken {
  objectId: string;
  startMs: number;
  endMs: number;
}

export interface AllocTrip {
  vehicle: { objectId: string; label: string; seats: number };
  /** In stop order. */
  bookings: AllocBooking[];
  shiftId: string | null;
}

export type UnplacedReason = 'NO_VEHICLE' | 'NO_POINTS';

export interface AllocResult {
  trips: AllocTrip[];
  unplaced: { booking: AllocBooking; reason: UnplacedReason }[];
}

const round3 = (p: GeoPoint | null) => (p ? `${p.lat.toFixed(3)},${p.lng.toFixed(3)}` : '-');

/** Metres between two points (equirectangular; enough to compare distances in a city). */
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return Math.sqrt(x * x + y * y) * 111_320;
}

function bearing(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const x = (to.lng - from.lng) * Math.cos(((from.lat + to.lat) / 2) * (Math.PI / 180));
  const y = to.lat - from.lat;
  return Math.atan2(y, x);
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/** The passenger's own end (IN pickup, OUT drop) and the office end. */
function ends(b: AllocBooking, direction: TransportDirection): { own: GeoPoint | null; office: GeoPoint | null } {
  return direction === 'IN' ? { own: b.pickup, office: b.drop } : { own: b.drop, office: b.pickup };
}

/** Bookings that may share a vehicle: same shift, window and office end. */
export function batchKey(b: AllocBooking, direction: TransportDirection): string {
  return `${b.shiftId ?? ''}|${b.windowStart}|${b.windowEnd}|${round3(ends(b, direction).office)}`;
}

interface Unit {
  bookings: AllocBooking[];
  seats: number;
  angle: number;
}

/** Choose vehicles for `need` seats: smallest single fit, else largest first and the last one downsized. */
export function chooseVehicles<V extends { seats: number }>(free: V[], need: number): V[] {
  const asc = [...free].sort((a, b) => a.seats - b.seats);
  const single = asc.find((v) => v.seats >= need);
  if (single) return [single];
  const chosen: V[] = [];
  let left = need;
  const pool = [...asc];
  while (left > 0 && pool.length) {
    // The smallest that holds the rest, else the largest.
    const fit = pool.find((v) => v.seats >= left);
    const pick = fit ?? pool[pool.length - 1];
    chosen.push(pick);
    pool.splice(pool.indexOf(pick), 1);
    left -= pick.seats;
  }
  return chosen;
}

// ───────────────────────────── Step 1: Routing (group by location) ─────────────────────────────

export interface RouteGroup {
  id: string;
  /** "Route 1 · NE · ~8 km" */
  label: string;
  bookings: AllocBooking[];
  seats: number;
  shiftId: string | null;
}

const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
const compass = (rad: number) => COMPASS[((Math.round(rad / (Math.PI / 4)) % 8) + 8) % 8];
/** A new route starts when the next home is more than this angle (seen from the office) away from the previous one. */
const ROUTE_GAP_RAD = (35 * Math.PI) / 180;

/**
 * Routing: groups the waiting people into routes by where they live (lat / lng), per shift + window + office. Seen
 * from the office, homes are swept around the compass; a route closes at a big angle gap or at `maxSeats`. A group ride
 * stays in one route. Routes are a proposal the dispatcher can change before allocating vehicles.
 */
export function routeGroups(bookings: AllocBooking[], direction: TransportDirection, maxSeats: number): { routes: RouteGroup[]; unplaced: AllocResult['unplaced'] } {
  const unplaced: AllocResult['unplaced'] = [];
  const batches = new Map<string, AllocBooking[]>();
  for (const b of bookings) {
    const { own, office } = ends(b, direction);
    if (!own || !office) {
      unplaced.push({ booking: b, reason: 'NO_POINTS' });
      continue;
    }
    const k = batchKey(b, direction);
    const list = batches.get(k);
    if (list) list.push(b);
    else batches.set(k, [b]);
  }
  const routes: RouteGroup[] = [];
  const cap = Math.max(1, maxSeats);
  for (const batch of [...batches.values()].sort((a, b) => a[0].windowStart.localeCompare(b[0].windowStart))) {
    const office = ends(batch[0], direction).office!;
    const groups = new Map<string, AllocBooking[]>();
    const units: Unit[] = [];
    for (const b of batch) {
      if (b.groupId) {
        const g = groups.get(b.groupId);
        if (g) g.push(b);
        else groups.set(b.groupId, [b]);
      } else units.push({ bookings: [b], seats: b.seats, angle: bearing(office, ends(b, direction).own!) });
    }
    for (const g of groups.values()) units.push({ bookings: g, seats: g.reduce((s, b) => s + b.seats, 0), angle: bearing(office, ends(g[0], direction).own!) });
    units.sort((a, b) => a.angle - b.angle);
    // Start the sweep after the widest gap, so a route never straddles the gap between the last and first bearing.
    if (units.length > 1) {
      let widest = 0;
      let at = 0;
      for (let i = 0; i < units.length; i++) {
        const next = units[(i + 1) % units.length].angle + (i + 1 === units.length ? 2 * Math.PI : 0);
        if (next - units[i].angle > widest) {
          widest = next - units[i].angle;
          at = (i + 1) % units.length;
        }
      }
      units.push(...units.splice(0, at));
    }
    let cur: Unit[] = [];
    const close = () => {
      if (!cur.length) return;
      const list = cur.flatMap((u) => u.bookings);
      const avgAngle = Math.atan2(cur.reduce((s, u) => s + Math.sin(u.angle), 0), cur.reduce((s, u) => s + Math.cos(u.angle), 0));
      const avgKm = list.reduce((s, b) => s + metres(office, ends(b, direction).own!), 0) / list.length / 1000;
      routes.push({ id: `r${routes.length + 1}`, label: `Route ${routes.length + 1} · ${compass(avgAngle)} · ~${Math.max(1, Math.round(avgKm))} km`, bookings: list, seats: list.reduce((s, b) => s + b.seats, 0), shiftId: batch[0].shiftId });
      cur = [];
    };
    for (const u of units) {
      const seats = cur.reduce((s, x) => s + x.seats, 0);
      const prev = cur.at(-1);
      const gap = prev ? Math.abs(Math.atan2(Math.sin(u.angle - prev.angle), Math.cos(u.angle - prev.angle))) : 0;
      if (cur.length && (seats + u.seats > cap || gap > ROUTE_GAP_RAD)) close();
      cur.push(u);
    }
    close();
  }
  return { routes, unplaced };
}

// ───────────────────────────── Step 2: Allocate vehicles (match capacity) ─────────────────────────────

/**
 * Allocate vehicles: each route gets the smallest free vehicle that holds it; a route bigger than every free vehicle is
 * split over several (largest first). Vehicles busy in the route's window, without seats or already used are skipped.
 */
export function allocateRoutes(routes: RouteGroup[], vehicles: AllocVehicle[], taken: AllocTaken[], direction: TransportDirection): AllocResult {
  const trips: AllocTrip[] = [];
  const unplaced: AllocResult['unplaced'] = [];
  const used: AllocTaken[] = [...taken];
  // Biggest routes first: they need the big vehicles.
  for (const r of [...routes].sort((a, b) => b.seats - a.seats || a.id.localeCompare(b.id))) {
    const office = ends(r.bookings[0], direction).office!;
    const startMs = Math.min(...r.bookings.map((b) => Date.parse(b.windowStart)));
    const endMs = Math.max(...r.bookings.map((b) => Date.parse(b.windowEnd)));
    const free = vehicles
      .filter((v) => v.seats !== null && v.seats > 0)
      .filter((v) => !v.busy.some((x) => overlaps(startMs, endMs, Date.parse(x.plannedStart), Date.parse(x.plannedEnd))))
      .filter((v) => !used.some((x) => x.objectId === v.objectId && overlaps(startMs, endMs, x.startMs, x.endMs)))
      .map((v) => ({ objectId: v.objectId, label: v.label, seats: v.seats as number }));
    const chosen = chooseVehicles(free, r.seats);
    const dist = (b: AllocBooking) => metres(office, ends(b, direction).own!);
    const queue = [...r.bookings].sort((a, b) => (direction === 'IN' ? dist(b) - dist(a) : dist(a) - dist(b)) || a.name.localeCompare(b.name));
    for (const v of chosen) {
      const list: AllocBooking[] = [];
      let left = v.seats;
      for (let i = 0; i < queue.length && left > 0; ) {
        if (queue[i].seats <= left) {
          left -= queue[i].seats;
          list.push(...queue.splice(i, 1));
        } else i++;
      }
      if (!list.length) continue;
      trips.push({ vehicle: v, bookings: list, shiftId: r.shiftId });
      used.push({ objectId: v.objectId, startMs, endMs });
    }
    for (const b of queue) unplaced.push({ booking: b, reason: 'NO_VEHICLE' });
  }
  // Show the trips in route order.
  const order = new Map(routes.flatMap((r, i) => r.bookings.map((b) => [b.id, i] as const)));
  trips.sort((a, b) => (order.get(a.bookings[0].id) ?? 0) - (order.get(b.bookings[0].id) ?? 0));
  return { trips, unplaced };
}

/** Largest seat count of the usable vehicles: the default route size, so one route fits one vehicle. */
export function largestSeats(vehicles: AllocVehicle[]): number {
  return Math.max(0, ...vehicles.map((v) => v.seats ?? 0));
}

/**
 * One-step propose (sweep within each batch, best-fit vehicles). Kept for comparison and tests; the page uses
 * routeGroups → allocateRoutes. `bookings` are the waiting, assignable bookings to place (not yet in the draft);
 * `taken` are vehicle uses already in the draft.
 */
export function autoAllocate(bookings: AllocBooking[], vehicles: AllocVehicle[], taken: AllocTaken[], direction: TransportDirection): AllocResult {
  const unplaced: AllocResult['unplaced'] = [];
  const trips: AllocTrip[] = [];
  const used: AllocTaken[] = [...taken];

  const batches = new Map<string, AllocBooking[]>();
  for (const b of bookings) {
    const { own, office } = ends(b, direction);
    if (!own || !office) {
      unplaced.push({ booking: b, reason: 'NO_POINTS' });
      continue;
    }
    const k = batchKey(b, direction);
    const list = batches.get(k);
    if (list) list.push(b);
    else batches.set(k, [b]);
  }
  const ordered = [...batches.values()].sort((a, b) => a[0].windowStart.localeCompare(b[0].windowStart));

  for (const batch of ordered) {
    const office = ends(batch[0], direction).office!;
    const startMs = Math.min(...batch.map((b) => Date.parse(b.windowStart)));
    const endMs = Math.max(...batch.map((b) => Date.parse(b.windowEnd)));
    const free = vehicles
      .filter((v) => v.seats !== null && v.seats > 0)
      .filter((v) => !v.busy.some((x) => overlaps(startMs, endMs, Date.parse(x.plannedStart), Date.parse(x.plannedEnd))))
      .filter((v) => !used.some((x) => x.objectId === v.objectId && overlaps(startMs, endMs, x.startMs, x.endMs)))
      .map((v) => ({ objectId: v.objectId, label: v.label, seats: v.seats as number }));

    // Units: a group ride as one unit (when some free vehicle can hold it), everyone else alone.
    const maxSeats = Math.max(0, ...free.map((v) => v.seats));
    const groups = new Map<string, AllocBooking[]>();
    const units: Unit[] = [];
    for (const b of batch) {
      if (b.groupId) {
        const g = groups.get(b.groupId);
        if (g) g.push(b);
        else groups.set(b.groupId, [b]);
      } else units.push({ bookings: [b], seats: b.seats, angle: bearing(office, ends(b, direction).own!) });
    }
    for (const g of groups.values()) {
      const seats = g.reduce((s, b) => s + b.seats, 0);
      if (seats <= maxSeats) units.push({ bookings: g, seats, angle: bearing(office, ends(g[0], direction).own!) });
      else for (const b of g) units.push({ bookings: [b], seats: b.seats, angle: bearing(office, ends(b, direction).own!) });
    }

    const need = units.reduce((s, u) => s + u.seats, 0);
    const chosen = chooseVehicles(free, need);
    const loads = chosen.map((v) => ({ vehicle: v, units: [] as Unit[], left: v.seats }));

    // Group rides first, each into the fullest vehicle that still holds it (best fit).
    const big = units.filter((u) => u.bookings.length > 1).sort((a, b) => b.seats - a.seats);
    const singles = units.filter((u) => u.bookings.length === 1).sort((a, b) => a.angle - b.angle);
    const rest: Unit[] = [];
    for (const u of big) {
      const target = loads.filter((l) => l.left >= u.seats).sort((a, b) => a.left - b.left)[0];
      if (target) {
        target.units.push(u);
        target.left -= u.seats;
      } else rest.push(...u.bookings.map((b) => ({ bookings: [b], seats: b.seats, angle: bearing(office, ends(b, direction).own!) })));
    }
    // Sweep: neighbours (by bearing from the office) fill one vehicle after another.
    const queue = [...singles, ...rest];
    for (const l of loads) {
      for (let i = 0; i < queue.length && l.left > 0; ) {
        if (queue[i].seats <= l.left) {
          l.units.push(queue[i]);
          l.left -= queue[i].seats;
          queue.splice(i, 1);
        } else i++;
      }
    }
    for (const u of queue) for (const b of u.bookings) unplaced.push({ booking: b, reason: 'NO_VEHICLE' });

    for (const l of loads) {
      const list = l.units.flatMap((u) => u.bookings);
      if (!list.length) continue;
      // IN: farthest pickup first; OUT: nearest drop first (group members stay next to each other by distance).
      const dist = (b: AllocBooking) => metres(office, ends(b, direction).own!);
      list.sort((a, b) => (direction === 'IN' ? dist(b) - dist(a) : dist(a) - dist(b)) || a.name.localeCompare(b.name));
      trips.push({ vehicle: l.vehicle, bookings: list, shiftId: batch[0].shiftId });
      used.push({ objectId: l.vehicle.objectId, startMs, endMs });
    }
  }
  return { trips, unplaced };
}
