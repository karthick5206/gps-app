import type { PdpProblem, PdpResult } from '../../routing-jobs/pdp-contract';
import { buildPdpProblem } from '../../routing-jobs/pdp-problem';
import { fallbackTravel, type InsertionRequest, type InsertionTrip, type LatLng, type TravelFn } from './insertion';

/**
 * Live fast path through the optimiser (doc 20 §5.1 step 2): one pdp problem with `insertOnly: true` over the candidate
 * trips (each a vehicle whose seated passengers are committed requests) and the new request. The optimiser picks the
 * trip; the API then realises that choice with the slack model of insertion.ts (existing stops keep their planned
 * times, the E3 ADD_STOP rule), so its answer can never move a committed stop. An optimiser without contract v3, or
 * unavailable, makes the caller use the in-process cheapest insertion (engine FALLBACK).
 */

export interface PdpCaller {
  solvePdp<P, R>(problem: P): Promise<R>;
}

/** Matrix over [trip stops of every candidate…, new pickup, new drop] (synthetic times: the live API has no road matrix). */
export function insertOnlyProblem(trips: readonly (InsertionTrip & { seated: { bookingId: string; pickupSeq: number; dropSeq: number; seats: number }[] })[], req: InsertionRequest, nowMs: number, travel: TravelFn = fallbackTravel): { problem: PdpProblem; tripOfVehicle: Map<string, string> } {
  const points: LatLng[] = [];
  const indexOf = new Map<string, number>();
  const add = (key: string, p: LatLng) => {
    if (!indexOf.has(key)) indexOf.set(key, points.push(p) - 1);
    return indexOf.get(key)!;
  };
  const base = nowMs;
  const rel = (ms: number) => Math.max(0, Math.round((ms - base) / 1000));
  const tripOfVehicle = new Map<string, string>();
  const vehicles: PdpProblem['vehicles'] = [];
  const requests: Parameters<typeof buildPdpProblem>[0]['requests'] = [];
  for (const t of trips) {
    const vid = `trip:${t.tripId}`;
    tripOfVehicle.set(vid, t.tripId);
    const stops = [...t.stops].sort((a, b) => a.seq - b.seq);
    const idx = stops.map((s) => add(`${t.tripId}:${s.seq}`, s));
    const firstOpen = stops.findIndex((s) => !s.visited);
    const startIdx = t.live ? add(`${t.tripId}:live`, t.live.pos) : idx[0];
    vehicles.push({ id: vid, startIndex: startIdx, availableFromS: rel(Math.max(nowMs, t.live?.atMs ?? stops[Math.max(0, firstOpen)]?.arrivalMs ?? nowMs)), shiftEndS: rel((t.nextStartMs ?? stops[stops.length - 1].departureMs + 6 * 3_600_000) - t.turnaroundS * 1000), capacity: t.seatCapacity, turnaroundS: t.turnaroundS });
    for (const p of t.seated) {
      const pick = stops.find((s) => s.seq === p.pickupSeq);
      const drop = stops.find((s) => s.seq === p.dropSeq);
      if (!pick || !drop || drop.visited) continue;
      requests.push({ bookingId: p.bookingId, pickupIndex: idx[stops.indexOf(pick)], dropIndex: idx[stops.indexOf(drop)], passengers: p.seats, preference: 'SHARED', windowStartS: rel(pick.arrivalMs), windowEndS: rel(pick.arrivalMs), limits: null, companyMaxRideS: null, committed: { vehicleId: vid, pickupWindow: [rel(pick.arrivalMs), rel(pick.arrivalMs)] } });
    }
  }
  const pIdx = add('new:p', req.pickup);
  const dIdx = add('new:d', req.drop);
  requests.push({ bookingId: req.bookingId, pickupIndex: pIdx, dropIndex: dIdx, passengers: req.seats, preference: req.preference, windowStartS: rel(req.windowStartMs), windowEndS: rel(req.windowEndMs), limits: req.limits, companyMaxRideS: req.companyMaxRideS });
  const durations = points.map((a) => points.map((b) => (a === b ? 0 : travel(a, b))));
  const problem = buildPdpProblem({ durationsS: durations, distancesM: durations.map((r) => r.map((s) => Math.round(s * 7))), horizonS: 86_400 * 2, vehicles, requests, timeLimitS: 2, insertOnly: true, deterministic: true });
  return { problem, tripOfVehicle };
}

/** The trip the optimiser put the new request on, or null (unserved / not in the answer). */
export function solverChoice(res: PdpResult, bookingId: string, tripOfVehicle: Map<string, string>): string | null {
  for (const v of res.vehicles ?? []) {
    if ((v.trips ?? []).some((t) => (t.stops ?? []).some((s) => s.requestId === bookingId))) return tripOfVehicle.get(v.id) ?? null;
  }
  return null;
}
