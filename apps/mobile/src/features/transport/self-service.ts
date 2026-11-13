/**
 * Passenger self-service helpers (pure, `node --test`; E5 WP 5.3, doc 05 §2.8, doc 08 §4.2). The server decides
 * everything (cut-off, horizon, consent, own records); these only shape the forms and the wording. No runtime import
 * from @veetracer/shared, so this file runs under plain `node --test`.
 */
import type { MeBookableShiftDto, MeConfirmKind, MeCreateBookingInput, MePlaceRef, MeReportCategory, MeTripDto, TransportDirection, TransportPassengerStatus } from '@veetracer/shared';

const MIN = 60_000;
const DAY_MS = 86_400_000;

/** Mirrors TRANSPORT_SELF_LIMITS of @veetracer/shared. */
export const SELF_LIMITS = { maxDaysAhead: 14, maxPlaces: 10, placeLabelMax: 60, bookingNoteMax: 200, reportNoteMax: 500, reportBeforeStartMin: 120, reportAfterEndMin: 48 * 60 } as const;

/** Today's day key (YYYY-MM-DD) in a time zone. */
export function todayKeyIn(timeZone: string, nowMs: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDayKeys(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday (the shift `days` convention). */
export function weekdayOfKey(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Days the passenger may pick for a shift: today … today + maxDaysAhead on which the shift runs. */
export function bookableDays(today: string, shiftDays: readonly number[], maxDaysAhead: number = SELF_LIMITS.maxDaysAhead): string[] {
  const out: string[] = [];
  for (let i = 0; i <= maxDaysAhead; i++) {
    const d = addDayKeys(today, i);
    if (shiftDays.includes(weekdayOfKey(d))) out.push(d);
  }
  return out;
}

/** "09:00" from minutes after midnight. */
export function hhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** The time the passenger is travelling for: login (IN) or logout (OUT). */
export function shiftTimeFor(shift: Pick<MeBookableShiftDto, 'startMin' | 'endMin'>, direction: TransportDirection): string {
  return hhmm(direction === 'IN' ? shift.startMin : shift.endMin);
}

export interface BookingForm {
  shiftId: string | null;
  serviceDate: string | null;
  direction: TransportDirection;
  place: MePlaceRef | null;
  note: string;
}

/** The request body, or the English reason (translate where shown) why it cannot be sent yet. */
export function bookingRequest(f: BookingForm): { ok: true; body: MeCreateBookingInput } | { ok: false; error: string } {
  if (!f.shiftId) return { ok: false, error: 'Choose a shift.' };
  if (!f.serviceDate) return { ok: false, error: 'Choose a day.' };
  if (!f.place) return { ok: false, error: 'Choose where you are picked up or dropped.' };
  if (f.place.kind === 'SAVED' && !f.place.placeId) return { ok: false, error: 'Choose a saved place.' };
  if (f.place.kind === 'STOP' && !f.place.poiId) return { ok: false, error: 'Choose a stop.' };
  const note = f.note.trim().slice(0, SELF_LIMITS.bookingNoteMax);
  return { ok: true, body: { serviceDate: f.serviceDate, direction: f.direction, shiftId: f.shiftId, place: f.place, ...(note ? { note } : {}) } };
}

type TripTimes = Pick<MeTripDto, 'plannedStart' | 'plannedEnd' | 'myStatus' | 'derivedState'>;

/**
 * Whether to offer "I was picked up / dropped" (owner decision P5: a dispute signal; the driver's record wins). The
 * server accepts it only inside the passenger's vehicle window (planned start − 30 min … end + 10 min) or, for a
 * recorded no-show, until 2 h after the planned end.
 */
export function canConfirm(trip: TripTimes, nowMs: number): boolean {
  if (!trip.plannedStart || !trip.plannedEnd || trip.derivedState === 'CANCELLED' || trip.myStatus === 'CANCELLED') return false;
  const start = Date.parse(trip.plannedStart);
  const end = Date.parse(trip.plannedEnd);
  if (trip.myStatus === 'NO_SHOW') return nowMs >= start - 30 * MIN && nowMs <= end + 120 * MIN;
  return nowMs >= start - 30 * MIN && nowMs <= end + 10 * MIN && trip.myStatus !== 'DROPPED';
}

/** Which confirmations make sense now: pickup until boarded, drop once boarded. */
export function confirmKinds(status: TransportPassengerStatus): MeConfirmKind[] {
  if (status === 'PENDING' || status === 'NO_SHOW') return ['PICKUP'];
  if (status === 'BOARDED') return ['DROP'];
  return [];
}

/** Reports are accepted from 2 h before the planned start until 48 h after the planned end. */
export function canReport(trip: Pick<MeTripDto, 'plannedStart' | 'plannedEnd'>, nowMs: number): boolean {
  if (!trip.plannedStart || !trip.plannedEnd) return false;
  return nowMs >= Date.parse(trip.plannedStart) - SELF_LIMITS.reportBeforeStartMin * MIN && nowMs <= Date.parse(trip.plannedEnd) + SELF_LIMITS.reportAfterEndMin * MIN;
}

export const REPORT_CATEGORY_LABEL: Record<MeReportCategory, string> = {
  DELAY: 'The vehicle is late',
  MISSED_PICKUP: 'I was not picked up',
  VEHICLE: 'Problem with the vehicle',
  DRIVER_BEHAVIOUR: 'Driver behaviour',
  ROUTE: 'Wrong route or stop',
  OTHER: 'Something else',
};

export const CONFIRM_LABEL: Record<MeConfirmKind, string> = { PICKUP: 'I was picked up', DROP: 'I was dropped off' };

/** Passenger-facing text (English source) for self-service API error codes; null = use the server message. */
export function selfErrorText(code: string | null | undefined, action: 'book' | 'place' | 'confirm' | 'report'): string | null {
  switch (code) {
    case 'SELF_BOOKING_DISABLED':
      return 'Your company has not switched on booking in the app. Contact your transport desk.';
    case 'AFTER_CUTOFF':
      return 'The booking cut-off for this trip has passed. Call your transport desk.';
    case 'BOOKING_DUPLICATE':
      return 'You already have a booking for this day and direction.';
    case 'CONSENT_REQUIRED':
      return 'Allow the use of your location for transport (Privacy & consent) to use a personal place.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait and try again.';
    case 'TOO_MANY_OPEN_REQUESTS':
      return 'You already have 10 open ride requests. Wait until the desk handles them, or cancel one.';
    case 'INVALID_STATE':
      return action === 'report' ? 'Reports are accepted from shortly before the trip until two days after it.' : 'You can confirm a pickup or drop only during your trip.';
    case 'NOT_FOUND':
      return action === 'place' ? 'This place no longer exists.' : 'This trip is no longer assigned to you.';
    case 'NOT_A_PASSENGER':
      return 'Your account is not linked to an active passenger profile. Ask your transport desk.';
    default:
      return null;
  }
}

// ───────────── Labels shown by the self-service screens (English source; translated where shown) ─────────────

/** 0 = Sunday … 6. */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const EXCEPTION_LABEL: Record<string, string> = { SKIP: 'No trip (leave day)', OVERRIDE: 'Changed time or pickup' };
export const PICKUP_MODE_LABEL: Record<string, string> = { HOME: 'Home', STOP: 'Company stop' };

export type SosStageKey = 'QUEUED_ON_DEVICE' | 'UNDELIVERED' | 'RECEIVED' | 'ACKNOWLEDGED' | 'RESOLVED';
/** Honest SOS wording (doc 10 §6.3): never "help is on the way" before the desk acknowledged. */
export const SOS_STAGE_TEXT: Record<SosStageKey, { label: string; body: string; tone: 'warning' | 'info' | 'success' | 'destructive' | 'neutral' }> = {
  QUEUED_ON_DEVICE: { label: 'Not sent yet', body: 'Your SOS is saved on this phone and is being sent. Call if you need help now.', tone: 'warning' },
  UNDELIVERED: { label: 'Not delivered', body: 'Your SOS could not be delivered. Call the desk or the emergency number now.', tone: 'destructive' },
  RECEIVED: { label: 'Received by VeeTrax', body: 'VeeTrax received your SOS. It has not been acknowledged by the desk yet.', tone: 'info' },
  ACKNOWLEDGED: { label: 'Acknowledged by the desk', body: 'The transport desk has seen your SOS.', tone: 'success' },
  RESOLVED: { label: 'Closed', body: 'The desk closed this SOS.', tone: 'neutral' },
};

/** Every English string self-service.ts hands to t() (the hi / ta completeness test reads it). */
export function selfServiceLabelStrings(): string[] {
  const errors = ['book', 'place', 'confirm', 'report'].flatMap((a) =>
    ['SELF_BOOKING_DISABLED', 'AFTER_CUTOFF', 'BOOKING_DUPLICATE', 'CONSENT_REQUIRED', 'RATE_LIMITED', 'TOO_MANY_OPEN_REQUESTS', 'INVALID_STATE', 'NOT_FOUND', 'NOT_A_PASSENGER'].map((c) => selfErrorText(c, a as 'book')),
  );
  const form = ['Choose a shift.', 'Choose a day.', 'Choose where you are picked up or dropped.', 'Choose a saved place.', 'Choose a stop.'];
  return [
    ...new Set(
      [
        ...Object.values(REPORT_CATEGORY_LABEL),
        ...Object.values(CONFIRM_LABEL),
        ...errors,
        ...form,
        ...WEEKDAY_SHORT,
        ...Object.values(EXCEPTION_LABEL),
        ...Object.values(PICKUP_MODE_LABEL),
        ...Object.values(SOS_STAGE_TEXT).flatMap((s) => [s.label, s.body]),
      ].filter((s): s is string => !!s),
    ),
  ];
}
