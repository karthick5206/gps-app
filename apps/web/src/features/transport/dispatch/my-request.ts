/**
 * v1.15.1 passenger web (pure, `node --test`): the passenger's own "Request a ride" on Transport → My commute, and the
 * approval / cancel wording of "My bookings". Same behaviour as the mobile RequestRideScreen (WP 3.9 wave 2, D-A5 /
 * D-A7): the server decides everything (eligibility, consent, cut-off, horizon, duplicates, overlap, approval); these
 * helpers only shape the form, build the `POST /me/transport/requests` body and choose the passenger wording. Type-only
 * imports from @veetracer/shared, so this file runs under plain `node --test`.
 */
import type { MeAdhocEndRef, MeAdhocRequestInput, MeBookingDto, MeTransportPolicyDto, TransportBookingJourney, TransportDirection } from '@veetracer/shared';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

/**
 * Mirrors TRANSPORT_ADHOC_LIMITS (purposeMax, passengerWindowMinMin, passengerOpenMax), TRANSPORT_SELF_LIMITS
 * (bookingNoteMax, placeLabelMax, maxDaysAhead) and MeBookingCancelDto (reason ≤ 200).
 */
export const REQUEST_LIMITS = { purposeMax: 120, noteMax: 200, mapLabelMax: 60, maxDaysAhead: 14, windowMinMin: 10, openMax: 10, cancelReasonMax: 200 } as const;

const DAY_MS = 86_400_000;
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Wave-2 policy fields are optional on an older server (it then means "requests off"). */
export type RequestPolicy = Pick<MeTransportPolicyDto, 'selfBooking' | 'routingConsent' | 'maxDaysAhead' | 'cutoffMin' | 'shifts'> & { adhocRequests?: boolean; approvalRequired?: boolean; timeZone?: string | null };

/** The "Request a ride" action is shown only when self-booking and ad-hoc requests are both on (never a dead button). */
export function canRequestRide(p: Pick<RequestPolicy, 'selfBooking' | 'adhocRequests'> | null | undefined): boolean {
  return !!p && p.selfBooking === true && p.adhocRequests === true;
}

// ───────────── Ends (pickup / destination) ─────────────

export type EndKind = MeAdhocEndRef['kind'];
/** Ends that are personal points (D-A3): never used without the passenger's active routing consent. */
export const PERSONAL_ENDS: readonly EndKind[] = ['HOME', 'SAVED', 'MAP'];
export const END_KIND_LABEL: Record<EndKind, string> = { HOME: 'Home', SAVED: 'Saved place', PLACE: 'Company place', MAP: 'Map point', SHIFT_SITE: 'Shift site' };

export const CONSENT_EXPLANATION = 'Home, saved places and map points are your personal locations. They are used only with your transport consent (Privacy & consent).';

export function isPersonalEnd(end: Pick<MeAdhocEndRef, 'kind'> | null | undefined): boolean {
  return !!end && PERSONAL_ENDS.includes(end.kind);
}

/** Which end kinds the form offers for a journey (the shift site only on a commute). */
export function endKindsFor(journey: TransportBookingJourney): EndKind[] {
  return journey === 'COMMUTE' ? ['HOME', 'SAVED', 'PLACE', 'MAP', 'SHIFT_SITE'] : ['HOME', 'SAVED', 'PLACE', 'MAP'];
}

/** Whether an end kind can be chosen now, and the English reason (translate where shown) when it cannot. */
export function endKindAvailability(kind: EndKind, ctx: { routingConsent: boolean; journey: TransportBookingJourney; shiftId: string | null }): { ok: true } | { ok: false; reason: string } {
  if (PERSONAL_ENDS.includes(kind) && !ctx.routingConsent) return { ok: false, reason: CONSENT_EXPLANATION };
  if (kind === 'SHIFT_SITE' && ctx.journey !== 'COMMUTE') return { ok: false, reason: 'Only for a commute.' };
  if (kind === 'SHIFT_SITE' && !ctx.shiftId) return { ok: false, reason: 'Choose a shift first.' };
  return { ok: true };
}

/** Default ends of a commute: home → shift site to log in, shift site → home to log out (home only with consent). */
export function defaultCommuteEnds(direction: TransportDirection, routingConsent: boolean): { pickup: MeAdhocEndRef | null; destination: MeAdhocEndRef | null } {
  const home: MeAdhocEndRef | null = routingConsent ? { kind: 'HOME' } : null;
  const site: MeAdhocEndRef = { kind: 'SHIFT_SITE' };
  return direction === 'IN' ? { pickup: home, destination: site } : { pickup: site, destination: home };
}

// ───────────── Days, zone and times ─────────────

/** Today's date (YYYY-MM-DD) in a time zone; the UTC date when the zone is unknown. */
export function todayKeyIn(tz: string, nowMs: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/** Days the passenger may pick: today … today + maxDaysAhead; for a commute with a shift, only the shift's weekdays. */
export function requestDays(today: string, maxDaysAhead: number = REQUEST_LIMITS.maxDaysAhead, shiftDays?: readonly number[] | null): string[] {
  const out: string[] = [];
  const start = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(start)) return out;
  for (let i = 0; i <= Math.max(0, maxDaysAhead); i++) {
    const d = new Date(start + i * DAY_MS);
    if (shiftDays && !shiftDays.includes(d.getUTCDay())) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** "HH:MM" → minutes after midnight, or null when it is not a time. */
export function parseClock(v: string): number | null {
  const m = HHMM.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after midnight → "HH:MM" (wraps past midnight). */
export function minutesText(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The zone a request's day list and time window are read in (r115 B8): the company zone from the policy first, then
 * the chosen shift's zone, then the first shift's; the browser's zone only for an older server.
 */
export function requestTimeZone(policy: { timeZone?: string | null; shifts?: readonly { id: string; timeZone?: string | null }[] } | null | undefined, shiftId: string | null, browserZone: string): string {
  const valid = (z: string | null | undefined): z is string => typeof z === 'string' && z.trim().length > 0;
  if (valid(policy?.timeZone)) return policy.timeZone;
  const shifts = policy?.shifts ?? [];
  const chosen = shiftId ? shifts.find((s) => s.id === shiftId)?.timeZone : null;
  if (valid(chosen)) return chosen;
  if (valid(shifts[0]?.timeZone)) return shifts[0].timeZone;
  return browserZone;
}

/** ISO instant of a wall-clock time on a day in a time zone (same algorithm as the planner's zonedIso). */
export function zonedIso(day: string, minutes: number, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, Math.round(minutes));
  const offset = (ms: number) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
      const g = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - ms;
    } catch {
      return 0;
    }
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first)).toISOString();
}

// ───────────── Form → body ─────────────

export interface RequestForm {
  journey: TransportBookingJourney;
  serviceDate: string | null;
  direction: TransportDirection;
  shiftId: string | null;
  pickup: MeAdhocEndRef | null;
  destination: MeAdhocEndRef | null;
  /** "HH:MM" wall-clock in `timeZone`, or '' (no own window). */
  windowStart: string;
  windowEnd: string;
  purpose: string;
  note: string;
}

export interface RequestContext {
  routingConsent: boolean;
  /** Zone of the times (requestTimeZone). */
  timeZone: string;
}

/** Which part of the form an error belongs to (focus / inline message). */
export type RequestField = 'serviceDate' | 'pickup' | 'destination' | 'window';

const endKey = (e: MeAdhocEndRef): string =>
  e.kind === 'SAVED' ? `SAVED:${e.placeId}` : e.kind === 'PLACE' ? `PLACE:${e.poiId}` : e.kind === 'MAP' ? `MAP:${e.lat.toFixed(5)},${e.lng.toFixed(5)}` : e.kind;

function endError(e: MeAdhocEndRef | null, which: 'pickup' | 'destination', f: RequestForm, ctx: RequestContext): string | null {
  if (!e) return which === 'pickup' ? 'Choose where you are picked up.' : 'Choose where you are going.';
  if (isPersonalEnd(e) && !ctx.routingConsent) return CONSENT_EXPLANATION;
  if (e.kind === 'SAVED' && !e.placeId) return 'Choose a saved place.';
  if (e.kind === 'PLACE' && !e.poiId) return 'Choose a company place.';
  if (e.kind === 'MAP' && !(Number.isFinite(e.lat) && Number.isFinite(e.lng) && Math.abs(e.lat) <= 90 && Math.abs(e.lng) <= 180)) return 'Choose a point on the map.';
  if (e.kind === 'SHIFT_SITE' && f.journey !== 'COMMUTE') return 'The shift site is only for a commute.';
  if (e.kind === 'SHIFT_SITE' && !f.shiftId) return 'Choose a shift first.';
  return null;
}

/** Every English validation message `buildRequest` can return (i18n completeness test). */
export const REQUEST_FORM_ERRORS = [
  'Choose a day.',
  'Choose where you are picked up.',
  'Choose where you are going.',
  CONSENT_EXPLANATION,
  'Choose a saved place.',
  'Choose a company place.',
  'Choose a point on the map.',
  'The shift site is only for a commute.',
  'Choose a shift first.',
  'Pickup and destination must be different.',
  'Enter times as HH:MM, for example 09:30.',
  'Enter both the start and the end of the time window.',
  'The time window must end after it starts.',
  'The time window must be at least 10 minutes long.',
  'A point-to-point ride needs a time window.',
  'A commute needs a shift or a time window.',
  'Only for a commute.',
] as const;

/**
 * The request body, or the English reason (translate where shown) and the field it belongs to. One seat, own profile
 * (the server takes the passenger from the session). Text fields are trimmed and capped; empty ones are left out.
 */
export function buildRequest(f: RequestForm, ctx: RequestContext): { ok: true; body: MeAdhocRequestInput } | { ok: false; error: string; field: RequestField } {
  const fail = (error: string, field: RequestField) => ({ ok: false as const, error, field });
  if (!f.serviceDate) return fail('Choose a day.', 'serviceDate');
  const pe = endError(f.pickup, 'pickup', f, ctx);
  if (pe) return fail(pe, 'pickup');
  const de = endError(f.destination, 'destination', f, ctx);
  if (de) return fail(de, 'destination');
  if (endKey(f.pickup!) === endKey(f.destination!)) return fail('Pickup and destination must be different.', 'destination');

  const ws = f.windowStart.trim();
  const we = f.windowEnd.trim();
  let window: { windowStart: string; windowEnd: string } | null = null;
  if (ws || we) {
    if (!ws || !we) return fail('Enter both the start and the end of the time window.', 'window');
    const a = parseClock(ws);
    const b = parseClock(we);
    if (a === null || b === null) return fail('Enter times as HH:MM, for example 09:30.', 'window');
    if (b <= a) return fail('The time window must end after it starts.', 'window');
    if (b - a < REQUEST_LIMITS.windowMinMin) return fail('The time window must be at least 10 minutes long.', 'window');
    const s = zonedIso(f.serviceDate, a, ctx.timeZone);
    const e = zonedIso(f.serviceDate, b, ctx.timeZone);
    if (!s || !e) return fail('Choose a day.', 'serviceDate');
    window = { windowStart: s, windowEnd: e };
  }
  if (f.journey === 'POINT_TO_POINT' && !window) return fail('A point-to-point ride needs a time window.', 'window');
  if (f.journey === 'COMMUTE' && !window && !f.shiftId) return fail('A commute needs a shift or a time window.', 'window');

  const purpose = f.purpose.trim().slice(0, REQUEST_LIMITS.purposeMax);
  const note = f.note.trim().slice(0, REQUEST_LIMITS.noteMax);
  const cleanEnd = (e: MeAdhocEndRef): MeAdhocEndRef => {
    if (e.kind !== 'MAP') return e;
    const label = (e.label ?? '').trim().slice(0, REQUEST_LIMITS.mapLabelMax);
    return { kind: 'MAP', lat: e.lat, lng: e.lng, ...(label ? { label } : {}) };
  };
  const body: MeAdhocRequestInput = {
    serviceDate: f.serviceDate,
    journey: f.journey,
    ...(f.journey === 'COMMUTE' ? { direction: f.direction } : {}),
    ...(f.shiftId ? { shiftId: f.shiftId } : {}),
    pickup: cleanEnd(f.pickup!),
    destination: cleanEnd(f.destination!),
    ...(window ?? {}),
    ...(purpose ? { purpose } : {}),
    ...(note ? { note } : {}),
  };
  return { ok: true, body };
}

// ───────────── Answers and errors ─────────────

export const WAITING_FOR_APPROVAL = 'Waiting for approval';
export const REQUESTED_DESK_ASSIGNS = 'Requested — the transport desk will assign a cab';

/** Toast after a successful request: approval pending (REQUESTED / approval PENDING / needsApproval) or sent to the desk. */
export function requestResultText(r: { status?: string | null; needsApproval?: unknown; approval?: unknown }): string {
  return r.needsApproval === true || r.status === 'REQUESTED' || r.approval === 'PENDING' ? WAITING_FOR_APPROVAL : REQUESTED_DESK_ASSIGNS;
}

/** NOT_ELIGIBLE reasons (TRANSPORT_INELIGIBLE_REASONS) in passenger wording. */
export const INELIGIBLE_TEXT: Record<string, string> = {
  PASSENGER_INACTIVE: 'Your passenger profile is not active. Ask your transport desk.',
  PASSENGER_ANONYMISED: 'Your passenger profile is no longer available. Ask your transport desk.',
  SHIFT_INACTIVE: 'This shift is no longer active. Choose another shift.',
  SHIFT_NOT_RUNNING: 'This shift does not run on the chosen day.',
  PLACE_NOT_ALLOWED: 'This place cannot be used for your rides. Choose another place.',
  SEATS_NOT_ALLOWED: 'You can request one seat only.',
};
export const NOT_ELIGIBLE_FALLBACK = 'You cannot request this ride. Ask your transport desk.';
export const VALIDATION_TEXT = 'Check the request: {{detail}}';

const REQUEST_ERROR_TEXT: Record<string, string> = {
  AFTER_CUTOFF: 'Requests for this time are closed (booking cut-off passed). Call your transport desk.',
  BOOKING_DUPLICATE: 'You already have a booking for this day and direction.',
  BOOKING_OVERLAP: 'You already have a ride at this time. Choose another time or cancel the other ride.',
  CONSENT_REQUIRED: CONSENT_EXPLANATION,
  SELF_BOOKING_DISABLED: 'Your company has not switched on booking in the app. Contact your transport desk.',
  NOT_A_PASSENGER: 'Your account is not linked to an active passenger profile. Ask your transport desk.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  TOO_MANY_OPEN_REQUESTS: 'You already have 10 open ride requests. Wait until the desk handles them, or cancel one.',
  NOT_FOUND: 'This place is no longer available. Choose another one.',
  IDEMPOTENCY_KEY_REUSED: 'This request changed while it was being sent. Send it again.',
};

/** A request error as the page sees it (web ApiError: code, parsed body, server message). */
export interface RequestErrorLike {
  code: string | null | undefined;
  body?: unknown;
  message?: string;
}

/** Passenger text for a request error (translated), or null = show the server's own message. */
export function requestErrorText(err: RequestErrorLike, t: Translate = english): string | null {
  switch (err.code) {
    case 'NOT_ELIGIBLE': {
      const reason = (err.body as { reason?: unknown } | null | undefined)?.reason;
      return t((typeof reason === 'string' && INELIGIBLE_TEXT[reason]) || NOT_ELIGIBLE_FALLBACK);
    }
    case 'VALIDATION_FAILED':
      return err.message?.trim() ? t(VALIDATION_TEXT, { detail: err.message.trim() }) : null;
    default:
      return err.code && REQUEST_ERROR_TEXT[err.code] ? t(REQUEST_ERROR_TEXT[err.code]) : null;
  }
}

/** Which form part a server error points at (focus it), if any. */
export function requestErrorField(code: string | null | undefined): RequestField | null {
  if (code === 'CONSENT_REQUIRED' || code === 'NOT_FOUND') return 'pickup';
  if (code === 'AFTER_CUTOFF' || code === 'BOOKING_OVERLAP') return 'window';
  if (code === 'BOOKING_DUPLICATE') return 'serviceDate';
  return null;
}

// ───────────── My bookings: approval, route, cancel ─────────────

export type Tone = 'secondary' | 'info' | 'success' | 'warning' | 'destructive';

/**
 * The approval state of one of my bookings (MeBookingDto.approval, D-A5): PENDING → "Waiting for approval", APPROVED →
 * "Approved" (only when the server says so), REJECTED → "Rejected" + the transport team's reason. NOT_REQUIRED or an
 * older server without `approval` shows nothing (never "approved").
 */
export function approvalMeta(b: Pick<MeBookingDto, 'status'> & { approval?: string | null; statusReason?: string | null }): { label: string; tone: Tone; reason: string | null } | null {
  const approval = b.approval ?? (b.status === 'REQUESTED' ? 'PENDING' : b.status === 'REJECTED' ? 'REJECTED' : null);
  if (approval === 'PENDING') return { label: WAITING_FOR_APPROVAL, tone: 'warning', reason: null };
  if (approval === 'APPROVED') return { label: 'Approved', tone: 'success', reason: null };
  if (approval === 'REJECTED') {
    const reason = typeof b.statusReason === 'string' && b.statusReason.trim() ? b.statusReason.trim() : null;
    return { label: 'Rejected', tone: 'destructive', reason };
  }
  return null;
}

/** "Pickup → Destination" of one of my bookings (labels as the server gives them), or null. */
export function myRouteText(b: Pick<MeBookingDto, 'pickupLabel' | 'dropLabel'>): string | null {
  const parts = [b.pickupLabel, b.dropLabel].map((s) => (s ?? '').trim());
  if (!parts[0] && !parts[1]) return null;
  return `${parts[0] || '—'} → ${parts[1] || '—'}`;
}

/** Statuses the passenger may cancel (BOOKING_TRANSITIONS.cancel). */
export const CANCELLABLE_STATUSES = ['REQUESTED', 'PENDING_ASSIGNMENT', 'WAITLISTED', 'ASSIGNED', 'CONFIRMED'] as const;

/**
 * Whether I may cancel this booking now (POST /me/transport/bookings/:id/cancel): a cancellable status and before the
 * cut-off (`cutoffAt`; null = until the trip starts — the server still refuses once the trip runs). `closed` says why
 * the button is replaced by a note (cut-off passed).
 */
export function cancelState(b: Pick<MeBookingDto, 'status' | 'cutoffAt'>, nowMs: number): 'CAN_CANCEL' | 'AFTER_CUTOFF' | 'NONE' {
  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(b.status)) return 'NONE';
  if (b.cutoffAt) {
    const c = Date.parse(b.cutoffAt);
    if (Number.isFinite(c) && nowMs >= c) return 'AFTER_CUTOFF';
  }
  return 'CAN_CANCEL';
}

const CANCEL_ERROR_TEXT: Record<string, string> = {
  AFTER_CUTOFF: 'The cancellation cut-off has passed. Call your transport desk.',
  INVALID_STATE: 'This booking can no longer be cancelled (the trip may have started). Call your transport desk.',
  VERSION_CONFLICT: 'This booking changed meanwhile. The list was reloaded; try again.',
  NOT_FOUND: 'This booking is no longer available.',
};

/** Passenger text for a cancel error (translated), or null = the server message. */
export function cancelErrorText(code: string | null | undefined, t: Translate = english): string | null {
  return code && CANCEL_ERROR_TEXT[code] ? t(CANCEL_ERROR_TEXT[code]) : null;
}

/** The cancel body: the optional reason, trimmed and capped (MeBookingCancelDto). */
export function cancelBody(reason: string): { reason?: string } {
  const r = reason.trim().slice(0, REQUEST_LIMITS.cancelReasonMax);
  return r ? { reason: r } : {};
}

/** English sources of every runtime string above (i18n completeness test). */
export function myRequestStrings(): string[] {
  return [
    ...REQUEST_FORM_ERRORS,
    ...Object.values(END_KIND_LABEL),
    WAITING_FOR_APPROVAL,
    REQUESTED_DESK_ASSIGNS,
    ...Object.values(INELIGIBLE_TEXT),
    NOT_ELIGIBLE_FALLBACK,
    VALIDATION_TEXT,
    ...Object.values(REQUEST_ERROR_TEXT),
    ...Object.values(CANCEL_ERROR_TEXT),
    'Approved',
    'Rejected',
  ];
}
