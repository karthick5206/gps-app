/**
 * WP 3.9 wave 2 (pure, `node --test`): group bookings (D-A8), the approval queue (D-A5 / D-A6) and the
 * "Passenger requests need approval" setting. Mirrors the contract in packages/shared transport-adhoc.ts so mistakes show
 * inline before the request; the server stays the authority (422 GROUP_INVALID with per-passenger failures,
 * 409 LATE_REASON_REQUIRED, …). No React, DOM or path aliases.
 *
 * Group points: the pickup is one common point (a company place, the shift's site on an OUT commute, or a one-time map
 * point) or each passenger's own home (kind HOME → `{ mode: 'OWN' }`); the destination is one point (the shift's site,
 * a company place or a one-time map point). A one-time point and a home are personal data (D-A3): every passenger
 * needs an active routing consent.
 */
import {
  TRANSPORT_ADHOC_LIMITS,
  TRANSPORT_E3_LIMITS,
  TRANSPORT_SELF_LIMITS,
  type CreateTransportGroupBookingInput,
  type GeoPoint,
  type TransportBookingDto,
  type TransportBookingJourney,
  type TransportBookingListQuery,
  type TransportDirection,
  type TransportGroupFailure,
  type TransportSettingsDto,
} from '@veetracer/shared';
import { shiftDay } from '../../planned-trips/trip-format.ts';
import {
  BOOKING_ERROR_TEXT,
  choiceToPoint,
  INELIGIBLE_REASON_TEXT,
  isLate,
  LABEL_MAX,
  lateReasonError,
  pointChoice,
  resolveWindow,
  type AdhocContext,
  type BookingEnd,
  type PlaceRef,
  type PointChoice,
  type PointKind,
} from './adhoc-booking.ts';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

const MAX_WINDOW_MS = 12 * 3_600_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ───────────────────────────── Wave-2 DTO fields (optional reads) ─────────────────────────────

/** Fields wave 2 adds to TransportBookingDto (read optionally so an older DTO renders as before). */
export interface GroupFields {
  groupId?: string | null;
  purpose?: string | null;
}

export const groupIdOf = (b: object): string | null => (b as GroupFields).groupId ?? null;
export const purposeOf = (b: object): string | null => {
  const p = (b as GroupFields).purpose;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
};

/** Bookings per group among the rows on screen (a group is one service date, so a day's list holds all of it). */
export function groupSizes(rows: readonly object[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const g = groupIdOf(r);
    if (g) out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Client-side safety net for the groupId filter (the server filters too). */
export function filterByGroup<T extends object>(rows: readonly T[], groupId: string | null): T[] {
  return groupId ? rows.filter((r) => groupIdOf(r) === groupId) : [...rows];
}

/**
 * Dispatch board: the bookings of a group that can be put on a trip now (seatable, not in the draft yet), to select the
 * whole group at once.
 */
export function groupSelection(
  queue: readonly (Pick<TransportBookingDto, 'id' | 'status' | 'needsLocation' | 'pointsHidden'> & GroupFields)[],
  groupId: string,
  inDraft: ReadonlySet<string>,
): string[] {
  return queue.filter((b) => groupIdOf(b) === groupId && b.status === 'PENDING_ASSIGNMENT' && !b.needsLocation && !b.pointsHidden && !inDraft.has(b.id)).map((b) => b.id);
}

// ───────────────────────────── Group form ─────────────────────────────

export interface GroupDraft {
  passengerIds: string[];
  journey: TransportBookingJourney;
  serviceDate: string;
  direction: TransportDirection;
  shiftId: string | null;
  /** HOME = each passenger's own home (OWN); SITE / PLACE / MAP = one common point; NONE = not chosen. */
  pickup: PointChoice;
  /** SITE / PLACE / MAP; NONE = not chosen. */
  drop: PointChoice;
  startTime: string;
  endTime: string;
  purpose: string;
  note: string;
  hold: boolean;
  lateReason: string;
}

/**
 * Which kinds each end offers. Commute IN: homes / place / map → site / place / map. Commute OUT: site / place / map →
 * place / map (the destination is one point, so no "own home" drop in a group). Point-to-point: homes / place / map →
 * place / map.
 */
export function groupPointKinds(journey: TransportBookingJourney, direction: TransportDirection, end: BookingEnd): PointKind[] {
  if (end === 'pickup') return journey === 'COMMUTE' && direction === 'OUT' ? ['SITE', 'PLACE', 'MAP'] : ['HOME', 'PLACE', 'MAP'];
  return journey === 'COMMUTE' && direction === 'IN' ? ['SITE', 'PLACE', 'MAP'] : ['PLACE', 'MAP'];
}

export function defaultGroupPoint(journey: TransportBookingJourney, direction: TransportDirection, end: BookingEnd): PointChoice {
  if (journey === 'POINT_TO_POINT') return pointChoice('NONE');
  if (end === 'pickup') return pointChoice(direction === 'IN' ? 'HOME' : 'SITE');
  return pointChoice(direction === 'IN' ? 'SITE' : 'NONE');
}

export function emptyGroupDraft(serviceDate: string): GroupDraft {
  return {
    passengerIds: [],
    journey: 'COMMUTE',
    serviceDate,
    direction: 'IN',
    shiftId: null,
    pickup: defaultGroupPoint('COMMUTE', 'IN', 'pickup'),
    drop: defaultGroupPoint('COMMUTE', 'IN', 'drop'),
    startTime: '',
    endTime: '',
    purpose: '',
    note: '',
    hold: false,
    lateReason: '',
  };
}

/** Switch journey / direction; a chosen place or map point that still fits is kept, everything else resets. */
export function withGroupJourney(d: GroupDraft, journey: TransportBookingJourney, direction: TransportDirection = d.direction): GroupDraft {
  const keep = (c: PointChoice, end: BookingEnd) => ((c.kind === 'PLACE' || c.kind === 'MAP') && groupPointKinds(journey, direction, end).includes(c.kind) ? c : defaultGroupPoint(journey, direction, end));
  return { ...d, journey, direction, pickup: keep(d.pickup, 'pickup'), drop: keep(d.drop, 'drop') };
}

/** Remove passengers (e.g. the ones the server refused) from the draft. */
export function withoutPassengers(d: GroupDraft, ids: readonly string[]): GroupDraft {
  const drop = new Set(ids);
  return { ...d, passengerIds: d.passengerIds.filter((id) => !drop.has(id)) };
}

export interface GroupPassengerInfo {
  name: string;
  routingConsent: boolean;
  hasHome: boolean;
}

export interface GroupContext extends Omit<AdhocContext, 'passenger'> {
  /** What the form knows about each chosen passenger (from the option lists); unknown ids are not checked. */
  passengers: Record<string, GroupPassengerInfo>;
}

export type GroupField = 'passengers' | 'serviceDate' | 'shift' | 'pickup' | 'drop' | 'pickupLabel' | 'dropLabel' | 'window' | 'purpose' | 'note' | 'lateReason';
export type GroupErrors = Partial<Record<GroupField, string>>;

/** Whether the group's points are personal data for every passenger (own homes or a one-time map point, D-A3). */
export function groupNeedsConsent(d: Pick<GroupDraft, 'pickup' | 'drop'>): boolean {
  return d.pickup.kind === 'HOME' || d.pickup.kind === 'MAP' || d.drop.kind === 'MAP';
}

/** Chosen passengers without an active routing consent (only matters when `groupNeedsConsent`). */
export function passengersWithoutConsent(d: Pick<GroupDraft, 'passengerIds'>, ctx: Pick<GroupContext, 'passengers'>): string[] {
  return d.passengerIds.filter((id) => ctx.passengers[id] && !ctx.passengers[id].routingConsent);
}

/** Chosen passengers with consent but no home / default pickup (own-home pickup would leave them without a location). */
export function passengersWithoutHome(d: Pick<GroupDraft, 'passengerIds'>, ctx: Pick<GroupContext, 'passengers'>): string[] {
  return d.passengerIds.filter((id) => ctx.passengers[id] && ctx.passengers[id].routingConsent && !ctx.passengers[id].hasHome);
}

const names = (ids: string[], ctx: Pick<GroupContext, 'passengers'>) => ids.map((id) => ctx.passengers[id]?.name ?? id).join(', ');

function groupPointError(c: PointChoice, end: BookingEnd, d: GroupDraft, ctx: GroupContext, t: Translate): string | undefined {
  switch (c.kind) {
    case 'NONE':
      return end === 'pickup' ? t('Choose the pickup.') : t('Choose the destination.');
    case 'HOME': {
      const missing = passengersWithoutHome(d, ctx);
      if (missing.length) return t('No home point yet for: {{names}}. Remove them or choose a common pickup.', { names: names(missing, ctx) });
      return undefined;
    }
    case 'SITE':
      if (!ctx.shift) return t('Without a shift there is no site: choose a company place or a point on the map.');
      if (!ctx.shift.site) return t('This shift has no site: choose a company place or a point on the map.');
      return undefined;
    case 'PLACE':
      return c.place ? undefined : t('Choose a company place.');
    case 'MAP':
      return c.point ? undefined : t('Click the map or search an address to set the point.');
    default:
      return undefined;
  }
}

function groupLabelError(c: PointChoice, t: Translate): string | undefined {
  if (c.label.trim().length > LABEL_MAX) return t('At most {{n}} characters.', { n: LABEL_MAX });
  if (c.kind === 'MAP' && c.point && !c.label.trim()) return t('Give the point a short label (e.g. "Client office gate").');
  return undefined;
}

/** Inline errors of the group form (the server's rules). */
export function validateGroup(d: GroupDraft, ctx: GroupContext, opts: { lateRequired?: boolean } = {}, t: Translate = english): GroupErrors {
  const e: GroupErrors = {};
  const n = d.passengerIds.length;
  if (n < TRANSPORT_ADHOC_LIMITS.groupMin) e.passengers = t('Choose at least {{n}} passengers.', { n: TRANSPORT_ADHOC_LIMITS.groupMin });
  else if (n > TRANSPORT_ADHOC_LIMITS.groupMax) e.passengers = t('At most {{n}} passengers in one group.', { n: TRANSPORT_ADHOC_LIMITS.groupMax });
  else if (new Set(d.passengerIds).size !== n) e.passengers = t('A passenger is chosen twice.');
  else if (groupNeedsConsent(d)) {
    const blocked = passengersWithoutConsent(d, ctx);
    if (blocked.length) e.passengers = t('No active transport consent: {{names}}. Remove them or use company places for pickup and destination.', { names: names(blocked, ctx) });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.serviceDate)) e.serviceDate = t('Required');
  else if (d.serviceDate < ctx.today) e.serviceDate = t('The date is in the past.');
  else if (d.serviceDate > shiftDay(ctx.today, TRANSPORT_E3_LIMITS.adhocMaxDaysAhead)) e.serviceDate = t('Book at most {{n}} days ahead.', { n: TRANSPORT_E3_LIMITS.adhocMaxDaysAhead });

  const typed = !!(d.startTime || d.endTime);
  if (d.journey === 'COMMUTE' && !d.shiftId && !typed) e.shift = t('Choose a shift, or give the time window.');

  const pe = groupPointError(d.pickup, 'pickup', d, ctx, t);
  if (pe) e.pickup = pe;
  const de = groupPointError(d.drop, 'drop', d, ctx, t);
  if (de) e.drop = de;
  const pl = groupLabelError(d.pickup, t);
  if (pl) e.pickupLabel = pl;
  const dl = groupLabelError(d.drop, t);
  if (dl) e.dropLabel = dl;

  const w = resolveWindow(d, ctx);
  if (typed && (!HHMM.test(d.startTime) || !HHMM.test(d.endTime))) e.window = t('Give both the start and the end time.');
  else if (!typed && d.journey === 'POINT_TO_POINT') e.window = t('A point-to-point ride needs a time window.');
  else if (!typed && !d.shiftId && d.journey === 'COMMUTE') e.window = t('Without a shift, give the time window.');
  else if (w) {
    if (w.end <= w.start) e.window = t('The window must end after it starts.');
    else if (w.end - w.start > MAX_WINDOW_MS) e.window = t('The window can be at most 12 hours.');
    else if (w.end < ctx.nowMs) e.window = t('The window has already passed.');
  }

  const purpose = d.purpose.trim();
  if (!purpose) e.purpose = t('Say why the group travels (e.g. "Site visit — plant 2").');
  else if (purpose.length > TRANSPORT_ADHOC_LIMITS.purposeMax) e.purpose = t('At most {{n}} characters.', { n: TRANSPORT_ADHOC_LIMITS.purposeMax });
  if (d.note.length > TRANSPORT_E3_LIMITS.noteMax) e.note = t('At most {{n}} characters.', { n: TRANSPORT_E3_LIMITS.noteMax });

  if (isLate(w, ctx, opts.lateRequired)) {
    const le = lateReasonError(d.lateReason, t);
    if (le) e.lateReason = le;
  }
  return e;
}

export const hasGroupErrors = (e: GroupErrors) => Object.values(e).some(Boolean);

function sitePoint(site: PlaceRef | null | undefined): GeoPoint | null {
  return site ? { lat: site.lat, lng: site.lng, label: site.name, poiId: site.id } : null;
}

/** The common point of an end (SITE uses the shift's site), or null. */
function commonPoint(c: PointChoice, ctx: Pick<GroupContext, 'shift'>): GeoPoint | null {
  if (c.kind === 'SITE') return sitePoint(ctx.shift?.site);
  return choiceToPoint(c) ?? null;
}

/** The POST /transport/bookings/group body. Only call when `validateGroup` found nothing. */
export function buildGroupInput(d: GroupDraft, ctx: Pick<GroupContext, 'shift' | 'timeZone' | 'cutoffMin' | 'nowMs'>, opts: { lateRequired?: boolean } = {}): CreateTransportGroupBookingInput {
  const w = resolveWindow(d, ctx);
  const pickupPoint = d.pickup.kind === 'HOME' ? null : commonPoint(d.pickup, ctx);
  const input: CreateTransportGroupBookingInput = {
    passengerIds: [...d.passengerIds],
    serviceDate: d.serviceDate,
    journey: d.journey,
    shiftId: d.shiftId,
    pickup: d.pickup.kind === 'HOME' || !pickupPoint ? { mode: 'OWN' } : { mode: 'COMMON', point: pickupPoint },
    drop: commonPoint(d.drop, ctx) ?? { lat: 0, lng: 0, label: null, poiId: null },
    purpose: d.purpose.trim(),
    hold: d.hold,
  };
  if (d.journey === 'COMMUTE') input.direction = d.direction;
  if (w && w.from === 'typed') {
    input.windowStart = new Date(w.start).toISOString();
    input.windowEnd = new Date(w.end).toISOString();
  }
  if (d.note.trim()) input.note = d.note.trim();
  if (isLate(w, ctx, opts.lateRequired) && d.lateReason.trim()) input.lateReason = d.lateReason.trim();
  return input;
}

// ───────────────────────────── 422 GROUP_INVALID ─────────────────────────────

/** Per-passenger failure texts (reusing the single-booking texts where they fit). */
export const GROUP_FAILURE_TEXT: Record<string, string> = {
  CONSENT_REQUIRED: 'No active transport consent: only company places can be used for this passenger.',
  BOOKING_DUPLICATE: BOOKING_ERROR_TEXT.BOOKING_DUPLICATE,
  BOOKING_OVERLAP: BOOKING_ERROR_TEXT.BOOKING_OVERLAP,
  NEEDS_LOCATION: 'The passenger has no home point yet; choose a common pickup or remove them.',
  NOT_ELIGIBLE: BOOKING_ERROR_TEXT.NOT_ELIGIBLE,
};

/** The failures of a 422 GROUP_INVALID body (`failures` at the top level or under `details`); [] when malformed. */
export function parseGroupFailures(body: unknown): TransportGroupFailure[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as { failures?: unknown; details?: { failures?: unknown } };
  const raw = Array.isArray(b.failures) ? b.failures : Array.isArray(b.details?.failures) ? b.details.failures : [];
  const out: TransportGroupFailure[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const { passengerId, code, reason } = f as Record<string, unknown>;
    if (typeof passengerId !== 'string' || typeof code !== 'string') continue;
    out.push(typeof reason === 'string' ? { passengerId, code, reason } : { passengerId, code });
  }
  return out;
}

/** Readable reason of one failure (NOT_ELIGIBLE uses its reason). */
export function groupFailureText(f: TransportGroupFailure, t: Translate = english): string {
  if (f.code === 'NOT_ELIGIBLE' && f.reason && f.reason in INELIGIBLE_REASON_TEXT) return t(INELIGIBLE_REASON_TEXT[f.reason as keyof typeof INELIGIBLE_REASON_TEXT]);
  const own = GROUP_FAILURE_TEXT[f.code];
  if (own) return t(own);
  return t('This passenger cannot be booked ({{code}}).', { code: f.code });
}

export interface GroupFailureRow {
  passengerId: string;
  name: string;
  code: string;
  text: string;
}

/** Rows for the failure list: name (from the form's passengers; else a generic one) + readable reason. */
export function groupFailureRows(failures: readonly TransportGroupFailure[], nameOf: (id: string) => string | null | undefined, t: Translate = english): GroupFailureRow[] {
  return failures.map((f) => ({ passengerId: f.passengerId, name: nameOf(f.passengerId) || t('Unknown passenger'), code: f.code, text: groupFailureText(f, t) }));
}

// ───────────────────────────── Approval queue (D-A5 / D-A6) ─────────────────────────────

/** Days ahead the approval queue looks (covers desk and passenger requests). */
export const APPROVAL_DAYS_AHEAD = Math.max(TRANSPORT_E3_LIMITS.adhocMaxDaysAhead, TRANSPORT_SELF_LIMITS.maxDaysAhead);

/** The list query of "Requests to approve": every REQUESTED booking from today on, soonest first. */
export function approvalQuery(today: string, extra: Pick<TransportBookingListQuery, 'q' | 'page' | 'pageSize'> = {}): TransportBookingListQuery {
  return { from: today, to: shiftDay(today, APPROVAL_DAYS_AHEAD), bookingStatus: 'REQUESTED', sort: 'windowStart', order: 'asc', ...extra };
}

/** The self-service path writes this note (apps/api self-service: "Booked by passenger[: …]"). */
export const PASSENGER_NOTE_PREFIX = 'Booked by passenger';

/** Requested by the passenger in the app (vs arranged by the transport desk). */
export function isPassengerRequest(b: Pick<TransportBookingDto, 'source' | 'note'>): boolean {
  return b.source === 'ADHOC' && typeof b.note === 'string' && b.note.startsWith(PASSENGER_NOTE_PREFIX);
}

/** The passenger's own note without the marker; null when there is none. */
export function requestNote(b: Pick<TransportBookingDto, 'source' | 'note'>): string | null {
  if (!b.note) return null;
  if (!isPassengerRequest(b)) return b.note.trim() || null;
  const rest = b.note.slice(PASSENGER_NOTE_PREFIX.length).replace(/^:\s*/, '').trim();
  return rest || null;
}

/** Rows of the approval queue: REQUESTED bookings (the server's allowedActions decide what each offers). */
export function requestRows<T extends Pick<TransportBookingDto, 'status'>>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.status === 'REQUESTED');
}

export const canApprove = (b: Pick<TransportBookingDto, 'allowedActions'>) => b.allowedActions.includes('approve');
export const canReject = (b: Pick<TransportBookingDto, 'allowedActions'>) => b.allowedActions.includes('reject');

/** Ids that "Approve all" sends: REQUESTED rows on screen that allow approve (optionally only the selected ones). */
export function bulkApproveIds(rows: readonly Pick<TransportBookingDto, 'id' | 'status' | 'allowedActions'>[], selected?: ReadonlySet<string>): string[] {
  return rows.filter((r) => r.status === 'REQUESTED' && canApprove(r) && (!selected || selected.size === 0 || selected.has(r.id))).map((r) => r.id);
}

// ───────────────────────────── Settings ─────────────────────────────

/** `selfBookingApproval` (D-A5): absent = ON (requests wait for approval). */
export function selfBookingApprovalOf(s: (TransportSettingsDto & { selfBookingApproval?: boolean }) | null | undefined): boolean {
  return s?.selfBookingApproval !== false;
}
