/**
 * WP 3.9 ad-hoc booking (pure, `node --test`): the dispatcher's one-off booking form and edit dialog. Mirrors the
 * server rules of POST / PATCH /api/transport/bookings (packages/shared transport-trips.ts WP 3.9 blocks) so mistakes
 * show inline before the request; the server stays the authority (409 LATE_REASON_REQUIRED, 422 NOT_ELIGIBLE,
 * 409 CONSENT_REQUIRED, BOOKING_DUPLICATE, BOOKING_OVERLAP).
 *
 * Points (D-A2 / D-A3): a company place (poiId, coordinates from the place), a one-time map point (lat / lng + label:
 * personal data, needs the passenger's active routing consent), the passenger's home (commute only: the field is left
 * out and the server uses the routing pickup, only with consent), or the shift's site (commute office end: left out,
 * the server uses the shift's site). No React, DOM or path aliases.
 */
import {
  TRANSPORT_E3_LIMITS,
  TRANSPORT_INELIGIBLE_REASONS,
  type CreateTransportBookingInput,
  type GeoPoint,
  type TransportBookingDto,
  type TransportBookingJourney,
  type TransportDirection,
  type TransportIneligibleReason,
  type UpdateTransportBookingInput,
} from '@veetracer/shared';
import { fromZonedWall, shiftDay, toZonedWall } from '../../planned-trips/trip-format.ts';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

const MIN = 60_000;
const MAX_WINDOW_MS = 12 * 3_600_000;

// ───────────────────────────── Points ─────────────────────────────

/**
 * How one end of the booking is chosen. KEEP (edit only): unchanged. HOME: the passenger's routing pickup (commute
 * personal end). SITE: the shift's site (commute office end). PLACE: a company place. MAP: a one-time map point.
 * NONE: nothing chosen yet.
 */
export type PointKind = 'KEEP' | 'HOME' | 'SITE' | 'PLACE' | 'MAP' | 'NONE';

export interface PlaceRef {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface PointChoice {
  kind: PointKind;
  /** PLACE. */
  place: PlaceRef | null;
  /** MAP. */
  point: { lat: number; lng: number } | null;
  /** Label shown to the driver / passenger (PLACE: defaults to the place's name; MAP: required). */
  label: string;
}

export const POINT_KIND_LABEL: Record<PointKind, string> = {
  KEEP: 'Keep current',
  HOME: "Passenger's home",
  SITE: "Shift's site",
  PLACE: 'Company place',
  MAP: 'Point on the map',
  NONE: 'Choose…',
};

export const LABEL_MAX = 120;

export const pointChoice = (kind: PointKind): PointChoice => ({ kind, place: null, point: null, label: '' });

export type BookingEnd = 'pickup' | 'drop';

/** Commute: the end at the passenger's side (pickup for IN, drop for OUT). The other end is the office end. */
export function personalEnd(direction: TransportDirection): BookingEnd {
  return direction === 'IN' ? 'pickup' : 'drop';
}

/** Which kinds a picker offers (create). Commute personal end: home / place / map; office end: site / place / map; P2P: place / map. */
export function pointKinds(journey: TransportBookingJourney, direction: TransportDirection, end: BookingEnd, mode: 'create' | 'edit' = 'create'): PointKind[] {
  if (mode === 'edit') return ['KEEP', 'PLACE', 'MAP'];
  if (journey === 'POINT_TO_POINT') return ['PLACE', 'MAP'];
  return end === personalEnd(direction) ? ['HOME', 'PLACE', 'MAP'] : ['SITE', 'PLACE', 'MAP'];
}

/** The default choice of a picker (create): commute home → site; P2P nothing (both points are required). */
export function defaultPoint(journey: TransportBookingJourney, direction: TransportDirection, end: BookingEnd): PointChoice {
  if (journey === 'POINT_TO_POINT') return pointChoice('NONE');
  return pointChoice(end === personalEnd(direction) ? 'HOME' : 'SITE');
}

/** Whether a choice puts personal data on the booking (D-A3: any point that is not a company place). */
export function isPersonalChoice(c: PointChoice): boolean {
  return c.kind === 'MAP' || c.kind === 'HOME';
}

/** The GeoPoint to send for a choice; undefined = leave the field out (server default), null = nothing usable. */
export function choiceToPoint(c: PointChoice): GeoPoint | undefined | null {
  switch (c.kind) {
    case 'PLACE':
      return c.place ? { lat: c.place.lat, lng: c.place.lng, label: c.label.trim() || c.place.name, poiId: c.place.id } : null;
    case 'MAP':
      return c.point ? { lat: c.point.lat, lng: c.point.lng, label: c.label.trim() || null, poiId: null } : null;
    case 'NONE':
      return null;
    default:
      return undefined; // KEEP / HOME / SITE: not sent
  }
}

// ───────────────────────────── Form ─────────────────────────────

export interface AdhocDraft {
  passengerId: string | null;
  journey: TransportBookingJourney;
  serviceDate: string;
  direction: TransportDirection;
  shiftId: string | null;
  pickup: PointChoice;
  drop: PointChoice;
  /** "HH:mm" on the service date (end ≤ start = the next day); both empty = the shift's window. */
  startTime: string;
  endTime: string;
  seats: string;
  hold: boolean;
  note: string;
  lateReason: string;
}

export function emptyAdhocDraft(serviceDate: string): AdhocDraft {
  return {
    passengerId: null,
    journey: 'COMMUTE',
    serviceDate,
    direction: 'IN',
    shiftId: null,
    pickup: defaultPoint('COMMUTE', 'IN', 'pickup'),
    drop: defaultPoint('COMMUTE', 'IN', 'drop'),
    startTime: '',
    endTime: '',
    seats: '1',
    hold: false,
    note: '',
    lateReason: '',
  };
}

/** Switch journey / direction and reset the pickers to that combination's defaults (choices that still fit are kept). */
export function withJourney(d: AdhocDraft, journey: TransportBookingJourney, direction: TransportDirection = d.direction): AdhocDraft {
  const keep = (c: PointChoice, end: BookingEnd) => (pointKinds(journey, direction, end).includes(c.kind) && !(c.kind === 'HOME' || c.kind === 'SITE') ? c : defaultPoint(journey, direction, end));
  return { ...d, journey, direction, pickup: keep(d.pickup, 'pickup'), drop: keep(d.drop, 'drop') };
}

/** What the form knows about the chosen passenger and shift (from the option lists). */
export interface AdhocContext {
  passenger: { routingConsent: boolean; hasHome: boolean } | null;
  shift: { startMin: number; endMin: number; timeZone: string; site: PlaceRef | null } | null;
  /** Zone of a shift-less window (the company / report zone). */
  timeZone: string | undefined;
  /** Company cut-off before the window start (minutes): learned from bookings on screen, else the default. */
  cutoffMin: number;
  /** Today in the booking's zone (YYYY-MM-DD). */
  today: string;
  nowMs: number;
}

export type AdhocField = 'passenger' | 'serviceDate' | 'shift' | 'pickup' | 'drop' | 'pickupLabel' | 'dropLabel' | 'window' | 'seats' | 'note' | 'lateReason';
export type AdhocErrors = Partial<Record<AdhocField, string>>;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const wallOf = (day: string, min: number) => `${day}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export interface ResolvedWindow {
  start: number;
  end: number;
  /** Where it came from: the typed times or the shift's leg window. */
  from: 'typed' | 'shift';
}

/**
 * The booking window: typed times on the service date in the shift's (or the company's) zone, an end at or before the
 * start being the next day; else the shift's leg window (IN [login − 90 min, login]; OUT [logout, logout + 90 min],
 * logout before login = next day), as the server's `legWindow`. null when neither is complete.
 */
export function resolveWindow(d: Pick<AdhocDraft, 'serviceDate' | 'direction' | 'journey' | 'startTime' | 'endTime'>, ctx: Pick<AdhocContext, 'shift' | 'timeZone'>): ResolvedWindow | null {
  const tz = ctx.shift?.timeZone ?? ctx.timeZone;
  const s = minutes(d.startTime);
  const e = minutes(d.endTime);
  if (s !== null && e !== null) {
    const start = fromZonedWall(wallOf(d.serviceDate, s), tz);
    const end = fromZonedWall(wallOf(e <= s ? shiftDay(d.serviceDate, 1) : d.serviceDate, e), tz);
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end, from: 'typed' } : null;
  }
  if (d.startTime || d.endTime || !ctx.shift || d.journey === 'POINT_TO_POINT') return null;
  const sh = ctx.shift;
  if (d.direction === 'IN') {
    const anchor = fromZonedWall(wallOf(d.serviceDate, sh.startMin), sh.timeZone);
    return { start: anchor - TRANSPORT_E3_LIMITS.inWindowMin * MIN, end: anchor, from: 'shift' };
  }
  const day = sh.endMin < sh.startMin ? shiftDay(d.serviceDate, 1) : d.serviceDate;
  const anchor = fromZonedWall(wallOf(day, sh.endMin), sh.timeZone);
  return { start: anchor, end: anchor + TRANSPORT_E3_LIMITS.outWindowMin * MIN, from: 'shift' };
}

/** Cut-off of a window start (window start − company cut-off). */
export function cutoffOf(windowStartMs: number, cutoffMin: number): number {
  return windowStartMs - cutoffMin * MIN;
}

/** The company cut-off learned from bookings on screen (windowStart − cutoffAt, most common value); `fallback` without any. */
export function learnCutoffMin(rows: readonly Pick<TransportBookingDto, 'windowStart' | 'cutoffAt'>[], fallback: number = TRANSPORT_E3_LIMITS.defaultCutoffMin): number {
  const seen = new Map<number, number>();
  for (const r of rows) {
    if (!r.cutoffAt) continue;
    const m = Math.round((Date.parse(r.windowStart) - Date.parse(r.cutoffAt)) / MIN);
    if (Number.isFinite(m) && m >= 0) seen.set(m, (seen.get(m) ?? 0) + 1);
  }
  let best: [number, number] | null = null;
  for (const e of seen) if (!best || e[1] > best[1]) best = e;
  return best ? best[0] : fallback;
}

/** After the cut-off: a reason is needed (D-A1). `serverSaid` = the server answered LATE_REASON_REQUIRED. */
export function isLate(window: ResolvedWindow | null, ctx: Pick<AdhocContext, 'cutoffMin' | 'nowMs'>, serverSaid = false): boolean {
  if (serverSaid) return true;
  return !!window && ctx.nowMs >= cutoffOf(window.start, ctx.cutoffMin);
}

/** "Give a reason of at least 10 characters" etc.; undefined when fine. */
export function lateReasonError(reason: string, t: Translate = english): string | undefined {
  const n = reason.trim().length;
  if (n < TRANSPORT_E3_LIMITS.lateReasonMin) return t('Give a reason of at least {{n}} characters.', { n: TRANSPORT_E3_LIMITS.lateReasonMin });
  if (n > TRANSPORT_E3_LIMITS.lateReasonMax) return t('At most {{n}} characters.', { n: TRANSPORT_E3_LIMITS.lateReasonMax });
  return undefined;
}

function pointError(c: PointChoice, end: BookingEnd, d: AdhocDraft, ctx: AdhocContext, t: Translate): string | undefined {
  switch (c.kind) {
    case 'NONE':
      return end === 'pickup' ? t('Choose the pickup.') : t('Choose the destination.');
    case 'HOME':
      if (d.journey === 'POINT_TO_POINT') return t('Choose a company place or a point on the map.');
      if (ctx.passenger && !ctx.passenger.routingConsent) return t('The passenger has no active transport consent: choose a company place.');
      return undefined;
    case 'SITE':
      if (d.journey === 'POINT_TO_POINT') return t('Choose a company place or a point on the map.');
      if (!ctx.shift) return t('Without a shift there is no site: choose a company place or a point on the map.');
      if (!ctx.shift.site) return t('This shift has no site: choose a company place or a point on the map.');
      return undefined;
    case 'PLACE':
      return c.place ? undefined : t('Choose a company place.');
    case 'MAP':
      if (!c.point) return t('Click the map or search an address to set the point.');
      if (ctx.passenger && !ctx.passenger.routingConsent) return t('The passenger has no active transport consent: choose a company place.');
      return undefined;
    default:
      return undefined;
  }
}

function labelError(c: PointChoice, t: Translate): string | undefined {
  if (c.label.trim().length > LABEL_MAX) return t('At most {{n}} characters.', { n: LABEL_MAX });
  if (c.kind === 'MAP' && c.point && !c.label.trim()) return t('Give the point a short label (e.g. "Client office gate").');
  return undefined;
}

/** Inline errors of the create form (the server's rules, so a mistake shows before the request). */
export function validateAdhoc(d: AdhocDraft, ctx: AdhocContext, opts: { lateRequired?: boolean } = {}, t: Translate = english): AdhocErrors {
  const e: AdhocErrors = {};
  if (!d.passengerId) e.passenger = t('Required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.serviceDate)) e.serviceDate = t('Required');
  else if (d.serviceDate < ctx.today) e.serviceDate = t('The date is in the past.');
  else if (d.serviceDate > shiftDay(ctx.today, TRANSPORT_E3_LIMITS.adhocMaxDaysAhead)) e.serviceDate = t('Book at most {{n}} days ahead.', { n: TRANSPORT_E3_LIMITS.adhocMaxDaysAhead });

  const typed = !!(d.startTime || d.endTime);
  if (d.journey === 'COMMUTE' && !d.shiftId && !typed) e.shift = t('Choose a shift, or give the time window.');

  const pe = pointError(d.pickup, 'pickup', d, ctx, t);
  if (pe) e.pickup = pe;
  const de = pointError(d.drop, 'drop', d, ctx, t);
  if (de) e.drop = de;
  const pl = labelError(d.pickup, t);
  if (pl) e.pickupLabel = pl;
  const dl = labelError(d.drop, t);
  if (dl) e.dropLabel = dl;

  const w = resolveWindow(d, ctx);
  if (typed && (minutes(d.startTime) === null || minutes(d.endTime) === null)) e.window = t('Give both the start and the end time.');
  else if (!typed && d.journey === 'POINT_TO_POINT') e.window = t('A point-to-point ride needs a time window.');
  else if (!typed && !d.shiftId && d.journey === 'COMMUTE') e.window = t('Without a shift, give the time window.');
  else if (w) {
    if (w.end <= w.start) e.window = t('The window must end after it starts.');
    else if (w.end - w.start > MAX_WINDOW_MS) e.window = t('The window can be at most 12 hours.');
    else if (w.end < ctx.nowMs) e.window = t('The window has already passed.');
  }

  const n = Number(d.seats);
  if (!Number.isInteger(n) || n < 1 || n > TRANSPORT_E3_LIMITS.maxPassengerCount) e.seats = t('1 to {{n}}', { n: TRANSPORT_E3_LIMITS.maxPassengerCount });
  if (d.note.length > TRANSPORT_E3_LIMITS.noteMax) e.note = t('At most {{n}} characters.', { n: TRANSPORT_E3_LIMITS.noteMax });

  if (isLate(w, ctx, opts.lateRequired)) {
    const le = lateReasonError(d.lateReason, t);
    if (le) e.lateReason = le;
  }
  return e;
}

export const hasErrors = (e: AdhocErrors) => Object.values(e).some(Boolean);

/** The POST body. Only call when `validateAdhoc` found nothing. */
export function buildCreateInput(d: AdhocDraft, ctx: Pick<AdhocContext, 'shift' | 'timeZone' | 'cutoffMin' | 'nowMs'>, opts: { lateRequired?: boolean } = {}): CreateTransportBookingInput {
  const w = resolveWindow(d, ctx);
  const input: CreateTransportBookingInput = {
    passengerId: d.passengerId ?? '',
    serviceDate: d.serviceDate,
    journey: d.journey,
    shiftId: d.shiftId,
    passengerCount: Number(d.seats),
    hold: d.hold,
  };
  if (d.journey === 'COMMUTE') input.direction = d.direction;
  const pickup = choiceToPoint(d.pickup);
  const drop = choiceToPoint(d.drop);
  if (pickup) input.pickup = pickup;
  if (drop) input.drop = drop;
  if (w && w.from === 'typed') {
    input.windowStart = new Date(w.start).toISOString();
    input.windowEnd = new Date(w.end).toISOString();
  }
  if (d.note.trim()) input.note = d.note.trim();
  if (isLate(w, ctx, opts.lateRequired) && d.lateReason.trim()) input.lateReason = d.lateReason.trim();
  return input;
}

// ───────────────────────────── Edit ─────────────────────────────

export interface EditDraft {
  pickup: PointChoice;
  drop: PointChoice;
  startTime: string;
  endTime: string;
  seats: string;
  note: string;
  lateReason: string;
}

/** Booking states a dispatcher may edit (contract: REQUESTED / PENDING_ASSIGNMENT / WAITLISTED). */
export const EDITABLE_STATUSES = ['REQUESTED', 'PENDING_ASSIGNMENT', 'WAITLISTED'] as const;

/**
 * Whether the row offers Edit: the server's allowedActions. The desk keeps 'edit' after the cut-off (WP 3.9 D-A1,
 * `bookingAllowedActions(..., { desk: true })`; the PATCH then needs a late reason), so no client-side fallback.
 */
export function canEditBooking(b: Pick<TransportBookingDto, 'allowedActions'>): boolean {
  return b.allowedActions.includes('edit');
}

/** "HH:mm" of an instant in a zone. */
export function clockIn(iso: string, tz: string | undefined): string {
  return toZonedWall(Date.parse(iso), tz).slice(11, 16);
}

/**
 * The end that is missing on a Needs-location booking: no point and no label (a withheld personal point keeps its row's
 * label or is the commute home end, which the server only withholds when it exists).
 */
export function endMissing(b: Pick<TransportBookingDto, 'needsLocation' | 'pickup' | 'drop' | 'pickupLabel' | 'dropLabel'>, end: BookingEnd): boolean {
  if (!b.needsLocation) return false;
  return end === 'pickup' ? !b.pickup && !b.pickupLabel : !b.drop && !b.dropLabel;
}

export function editDraftOf(b: Pick<TransportBookingDto, 'windowStart' | 'windowEnd' | 'timeZone' | 'passengerCount' | 'note' | 'needsLocation' | 'pickup' | 'drop' | 'pickupLabel' | 'dropLabel'>): EditDraft {
  return {
    // A missing point has nothing to keep: the dispatcher sets it (Needs location).
    pickup: pointChoice(endMissing(b, 'pickup') ? 'NONE' : 'KEEP'),
    drop: pointChoice(endMissing(b, 'drop') ? 'NONE' : 'KEEP'),
    startTime: clockIn(b.windowStart, b.timeZone),
    endTime: clockIn(b.windowEnd, b.timeZone),
    seats: String(b.passengerCount),
    note: b.note ?? '',
    lateReason: '',
  };
}

/** The edited window (start on the booking's service date; end ≤ start = next day), or null when unchanged / invalid. */
export function editWindow(e: EditDraft, b: Pick<TransportBookingDto, 'serviceDate' | 'windowStart' | 'windowEnd' | 'timeZone'>): { start: number; end: number } | null {
  const s = minutes(e.startTime);
  const en = minutes(e.endTime);
  if (s === null || en === null) return null;
  const day = toZonedWall(Date.parse(b.windowStart), b.timeZone).slice(0, 10);
  const start = fromZonedWall(wallOf(day, s), b.timeZone);
  const end = fromZonedWall(wallOf(en <= s ? shiftDay(day, 1) : day, en), b.timeZone);
  return { start, end };
}

export interface EditContext {
  passengerConsent: boolean | null;
  cutoffMin: number;
  nowMs: number;
}

/** Whether the edit happens after the cut-off: the booking's own cut-off passed, or the new window's cut-off has. */
export function editIsLate(e: EditDraft, b: Pick<TransportBookingDto, 'serviceDate' | 'windowStart' | 'windowEnd' | 'timeZone' | 'cutoffAt'>, ctx: Pick<EditContext, 'cutoffMin' | 'nowMs'>, serverSaid = false): boolean {
  if (serverSaid) return true;
  if (b.cutoffAt && ctx.nowMs >= Date.parse(b.cutoffAt)) return true;
  const w = editWindow(e, b);
  return !!w && Number.isFinite(w.start) && ctx.nowMs >= cutoffOf(w.start, ctx.cutoffMin);
}

export function validateEdit(e: EditDraft, b: TransportBookingDto, ctx: EditContext, opts: { lateRequired?: boolean } = {}, t: Translate = english): AdhocErrors {
  const out: AdhocErrors = {};
  for (const end of ['pickup', 'drop'] as const) {
    const c = e[end];
    if (c.kind === 'NONE') out[end] = t('Set this location: choose a company place or a point on the map.');
    else if (c.kind === 'PLACE' && !c.place) out[end] = t('Choose a company place.');
    else if (c.kind === 'MAP') {
      if (!c.point) out[end] = t('Click the map or search an address to set the point.');
      else if (ctx.passengerConsent === false) out[end] = t('The passenger has no active transport consent: choose a company place.');
    }
    const le = labelError(c, t);
    if (le) out[end === 'pickup' ? 'pickupLabel' : 'dropLabel'] = le;
  }
  if (!HHMM.test(e.startTime) || !HHMM.test(e.endTime)) out.window = t('Give both the start and the end time.');
  else {
    const w = editWindow(e, b);
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end)) out.window = t('Give both the start and the end time.');
    else if (w.end - w.start > MAX_WINDOW_MS) out.window = t('The window can be at most 12 hours.');
    else if (windowChanged(e, b) && w.end < ctx.nowMs) out.window = t('The window has already passed.');
  }
  const n = Number(e.seats);
  if (!Number.isInteger(n) || n < 1 || n > TRANSPORT_E3_LIMITS.maxPassengerCount) out.seats = t('1 to {{n}}', { n: TRANSPORT_E3_LIMITS.maxPassengerCount });
  if (e.note.length > TRANSPORT_E3_LIMITS.noteMax) out.note = t('At most {{n}} characters.', { n: TRANSPORT_E3_LIMITS.noteMax });
  if (editIsLate(e, b, ctx, opts.lateRequired)) {
    const le = lateReasonError(e.lateReason, t);
    if (le) out.lateReason = le;
  }
  return out;
}

function windowChanged(e: EditDraft, b: Pick<TransportBookingDto, 'windowStart' | 'windowEnd' | 'timeZone' | 'serviceDate'>): boolean {
  const w = editWindow(e, b);
  return !!w && (w.start !== Date.parse(b.windowStart) || w.end !== Date.parse(b.windowEnd));
}

/** The PATCH body: only what changed, plus expectedVersion (and the late reason when late). null = nothing changed. */
export function buildUpdateInput(e: EditDraft, b: TransportBookingDto, ctx: Pick<EditContext, 'cutoffMin' | 'nowMs'>, opts: { lateRequired?: boolean } = {}): UpdateTransportBookingInput | null {
  const out: UpdateTransportBookingInput = { expectedVersion: b.version };
  let changed = false;
  for (const end of ['pickup', 'drop'] as const) {
    const p = choiceToPoint(e[end]);
    if (p) {
      out[end] = p;
      changed = true;
    }
  }
  if (windowChanged(e, b)) {
    const w = editWindow(e, b)!;
    out.windowStart = new Date(w.start).toISOString();
    out.windowEnd = new Date(w.end).toISOString();
    changed = true;
  }
  if (Number(e.seats) !== b.passengerCount) {
    out.passengerCount = Number(e.seats);
    changed = true;
  }
  const note = e.note.trim();
  if (note !== (b.note ?? '').trim()) {
    out.note = note || null;
    changed = true;
  }
  if (!changed) return null;
  if (editIsLate(e, b, ctx, opts.lateRequired) && e.lateReason.trim()) out.lateReason = e.lateReason.trim();
  return out;
}

// ───────────────────────────── List / board ─────────────────────────────

export const JOURNEY_LABEL: Record<TransportBookingJourney, string> = { COMMUTE: 'Commute', POINT_TO_POINT: 'Point-to-point' };

/**
 * Text of one end on a list row or board card. Only labels are shown, never coordinates; a personal point withheld
 * (pointsHidden) or without a label reads as a generic "Home" / "Personal point", a missing one as "Needs location".
 */
export function endpointText(b: Pick<TransportBookingDto, 'journey' | 'direction' | 'pickup' | 'drop' | 'pickupLabel' | 'dropLabel' | 'needsLocation' | 'pointsHidden'>, end: BookingEnd): string {
  const label = end === 'pickup' ? b.pickupLabel : b.dropLabel;
  if (label) return label;
  const point = end === 'pickup' ? b.pickup : b.drop;
  if (point?.label) return point.label;
  if (endMissing(b, end)) return 'Needs location';
  const journey = b.journey ?? 'COMMUTE';
  if (journey === 'COMMUTE' && end === personalEnd(b.direction)) return 'Home';
  return 'Personal point';
}

/** "Home → Main office". */
export function routeText(b: Parameters<typeof endpointText>[0], t: Translate = english): string {
  return `${t(endpointText(b, 'pickup'))} → ${t(endpointText(b, 'drop'))}`;
}

// ───────────────────────────── Errors ─────────────────────────────

export const INELIGIBLE_REASON_TEXT: Record<TransportIneligibleReason, string> = {
  PASSENGER_INACTIVE: 'The passenger is inactive, so no ride can be booked.',
  PASSENGER_ANONYMISED: "The passenger's data was erased; no ride can be booked.",
  SHIFT_INACTIVE: 'That shift is archived. Choose another shift.',
  SHIFT_NOT_RUNNING: 'That shift does not run on this date. Choose another date or shift, or give a time window without a shift.',
  PLACE_NOT_ALLOWED: 'That place is not an approved company place for this passenger. Choose another place.',
  SEATS_NOT_ALLOWED: 'That many seats cannot be booked for this passenger.',
};

/** Ensure every contract reason has a text (compile-time via Record; runtime check for tests). */
export const ineligibleReasonsCovered = (): boolean => TRANSPORT_INELIGIBLE_REASONS.every((r) => !!INELIGIBLE_REASON_TEXT[r]);

/** Booking-form texts that differ from the generic E3 ones (create / edit context). */
export const BOOKING_ERROR_TEXT: Record<string, string> = {
  CONSENT_REQUIRED: 'The passenger has no active transport consent; choose a company place.',
  LATE_REASON_REQUIRED: 'The cut-off has passed. Give a reason for the late booking.',
  BOOKING_DUPLICATE: 'The passenger already has a commute booking for that day and direction.',
  BOOKING_OVERLAP: 'The passenger already has another booking at that time.',
  AFTER_CUTOFF: 'The booking cut-off has passed.',
  VERSION_CONFLICT: 'Someone changed this booking meanwhile. The latest version was loaded; check it and save again.',
  NOT_ELIGIBLE: 'This passenger cannot be booked for this ride.',
};

/** Friendly text of a booking create / edit error from its code and body (NOT_ELIGIBLE uses `body.reason`). */
export function bookingErrorText(code: string | null | undefined, body: unknown): string | null {
  if (!code) return null;
  if (code === 'NOT_ELIGIBLE') {
    const reason = (body as { reason?: unknown } | null)?.reason;
    if (typeof reason === 'string' && reason in INELIGIBLE_REASON_TEXT) return INELIGIBLE_REASON_TEXT[reason as TransportIneligibleReason];
  }
  return BOOKING_ERROR_TEXT[code] ?? null;
}
