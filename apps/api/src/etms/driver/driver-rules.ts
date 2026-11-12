import {
  DRIVER_LIMITS as L,
  DRIVER_TRIP_EVENT_TYPES,
  driverOutcomeAllowed,
  driverReasonAllowed,
  type DriverErrorCode,
  type DriverTripEventOutcome,
  type DriverTripEventType,
  type PlannedStopStatus,
  type PlannedTripStatus,
  type TransportPassengerStatus,
} from '@veetracer/shared';
import { haversineMeters } from '../../tracking/geo';

/**
 * The driver trip-event state machine (doc 09 §4.4 validation, §6.4 ordering / conflicts / clock), pure: the service
 * loads a snapshot of the trip under its row lock, asks `decide` for every event in `seq` order, applies the returned
 * effect to the database and to the snapshot (`applyToSnapshot`) and stores the event with its outcome.
 *
 * Rules in short: the server decides, the client only reports. Dispatcher actions win (a cancelled / closed trip makes
 * queued events LATE, a reassigned trip makes them REJECTED NOT_ASSIGNED). The first passenger outcome wins (a later
 * contradiction is REJECTED CONFLICT; the same fact again is DUPLICATE ALREADY_RECORDED). GPS stays authoritative for
 * stop times; driver events are authoritative for passenger outcomes. An event that depends on an earlier one which
 * has not arrived yet (gap in `seq`) is RETRY OUT_OF_ORDER and is not stored.
 */

export type StopSnap = {
  id: string;
  seq: number;
  status: PlannedStopStatus;
  plannedArrival: Date;
  actualArrival: Date | null;
  lat: number;
  lng: number;
  radiusM: number;
  /**
   * The point is hidden from the driver (no routing consent, or its only seats are cancelled): ARRIVED is never
   * checked against the GPS there (security review L2: no hot / cold oracle), it is accepted as unverified.
   */
  hidden?: boolean;
  /**
   * Security review M1: the arrival was set by a driver ARRIVED the vehicle GPS could not confirm, received by the
   * server at arrivalReceivedAt. Null / undefined = confirmed (GPS tracker, dispatcher, or a verified ARRIVED).
   */
  arrivalUnverified?: boolean;
  /**
   * Re-check R-2: the arrival-setting ARRIVED reached the server more than arrivalFixMaxSkewMs after its (clamped) time
   * (a retroactive tap, even if a stored-track fix confirms it). Treated like an unverified arrival for the wait and review.
   */
  arrivalLate?: boolean;
  /** Server receipt of the arrival-setting ARRIVED when it is unverified or late (the NO_SHOW wait starts there). */
  arrivalReceivedAt?: Date | null;
};

/** Outcome review codes (SYSTEM review events on the dispatcher's timeline; M1, re-check R-2 / R-3). */
export type OutcomeReview = 'NO_SHOW_UNVERIFIED_ARRIVAL' | 'NO_SHOW_LATE_ARRIVAL' | 'BOARDED_UNVERIFIED_ARRIVAL' | 'DROPPED_UNVERIFIED_ARRIVAL';

/** The stop's arrival could not be trusted as live (GPS did not confirm it, or it was reported retroactively). */
const doubtful = (stop: StopSnap | undefined): boolean => !!stop && (!!stop.arrivalUnverified || !!stop.arrivalLate);
export type PassengerSnap = { id: string; status: TransportPassengerStatus; pickupSeq: number; dropSeq: number };

export interface TripSnapshot {
  plannedTripStatus: PlannedTripStatus | null;
  publishedAt: Date | null;
  acknowledgedAt: Date | null;
  /** The trip's PlannedTrip is (still) assigned to the caller's driver. */
  assigned: boolean;
  plannedStart: Date;
  /** When the trip started (security review M1: stop and passenger events are never dated before it). */
  actualStart?: Date | null;
  stops: StopSnap[];
  passengers: PassengerSnap[];
  /** Highest client seq stored for this trip from this driver (null = none yet). */
  lastSeq: number | null;
  /** The vehicle's latest fix (live cache), for ARRIVED verification; null = none. */
  fix: Fix | null;
  /** Stored vehicle track (Position rows) near the batch's ARRIVED times (security review M1). */
  track?: Fix[];
  /** Server receipt of the last accepted REPORT_DELAY of this trip (security review M2); null = none. */
  lastDelayAt?: Date | null;
  /** When the trip was closed (PlannedTrip.actualEnd); the D1 settle grace runs from here. */
  actualEnd?: Date | null;
}

export type Fix = { lat: number; lng: number; at: Date };

export interface EventIn {
  seq: number;
  type: string;
  /** Corrected device time (clock offset applied). */
  occurredAt: Date;
  stopSeq?: number;
  passengerTripId?: string;
  reasonCode?: string;
  etaMin?: number;
}

export type Effect =
  | { kind: 'ACKNOWLEDGE' }
  | { kind: 'ARRIVE'; stopId: string; confirmOnly: boolean }
  | { kind: 'DEPART'; stopId: string }
  | { kind: 'OUTCOME'; passengerTripId: string; from: TransportPassengerStatus; to: 'BOARDED' | 'NO_SHOW' | 'DROPPED'; earlyDrop: boolean }
  | { kind: 'OVERLAY'; overlay: 'DELAY' | 'BREAKDOWN' }
  | { kind: 'COMPLETE'; from: PlannedTripStatus };

export type Decision =
  | { outcome: 'ACCEPTED'; effect: Effect; verified?: 'gps' | 'unverified_location' | null; code?: null; review?: OutcomeReview; afterClose?: true }
  | { outcome: Exclude<DriverTripEventOutcome, 'ACCEPTED'>; code: DriverErrorCode | 'ALREADY_RECORDED'; effect?: undefined; verified?: undefined; review?: undefined };

const OPEN: readonly (PlannedTripStatus | null)[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];
const RUNNING: readonly (PlannedTripStatus | null)[] = ['STARTED', 'IN_PROGRESS'];
const MIN = 60_000;

const reject = (code: DriverErrorCode): Decision => ({ outcome: 'REJECTED', code });
const late = (code: DriverErrorCode = 'TRIP_CLOSED'): Decision => ({ outcome: 'LATE', code });
const dup = (): Decision => ({ outcome: 'DUPLICATE', code: 'ALREADY_RECORDED' });
const retry = (code: DriverErrorCode = 'OUT_OF_ORDER'): Decision => ({ outcome: 'RETRY', code });
/** Event types tied to the trip run (stops / passengers): never dated before the trip's actual start (M1). */
const RUN_EVENTS: readonly string[] = ['ARRIVED', 'DEPARTED', 'BOARDED', 'NO_SHOW', 'DROPPED', 'COMPLETE_TRIP'];

/** Passenger outcomes the driver may still send for a while after the trip is COMPLETED (D1 / D1b). */
const SETTLE_EVENTS: readonly string[] = ['BOARDED', 'NO_SHOW', 'DROPPED'];

/**
 * D1 / D1b (Lead decision 2026-11-12): the trip is COMPLETED (typically auto-completed by the vehicle GPS on reaching the
 * last stop) no longer than DRIVER_LIMITS.settleGraceHours ago. Then the driver's per-passenger settlements are still
 * evaluated (see decide); the trip itself stays closed.
 */
export function inSettleGrace(s: Pick<TripSnapshot, 'plannedTripStatus' | 'actualEnd'>, now: number): boolean {
  return s.plannedTripStatus === 'COMPLETED' && !!s.actualEnd && now - s.actualEnd.getTime() <= L.settleGraceHours * 3_600_000;
}

/** Stored TransportTripEvent kind of a driver event (COMPLETE_TRIP is stored as COMPLETED, like the dispatcher's). */
export function storedKind(type: string): string {
  return type === 'COMPLETE_TRIP' ? 'COMPLETED' : type;
}

export const isDriverEventType = (t: string): t is DriverTripEventType => (DRIVER_TRIP_EVENT_TYPES as readonly string[]).includes(t);

/**
 * Clock rule (09 §6.4.3): corrected time = device time + clockOffsetMs (bounded to ± 1 day); it must not be more than
 * `maxFutureSkewMs` ahead of the server, nor older than `maxPastHours`, nor earlier than the trip could be seen (plannedStart − 48 h).
 */
export function correctedTime(raw: string, clockOffsetMs: number | undefined): { at: Date; offset: number } | null {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const offset = Number.isFinite(clockOffsetMs) ? Math.max(-86_400_000, Math.min(86_400_000, Math.round(clockOffsetMs!))) : 0;
  return { at: new Date(ms + offset), offset };
}

export function clockOk(at: Date, plannedStart: Date, now: number): boolean {
  const t = at.getTime();
  return t <= now + L.maxFutureSkewMs && t >= now - L.maxPastHours * 3_600_000 && t >= plannedStart.getTime() - (L.windowPastHours + L.windowFutureHours) * 3_600_000;
}

/**
 * Security review M1: the time an event is evaluated and stored at. Stop and passenger events are clamped to the trip's
 * actual start (a backdated tap cannot predate the run); the 48 h / window bounds stay with clockOk.
 */
export function effectiveTime(s: Pick<TripSnapshot, 'actualStart'>, type: string, at: Date): Date {
  if (!s.actualStart || !RUN_EVENTS.includes(type)) return at;
  return at.getTime() < s.actualStart.getTime() ? new Date(s.actualStart.getTime()) : at;
}

/**
 * ARRIVED vs the vehicle GPS (09 §4.4; security review M1): the vehicle fixes near occurredAt (± arrivalFixMaxSkewMs) from
 * the stored track and the live cache. Any of them within k × radius → gps; fixes there but all far → NOT_AT_STOP; no
 * fix near occurredAt → unverified (the NO_SHOW wait then runs from the server's receipt).
 */
export function verifyArrival(stop: StopSnap, fixes: Fix | null | (Fix | null)[], at: Date): 'gps' | 'unverified_location' | 'far' {
  const list = (Array.isArray(fixes) ? fixes : [fixes]).filter((f): f is Fix => !!f && Math.abs(f.at.getTime() - at.getTime()) <= L.arrivalFixMaxSkewMs);
  if (!list.length) return 'unverified_location';
  const max = L.arrivalRadiusFactor * Math.max(stop.radiusM, 50);
  return list.some((f) => haversineMeters(f.lat, f.lng, stop.lat, stop.lng) <= max) ? 'gps' : 'far';
}

/** Decide one event against the snapshot. Pure. */
export function decide(s: TripSnapshot, e: EventIn, now: number): Decision {
  if (e.type === 'START_TRIP') return reject('ONLINE_ONLY');
  if (!isDriverEventType(e.type)) return reject('VALIDATION_FAILED');
  if (!s.assigned) return reject('NOT_ASSIGNED');
  if (!driverReasonAllowed(e.type, e.reasonCode)) return reject('VALIDATION_FAILED');
  if (!clockOk(e.occurredAt, s.plannedStart, now)) return reject('CLOCK_SKEW');
  // M1: checked on the device's (corrected) time, evaluated on the time clamped to the trip's actual start.
  e = { ...e, occurredAt: effectiveTime(s, e.type, e.occurredAt) };
  const gap = e.seq > (s.lastSeq ?? 0) + 1;
  const status = s.plannedTripStatus;

  // A trip the dispatcher (or the timeout sweeper / GPS) closed: queued events change nothing (dispatcher wins).
  if (!OPEN.includes(status)) {
    if (e.type === 'COMPLETE_TRIP' && status === 'COMPLETED') return dup();
    // D1 / D1b: inside the settle grace a COMPLETED trip still takes passenger settlements, never a new boarding (a
    // BOARDED counts only when it happened before the close). Everything else, and anything later, is LATE.
    if (SETTLE_EVENTS.includes(e.type) && inSettleGrace(s, now)) {
      if (e.type === 'BOARDED' && e.occurredAt.getTime() > s.actualEnd!.getTime()) return late('TRIP_CLOSED');
      const d = decideOutcome(s, e, now, gap);
      return d.outcome === 'ACCEPTED' ? { ...d, afterClose: true as const } : d;
    }
    return late('TRIP_CLOSED');
  }

  switch (e.type) {
    case 'ACKNOWLEDGE':
      if (!s.publishedAt) return reject('INVALID_STATE');
      return s.acknowledgedAt ? dup() : { outcome: 'ACCEPTED', effect: { kind: 'ACKNOWLEDGE' } };

    case 'REPORT_DELAY':
      // Security review M2: one delay report per trip and interval (each one may notify every waiting passenger).
      if (s.lastDelayAt && now - s.lastDelayAt.getTime() < L.delayReportMinIntervalMin * MIN) return { outcome: 'DUPLICATE', code: 'TOO_FREQUENT' };
      return { outcome: 'ACCEPTED', effect: { kind: 'OVERLAY', overlay: 'DELAY' } };
    case 'REPORT_BREAKDOWN':
      return { outcome: 'ACCEPTED', effect: { kind: 'OVERLAY', overlay: 'BREAKDOWN' } };

    case 'ARRIVED': {
      if (!RUNNING.includes(status)) return reject('TRIP_NOT_STARTED');
      const stop = s.stops.find((x) => x.seq === e.stopSeq);
      if (!stop) return reject('VALIDATION_FAILED');
      if (stop.status === 'SKIPPED') return reject('INVALID_STATE');
      if (stop.status === 'DEPARTED') return dup();
      // A hidden point is never checked (L2): accepted as unverified, so the M1 receipt rule applies to its no-shows.
      const v = stop.hidden ? 'unverified_location' : verifyArrival(stop, [...(s.track ?? []), s.fix], e.occurredAt);
      if (v === 'far') return reject('NOT_AT_STOP');
      return { outcome: 'ACCEPTED', effect: { kind: 'ARRIVE', stopId: stop.id, confirmOnly: stop.status === 'ARRIVED' }, verified: v };
    }

    case 'DEPARTED': {
      if (!RUNNING.includes(status)) return reject('TRIP_NOT_STARTED');
      const stop = s.stops.find((x) => x.seq === e.stopSeq);
      if (!stop) return reject('VALIDATION_FAILED');
      if (stop.status === 'DEPARTED') return dup();
      if (stop.status !== 'ARRIVED') return gap ? retry() : reject('STOP_NOT_ARRIVED');
      if (s.passengers.some((p) => p.pickupSeq === stop.seq && p.status === 'PENDING')) return gap ? retry() : reject('UNRESOLVED_PASSENGERS');
      return { outcome: 'ACCEPTED', effect: { kind: 'DEPART', stopId: stop.id } };
    }

    case 'BOARDED':
    case 'NO_SHOW':
    case 'DROPPED':
      if (!RUNNING.includes(status)) return reject('TRIP_NOT_STARTED');
      return decideOutcome(s, e, now, gap);

    case 'COMPLETE_TRIP':
      if (!RUNNING.includes(status)) return gap ? retry() : reject('TRIP_NOT_STARTED');
      if (s.passengers.some((p) => p.status === 'BOARDED')) return gap ? retry() : reject('PASSENGERS_ON_BOARD');
      return { outcome: 'ACCEPTED', effect: { kind: 'COMPLETE', from: status as PlannedTripStatus } };
  }
  return reject('VALIDATION_FAILED');
}

/** BOARDED / NO_SHOW / DROPPED against the seat and its stops: while the trip runs, or in the D1 settle grace. */
function decideOutcome(s: TripSnapshot, e: EventIn, now: number, gap: boolean): Decision {
  const p = s.passengers.find((x) => x.id === e.passengerTripId);
  if (!p) return reject('NOT_FOUND');
  if (p.status === 'CANCELLED') return reject('INVALID_STATE');
  const to = e.type as 'BOARDED' | 'NO_SHOW' | 'DROPPED';
  // Same fact already recorded (by this app, another device or the dispatcher): nothing to change.
  if (p.status === to || (to === 'BOARDED' && p.status === 'DROPPED')) return dup();
  if (to === 'DROPPED') {
    if (p.status === 'PENDING') return gap ? retry() : reject('INVALID_STATE');
    if (!driverOutcomeAllowed(p.status, to)) return reject('CONFLICT');
    const early = e.stopSeq !== undefined && e.stopSeq !== p.dropSeq;
    if (early && !e.reasonCode) return reject('NOT_AT_DROP_STOP');
    // R-3: a drop at a stop whose arrival is doubtful is accepted but goes to the dispatcher for review.
    const at = s.stops.find((x) => x.seq === (e.stopSeq ?? p.dropSeq));
    return { outcome: 'ACCEPTED', effect: { kind: 'OUTCOME', passengerTripId: p.id, from: p.status, to, earlyDrop: early }, ...(doubtful(at) ? { review: 'DROPPED_UNVERIFIED_ARRIVAL' as const } : {}) };
  }
  if (!driverOutcomeAllowed(p.status, to)) return reject('CONFLICT');
  const pickup = s.stops.find((x) => x.seq === p.pickupSeq);
  if (!pickup || (pickup.status !== 'ARRIVED' && pickup.status !== 'DEPARTED')) return gap ? retry() : reject('STOP_NOT_ARRIVED');
  // R-1: the no-show's time never counts beyond the server's now (a device clock up to 2 min fast cannot shorten
  // the wait).
  const noShowAt = Math.min(e.occurredAt.getTime(), now);
  if (to === 'NO_SHOW' && pickup.actualArrival && noShowAt - pickup.actualArrival.getTime() < L.noShowMinWaitMin * MIN) return reject('WAIT_NOT_ELAPSED');
  if (to === 'NO_SHOW' && doubtful(pickup)) {
    // M1 / R-2: an arrival the GPS did not confirm, or one reported retroactively, starts the wait when the server
    // heard of it, never earlier. RETRY: the queue keeps it and sends it again later.
    const from = Math.max(pickup.actualArrival?.getTime() ?? 0, pickup.arrivalReceivedAt?.getTime() ?? now);
    if (now - from < L.noShowMinWaitMin * MIN) return retry('WAIT_NOT_ELAPSED');
    return { outcome: 'ACCEPTED', effect: { kind: 'OUTCOME', passengerTripId: p.id, from: p.status, to, earlyDrop: false }, review: pickup.arrivalUnverified ? 'NO_SHOW_UNVERIFIED_ARRIVAL' : 'NO_SHOW_LATE_ARRIVAL' };
  }
  // R-3: BOARDED after a doubtful arrival is accepted (boarding cannot be proven) but reviewed like a no-show.
  if (to === 'BOARDED' && doubtful(pickup)) return { outcome: 'ACCEPTED', effect: { kind: 'OUTCOME', passengerTripId: p.id, from: p.status, to, earlyDrop: false }, review: 'BOARDED_UNVERIFIED_ARRIVAL' };
  return { outcome: 'ACCEPTED', effect: { kind: 'OUTCOME', passengerTripId: p.id, from: p.status, to, earlyDrop: false } };
}

/**
 * Mirror an accepted effect in the snapshot so later events of the same batch see it. meta.now = server receipt,
 * meta.verified = the ARRIVED's GPS check (an unverified or late arrival keeps its receipt time for the NO_SHOW wait).
 * An arrival is late (R-2) when the server receives it more than arrivalFixMaxSkewMs after its (clamped) time.
 */
export function applyToSnapshot(s: TripSnapshot, effect: Effect, at: Date, meta: { now?: number; verified?: 'gps' | 'unverified_location' | null } = {}): void {
  switch (effect.kind) {
    case 'ACKNOWLEDGE':
      s.acknowledgedAt = at;
      break;
    case 'ARRIVE': {
      const stop = s.stops.find((x) => x.id === effect.stopId)!;
      if (stop.status === 'PENDING') {
        const now = meta.now ?? Date.now();
        const unverified = meta.verified === 'unverified_location';
        const late = arrivalIsLate(at, now);
        Object.assign(stop, { status: 'ARRIVED', actualArrival: at, arrivalUnverified: unverified, arrivalLate: late, arrivalReceivedAt: unverified || late ? new Date(now) : null });
      }
      break;
    }
    case 'DEPART':
      s.stops.find((x) => x.id === effect.stopId)!.status = 'DEPARTED';
      break;
    case 'OUTCOME':
      s.passengers.find((x) => x.id === effect.passengerTripId)!.status = effect.to;
      break;
    case 'COMPLETE':
      s.plannedTripStatus = 'COMPLETED';
      for (const stop of s.stops) if (stop.status === 'PENDING') stop.status = 'SKIPPED';
      break;
    case 'OVERLAY':
      if (effect.overlay === 'DELAY') s.lastDelayAt = new Date(meta.now ?? Date.now());
      break;
  }
}

/** Re-check R-2: an ARRIVED received more than arrivalFixMaxSkewMs after the time it is stored at is retroactive. */
export function arrivalIsLate(at: Date, receivedAt: number): boolean {
  return receivedAt - at.getTime() > L.arrivalFixMaxSkewMs;
}

/** Whether an online-only command's device time is fresh enough to execute (else 409 STALE_COMMAND). */
export function onlineCommandFresh(occurredAt: string, now: number): boolean {
  const ms = Date.parse(occurredAt);
  return Number.isFinite(ms) && ms <= now + L.maxFutureSkewMs && now - ms <= L.onlineCommandMaxAgeMs;
}

/** A trip may be started from plannedStart − startEarlyMin until plannedEnd + startLateMin. */
export function withinStartWindow(plannedStart: Date, plannedEnd: Date, now: number): boolean {
  return now >= plannedStart.getTime() - L.startEarlyMin * MIN && now <= plannedEnd.getTime() + L.startLateMin * MIN;
}

/** Licence still valid today (a missing expiry is not blocking: the document gate is the fleet's Documents module). */
export function licenceValid(licenseExpiry: Date | null, now: number): boolean {
  if (!licenseExpiry) return true;
  return licenseExpiry.getTime() + 86_400_000 > now;
}
