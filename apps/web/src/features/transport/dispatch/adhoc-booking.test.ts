import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTE_PLAN_SKIP_REASONS, TRANSPORT_E3_LIMITS, TRANSPORT_INELIGIBLE_REASONS, type TransportBookingDto } from '@veetracer/shared';
import { SKIPPED_REASON_HINT, SKIPPED_REASON_LABEL, skippedSummary, PLANNER_ERROR_TEXT } from '../planning/planner-format.ts';
import {
  bookingErrorText,
  buildCreateInput,
  buildUpdateInput,
  canEditBooking,
  choiceToPoint,
  defaultPoint,
  editDraftOf,
  editIsLate,
  emptyAdhocDraft,
  endMissing,
  endpointText,
  hasErrors,
  INELIGIBLE_REASON_TEXT,
  ineligibleReasonsCovered,
  isLate,
  learnCutoffMin,
  pointKinds,
  resolveWindow,
  routeText,
  validateAdhoc,
  validateEdit,
  withJourney,
  type AdhocContext,
  type AdhocDraft,
} from './adhoc-booking.ts';
import { e3ErrorText } from './e3-format.ts';

// Synthetic data only. Zone Asia/Kolkata (UTC+5:30, no DST).
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-11-12T03:30:00Z'); // 09:00 IST on 12 Nov
const SITE = { id: 'site-1', name: 'Main office', lat: 13.0, lng: 80.2 };
const PLACE = { id: 'poi-9', name: 'Client campus', lat: 13.05, lng: 80.25 };
const SHIFT = { startMin: 14 * 60, endMin: 23 * 60, timeZone: TZ, site: SITE }; // 14:00 – 23:00

const ctx = (over: Partial<AdhocContext> = {}): AdhocContext => ({
  passenger: { routingConsent: true, hasHome: true },
  shift: SHIFT,
  timeZone: TZ,
  cutoffMin: 60,
  today: '2026-11-12',
  nowMs: NOW,
  ...over,
});
const draft = (over: Partial<AdhocDraft> = {}): AdhocDraft => ({ ...emptyAdhocDraft('2026-11-12'), passengerId: 'p1', shiftId: 'sh1', ...over });

test('pickers: commute personal end offers home, office end the site; P2P offers place / map only; edit can keep', () => {
  assert.deepEqual(pointKinds('COMMUTE', 'IN', 'pickup'), ['HOME', 'PLACE', 'MAP']);
  assert.deepEqual(pointKinds('COMMUTE', 'IN', 'drop'), ['SITE', 'PLACE', 'MAP']);
  assert.deepEqual(pointKinds('COMMUTE', 'OUT', 'pickup'), ['SITE', 'PLACE', 'MAP']);
  assert.deepEqual(pointKinds('COMMUTE', 'OUT', 'drop'), ['HOME', 'PLACE', 'MAP']);
  assert.deepEqual(pointKinds('POINT_TO_POINT', 'IN', 'pickup'), ['PLACE', 'MAP']);
  assert.deepEqual(pointKinds('COMMUTE', 'IN', 'pickup', 'edit'), ['KEEP', 'PLACE', 'MAP']);
  assert.equal(defaultPoint('COMMUTE', 'IN', 'drop').kind, 'SITE');
  assert.equal(defaultPoint('POINT_TO_POINT', 'IN', 'drop').kind, 'NONE');
  // Switching to OUT swaps the defaults; switching to P2P clears home / site but keeps a chosen place.
  const out = withJourney(emptyAdhocDraft('2026-11-12'), 'COMMUTE', 'OUT');
  assert.equal(out.pickup.kind, 'SITE');
  assert.equal(out.drop.kind, 'HOME');
  const withPlace = { ...emptyAdhocDraft('2026-11-12'), drop: { kind: 'PLACE' as const, place: PLACE, point: null, label: '' } };
  const p2p = withJourney(withPlace, 'POINT_TO_POINT');
  assert.equal(p2p.pickup.kind, 'NONE');
  assert.equal(p2p.drop.kind, 'PLACE');
});

test('points: place sends poiId and its name; map point sends lat/lng + label; home / site are left out', () => {
  assert.deepEqual(choiceToPoint({ kind: 'PLACE', place: PLACE, point: null, label: '' }), { lat: 13.05, lng: 80.25, label: 'Client campus', poiId: 'poi-9' });
  assert.deepEqual(choiceToPoint({ kind: 'PLACE', place: PLACE, point: null, label: ' Gate 2 ' }), { lat: 13.05, lng: 80.25, label: 'Gate 2', poiId: 'poi-9' });
  assert.deepEqual(choiceToPoint({ kind: 'MAP', place: null, point: { lat: 12.9, lng: 80.1 }, label: 'Hotel lobby' }), { lat: 12.9, lng: 80.1, label: 'Hotel lobby', poiId: null });
  assert.equal(choiceToPoint({ kind: 'HOME', place: null, point: null, label: '' }), undefined);
  assert.equal(choiceToPoint({ kind: 'SITE', place: null, point: null, label: '' }), undefined);
  assert.equal(choiceToPoint({ kind: 'NONE', place: null, point: null, label: '' }), null);
});

test('window: shift leg window IN [login − 90, login], OUT [logout, logout + 90]; typed times; end ≤ start is next day', () => {
  const inW = resolveWindow(draft(), ctx())!;
  assert.equal(inW.from, 'shift');
  assert.equal(new Date(inW.end).toISOString(), '2026-11-12T08:30:00.000Z'); // 14:00 IST
  assert.equal(inW.end - inW.start, TRANSPORT_E3_LIMITS.inWindowMin * 60_000);
  const outW = resolveWindow(draft({ direction: 'OUT' }), ctx())!;
  assert.equal(new Date(outW.start).toISOString(), '2026-11-12T17:30:00.000Z'); // 23:00 IST
  const typed = resolveWindow(draft({ startTime: '22:00', endTime: '01:00' }), ctx())!;
  assert.equal(typed.from, 'typed');
  assert.equal(new Date(typed.start).toISOString(), '2026-11-12T16:30:00.000Z');
  assert.equal(new Date(typed.end).toISOString(), '2026-11-12T19:30:00.000Z'); // 01:00 IST on the 13th
  assert.equal(resolveWindow(draft({ journey: 'POINT_TO_POINT' }), ctx()), null, 'P2P never falls back to the shift window');
});

test('validation: commute needs a shift or a window; P2P needs both points and a window', () => {
  assert.deepEqual(validateAdhoc(draft(), ctx()), {});
  const noShift = validateAdhoc(draft({ shiftId: null }), ctx({ shift: null }));
  assert.ok(noShift.shift);
  assert.ok(noShift.window);
  assert.ok(noShift.drop, 'the site needs a shift');
  const p2p = validateAdhoc(withJourney(draft(), 'POINT_TO_POINT'), ctx());
  assert.ok(p2p.pickup && p2p.drop && p2p.window);
  const ok = validateAdhoc(
    draft({
      journey: 'POINT_TO_POINT',
      shiftId: null,
      pickup: { kind: 'PLACE', place: PLACE, point: null, label: '' },
      drop: { kind: 'MAP', place: null, point: { lat: 12.9, lng: 80.1 }, label: 'Hotel lobby' },
      startTime: '18:00',
      endTime: '19:00',
    }),
    ctx({ shift: null }),
  );
  assert.deepEqual(ok, {});
});

test('validation: dates, window limits, seats, map label, note', () => {
  assert.ok(validateAdhoc(draft({ serviceDate: '2026-11-11' }), ctx()).serviceDate);
  assert.ok(validateAdhoc(draft({ serviceDate: '2027-02-01' }), ctx()).serviceDate, 'more than 60 days ahead');
  assert.ok(validateAdhoc(draft({ startTime: '10:00', endTime: '' }), ctx()).window);
  assert.ok(validateAdhoc(draft({ startTime: '10:00', endTime: '09:00' }), ctx()).window, '23 h > 12 h');
  assert.ok(validateAdhoc(draft({ startTime: '05:00', endTime: '06:00' }), ctx()).window, 'already passed');
  assert.ok(validateAdhoc(draft({ seats: '0' }), ctx()).seats);
  assert.ok(validateAdhoc(draft({ seats: '7' }), ctx()).seats);
  assert.ok(validateAdhoc(draft({ drop: { kind: 'MAP', place: null, point: { lat: 1, lng: 2 }, label: '' } }), ctx()).dropLabel);
  assert.ok(validateAdhoc(draft({ note: 'x'.repeat(501) }), ctx()).note);
});

test('consent (D-A3): without active consent home and one-time points are refused, a company place is fine', () => {
  const c = ctx({ passenger: { routingConsent: false, hasHome: true } });
  assert.match(validateAdhoc(draft(), c).pickup ?? '', /no active transport consent/);
  assert.ok(validateAdhoc(draft({ pickup: { kind: 'MAP', place: null, point: { lat: 1, lng: 2 }, label: 'X' } }), c).pickup);
  assert.equal(validateAdhoc(draft({ pickup: { kind: 'PLACE', place: PLACE, point: null, label: '' } }), c).pickup, undefined);
});

test('late booking (D-A1): cut-off = window start − cut-off; a reason of ≥ lateReasonMin chars is required and sent', () => {
  // Window 14:00 IST, cut-off 60 min → 13:00 IST. Now 09:00: not late.
  assert.equal(isLate(resolveWindow(draft(), ctx()), ctx()), false);
  const lateCtx = ctx({ nowMs: Date.parse('2026-11-12T07:45:00Z') }); // 13:15 IST
  assert.equal(isLate(resolveWindow(draft(), lateCtx), lateCtx), true);
  assert.ok(validateAdhoc(draft(), lateCtx).lateReason);
  assert.ok(validateAdhoc(draft({ lateReason: 'too short' }), lateCtx).lateReason);
  const d = draft({ lateReason: '  Client visit moved earlier  ' });
  assert.deepEqual(validateAdhoc(d, lateCtx), {});
  assert.equal(buildCreateInput(d, lateCtx).lateReason, 'Client visit moved earlier');
  assert.equal(buildCreateInput(d, ctx()).lateReason, undefined, 'not late: no reason sent');
  // The server says LATE_REASON_REQUIRED (its company cut-off differs): the reason becomes required.
  assert.ok(validateAdhoc(draft(), ctx(), { lateRequired: true }).lateReason);
  assert.equal(buildCreateInput(d, ctx(), { lateRequired: true }).lateReason, 'Client visit moved earlier');
});

test('cut-off learned from the rows on screen (most common windowStart − cutoffAt), else the default', () => {
  assert.equal(learnCutoffMin([]), TRANSPORT_E3_LIMITS.defaultCutoffMin);
  const row = (start: string, cut: string | null) => ({ windowStart: start, cutoffAt: cut });
  assert.equal(learnCutoffMin([row('2026-11-12T08:00:00Z', '2026-11-12T06:00:00Z'), row('2026-11-12T09:00:00Z', '2026-11-12T07:00:00Z'), row('2026-11-12T09:00:00Z', '2026-11-12T08:30:00Z'), row('2026-11-12T09:00:00Z', null)]), 120);
});

test('create body: commute leaves home / site out; P2P has no direction, both points and the window', () => {
  const commute = buildCreateInput(draft({ seats: '2', note: ' gate B ', hold: true }), ctx());
  assert.deepEqual(commute, { passengerId: 'p1', serviceDate: '2026-11-12', journey: 'COMMUTE', direction: 'IN', shiftId: 'sh1', passengerCount: 2, hold: true, note: 'gate B' });
  const p2p = buildCreateInput(
    draft({
      journey: 'POINT_TO_POINT',
      shiftId: null,
      pickup: { kind: 'PLACE', place: PLACE, point: null, label: '' },
      drop: { kind: 'MAP', place: null, point: { lat: 12.9, lng: 80.1 }, label: 'Hotel lobby' },
      startTime: '18:00',
      endTime: '19:00',
    }),
    ctx({ shift: null }),
  );
  assert.equal(p2p.direction, undefined);
  assert.equal(p2p.journey, 'POINT_TO_POINT');
  assert.equal(p2p.pickup?.poiId, 'poi-9');
  assert.equal(p2p.drop?.label, 'Hotel lobby');
  assert.equal(p2p.windowStart, '2026-11-12T12:30:00.000Z');
  assert.equal(p2p.windowEnd, '2026-11-12T13:30:00.000Z');
});

const booking = (over: Partial<TransportBookingDto> = {}): TransportBookingDto => ({
  id: 'b1',
  version: 4,
  status: 'PENDING_ASSIGNMENT',
  statusReason: null,
  source: 'ADHOC',
  passenger: { id: 'p1', displayName: 'Test Passenger', employeeCode: 'T-001' },
  scheduleId: null,
  shiftId: 'sh1',
  shiftName: 'Afternoon',
  serviceDate: '2026-11-12',
  direction: 'IN',
  timeZone: TZ,
  pickup: null,
  drop: { lat: 13, lng: 80.2, label: 'Main office', poiId: 'site-1' },
  pickupLabel: null,
  dropLabel: 'Main office',
  pointsHidden: 'LIST_VIEW',
  needsLocation: false,
  windowStart: '2026-11-12T07:00:00.000Z',
  windowEnd: '2026-11-12T08:30:00.000Z',
  passengerCount: 1,
  cutoffAt: '2026-11-12T06:00:00.000Z',
  journey: 'COMMUTE',
  afterCutoff: false,
  lateReason: null,
  groupId: null,
  groupSize: null,
  purpose: null,
  requestedByPassenger: false,
  tripId: null,
  passengerTripId: null,
  customerCompanyId: 'c1',
  providerCompanyId: null,
  note: null,
  allowedActions: ['edit', 'cancel'],
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
  ...over,
});

test('edit: draft from the booking; only changes are sent with expectedVersion; nothing changed = null', () => {
  const b = booking();
  const e = editDraftOf(b);
  assert.equal(e.pickup.kind, 'KEEP');
  assert.equal(e.startTime, '12:30');
  assert.equal(e.endTime, '14:00');
  const ectx = { cutoffMin: 60, nowMs: NOW };
  assert.equal(buildUpdateInput(e, b, ectx), null);
  const moved = buildUpdateInput({ ...e, startTime: '13:00', seats: '2', drop: { kind: 'PLACE', place: PLACE, point: null, label: '' } }, b, ectx)!;
  assert.deepEqual(moved, { expectedVersion: 4, drop: { lat: 13.05, lng: 80.25, label: 'Client campus', poiId: 'poi-9' }, windowStart: '2026-11-12T07:30:00.000Z', windowEnd: '2026-11-12T08:30:00.000Z', passengerCount: 2 });
  assert.deepEqual(buildUpdateInput({ ...e, note: 'call on arrival' }, b, ectx), { expectedVersion: 4, note: 'call on arrival' });
  assert.deepEqual(buildUpdateInput({ ...e, note: '' }, booking({ note: 'old' }), ectx), { expectedVersion: 4, note: null });
});

test('edit: Needs location → the missing end must be set; a withheld home end is not "missing"', () => {
  const b = booking({ needsLocation: true, pickup: null, pickupLabel: null, pointsHidden: null });
  assert.equal(endMissing(b, 'pickup'), true);
  assert.equal(endMissing(b, 'drop'), false);
  const e = editDraftOf(b);
  assert.equal(e.pickup.kind, 'NONE');
  assert.ok(validateEdit(e, b, { passengerConsent: null, cutoffMin: 60, nowMs: NOW }).pickup);
  const set = { ...e, pickup: { kind: 'PLACE' as const, place: PLACE, point: null, label: '' } };
  assert.deepEqual(validateEdit(set, b, { passengerConsent: null, cutoffMin: 60, nowMs: NOW }), {});
  assert.equal(buildUpdateInput(set, b, { cutoffMin: 60, nowMs: NOW })?.pickup?.poiId, 'poi-9');
  // Consent known to be missing (pointsHidden CONSENT_REQUIRED): a one-time point is refused.
  const mapSet = { ...e, pickup: { kind: 'MAP' as const, place: null, point: { lat: 1, lng: 2 }, label: 'X' } };
  assert.ok(validateEdit(mapSet, b, { passengerConsent: false, cutoffMin: 60, nowMs: NOW }).pickup);
});

test('edit after the cut-off: Edit stays offered for editable states; a late reason is required and sent', () => {
  const late = booking({ allowedActions: ['edit', 'cancel'] }); // the server keeps 'edit' for the desk after the cut-off
  const after = Date.parse('2026-11-12T06:30:00Z');
  assert.equal(canEditBooking(late), true);
  assert.equal(canEditBooking(booking({ allowedActions: ['cancel'] })), false);
  assert.equal(canEditBooking(booking({ status: 'ASSIGNED', allowedActions: ['cancel'] })), false);
  const e = { ...editDraftOf(late), seats: '2' };
  const ectx = { passengerConsent: null, cutoffMin: 60, nowMs: after };
  assert.equal(editIsLate(e, late, ectx), true);
  assert.ok(validateEdit(e, late, ectx).lateReason);
  const withReason = { ...e, lateReason: 'Passenger brings a colleague' };
  assert.deepEqual(validateEdit(withReason, late, ectx), {});
  assert.equal(buildUpdateInput(withReason, late, ectx)?.lateReason, 'Passenger brings a colleague');
  // Before the cut-off, moving the window into the past cut-off makes it late too.
  const early = { ...editDraftOf(booking()), startTime: '09:30', endTime: '10:00' }; // cut-off 08:30 IST < now 09:00
  assert.equal(editIsLate(early, booking(), { cutoffMin: 60, nowMs: NOW }), true);
});

test('list text: labels only, never coordinates; withheld personal points read generically', () => {
  assert.equal(routeText(booking()), 'Home → Main office');
  assert.equal(endpointText(booking({ journey: 'POINT_TO_POINT', drop: null, dropLabel: null }), 'drop'), 'Personal point');
  assert.equal(endpointText(booking({ needsLocation: true, pickup: null, pickupLabel: null, pointsHidden: null }), 'pickup'), 'Needs location');
  assert.equal(endpointText(booking({ pickupLabel: 'Client campus' }), 'pickup'), 'Client campus');
  for (const s of [routeText(booking({ pickup: { lat: 12.3456, lng: 80.9876 } }))]) assert.doesNotMatch(s, /\d+\.\d+/);
});

test('errors: every ineligible reason has a message; booking codes map to clear texts', () => {
  assert.ok(ineligibleReasonsCovered());
  for (const r of TRANSPORT_INELIGIBLE_REASONS) assert.equal(bookingErrorText('NOT_ELIGIBLE', { code: 'NOT_ELIGIBLE', reason: r }), INELIGIBLE_REASON_TEXT[r]);
  assert.equal(bookingErrorText('NOT_ELIGIBLE', { reason: 'SOMETHING_NEW' }), 'This passenger cannot be booked for this ride.');
  assert.equal(bookingErrorText('CONSENT_REQUIRED', null), 'The passenger has no active transport consent; choose a company place.');
  assert.match(bookingErrorText('LATE_REASON_REQUIRED', null) ?? '', /reason/);
  assert.match(bookingErrorText('BOOKING_DUPLICATE', null) ?? '', /commute booking/);
  assert.match(bookingErrorText('BOOKING_OVERLAP', null) ?? '', /another booking at that time/);
  assert.equal(bookingErrorText('CAPACITY_EXCEEDED', null), null, 'others fall back to the generic E3 texts');
  for (const c of ['LATE_REASON_REQUIRED', 'NOT_ELIGIBLE', 'BOOKING_OVERLAP']) assert.ok(e3ErrorText(c), `generic text for ${c}`);
  assert.equal(hasErrors({}), false);
});

test('planner: every contract skip reason has a human label and an action hint; BOOKING_CHANGED is readable', () => {
  for (const r of ROUTE_PLAN_SKIP_REASONS) {
    assert.ok(SKIPPED_REASON_LABEL[r] && SKIPPED_REASON_LABEL[r] !== r, `label for ${r}`);
    assert.ok(SKIPPED_REASON_HINT[r], `hint for ${r}`);
  }
  const rows = skippedSummary([
    { bookingId: 'b1', reason: 'point_to_point' },
    { bookingId: 'b2', reason: 'needs_approval' },
    { bookingId: 'b3', reason: 'point_to_point' },
  ]);
  assert.deepEqual(rows.map((r) => [r.reason, r.label, r.n]), [
    ['point_to_point', 'Point-to-point ride', 2],
    ['needs_approval', 'Not approved yet', 1],
  ]);
  assert.match(rows[0].hint ?? '', /dispatch board/);
  assert.match(PLANNER_ERROR_TEXT.BOOKING_CHANGED, /changed after planning/);
});
