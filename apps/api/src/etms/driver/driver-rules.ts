import {
  DRIVER_LIMITS as L,
  DRIVER_TRIP_EVENT_TYPES,
  driverOutcomeAllowed,
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

export type StopSnap = { id: string; seq: number; status: PlannedStopStatus; plannedArrival: Date; actualArrival: Date | null; lat: number; lng: number; radiusM: number };
export type PassengerSnap = { id: string; status: TransportPassengerStatus; pickupSeq: number; dropSeq: number };

export interface TripSnapshot {
  plannedTripStatus: PlannedTripStatus | null;
  publishedAt: Date | null;
  acknowledgedAt: Date | null;
  /** The trip's PlannedTrip is (still) assigned to the caller's driver. */
  assigned: boolean;
  plannedStart: Date;
  stops: StopSnap[];
  passengers: PassengerSnap[];
  /** Highest client seq stored for this trip from this driver (null = none yet). */
  lastSeq: number | null;
  /** The vehicle's latest fix (live cache), for ARRIVED verification; null = none. */
  fix: { lat: number; lng: number; at: Date } | null;
}

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
  | { outcome: 'ACCEPTED'; effect: Effect; verified?: 'gps' | 'unverified_location' | null; code?: null }
  | { outcome: Exclude<DriverTripEventOutcome, 'ACCEPTED'>; code: DriverErrorCode | 'ALREADY_RECORDED'; effect?: undefined; verified?: undefined };

const OPEN: readonly (PlannedTripStatus | null)[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];
const RUNNING: readonly (PlannedTripStatus | null)[] = ['STARTED', 'IN_PROGRESS'];
const MIN = 60_000;

const reject = (code: DriverErrorCode): Decision => ({ outcome: 'REJECTED', code });
const late = (code: DriverErrorCode = 'TRIP_CLOSED'): Decision => ({ outcome: 'LATE', code });
const dup = (): Decision => ({ outcome: 'DUPLICATE', code: 'ALREADY_RECORDED' });
const retry = (): Decision => ({ outcome: 'RETRY', code: 'OUT_OF_ORDER' });

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

/** ARRIVED vs the vehicle GPS (09 §4.4): a fix near occurredAt within k × radius → gps; far → NOT_AT_STOP; none → unverified. */
export function verifyArrival(stop: StopSnap, fix: TripSnapshot['fix'], at: Date): 'gps' | 'unverified_location' | 'far' {
  if (!fix || Math.abs(fix.at.getTime() - at.getTime()) > L.arrivalFixMaxSkewMs) return 'unverified_location';
  const d = haversineMeters(fix.lat, fix.lng, stop.lat, stop.lng);
  return d <= L.arrivalRadiusFactor * Math.max(stop.radiusM, 50) ? 'gps' : 'far';
}

/** Decide one event against the snapshot. Pure. */
export function decide(s: TripSnapshot, e: EventIn, now: number): Decision {
  if (e.type === 'START_TRIP') return reject('ONLINE_ONLY');
  if (!isDriverEventType(e.type)) return reject('VALIDATION_FAILED');
  if (!s.assigned) return reject('NOT_ASSIGNED');
  if (!clockOk(e.occurredAt, s.plannedStart, now)) return reject('CLOCK_SKEW');
  const gap = e.seq > (s.lastSeq ?? 0) + 1;
  const status = s.plannedTripStatus;

  // A trip the dispatcher (or the timeout sweeper / GPS) closed: queued events change nothing (dispatcher wins).
  if (!OPEN.includes(status)) {
    if (e.type === 'COMPLETE_TRIP' && status === 'COMPLETED') return dup();
    return late('TRIP_CLOSED');
  }

  switch (e.type) {
    case 'ACKNOWLEDGE':
      if (!s.publishedAt) return reject('INVALID_STATE');
      return s.acknowledgedAt ? dup() : { outcome: 'ACCEPTED', effect: { kind: 'ACKNOWLEDGE' } };

    case 'REPORT_DELAY':
      return { outcome: 'ACCEPTED', effect: { kind: 'OVERLAY', overlay: 'DELAY' } };
    case 'REPORT_BREAKDOWN':
      return { outcome: 'ACCEPTED', effect: { kind: 'OVERLAY', overlay: 'BREAKDOWN' } };

    case 'ARRIVED': {
      if (!RUNNING.includes(status)) return reject('TRIP_NOT_STARTED');
      const stop = s.stops.find((x) => x.seq === e.stopSeq);
      if (!stop) return reject('VALIDATION_FAILED');
      if (stop.status === 'SKIPPED') return reject('INVALID_STATE');
      if (stop.status === 'DEPARTED') return dup();
      const v = verifyArrival(stop, s.fix, e.occurredAt);
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
    case 'DROPPED': {
      if (!RUNNING.includes(status)) return reject('TRIP_NOT_STARTED');
      const p = s.passengers.find((x) => x.id === e.passengerTripId);
      if (!p) return reject('NOT_FOUND');
      if (p.status === 'CANCELLED') return reject('INVALID_STATE');
      const to = e.type;
      // Same fact already recorded (by this app, another device or the dispatcher): nothing to change.
      if (p.status === to || (to === 'BOARDED' && p.status === 'DROPPED')) return dup();
      if (to === 'DROPPED') {
        if (p.status === 'PENDING') return gap ? retry() : reject('INVALID_STATE');
        if (!driverOutcomeAllowed(p.status, to)) return reject('CONFLICT');
        const early = e.stopSeq !== undefined && e.stopSeq !== p.dropSeq;
        if (early && !e.reasonCode) return reject('NOT_AT_DROP_STOP');
        return { outcome: 'ACCEPTED', effect: { kind: 'OUTCOME', passengerTripId: p.id, from: p.status, to, earlyDrop: early } };
      }
      if (!driverOutcomeAllowed(p.status, to)) return reject('CONFLICT');
      const pickup = s.stops.find((x) => x.seq === p.pickupSeq);
      if (!pickup || (pickup.status !== 'ARRIVED' && pickup.status !== 'DEPARTED')) return gap ? retry() : reject('STOP_NOT_ARRIVED');
      if (to === 'NO_SHOW' && pickup.actualArrival && e.occurredAt.getTime() - pickup.actualArrival.getTime() < L.noShowMinWaitMin * MIN) return reject('WAIT_NOT_ELAPSED');
      return { outcome: 'ACCEPTED', effect: { kind: 'OUTCOME', passengerTripId: p.id, from: p.status, to, earlyDrop: false } };
    }

    case 'COMPLETE_TRIP':
      if (!RUNNING.includes(status)) return gap ? retry() : reject('TRIP_NOT_STARTED');
      if (s.passengers.some((p) => p.status === 'BOARDED')) return gap ? retry() : reject('PASSENGERS_ON_BOARD');
      return { outcome: 'ACCEPTED', effect: { kind: 'COMPLETE', from: status as PlannedTripStatus } };
  }
  return reject('VALIDATION_FAILED');
}

/** Mirror an accepted effect in the snapshot so later events of the same batch see it. */
export function applyToSnapshot(s: TripSnapshot, effect: Effect, at: Date): void {
  switch (effect.kind) {
    case 'ACKNOWLEDGE':
      s.acknowledgedAt = at;
      break;
    case 'ARRIVE': {
      const stop = s.stops.find((x) => x.id === effect.stopId)!;
      if (stop.status === 'PENDING') Object.assign(stop, { status: 'ARRIVED', actualArrival: at });
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
      break;
  }
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
