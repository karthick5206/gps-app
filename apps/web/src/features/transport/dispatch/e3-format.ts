/**
 * Pure helpers of the E3 transport screens (shifts, schedules, bookings, dispatch, trips, My transport). No React, DOM
 * or path aliases, so `node --test` runs them. Labels are English i18n keys; components pass them through `t()`.
 * Docs: employee-transport 02 §5.3 (outcomes; GPS never proves boarding), 05 §3–4 (contract, error codes), 07 §4
 * (occupancy as text + bar, never colour alone; no invented ETA).
 */
import type {
  EtaValue,
  TransportBookingSource,
  TransportBookingStatus,
  TransportDirection,
  TransportPassengerOutcome,
  TransportPassengerStatus,
  TransportTripAction,
  TransportTripDerivedState,
  TransportTripPassengerDto,
} from '@veetracer/shared';

export type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'muted';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

// ───────────────────────────── Bookings ─────────────────────────────

export const BOOKING_STATUS_META: Record<TransportBookingStatus, { label: string; tone: Tone; hint: string }> = {
  REQUESTED: { label: 'Needs approval', tone: 'warning', hint: 'Held until a dispatcher approves it.' },
  PENDING_ASSIGNMENT: { label: 'Waiting for a seat', tone: 'info', hint: 'Approved; not on a trip yet.' },
  ASSIGNED: { label: 'Assigned', tone: 'success', hint: 'Seated on a published trip.' },
  CONFIRMED: { label: 'Confirmed', tone: 'success', hint: 'Seated and confirmed.' },
  REJECTED: { label: 'Rejected', tone: 'destructive', hint: 'Refused by a dispatcher.' },
  CANCELLED: { label: 'Cancelled', tone: 'muted', hint: 'Cancelled; no trip will pick it up.' },
  EXPIRED: { label: 'Expired', tone: 'muted', hint: 'The window passed without a seat.' },
  WAITLISTED: { label: 'Waitlisted', tone: 'warning', hint: 'Waiting for capacity; approve it to queue it.' },
  FAILED: { label: 'Failed', tone: 'destructive', hint: 'Could not be processed.' },
};

/** Status chips of the bookings list, in workflow order. */
export const BOOKING_STATUS_CHIPS: readonly TransportBookingStatus[] = ['REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'WAITLISTED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

export const BOOKING_SOURCE_LABEL: Record<TransportBookingSource, string> = { ADHOC: 'One-off', SCHEDULE: 'Recurring' };

export const DIRECTION_LABEL: Record<TransportDirection, string> = { IN: 'To site (login)', OUT: 'From site (logout)' };
export const DIRECTION_SHORT: Record<TransportDirection, string> = { IN: 'Login', OUT: 'Logout' };

/** Bookings of a selection that bulk approve can act on (REQUESTED / WAITLISTED). */
export function approvableIds(rows: readonly { id: string; status: TransportBookingStatus }[], selected: ReadonlySet<string>): string[] {
  return rows.filter((r) => selected.has(r.id) && (r.status === 'REQUESTED' || r.status === 'WAITLISTED')).map((r) => r.id);
}

/** "Cut-off in 25 min" / "After cut-off" / null when the booking has no cut-off or is final. */
export function cutoffLabel(cutoffAt: string | null, status: TransportBookingStatus, nowMs: number, t: Translate = english): string | null {
  if (!cutoffAt || ['REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(status)) return null;
  const ms = Date.parse(cutoffAt) - nowMs;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return t('After cut-off');
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return t('Cut-off in {{n}} min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return t('Cut-off in {{n}} h', { n: h });
  return null;
}

// ───────────────────────────── Trips ─────────────────────────────

export const TRIP_STATE_META: Record<TransportTripDerivedState, { label: string; tone: Tone; live?: boolean }> = {
  PLANNED: { label: 'Planned', tone: 'neutral' },
  PUBLISHED: { label: 'Published', tone: 'info' },
  DRIVER_ACKNOWLEDGED: { label: 'Driver acknowledged', tone: 'info' },
  EN_ROUTE: { label: 'En route', tone: 'info', live: true },
  AT_STOP: { label: 'At a stop', tone: 'warning', live: true },
  IN_PROGRESS: { label: 'In progress', tone: 'info', live: true },
  COMPLETED: { label: 'Completed', tone: 'success' },
  INCOMPLETE: { label: 'Incomplete', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  DETACHED: { label: 'Vehicle removed', tone: 'muted' },
};

export const TRIP_ACTION_LABEL: Record<TransportTripAction, string> = {
  start: 'Start trip',
  arrive: 'Mark arrived',
  complete: 'Complete trip',
  cancel: 'Cancel trip',
  acknowledge: 'Driver acknowledged',
  repeat: 'Repeat to date',
};

/** A trip whose seats can still change through dispatch (the PlannedTrip has not started). */
export function isEditableTrip(state: TransportTripDerivedState): boolean {
  return state === 'PLANNED' || state === 'PUBLISHED' || state === 'DRIVER_ACKNOWLEDGED';
}

// ───────────────────────────── Passenger outcomes ─────────────────────────────

export const PASSENGER_STATUS_META: Record<TransportPassengerStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting', tone: 'neutral' },
  BOARDED: { label: 'Boarded', tone: 'success' },
  NO_SHOW: { label: 'No-show', tone: 'destructive' },
  DROPPED: { label: 'Dropped', tone: 'success' },
  CANCELLED: { label: 'Removed', tone: 'muted' },
};

export const OUTCOME_ACTION_LABEL: Record<TransportPassengerOutcome, string> = {
  BOARDED: 'Boarded',
  NO_SHOW: 'No-show',
  DROPPED: 'Dropped',
};

/**
 * What the manifest shows for one passenger. The stop being reached (GPS or dispatcher) with no recorded outcome is
 * "Outcome not recorded" (02 §5.3): never shown as boarded.
 */
export function passengerOutcomeView(p: Pick<TransportTripPassengerDto, 'status' | 'outcomeMissing' | 'outcomeSource'>): { label: string; tone: Tone; source: string | null } {
  if (p.status === 'PENDING' && p.outcomeMissing) return { label: 'Outcome not recorded', tone: 'warning', source: null };
  const m = PASSENGER_STATUS_META[p.status];
  const source = p.outcomeSource === 'WEB' ? 'Recorded by the dispatcher' : p.outcomeSource === 'DRIVER_APP' ? 'Recorded in the driver app' : null;
  return { label: m.label, tone: m.tone, source: p.status === 'PENDING' || p.status === 'CANCELLED' ? null : source };
}

/** Passengers still waiting for an outcome (blocks Complete on the server: UNRESOLVED_PASSENGERS). */
export function unresolvedCount(passengers: readonly Pick<TransportTripPassengerDto, 'status'>[]): number {
  return passengers.filter((p) => p.status === 'PENDING').length;
}

// ───────────────────────────── Occupancy ─────────────────────────────

export type OccupancyLevel = 'unknown' | 'empty' | 'available' | 'full' | 'over';

export interface Occupancy {
  used: number;
  capacity: number | null;
  free: number | null;
  /** 0..1 for the bar (clamped). */
  ratio: number;
  level: OccupancyLevel;
}

/** Seats used / capacity for the occupancy bar ("3 / 6 seats"); capacity null = seats not set on the vehicle. */
export function occupancy(used: number, capacity: number | null | undefined): Occupancy {
  const u = Math.max(0, Math.round(used || 0));
  if (capacity === null || capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) return { used: u, capacity: null, free: null, ratio: 0, level: 'unknown' };
  const cap = Math.round(capacity);
  const level: OccupancyLevel = u === 0 ? 'empty' : u > cap ? 'over' : u === cap ? 'full' : 'available';
  return { used: u, capacity: cap, free: Math.max(0, cap - u), ratio: Math.min(1, u / cap), level };
}

export function occupancyLabel(o: Occupancy, t: Translate = english): string {
  if (o.capacity === null) return t('{{used}} seats used · seats not set', { used: o.used });
  return t('{{used}} / {{capacity}} seats', { used: o.used, capacity: o.capacity });
}

// ───────────────────────────── ETA ─────────────────────────────

/** Note shown with every routing estimate (doc 07 §4.3): times are road estimates without live traffic. */
export const ETA_ESTIMATE_NOTE = 'estimate · no live traffic';

export interface EtaView {
  /** The time to show, or null (never a guessed number). */
  at: string | null;
  /** Text after the time, or the whole text when there is no time. */
  note: string;
  degraded: boolean;
}

/**
 * How to show an ETA. ROAD = routing estimate (labelled "estimate · no live traffic"), TRACKER = the tracker's own
 * next-stop ETA. Degraded / missing values give a text reason instead of a time.
 */
export function etaView(eta: EtaValue | null | undefined): EtaView {
  if (!eta) return { at: null, note: 'No ETA', degraded: false };
  if (eta.at && eta.model === 'ROAD') return { at: eta.at, note: ETA_ESTIMATE_NOTE, degraded: false };
  if (eta.at && eta.model === 'TRACKER') return { at: eta.at, note: 'from the vehicle tracker', degraded: false };
  switch (eta.degraded) {
    case 'ROUTING_UNAVAILABLE':
      return { at: null, note: 'Routing unavailable: no ETA', degraded: true };
    case 'NO_FIX':
      return { at: null, note: 'No vehicle position: no ETA', degraded: true };
    case 'NO_ROUTE':
      return { at: null, note: 'No road route found: no ETA', degraded: true };
    case 'NO_PICKUP':
      return { at: null, note: 'No pickup point to route to: no ETA', degraded: true };
    default:
      return { at: null, note: 'No ETA', degraded: false };
  }
}

/** Straight-line distance, always labelled as such ("1.2 km straight line"); null when unknown. */
export function straightLineLabel(m: number | null | undefined, t: Translate = english): string | null {
  if (m === null || m === undefined || !Number.isFinite(m)) return null;
  if (m < 1000) return t('{{m}} m straight line', { m: Math.round(m) });
  return t('{{km}} km straight line', { km: (m / 1000).toFixed(m < 10_000 ? 1 : 0) });
}

/** Candidate refusal / warning reasons (DispatchCandidateDto.reasons) as text. */
export const CANDIDATE_REASON_LABEL: Record<string, string> = {
  NO_SEATS_SET: 'Seats not set on the vehicle',
  CAPACITY: 'Not enough free seats',
  VEHICLE_BUSY: 'Vehicle busy at that time',
  CONSENT_REQUIRED: 'Passenger consent missing',
  NEEDS_LOCATION: 'Pickup or drop point missing',
  INVALID_STATE: 'Booking not approved yet',
};

export function candidateReason(code: string): string {
  return CANDIDATE_REASON_LABEL[code] ?? code;
}

// ───────────────────────────── Errors ─────────────────────────────

/** Friendly text per API error code (05 §4); the server message is shown as detail. */
export const E3_ERROR_TEXT: Record<string, string> = {
  VERSION_CONFLICT: 'Someone changed this meanwhile. The latest data was loaded; check it and try again.',
  CAPACITY_EXCEEDED: 'Not enough free seats on that vehicle.',
  CONSENT_REQUIRED: 'The passenger has not consented to transport use of their pickup location, so they cannot be assigned.',
  VEHICLE_BUSY: 'The vehicle already has a trip at that time.',
  DRIVER_BUSY: 'The driver already has a trip at that time.',
  NO_SEATS_SET: "Set the vehicle's passenger seats first (Vehicle seats).",
  NEEDS_LOCATION: 'The booking has no pickup or drop point yet.',
  INVALID_STATE: 'This is no longer possible in its current state. Reload and try again.',
  TRIP_CLOSED: 'The trip has started or closed; it can no longer be changed here.',
  AFTER_CUTOFF: 'The booking cut-off has passed.',
  BOOKING_DUPLICATE: 'The passenger already has a booking for that day and direction.',
  UNRESOLVED_PASSENGERS: 'Record an outcome (boarded / no-show) for every passenger before completing the trip.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already sent with other content. Review the changes and publish again.',
  IDEMPOTENCY_KEY_REQUIRED: 'The request was missing its retry key. Try again.',
  MANAGED_BY_ETMS: 'This trip is managed by employee transport. Change it from Dispatch.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  NOT_A_PASSENGER: 'Your account is not linked to an active passenger profile.',
  FORBIDDEN_GRANT: 'You do not have access to this.',
};

export function e3ErrorText(code: string | null | undefined): string | null {
  return code ? (E3_ERROR_TEXT[code] ?? null) : null;
}

// ───────────────────────────── Times ─────────────────────────────

/** "09:00 – 18:00", with "(next day)" for an overnight shift. */
export function shiftTimesLabel(startMin: number, endMin: number, t: Translate = english): string {
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const base = `${hhmm(startMin)} – ${hhmm(endMin)}`;
  return endMin < startMin ? `${base} ${t('(next day)')}` : base;
}

/** UUID v4 for clientEventId / Idempotency-Key (crypto.randomUUID when available). */
export function newUuid(rand: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(rand() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
