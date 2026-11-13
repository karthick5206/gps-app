/**
 * The dispatcher's change tray (pure, `node --test`): explicit assign / unassign / reassign actions collect into a
 * local draft, which becomes ONE change set (05 §3.4) on publish: draft → review → publish / discard. Builds the
 * door-to-door stops of new trips, the expectedVersions of every existing trip touched, a before / after diff per trip
 * for the review, and the Idempotency-Key reuse rule (same body retried → same key; any change → a new key).
 */
import type { DispatchChangeOp, DispatchChangeSetInput, DispatchStopInput, GeoPoint, TransportDirection } from '@veetracer/shared';

/** What the draft remembers about a queued booking (captured when it is added). */
export interface DraftBooking {
  id: string;
  name: string;
  pickup: GeoPoint | null;
  drop: GeoPoint | null;
  windowStart: string;
  windowEnd: string;
  seats: number;
}

/** A new door-to-door trip on an idle vehicle; its stops are derived from its bookings at publish time. */
export interface DraftNewTrip {
  tempId: string;
  objectId: string;
  label: string;
  seats: number;
  /** Planned start (first stop). */
  startMs: number;
  /** Planned minutes between consecutive stops (not a road estimate). */
  gapMin: number;
  bookingIds: string[];
  shiftId: string | null;
}

/** A new stop at the booking's own point (server ADD_STOP), inserted after the trip's stop `afterSeq` (-1 = first). */
export interface DraftNewStop {
  end: 'PICKUP' | 'DROP';
  afterSeq: number;
}

export interface DraftAdd {
  tripId: string;
  bookingId: string;
  /** Seqs of the trip as published (the change set renumbers them around new stops). */
  pickupSeq: number;
  dropSeq: number;
  /** The pickup (or drop) is not an existing stop: a new one is added for it. */
  newStop?: DraftNewStop | null;
}

export interface DraftRemove {
  passengerTripId: string;
  tripId: string;
  bookingId: string;
  name: string;
  seats: number;
  reason: string;
}

export interface DraftReassign {
  tripId: string;
  kind: 'VEHICLE' | 'DRIVER';
  /** objectId (VEHICLE) or driverId / null (DRIVER). */
  targetId: string | null;
  label: string;
  /** New seat capacity (VEHICLE). */
  seats?: number | null;
}

export interface DispatchDraft {
  serviceDate: string;
  direction: TransportDirection;
  bookings: Record<string, DraftBooking>;
  newTrips: DraftNewTrip[];
  adds: DraftAdd[];
  removes: DraftRemove[];
  reassigns: DraftReassign[];
  /** Version of every existing trip the draft touches, as seen when the change was made. */
  versions: Record<string, number>;
}

/** The trip fields the diff needs (TransportTripSummaryDto subset). */
export interface DraftTripRef {
  id: string;
  name: string;
  vehicleName: string | null;
  version: number;
  occupiedSeats: number;
  seatCapacity: number;
}

export interface StopRef {
  seq: number;
  lat: number;
  lng: number;
}

export const DEFAULT_GAP_MIN = 10;
const MIN = 60_000;

export function emptyDraft(serviceDate: string, direction: TransportDirection): DispatchDraft {
  return { serviceDate, direction, bookings: {}, newTrips: [], adds: [], removes: [], reassigns: [], versions: {} };
}

export function draftChangeCount(d: DispatchDraft): number {
  return d.newTrips.reduce((s, n) => s + 1 + n.bookingIds.length, 0) + d.adds.length + d.removes.length + d.reassigns.length;
}

export function isDraftEmpty(d: DispatchDraft): boolean {
  return draftChangeCount(d) === 0;
}

/** Bookings the draft seats (so the queue can mark them "in draft"). */
export function draftBookingIds(d: DispatchDraft): Set<string> {
  return new Set([...d.adds.map((a) => a.bookingId), ...d.newTrips.flatMap((n) => n.bookingIds)]);
}

function withBookings(d: DispatchDraft, bookings: DraftBooking[]): Record<string, DraftBooking> {
  const out = { ...d.bookings };
  for (const b of bookings) out[b.id] = b;
  return out;
}

function nextTempId(d: DispatchDraft): string {
  let i = d.newTrips.length + 1;
  while (d.newTrips.some((n) => n.tempId === `new-${i}`)) i++;
  return `new-${i}`;
}

// ───────────────────────────── Stops of a new trip ─────────────────────────────

const samePoint = (a: GeoPoint, b: GeoPoint) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;

/**
 * Door-to-door stops of a new trip (IN: every pickup, then the site(s); OUT: the site(s), then every drop). Identical
 * points share one stop. WP 3.9: a POINT_TO_POINT booking is stored as IN, so its stops are pickups first, then its
 * own destination (any point, not necessarily a site); drops follow in window-end order. Planned arrivals are `startMs + i × gapMin`: a plain plan the dispatcher set, not an ETA.
 * Returns the stops and each booking's pickup / drop seq.
 */
export function newTripStops(trip: Pick<DraftNewTrip, 'startMs' | 'gapMin' | 'bookingIds'>, bookings: Record<string, DraftBooking>, direction: TransportDirection): { stops: DispatchStopInput[]; seqs: Record<string, { pickupSeq: number; dropSeq: number }> } {
  const list = trip.bookingIds.map((id) => bookings[id]).filter((b): b is DraftBooking => !!b && !!b.pickup && !!b.drop);
  const order = (key: 'windowStart' | 'windowEnd') => [...list].sort((a, b) => a[key].localeCompare(b[key]) || a.name.localeCompare(b.name));
  const points: GeoPoint[] = [];
  const indexOf = (p: GeoPoint) => {
    const i = points.findIndex((q) => samePoint(q, p));
    if (i >= 0) return i;
    points.push(p);
    return points.length - 1;
  };
  const pick: Record<string, number> = {};
  const drop: Record<string, number> = {};
  if (direction === 'IN') {
    for (const b of order('windowStart')) pick[b.id] = indexOf(b.pickup!);
    const firstDrop = points.length;
    for (const b of order('windowEnd')) {
      const i = points.findIndex((q, k) => k >= firstDrop && samePoint(q, b.drop!));
      drop[b.id] = i >= 0 ? i : (points.push(b.drop!), points.length - 1);
    }
  } else {
    for (const b of list) {
      const i = points.findIndex((q) => samePoint(q, b.pickup!));
      pick[b.id] = i >= 0 ? i : (points.push(b.pickup!), points.length - 1);
    }
    const firstDrop = points.length;
    for (const b of order('windowEnd')) {
      const i = points.findIndex((q, k) => k >= firstDrop && samePoint(q, b.drop!));
      drop[b.id] = i >= 0 ? i : (points.push(b.drop!), points.length - 1);
    }
  }
  const stops = points.map((p, seq) => ({
    seq,
    point: { lat: p.lat, lng: p.lng, label: p.label ?? null, poiId: p.poiId ?? null },
    plannedArrival: new Date(trip.startMs + seq * trip.gapMin * MIN).toISOString(),
  }));
  const seqs: Record<string, { pickupSeq: number; dropSeq: number }> = {};
  for (const b of list) seqs[b.id] = { pickupSeq: pick[b.id], dropSeq: drop[b.id] };
  return { stops, seqs };
}

/** Default planned start: IN arrives at the site by the earliest window end (login); OUT leaves at the latest window start (logout). */
export function defaultNewTripStart(bookings: DraftBooking[], direction: TransportDirection, gapMin: number = DEFAULT_GAP_MIN): number {
  if (!bookings.length) return Date.now();
  if (direction === 'OUT') return Math.max(...bookings.map((b) => Date.parse(b.windowStart)));
  const pickups: GeoPoint[] = [];
  for (const b of bookings) if (b.pickup && !pickups.some((p) => samePoint(p, b.pickup!))) pickups.push(b.pickup);
  return Math.min(...bookings.map((b) => Date.parse(b.windowEnd))) - Math.max(1, pickups.length) * gapMin * MIN;
}

// ───────────────────────────── Stops of an existing trip ─────────────────────────────

const dist2 = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const x = (a.lng - b.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = a.lat - b.lat;
  return x * x + y * y;
};

function nearest(stops: StopRef[], p: { lat: number; lng: number } | null, fallback: number): number {
  if (!p || !stops.length) return fallback;
  return stops.reduce((best, s) => (dist2(s, p) < dist2(best, p) ? s : best), stops[0]).seq;
}

/** Metres between two points (equirectangular; enough to compare stop distances). */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return Math.sqrt(dist2(a, b)) * 111_320;
}

/** Beyond this distance from every stop, the booking gets its own new stop by default (the dispatcher can change it). */
export const NEW_STOP_DISTANCE_M = 300;

/**
 * Where a booking goes on an existing trip: the nearest stops, or — when the passenger's end (IN: pickup, OUT: drop) is
 * farther than NEW_STOP_DISTANCE_M from every stop — a new stop at the cheapest insertion point (least added straight
 * distance). Returns null for a trip with fewer than 2 stops.
 */
export function defaultPlacement(stops: StopRef[], booking: Pick<DraftBooking, 'pickup' | 'drop'>, direction: TransportDirection): Pick<DraftAdd, 'pickupSeq' | 'dropSeq' | 'newStop'> | null {
  const sorted = [...stops].sort((a, b) => a.seq - b.seq);
  const base = defaultSeqs(sorted, booking);
  if (!base) return null;
  const end = direction === 'IN' ? 'PICKUP' : 'DROP';
  const p = end === 'PICKUP' ? booking.pickup : booking.drop;
  if (!p || Math.min(...sorted.map((s) => metresBetween(s, p))) <= NEW_STOP_DISTANCE_M) return { ...base, newStop: null };
  const detour = (i: number) => {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a) return metresBetween(p, b);
    if (!b) return metresBetween(a, p);
    return metresBetween(a, p) + metresBetween(p, b) - metresBetween(a, b);
  };
  const last = sorted.length - 1;
  if (end === 'PICKUP') {
    // Before the last stop (the site of a login trip), after -1 … last − 1.
    let best = -1;
    for (let i = -1; i < last; i++) if (detour(i) < detour(best)) best = i;
    const dropSeq = sorted.filter((s) => s.seq > best).reduce((x, s) => (booking.drop && metresBetween(s, booking.drop) < metresBetween(x, booking.drop) ? s : x), sorted[last]).seq;
    return { pickupSeq: Math.max(0, best), dropSeq: Math.max(dropSeq, best + 1), newStop: { end, afterSeq: best } };
  }
  // DROP: after the pickup stop, anywhere up to the end.
  let best = base.pickupSeq;
  for (let i = base.pickupSeq; i <= last; i++) if (detour(i) < detour(best)) best = i;
  return { pickupSeq: base.pickupSeq, dropSeq: Math.min(last, best + 1), newStop: { end, afterSeq: best } };
}

/** Default pickup / drop stops of a booking on an existing trip: nearest stop to each point, pickup before drop. */
export function defaultSeqs(stops: StopRef[], booking: Pick<DraftBooking, 'pickup' | 'drop'>): { pickupSeq: number; dropSeq: number } | null {
  const sorted = [...stops].sort((a, b) => a.seq - b.seq);
  if (sorted.length < 2) return null;
  const last = sorted[sorted.length - 1].seq;
  const pickupSeq = nearest(sorted.slice(0, -1), booking.pickup, sorted[0].seq);
  const dropSeq = nearest(
    sorted.filter((s) => s.seq > pickupSeq),
    booking.drop,
    last,
  );
  return { pickupSeq, dropSeq };
}

// ───────────────────────────── Draft edits ─────────────────────────────

/** Seat bookings on a new trip with an idle vehicle. */
export function addNewTrip(d: DispatchDraft, vehicle: { objectId: string; label: string; seats: number }, bookings: DraftBooking[], opts: { startMs?: number; gapMin?: number; shiftId?: string | null } = {}): DispatchDraft {
  const clean = withoutBookings(d, bookings.map((b) => b.id));
  const gapMin = opts.gapMin ?? DEFAULT_GAP_MIN;
  const trip: DraftNewTrip = {
    tempId: nextTempId(clean),
    objectId: vehicle.objectId,
    label: vehicle.label,
    seats: vehicle.seats,
    startMs: opts.startMs ?? defaultNewTripStart(bookings, d.direction, gapMin),
    gapMin,
    bookingIds: bookings.map((b) => b.id),
    shiftId: opts.shiftId ?? null,
  };
  return { ...clean, bookings: withBookings(clean, bookings), newTrips: [...clean.newTrips, trip] };
}

/** Seat bookings on a trip that is already in the draft as a new trip. */
export function addToNewTrip(d: DispatchDraft, tempId: string, bookings: DraftBooking[]): DispatchDraft {
  const clean = withoutBookings(d, bookings.map((b) => b.id));
  return {
    ...clean,
    bookings: withBookings(clean, bookings),
    newTrips: clean.newTrips.map((n) => (n.tempId === tempId ? { ...n, bookingIds: [...n.bookingIds, ...bookings.map((b) => b.id)] } : n)),
  };
}

/** Seat bookings on an existing (published, not started) trip; `seqs` gives each booking's pickup / drop stop (or new stop). */
export function addToTrip(d: DispatchDraft, trip: { id: string; version: number }, bookings: DraftBooking[], seqs: Record<string, Pick<DraftAdd, 'pickupSeq' | 'dropSeq' | 'newStop'>>): DispatchDraft {
  const clean = withoutBookings(d, bookings.map((b) => b.id));
  const adds = bookings.filter((b) => seqs[b.id]).map((b) => ({ tripId: trip.id, bookingId: b.id, ...seqs[b.id] }));
  return { ...clean, bookings: withBookings(clean, bookings), adds: [...clean.adds, ...adds], versions: { [trip.id]: clean.versions[trip.id] ?? trip.version, ...clean.versions } };
}

/** Change the stops of one pending add (to existing stops: any new stop is dropped). */
export function setAddSeqs(d: DispatchDraft, bookingId: string, pickupSeq: number, dropSeq: number): DispatchDraft {
  return { ...d, adds: d.adds.map((a) => (a.bookingId === bookingId ? { ...a, pickupSeq, dropSeq, newStop: null } : a)) };
}

/** Give one pending add a new stop for its pickup (after `afterSeq`; the drop stays an existing stop after it). */
export function setAddNewPickupStop(d: DispatchDraft, bookingId: string, afterSeq: number): DispatchDraft {
  return { ...d, adds: d.adds.map((a) => (a.bookingId === bookingId ? { ...a, pickupSeq: Math.max(0, afterSeq), dropSeq: Math.max(a.dropSeq, afterSeq + 1), newStop: { end: 'PICKUP', afterSeq } } : a)) };
}

/** Give one pending add a new stop for its drop (after `afterSeq` ≥ its pickup stop). */
export function setAddNewDropStop(d: DispatchDraft, bookingId: string, afterSeq: number): DispatchDraft {
  return { ...d, adds: d.adds.map((a) => (a.bookingId === bookingId ? { ...a, pickupSeq: Math.min(a.pickupSeq, afterSeq), newStop: { end: 'DROP', afterSeq } } : a)) };
}

/**
 * ADD_STOP + ADD_PASSENGER ops of one existing trip's adds. The server applies the ADD_STOPs in order, each renumbering
 * the stops after it, so every afterSeq is given in the numbering at that moment, and the passengers' seqs in the final
 * numbering. Two new stops after the same stop keep the order of the adds.
 */
export function existingTripOps(adds: DraftAdd[]): DispatchChangeOp[] {
  const inserts = adds.filter((a) => a.newStop);
  const before = (a: number, k: number) => inserts.filter((x, j) => j !== k && x.newStop!.afterSeq < a).length;
  const finalOf = (seq: number) => seq + inserts.filter((x) => x.newStop!.afterSeq < seq).length;
  const ops: DispatchChangeOp[] = [];
  const newSeq = new Map<string, number>();
  inserts.forEach((x, k) => {
    const a = x.newStop!.afterSeq;
    const earlierLower = inserts.slice(0, k).filter((y) => y.newStop!.afterSeq < a).length;
    const earlierSame = inserts.slice(0, k).filter((y) => y.newStop!.afterSeq === a).length;
    ops.push({ op: 'ADD_STOP', tripId: x.tripId, bookingId: x.bookingId, end: x.newStop!.end, afterSeq: a + earlierLower + earlierSame });
    newSeq.set(x.bookingId, a + 1 + before(a, k) + earlierSame);
  });
  for (const a of adds) {
    const s = newSeq.get(a.bookingId);
    const pickupSeq = a.newStop?.end === 'PICKUP' ? s! : finalOf(a.pickupSeq);
    const dropSeq = a.newStop?.end === 'DROP' ? s! : finalOf(a.dropSeq);
    ops.push({ op: 'ADD_PASSENGER', tripId: a.tripId, bookingId: a.bookingId, pickupSeq, dropSeq });
  }
  return ops;
}

/** Undo the seating of bookings (from new trips and adds); a new trip left without bookings is dropped. */
export function withoutBookings(d: DispatchDraft, ids: string[]): DispatchDraft {
  const drop = new Set(ids);
  const newTrips = d.newTrips.map((n) => ({ ...n, bookingIds: n.bookingIds.filter((id) => !drop.has(id)) })).filter((n) => n.bookingIds.length > 0);
  const adds = d.adds.filter((a) => !drop.has(a.bookingId));
  return pruneVersions({ ...d, newTrips, adds });
}

/** Unassign a seated passenger (REMOVE_PASSENGER; the booking returns to the queue on publish). */
export function addRemove(d: DispatchDraft, r: DraftRemove, version: number): DispatchDraft {
  if (d.removes.some((x) => x.passengerTripId === r.passengerTripId)) return d;
  return { ...d, removes: [...d.removes, r], versions: { [r.tripId]: d.versions[r.tripId] ?? version, ...d.versions } };
}

export function undoRemove(d: DispatchDraft, passengerTripId: string): DispatchDraft {
  return pruneVersions({ ...d, removes: d.removes.filter((r) => r.passengerTripId !== passengerTripId) });
}

/** Reassign the vehicle or driver of an existing trip (one per trip and kind; the latest wins). */
export function addReassign(d: DispatchDraft, r: DraftReassign, version: number): DispatchDraft {
  const rest = d.reassigns.filter((x) => !(x.tripId === r.tripId && x.kind === r.kind));
  return { ...d, reassigns: [...rest, r], versions: { [r.tripId]: d.versions[r.tripId] ?? version, ...d.versions } };
}

export function undoReassign(d: DispatchDraft, tripId: string, kind: DraftReassign['kind']): DispatchDraft {
  return pruneVersions({ ...d, reassigns: d.reassigns.filter((x) => !(x.tripId === tripId && x.kind === kind)) });
}

export function setNewTripTiming(d: DispatchDraft, tempId: string, startMs: number, gapMin: number): DispatchDraft {
  return { ...d, newTrips: d.newTrips.map((n) => (n.tempId === tempId ? { ...n, startMs, gapMin } : n)) };
}

/** Existing trips touched by the draft. */
export function touchedTripIds(d: DispatchDraft): string[] {
  return [...new Set([...d.adds.map((a) => a.tripId), ...d.removes.map((r) => r.tripId), ...d.reassigns.map((r) => r.tripId)])];
}

function pruneVersions(d: DispatchDraft): DispatchDraft {
  const keep = new Set(touchedTripIds(d));
  return { ...d, versions: Object.fromEntries(Object.entries(d.versions).filter(([id]) => keep.has(id))) };
}

/**
 * After a VERSION_CONFLICT: take the board's current versions and drop changes that no longer apply (bookings no longer
 * waiting for a seat, trips gone or started). The dispatcher reviews the result again before publishing.
 */
export function rebaseDraft(d: DispatchDraft, board: { queueIds: Iterable<string>; trips: { id: string; version: number; editable: boolean }[] }): { draft: DispatchDraft; dropped: number } {
  const queue = new Set(board.queueIds);
  const trips = new Map(board.trips.map((t) => [t.id, t]));
  const before = draftChangeCount(d);
  const okTrip = (id: string) => !!trips.get(id)?.editable;
  const newTrips = d.newTrips.map((n) => ({ ...n, bookingIds: n.bookingIds.filter((id) => queue.has(id)) })).filter((n) => n.bookingIds.length > 0);
  const adds = d.adds.filter((a) => queue.has(a.bookingId) && okTrip(a.tripId));
  const removes = d.removes.filter((r) => okTrip(r.tripId));
  const reassigns = d.reassigns.filter((r) => okTrip(r.tripId));
  const next = pruneVersions({ ...d, newTrips, adds, removes, reassigns });
  next.versions = Object.fromEntries(touchedTripIds(next).map((id) => [id, trips.get(id)!.version]));
  return { draft: next, dropped: before - draftChangeCount(next) };
}

// ───────────────────────────── Change set ─────────────────────────────

/**
 * The change set of a draft: removals first (they free seats), then reassignments, then each new trip followed by its
 * passengers, then passengers added to existing trips. expectedVersions names every existing trip touched.
 */
export function buildChangeSet(d: DispatchDraft, reason?: string): DispatchChangeSetInput {
  const changes: DispatchChangeOp[] = [];
  for (const r of d.removes) changes.push({ op: 'REMOVE_PASSENGER', passengerTripId: r.passengerTripId, reason: r.reason });
  for (const r of d.reassigns) {
    if (r.kind === 'VEHICLE' && r.targetId) changes.push({ op: 'REASSIGN_VEHICLE', tripId: r.tripId, objectId: r.targetId });
    if (r.kind === 'DRIVER') changes.push({ op: 'REASSIGN_DRIVER', tripId: r.tripId, driverId: r.targetId });
  }
  for (const n of d.newTrips) {
    const { stops, seqs } = newTripStops(n, d.bookings, d.direction);
    changes.push({ op: 'CREATE_TRIP', tempId: n.tempId, objectId: n.objectId, plannedStart: new Date(n.startMs).toISOString(), stops, ...(n.shiftId ? { shiftId: n.shiftId } : {}) });
    for (const id of n.bookingIds) if (seqs[id]) changes.push({ op: 'ADD_PASSENGER', tripId: n.tempId, bookingId: id, ...seqs[id] });
  }
  // Passengers added to existing trips, per trip: new stops first (ADD_STOP), then the seats with the final seqs.
  for (const tripId of [...new Set(d.adds.map((a) => a.tripId))]) changes.push(...existingTripOps(d.adds.filter((a) => a.tripId === tripId)));
  const expectedVersions: Record<string, number> = {};
  for (const id of touchedTripIds(d)) expectedVersions[id] = d.versions[id];
  return { serviceDate: d.serviceDate, direction: d.direction, changes, expectedVersions, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
}

export interface DraftDiffRow {
  /** Trip id or tempId. */
  key: string;
  label: string;
  isNew: boolean;
  before: number;
  after: number;
  capacity: number | null;
  added: string[];
  removed: string[];
  /** Vehicle / driver reassignments. */
  notes: { kind: 'VEHICLE' | 'DRIVER'; label: string }[];
  overCapacity: boolean;
}

/** Before / after seats and names per trip, for the review dialog and the board's occupancy preview. */
export function diffDraft(d: DispatchDraft, trips: DraftTripRef[]): DraftDiffRow[] {
  const rows = new Map<string, DraftDiffRow>();
  const seatOf = (id: string) => d.bookings[id]?.seats ?? 1;
  const nameOf = (id: string) => d.bookings[id]?.name ?? id;
  const row = (id: string): DraftDiffRow => {
    let r = rows.get(id);
    if (!r) {
      const t = trips.find((x) => x.id === id);
      r = { key: id, label: t ? [t.vehicleName, t.name].filter(Boolean).join(' · ') : id, isNew: false, before: t?.occupiedSeats ?? 0, after: t?.occupiedSeats ?? 0, capacity: t?.seatCapacity ?? null, added: [], removed: [], notes: [], overCapacity: false };
      rows.set(id, r);
    }
    return r;
  };
  for (const r of d.removes) {
    const x = row(r.tripId);
    x.after -= r.seats;
    x.removed.push(r.name);
  }
  for (const r of d.reassigns) {
    const x = row(r.tripId);
    x.notes.push({ kind: r.kind, label: r.label });
    if (r.kind === 'VEHICLE' && r.seats !== undefined) x.capacity = r.seats ?? null;
  }
  for (const a of d.adds) {
    const x = row(a.tripId);
    x.after += seatOf(a.bookingId);
    x.added.push(nameOf(a.bookingId));
  }
  for (const n of d.newTrips) {
    const seats = n.bookingIds.reduce((s, id) => s + seatOf(id), 0);
    rows.set(n.tempId, { key: n.tempId, label: n.label, isNew: true, before: 0, after: seats, capacity: n.seats, added: n.bookingIds.map(nameOf), removed: [], notes: [], overCapacity: false });
  }
  const out = [...rows.values()];
  for (const r of out) r.overCapacity = r.capacity !== null && r.after > r.capacity;
  return out;
}

// ───────────────────────────── Idempotency ─────────────────────────────

/** Stable JSON (sorted object keys) so the same body always hashes the same. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface IdempotencySlot {
  key: string;
  body: string;
}

/**
 * The Idempotency-Key for a publish: a retry of the same body (e.g. after a network error or a lost response) reuses
 * the key, so the server replays the first result instead of publishing twice; any other body gets a new key (reusing
 * a key with another body is 422 IDEMPOTENCY_KEY_REUSED).
 */
export function idempotencyFor(prev: IdempotencySlot | null, body: unknown, gen: () => string): IdempotencySlot {
  const s = stableStringify(body);
  if (prev && prev.body === s) return prev;
  return { key: gen(), body: s };
}
