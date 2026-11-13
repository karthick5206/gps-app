import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSPORT_ADHOC_LIMITS, type TransportBookingDto } from '@veetracer/shared';
import {
  APPROVAL_DAYS_AHEAD,
  approvalQuery,
  buildGroupInput,
  bulkApproveIds,
  canApprove,
  canReject,
  defaultGroupPoint,
  emptyGroupDraft,
  filterByGroup,
  groupFailureRows,
  groupFailureText,
  groupIdOf,
  groupPointKinds,
  groupSelection,
  groupSizes,
  hasGroupErrors,
  isPassengerRequest,
  parseGroupFailures,
  purposeOf,
  requestNote,
  requestRows,
  selfBookingApprovalOf,
  validateGroup,
  withGroupJourney,
  withoutPassengers,
  type GroupContext,
  type GroupDraft,
} from './group-booking.ts';

const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-11-12T03:30:00Z'); // 09:00 IST
const SITE = { id: 'site-1', name: 'Main office', lat: 13.0, lng: 80.2 };
const PLACE = { id: 'poi-9', name: 'Client campus', lat: 13.05, lng: 80.25 };
const SHIFT = { startMin: 14 * 60, endMin: 23 * 60, timeZone: TZ, site: SITE };
const P = (name: string, routingConsent = true, hasHome = true) => ({ name, routingConsent, hasHome });

const ctx = (over: Partial<GroupContext> = {}): GroupContext => ({
  passengers: { a: P('Asha Test'), b: P('Bala Test'), c: P('Chitra Test', false), d: P('Devi Test', true, false) },
  shift: SHIFT,
  timeZone: TZ,
  cutoffMin: 60,
  today: '2026-11-12',
  nowMs: NOW,
  ...over,
});
const draft = (over: Partial<GroupDraft> = {}): GroupDraft => ({ ...emptyGroupDraft('2026-11-12'), passengerIds: ['a', 'b'], shiftId: 'sh1', purpose: 'Site visit — plant 2', ...over });
const placeChoice = { kind: 'PLACE' as const, place: PLACE, point: null, label: '' };
const mapChoice = { kind: 'MAP' as const, place: null, point: { lat: 13.1, lng: 80.3 }, label: 'Client gate' };

test('group pickers: IN homes → site; OUT site → one destination; P2P homes / place / map → place / map', () => {
  assert.deepEqual(groupPointKinds('COMMUTE', 'IN', 'pickup'), ['HOME', 'PLACE', 'MAP']);
  assert.deepEqual(groupPointKinds('COMMUTE', 'IN', 'drop'), ['SITE', 'PLACE', 'MAP']);
  assert.deepEqual(groupPointKinds('COMMUTE', 'OUT', 'pickup'), ['SITE', 'PLACE', 'MAP']);
  assert.deepEqual(groupPointKinds('COMMUTE', 'OUT', 'drop'), ['PLACE', 'MAP']);
  assert.deepEqual(groupPointKinds('POINT_TO_POINT', 'IN', 'drop'), ['PLACE', 'MAP']);
  assert.equal(defaultGroupPoint('COMMUTE', 'IN', 'pickup').kind, 'HOME');
  assert.equal(defaultGroupPoint('COMMUTE', 'OUT', 'drop').kind, 'NONE');
  // Switching keeps a chosen place that still fits and resets the rest.
  const p2p = withGroupJourney({ ...draft(), drop: placeChoice }, 'POINT_TO_POINT');
  assert.equal(p2p.drop.kind, 'PLACE');
  assert.equal(p2p.pickup.kind, 'NONE');
  assert.equal(withGroupJourney(draft(), 'COMMUTE', 'OUT').pickup.kind, 'SITE');
});

test('group validation: passengers 2..max, purpose required, consent for homes / map points, window and late reason', () => {
  assert.deepEqual(validateGroup(draft(), ctx()), {});
  assert.ok(validateGroup(draft({ passengerIds: ['a'] }), ctx()).passengers);
  const many = Array.from({ length: TRANSPORT_ADHOC_LIMITS.groupMax + 1 }, (_, i) => `p${i}`);
  assert.match(validateGroup(draft({ passengerIds: many }), ctx()).passengers ?? '', /At most 30/);
  assert.ok(validateGroup(draft({ passengerIds: ['a', 'a'] }), ctx()).passengers);
  assert.ok(validateGroup(draft({ purpose: '   ' }), ctx()).purpose);
  assert.ok(validateGroup(draft({ purpose: 'x'.repeat(TRANSPORT_ADHOC_LIMITS.purposeMax + 1) }), ctx()).purpose);
  // Own homes: a passenger without consent is named; one without a home point too.
  assert.match(validateGroup(draft({ passengerIds: ['a', 'c'] }), ctx()).passengers ?? '', /Chitra Test/);
  assert.match(validateGroup(draft({ passengerIds: ['a', 'd'] }), ctx()).pickup ?? '', /Devi Test/);
  // Company places only: consent does not matter.
  assert.deepEqual(validateGroup(draft({ passengerIds: ['a', 'c'], pickup: placeChoice }), ctx()), {});
  // A one-time map point as destination needs consent from everyone, and a label.
  assert.ok(validateGroup(draft({ passengerIds: ['a', 'c'], pickup: placeChoice, drop: mapChoice }), ctx()).passengers);
  assert.ok(validateGroup(draft({ pickup: placeChoice, drop: { ...mapChoice, label: '' } }), ctx()).dropLabel);
  // Site without a shift; P2P without a window.
  assert.ok(validateGroup(draft({ shiftId: null, startTime: '10:00', endTime: '11:00' }), ctx({ shift: null })).drop);
  assert.ok(validateGroup(draft({ journey: 'POINT_TO_POINT', pickup: placeChoice, drop: mapChoice }), ctx()).window);
  // After the cut-off (10:00 window at 09:30 with a 60-minute cut-off) a reason is required.
  const late = draft({ startTime: '10:00', endTime: '10:30' });
  assert.ok(validateGroup(late, ctx()).lateReason);
  assert.equal(hasGroupErrors(validateGroup({ ...late, lateReason: 'Client moved the meeting forward' }, ctx())), false);
  assert.ok(validateGroup(draft(), ctx(), { lateRequired: true }).lateReason);
});

test('group input: OWN vs COMMON pickup, site as the destination point, typed window, late reason only when late', () => {
  const own = buildGroupInput(draft({ note: ' bring ID ' }), ctx());
  assert.deepEqual(own.pickup, { mode: 'OWN' });
  assert.deepEqual(own.drop, { lat: 13.0, lng: 80.2, label: 'Main office', poiId: 'site-1' });
  assert.equal(own.direction, 'IN');
  assert.equal(own.purpose, 'Site visit — plant 2');
  assert.equal(own.note, 'bring ID');
  assert.equal(own.windowStart, undefined);
  assert.equal(own.lateReason, undefined);
  const common = buildGroupInput(draft({ journey: 'POINT_TO_POINT', pickup: placeChoice, drop: mapChoice, startTime: '15:00', endTime: '16:00', lateReason: 'ignored' }), ctx());
  assert.deepEqual(common.pickup, { mode: 'COMMON', point: { lat: 13.05, lng: 80.25, label: 'Client campus', poiId: 'poi-9' } });
  assert.deepEqual(common.drop, { lat: 13.1, lng: 80.3, label: 'Client gate', poiId: null });
  assert.equal(common.direction, undefined);
  assert.equal(common.windowStart, '2026-11-12T09:30:00.000Z');
  assert.equal(common.lateReason, undefined);
  const late = buildGroupInput(draft({ startTime: '10:00', endTime: '10:30', lateReason: '  Client moved it  ' }), ctx());
  assert.equal(late.lateReason, 'Client moved it');
  assert.deepEqual(withoutPassengers(draft({ passengerIds: ['a', 'b', 'c'] }), ['c']).passengerIds, ['a', 'b']);
});

test('422 GROUP_INVALID: failures parsed defensively and mapped to name + readable reason', () => {
  const body = {
    code: 'GROUP_INVALID',
    failures: [
      { passengerId: 'c', code: 'CONSENT_REQUIRED' },
      { passengerId: 'b', code: 'NOT_ELIGIBLE', reason: 'SHIFT_NOT_RUNNING' },
      { passengerId: 'x', code: 'WEIRD' },
      { code: 'NO_ID' },
      null,
    ],
  };
  const f = parseGroupFailures(body);
  assert.equal(f.length, 3);
  assert.deepEqual(parseGroupFailures({ details: { failures: [{ passengerId: 'a', code: 'BOOKING_OVERLAP' }] } }), [{ passengerId: 'a', code: 'BOOKING_OVERLAP' }]);
  assert.deepEqual(parseGroupFailures(null), []);
  assert.deepEqual(parseGroupFailures({ failures: 'nope' }), []);
  const names: Record<string, string> = { b: 'Bala Test', c: 'Chitra Test' };
  const rows = groupFailureRows(f, (id) => names[id]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.code]),
    [
      ['Chitra Test', 'CONSENT_REQUIRED'],
      ['Bala Test', 'NOT_ELIGIBLE'],
      ['Unknown passenger', 'WEIRD'],
    ],
  );
  assert.match(rows[0].text, /consent/);
  assert.match(rows[1].text, /does not run on this date/);
  assert.match(rows[2].text, /WEIRD/);
  assert.match(groupFailureText({ passengerId: 'a', code: 'NEEDS_LOCATION' }), /no home point/);
  assert.match(groupFailureText({ passengerId: 'a', code: 'BOOKING_DUPLICATE' }), /already has a commute booking/);
  assert.match(groupFailureText({ passengerId: 'a', code: 'NOT_ELIGIBLE', reason: 'UNKNOWN' }), /cannot be booked for this ride/);
});

const booking = (over: Partial<TransportBookingDto> & { groupId?: string | null; purpose?: string | null } = {}): TransportBookingDto =>
  ({
    id: 'b1',
    version: 1,
    status: 'REQUESTED',
    statusReason: null,
    source: 'ADHOC',
    passenger: { id: 'p1', displayName: 'Test Passenger', employeeCode: 'T-001' },
    needsLocation: false,
    pointsHidden: null,
    allowedActions: ['edit', 'approve', 'reject', 'cancel'],
    note: null,
    ...over,
  }) as TransportBookingDto;

test('group list helpers: sizes, filter by groupId, select a whole group on the board', () => {
  const rows = [booking({ id: '1', groupId: 'g1', purpose: ' Site visit ' }), booking({ id: '2', groupId: 'g1' }), booking({ id: '3', groupId: 'g2' }), booking({ id: '4' })];
  assert.equal(groupSizes(rows).get('g1'), 2);
  assert.equal(groupSizes(rows).get('g2'), 1);
  // QA B5: the server's groupSize wins over the rows on screen (paged lists, partly seated groups on the board).
  const paged = [booking({ id: '1', groupId: 'g1', groupSize: 5 }), booking({ id: '2', groupId: 'g1', groupSize: 5 }), booking({ id: '3', groupId: 'g2', groupSize: null })];
  assert.equal(groupSizes(paged).get('g1'), 5);
  assert.equal(groupSizes(paged).get('g2'), 1);
  assert.equal(groupIdOf(rows[3]), null);
  assert.equal(purposeOf(rows[0]), 'Site visit');
  assert.equal(purposeOf(rows[1]), null);
  assert.deepEqual(filterByGroup(rows, 'g1').map((r) => r.id), ['1', '2']);
  assert.equal(filterByGroup(rows, null).length, 4);
  const queue = [
    booking({ id: '1', groupId: 'g1', status: 'PENDING_ASSIGNMENT' }),
    booking({ id: '2', groupId: 'g1', status: 'PENDING_ASSIGNMENT', needsLocation: true }),
    booking({ id: '3', groupId: 'g1', status: 'REQUESTED' }),
    booking({ id: '4', groupId: 'g1', status: 'PENDING_ASSIGNMENT' }),
    booking({ id: '5', groupId: 'g2', status: 'PENDING_ASSIGNMENT' }),
  ];
  assert.deepEqual(groupSelection(queue, 'g1', new Set(['4'])), ['1']);
  assert.deepEqual(groupSelection(queue, 'g1', new Set()), ['1', '4']);
});

test('approval queue: REQUESTED from today on, passenger vs desk, allowedActions respected', () => {
  const q = approvalQuery('2026-11-12', { q: 'asha', page: 2, pageSize: 50 });
  assert.equal(q.bookingStatus, 'REQUESTED');
  assert.equal(q.from, '2026-11-12');
  assert.ok(APPROVAL_DAYS_AHEAD >= 14);
  assert.equal(q.sort, 'windowStart');
  assert.equal(q.q, 'asha');
  const mine = booking({ note: 'Booked by passenger: Late meeting' });
  assert.equal(isPassengerRequest(mine), true);
  assert.equal(requestNote(mine), 'Late meeting');
  assert.equal(requestNote(booking({ note: 'Booked by passenger' })), null);
  assert.equal(isPassengerRequest(booking({ note: 'Desk note' })), false);
  assert.equal(requestNote(booking({ note: 'Desk note' })), 'Desk note');
  assert.equal(isPassengerRequest(booking({ source: 'SCHEDULE', note: 'Booked by passenger' })), false);
  // QA B3: the server's requestedByPassenger decides; both self-service note markers are stripped.
  const req = booking({ requestedByPassenger: true, note: 'Requested by passenger: Client dinner' });
  assert.equal(isPassengerRequest(req), true);
  assert.equal(requestNote(req), 'Client dinner');
  assert.equal(requestNote(booking({ requestedByPassenger: true, note: 'Requested by passenger' })), null);
  assert.equal(isPassengerRequest(booking({ requestedByPassenger: false, note: 'Booked by passenger: typed by the desk' })), false);
  assert.equal(requestNote(booking({ requestedByPassenger: false, note: 'Requested by passenger: x' })), 'Requested by passenger: x');
  const rows = [booking({ id: '1' }), booking({ id: '2', allowedActions: ['cancel'] }), booking({ id: '3', status: 'PENDING_ASSIGNMENT' })];
  assert.deepEqual(requestRows(rows).map((r) => r.id), ['1', '2']);
  assert.equal(canApprove(rows[1]), false);
  assert.equal(canReject(rows[1]), false);
  assert.equal(canReject(rows[0]), true);
  assert.deepEqual(bulkApproveIds(rows), ['1']);
  assert.deepEqual(bulkApproveIds(rows, new Set(['2'])), []);
  assert.deepEqual(bulkApproveIds(rows, new Set()), ['1']);
});

test('settings: passenger requests need approval unless explicitly switched off', () => {
  assert.equal(selfBookingApprovalOf(undefined), true);
  assert.equal(selfBookingApprovalOf({ directoryListed: false }), true);
  assert.equal(selfBookingApprovalOf({ directoryListed: false, selfBookingApproval: true }), true);
  assert.equal(selfBookingApprovalOf({ directoryListed: false, selfBookingApproval: false }), false);
});
