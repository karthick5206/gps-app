/**
 * WP 3.9 wave 2 (D-A5, D-A7): the passenger's "Request a ride" form (pure, `node --test`). The server decides
 * everything (eligibility, consent, cut-off, horizon, duplicates, overlap, approval); these helpers only shape the form,
 * build the `POST /me/transport/requests` body and choose the passenger wording. No runtime import from
 * @veetracer/shared, so this file runs under plain `node --test`.
 */
import type { MeAdhocEndRef, MeAdhocRequestInput, TransportBookingJourney, TransportDirection } from '@veetracer/shared';

/** Mirrors TRANSPORT_ADHOC_LIMITS.purposeMax and TRANSPORT_SELF_LIMITS (bookingNoteMax, placeLabelMax, maxDaysAhead). */
export const REQUEST_LIMITS = { purposeMax: 120, noteMax: 200, mapLabelMax: 60, maxDaysAhead: 14 } as const;

const DAY_MS = 86_400_000;
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export type EndKind = MeAdhocEndRef['kind'];
/** Ends that are personal points (D-A3): never used without the passenger's active routing consent. */
export const PERSONAL_ENDS: readonly EndKind[] = ['HOME', 'SAVED', 'MAP'];

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

export const CONSENT_EXPLANATION = 'Home, saved places and map points are your personal locations. They are used only with your transport consent (Privacy & consent).';

/** Default ends of a commute: home → shift site to log in, shift site → home to log out (home only with consent). */
export function defaultCommuteEnds(direction: TransportDirection, routingConsent: boolean): { pickup: MeAdhocEndRef | null; destination: MeAdhocEndRef | null } {
  const home: MeAdhocEndRef | null = routingConsent ? { kind: 'HOME' } : null;
  const site: MeAdhocEndRef = { kind: 'SHIFT_SITE' };
  return direction === 'IN' ? { pickup: home, destination: site } : { pickup: site, destination: home };
}

/** Days the passenger may pick: today … today + maxDaysAhead; for a commute with a shift, only the shift's weekdays. */
export function requestDays(today: string, maxDaysAhead: number = REQUEST_LIMITS.maxDaysAhead, shiftDays?: readonly number[] | null): string[] {
  const out: string[] = [];
  const start = Date.parse(`${today}T00:00:00Z`);
  for (let i = 0; i <= maxDaysAhead; i++) {
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

/**
 * The zone a request's day list and time window are read in (r115 B8): the company zone from the policy first (WP 3.9
 * wave 2 `timeZone`), then the chosen shift's zone, then the first shift's; the phone's own zone only when the server
 * sends none of these (an older server).
 */
export function requestTimeZone(policy: { timeZone?: string | null; shifts?: readonly { id: string; timeZone?: string | null }[] } | null | undefined, shiftId: string | null, phoneZone: string): string {
  const valid = (z: string | null | undefined): z is string => typeof z === 'string' && z.trim().length > 0;
  if (valid(policy?.timeZone)) return policy.timeZone;
  const shifts = policy?.shifts ?? [];
  const chosen = shiftId ? shifts.find((s) => s.id === shiftId)?.timeZone : null;
  if (valid(chosen)) return chosen;
  if (valid(shifts[0]?.timeZone)) return shifts[0].timeZone;
  return phoneZone;
}

/** ISO instant of a wall-clock time on a day in a time zone (same algorithm as the web planner's zonedIso). */
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
  /** Zone of the times (the chosen shift's, else the company's first shift, else the phone's). */
  timeZone: string;
}

const endKey = (e: MeAdhocEndRef): string =>
  e.kind === 'SAVED' ? `SAVED:${e.placeId}` : e.kind === 'PLACE' ? `PLACE:${e.poiId}` : e.kind === 'MAP' ? `MAP:${e.lat.toFixed(5)},${e.lng.toFixed(5)}` : e.kind;

/** Validation of one end; English reason or null. */
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

/** Every English validation message `adhocRequest` can return (i18n completeness test). */
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
  'A point-to-point ride needs a time window.',
  'A commute needs a shift or a time window.',
  'Only for a commute.',
] as const;

/**
 * The request body, or the English reason (translate where shown) why it cannot be sent yet. One seat, own profile
 * (the server takes the passenger from the session). Text fields are trimmed and capped.
 */
export function adhocRequest(f: RequestForm, ctx: RequestContext): { ok: true; body: MeAdhocRequestInput } | { ok: false; error: string } {
  if (!f.serviceDate) return { ok: false, error: 'Choose a day.' };
  const pe = endError(f.pickup, 'pickup', f, ctx);
  if (pe) return { ok: false, error: pe };
  const de = endError(f.destination, 'destination', f, ctx);
  if (de) return { ok: false, error: de };
  if (endKey(f.pickup!) === endKey(f.destination!)) return { ok: false, error: 'Pickup and destination must be different.' };

  const ws = f.windowStart.trim();
  const we = f.windowEnd.trim();
  let window: { windowStart: string; windowEnd: string } | null = null;
  if (ws || we) {
    if (!ws || !we) return { ok: false, error: 'Enter both the start and the end of the time window.' };
    const a = parseClock(ws);
    const b = parseClock(we);
    if (a === null || b === null) return { ok: false, error: 'Enter times as HH:MM, for example 09:30.' };
    if (b <= a) return { ok: false, error: 'The time window must end after it starts.' };
    const s = zonedIso(f.serviceDate, a, ctx.timeZone);
    const e = zonedIso(f.serviceDate, b, ctx.timeZone);
    if (!s || !e) return { ok: false, error: 'Choose a day.' };
    window = { windowStart: s, windowEnd: e };
  }
  if (f.journey === 'POINT_TO_POINT' && !window) return { ok: false, error: 'A point-to-point ride needs a time window.' };
  if (f.journey === 'COMMUTE' && !window && !f.shiftId) return { ok: false, error: 'A commute needs a shift or a time window.' };

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

/** What the passenger sees after a successful request: approval pending (REQUESTED / needsApproval) or sent to the desk. */
export function requestResultText(r: { status?: string | null; needsApproval?: unknown }): string {
  return r.needsApproval === true || r.status === 'REQUESTED' ? WAITING_FOR_APPROVAL : REQUESTED_DESK_ASSIGNS;
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

/** Passenger-facing text (English source) for a request error; null = use the server message. */
export function requestErrorText(code: string | null | undefined, reason?: unknown): string | null {
  switch (code) {
    case 'NOT_ELIGIBLE':
      return (typeof reason === 'string' && INELIGIBLE_TEXT[reason]) || NOT_ELIGIBLE_FALLBACK;
    case 'AFTER_CUTOFF':
      return 'Requests for this time are closed (booking cut-off passed). Call your transport desk.';
    case 'BOOKING_DUPLICATE':
      return 'You already have a booking for this day and direction.';
    case 'BOOKING_OVERLAP':
      return 'You already have a ride at this time. Choose another time or cancel the other ride.';
    case 'CONSENT_REQUIRED':
      return CONSENT_EXPLANATION;
    case 'SELF_BOOKING_DISABLED':
      return 'Your company has not switched on booking in the app. Contact your transport desk.';
    case 'NOT_A_PASSENGER':
      return 'Your account is not linked to an active passenger profile. Ask your transport desk.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait and try again.';
    case 'NOT_FOUND':
      return 'This place is no longer available. Choose another one.';
    default:
      return null;
  }
}

/** Every English string requestErrorText can return. */
export function requestErrorStrings(): string[] {
  const codes = ['NOT_ELIGIBLE', 'AFTER_CUTOFF', 'BOOKING_DUPLICATE', 'BOOKING_OVERLAP', 'CONSENT_REQUIRED', 'SELF_BOOKING_DISABLED', 'NOT_A_PASSENGER', 'RATE_LIMITED', 'NOT_FOUND'];
  return [...new Set([...codes.map((c) => requestErrorText(c)), ...Object.values(INELIGIBLE_TEXT)].filter((s): s is string => !!s))];
}

// ───────────── Booking status for the passenger (approval flow) ─────────────

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

/**
 * Status chip of the passenger's own booking. Approval flow (D-A5): REQUESTED (approval PENDING) → "Requested"
 * (waiting for approval), REJECTED → "Rejected" (+ the reason, when the server sends `statusReason`). "Approved" only
 * when the server says `approval === 'APPROVED'` (the transport team approved it while it waited) and it is still
 * waiting for a seat (r115 B4). NOT_REQUIRED (approval off, desk booking without hold, schedule) or an older server
 * without `approval` keeps the normal wording ("Waiting for a seat", "Assigned", …): never shown as approved.
 */
export function passengerStatusMeta<Tn extends string>(b: { status: string; source?: string | null; arrangedByDesk?: unknown; approval?: unknown }, fallback: Record<string, { label: string; tone: Tn }>): { label: string; tone: StatusTone | Tn } {
  if (b.status === 'REQUESTED') return { label: 'Requested', tone: 'warning' };
  if (b.status === 'PENDING_ASSIGNMENT' && b.approval === 'APPROVED') return { label: 'Approved', tone: 'info' };
  if (b.status === 'REJECTED') return { label: 'Rejected', tone: 'destructive' };
  return fallback[b.status] ?? { label: b.status, tone: 'neutral' };
}

/** One explanatory line under the chip, or null. */
export function passengerStatusLine(b: { status: string; source?: string | null; arrangedByDesk?: unknown; statusReason?: unknown; approval?: unknown }): { text: string; reason: string | null } | null {
  if (b.status === 'REQUESTED') return { text: WAITING_FOR_APPROVAL, reason: null };
  if (b.status === 'PENDING_ASSIGNMENT' && b.source === 'ADHOC' && b.arrangedByDesk === false) return { text: 'The transport desk will assign a cab.', reason: null };
  if (b.status === 'REJECTED') {
    const reason = typeof b.statusReason === 'string' && b.statusReason.trim() ? b.statusReason.trim() : null;
    return { text: reason ? 'Not approved: {{reason}}' : 'Not approved.', reason };
  }
  return null;
}

/** English sources of the labels above (i18n completeness test). */
export const REQUEST_STATUS_STRINGS = ['Requested', 'Approved', 'Rejected', WAITING_FOR_APPROVAL, REQUESTED_DESK_ASSIGNS, 'The transport desk will assign a cab.', 'Not approved: {{reason}}', 'Not approved.'] as const;
