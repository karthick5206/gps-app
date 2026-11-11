import { ROUTE_LIMITS, TRANSPORT_E3_LIMITS, type DispatchChangeOp, type DispatchStopInput } from '@veetracer/shared';
import { invalid, validPoint } from './e3-common';

/**
 * Shape validation of a dispatch change set (05 §3.4) before any database work: a discriminated union class-validator
 * cannot express. Pure; throws 400 VALIDATION_FAILED naming the change (1-based) that is wrong.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMP = /^[A-Za-z0-9_-]{1,40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 300) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isoMs = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);

function stops(raw: unknown, n: number): DispatchStopInput[] {
  if (!Array.isArray(raw) || raw.length < ROUTE_LIMITS.minStops || raw.length > TRANSPORT_E3_LIMITS.maxStops) throw invalid(`Change ${n}: a trip needs ${ROUTE_LIMITS.minStops}–${TRANSPORT_E3_LIMITS.maxStops} stops`);
  const out = raw.map((s, i): DispatchStopInput => {
    if (!isObj(s) || !int(s.seq) || !isObj(s.point) || !validPoint(s.point as { lat?: unknown; lng?: unknown }) || !Number.isFinite(isoMs(s.plannedArrival))) throw invalid(`Change ${n}: stop ${i + 1} needs seq, a valid point and plannedArrival`);
    if (s.radiusM !== undefined && !int(s.radiusM, ROUTE_LIMITS.radiusMinM, ROUTE_LIMITS.radiusMaxM)) throw invalid(`Change ${n}: stop ${i + 1} radius out of range`);
    if (s.waitMin !== undefined && !int(s.waitMin, 0, ROUTE_LIMITS.maxWaitMin)) throw invalid(`Change ${n}: stop ${i + 1} wait out of range`);
    const p = s.point as Record<string, unknown>;
    return {
      seq: s.seq as number,
      point: { lat: p.lat as number, lng: p.lng as number, label: typeof p.label === 'string' ? p.label.slice(0, 120) : null, poiId: typeof p.poiId === 'string' && UUID.test(p.poiId) ? p.poiId : null },
      plannedArrival: new Date(isoMs(s.plannedArrival)).toISOString(),
      ...(s.radiusM !== undefined ? { radiusM: s.radiusM as number } : {}),
      ...(s.waitMin !== undefined ? { waitMin: s.waitMin as number } : {}),
    };
  });
  out.sort((a, b) => a.seq - b.seq);
  out.forEach((s, i) => {
    if (s.seq !== i) throw invalid(`Change ${n}: stop seqs must be 0..${out.length - 1} without gaps`);
    if (i > 0 && Date.parse(s.plannedArrival) < Date.parse(out[i - 1].plannedArrival)) throw invalid(`Change ${n}: planned arrivals must not go back in time`);
  });
  return out;
}

export function parseChangeOps(raw: unknown[]): DispatchChangeOp[] {
  const temps = new Set<string>();
  return raw.map((c, i): DispatchChangeOp => {
    const n = i + 1;
    if (!isObj(c)) throw invalid(`Change ${n} is not an object`);
    const ref = (v: unknown, what: string) => {
      if (typeof v !== 'string' || (!UUID.test(v) && !temps.has(v))) throw invalid(`Change ${n}: ${what} must be a trip id or a tempId created earlier in this change set`);
      return v;
    };
    const uuid = (v: unknown, what: string) => {
      if (typeof v !== 'string' || !UUID.test(v)) throw invalid(`Change ${n}: ${what} must be an id`);
      return v;
    };
    switch (c.op) {
      case 'CREATE_TRIP': {
        if (typeof c.tempId !== 'string' || !TEMP.test(c.tempId) || UUID.test(c.tempId) || temps.has(c.tempId)) throw invalid(`Change ${n}: tempId must be a unique short label (not an id)`);
        if (!Number.isFinite(isoMs(c.plannedStart))) throw invalid(`Change ${n}: plannedStart must be a date and time`);
        const hasRoute = c.routeId !== undefined && c.routeId !== null;
        if (hasRoute === (c.stops !== undefined && c.stops !== null)) throw invalid(`Change ${n}: give either routeId (shuttle) or stops (door-to-door)`);
        if (c.corridorM !== undefined && !int(c.corridorM, ROUTE_LIMITS.corridorMinM, ROUTE_LIMITS.corridorMaxM)) throw invalid(`Change ${n}: corridor out of range`);
        if (c.name !== undefined && !str(c.name, 120)) throw invalid(`Change ${n}: name too long`);
        temps.add(c.tempId);
        return {
          op: 'CREATE_TRIP',
          tempId: c.tempId,
          objectId: uuid(c.objectId, 'objectId'),
          driverId: c.driverId === undefined || c.driverId === null ? null : uuid(c.driverId, 'driverId'),
          plannedStart: new Date(isoMs(c.plannedStart)).toISOString(),
          routeId: hasRoute ? uuid(c.routeId, 'routeId') : null,
          ...(hasRoute ? {} : { stops: stops(c.stops, n) }),
          shiftId: c.shiftId === undefined || c.shiftId === null ? null : uuid(c.shiftId, 'shiftId'),
          sitePoiId: c.sitePoiId === undefined || c.sitePoiId === null ? null : uuid(c.sitePoiId, 'sitePoiId'),
          ...(c.corridorM !== undefined ? { corridorM: c.corridorM as number } : {}),
          ...(typeof c.name === 'string' ? { name: c.name.trim() } : {}),
        };
      }
      case 'ADD_PASSENGER':
        if (!int(c.pickupSeq) || !int(c.dropSeq) || (c.dropSeq as number) <= (c.pickupSeq as number)) throw invalid(`Change ${n}: pickupSeq must come before dropSeq`);
        return { op: 'ADD_PASSENGER', tripId: ref(c.tripId, 'tripId'), bookingId: uuid(c.bookingId, 'bookingId'), pickupSeq: c.pickupSeq as number, dropSeq: c.dropSeq as number };
      case 'REMOVE_PASSENGER':
        if (!str(c.reason)) throw invalid(`Change ${n}: give a reason`);
        return { op: 'REMOVE_PASSENGER', passengerTripId: uuid(c.passengerTripId, 'passengerTripId'), reason: (c.reason as string).trim() };
      case 'REASSIGN_VEHICLE':
        return { op: 'REASSIGN_VEHICLE', tripId: ref(c.tripId, 'tripId'), objectId: uuid(c.objectId, 'objectId') };
      case 'REASSIGN_DRIVER':
        return { op: 'REASSIGN_DRIVER', tripId: ref(c.tripId, 'tripId'), driverId: c.driverId === null || c.driverId === undefined ? null : uuid(c.driverId, 'driverId') };
      default:
        throw invalid(`Change ${n}: unknown op ${String(c.op)} (R1: CREATE_TRIP, ADD_PASSENGER, REMOVE_PASSENGER, REASSIGN_VEHICLE, REASSIGN_DRIVER)`);
    }
  });
}

/** Planned stop times of an ad-hoc trip (wait → departure); plannedEnd = last arrival (v1.8 snapshot rule). */
export function adhocStops(list: DispatchStopInput[]) {
  return list.map((s) => {
    const arrival = new Date(s.plannedArrival);
    return {
      seq: s.seq,
      name: (s.point.label ?? '').trim() || `Stop ${s.seq + 1}`,
      lat: s.point.lat,
      lng: s.point.lng,
      radiusM: s.radiusM ?? ROUTE_LIMITS.radiusDefaultM,
      plannedArrival: arrival,
      plannedDeparture: new Date(arrival.getTime() + (s.waitMin ?? 0) * 60_000),
    };
  });
}
