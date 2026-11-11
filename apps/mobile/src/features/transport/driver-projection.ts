/**
 * Local projection of a driver trip (pure, `node --test`; doc 09 §6.5). The server trip (`DriverTripDetailDto`) is the
 * only source of "Confirmed"; queued events only add a "Pending sync" / "Rejected" / "Received late" badge next to the
 * server state, and let the driver move on (e.g. to the next stop) while offline. Nothing here invents a server state.
 */
import type { DriverPassengerDto, DriverStopDto, DriverTripDetailDto, DriverTripEventType } from '@veetracer/shared';
import type { ActionDisplay, QueuedEvent } from './event-queue';

// Same rule as event-queue.ts actionDisplay (kept local: pure modules have no runtime relative imports, for node --test).
function actionDisplay(serverConfirmed: boolean, local: readonly Pick<QueuedEvent, 'state'>[]): ActionDisplay {
  if (serverConfirmed) return 'CONFIRMED';
  const last = local[local.length - 1];
  return last ? last.state : 'NONE';
}

type Local = Pick<QueuedEvent, 'type' | 'state' | 'stopSeq' | 'passengerTripId' | 'code'> & Partial<Pick<QueuedEvent, 'occurredAt'>>;

/** Mirrors DRIVER_LIMITS.noShowMinWaitMin (literal: no runtime import in pure modules). */
export const NO_SHOW_WAIT_MS = 5 * 60_000;

function matching(local: readonly Local[], type: DriverTripEventType, key: Partial<Pick<Local, 'stopSeq' | 'passengerTripId'>>): Local[] {
  return local.filter((e) => e.type === type && (key.stopSeq === undefined || e.stopSeq === key.stopSeq) && (key.passengerTripId === undefined || e.passengerTripId === key.passengerTripId));
}

export interface ActionState {
  display: ActionDisplay;
  code: string | null;
}

function state(serverConfirmed: boolean, events: Local[]): ActionState {
  return { display: actionDisplay(serverConfirmed, events), code: events[events.length - 1]?.code ?? null };
}

/** ARRIVED / DEPARTED at a stop: confirmed by the server stop status, else the local event's state. */
export function stopActionState(stop: Pick<DriverStopDto, 'seq' | 'status'>, type: 'ARRIVED' | 'DEPARTED', local: readonly Local[]): ActionState {
  const confirmed = type === 'ARRIVED' ? stop.status === 'ARRIVED' || stop.status === 'DEPARTED' : stop.status === 'DEPARTED';
  return state(confirmed, matching(local, type, { stopSeq: stop.seq }));
}

/** BOARDED / NO_SHOW / DROPPED for a passenger: confirmed by the server status. */
export function passengerActionState(p: Pick<DriverPassengerDto, 'passengerTripId' | 'status'>, type: 'BOARDED' | 'NO_SHOW' | 'DROPPED', local: readonly Local[]): ActionState {
  const confirmed = p.status === type || (type === 'BOARDED' && p.status === 'DROPPED');
  return state(confirmed, matching(local, type, { passengerTripId: p.passengerTripId }));
}

/** The latest local outcome event for a passenger that is not yet confirmed (for its badge), else null. */
export function passengerPending(p: Pick<DriverPassengerDto, 'passengerTripId' | 'status'>, local: readonly Local[]): { type: 'BOARDED' | 'NO_SHOW' | 'DROPPED'; state: ActionState } | null {
  const mine = local.filter((e) => e.passengerTripId === p.passengerTripId && (e.type === 'BOARDED' || e.type === 'NO_SHOW' || e.type === 'DROPPED'));
  const last = mine[mine.length - 1];
  if (!last) return null;
  const type = last.type as 'BOARDED' | 'NO_SHOW' | 'DROPPED';
  const s = passengerActionState(p, type, local);
  return s.display === 'CONFIRMED' ? null : { type, state: s };
}

/**
 * Outcome buttons to offer at one stop: the server's `allowedEvents`, minus anything already waiting to sync for that
 * passenger; BOARDED / NO_SHOW only at the passenger's pickup stop, DROPPED only at their drop stop.
 */
export function passengerButtons(
  p: Pick<DriverPassengerDto, 'passengerTripId' | 'status' | 'allowedEvents' | 'pickupSeq' | 'dropSeq'>,
  local: readonly Local[],
  stopSeq: number,
): ('BOARDED' | 'NO_SHOW' | 'DROPPED')[] {
  const pending = local.filter((e) => e.passengerTripId === p.passengerTripId && e.state === 'PENDING');
  let out: ('BOARDED' | 'NO_SHOW' | 'DROPPED')[] = [...p.allowedEvents];
  // After a pending BOARDED the next step is DROPPED (driverOutcomeAllowed); after NO_SHOW / DROPPED nothing.
  if (pending.length) out = pending[pending.length - 1].type === 'BOARDED' ? ['DROPPED'] : [];
  return out.filter((o) => (o === 'DROPPED' ? stopSeq === p.dropSeq : stopSeq === p.pickupSeq));
}

/**
 * Event order (server rule STOP_NOT_ARRIVED): BOARDED / NO_SHOW at a pickup only once the stop is arrived, by the
 * vehicle GPS / an accepted ARRIVED (server status), or by an ARRIVED this phone has queued (sent first, FIFO).
 */
export function pickupUnlocked(stop: Pick<DriverStopDto, 'seq' | 'status'>, local: readonly Local[]): boolean {
  if (stop.status === 'ARRIVED' || stop.status === 'DEPARTED') return true;
  return local.some((e) => e.type === 'ARRIVED' && e.stopSeq === stop.seq && e.state === 'PENDING');
}

/**
 * When NO_SHOW becomes possible at a stop (server rule WAIT_NOT_ELAPSED: 5 min after the arrival): the server's actual
 * arrival, else the time of this phone's queued ARRIVED. 0 = arrived per the server without a time (the server decides);
 * null = not arrived.
 */
export function noShowAvailableAt(stop: Pick<DriverStopDto, 'seq' | 'status' | 'actualArrival'>, local: readonly Local[]): number | null {
  const server = stop.actualArrival ? Date.parse(stop.actualArrival) : Number.NaN;
  if (Number.isFinite(server)) return server + NO_SHOW_WAIT_MS;
  const mine = local.find((e) => e.type === 'ARRIVED' && e.stopSeq === stop.seq && e.state === 'PENDING' && e.occurredAt);
  if (mine?.occurredAt) return Date.parse(mine.occurredAt) + NO_SHOW_WAIT_MS;
  return stop.status === 'ARRIVED' || stop.status === 'DEPARTED' ? 0 : null;
}

/** "4:05" until `at` (ms), or null once it has passed. */
export function countdown(at: number, nowMs: number): string | null {
  const s = Math.ceil((at - nowMs) / 1000);
  if (s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The stop the driver is working on: the first stop that is neither departed nor skipped, counting a pending local
 * DEPARTED as departed (so the driver can continue offline). Null when every stop is done.
 */
export function currentStop<S extends Pick<DriverStopDto, 'seq' | 'status'>>(stops: readonly S[], local: readonly Local[]): S | null {
  const departedLocally = new Set(local.filter((e) => e.type === 'DEPARTED' && e.state === 'PENDING').map((e) => e.stopSeq));
  return [...stops].sort((a, b) => a.seq - b.seq).find((s) => s.status !== 'DEPARTED' && s.status !== 'SKIPPED' && !departedLocally.has(s.seq)) ?? null;
}

/** Trip-level command state (ACKNOWLEDGE / COMPLETE_TRIP). */
export function tripActionState(trip: Pick<DriverTripDetailDto, 'acknowledgedAt' | 'plannedTripStatus'>, type: 'ACKNOWLEDGE' | 'COMPLETE_TRIP', local: readonly Local[]): ActionState {
  const confirmed = type === 'ACKNOWLEDGE' ? !!trip.acknowledgedAt : trip.plannedTripStatus === 'COMPLETED';
  return state(confirmed, matching(local, type, {}));
}

/** Whether a trip-level button should still be offered (allowed by the server and not already waiting to sync). */
export function offerTripAction(allowed: boolean, s: ActionState): boolean {
  return allowed && s.display !== 'PENDING' && s.display !== 'CONFIRMED';
}
