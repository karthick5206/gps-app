/**
 * E4 WP-W (risk-based, small fixtures): strategy / preferences → request body (max ride capped at the plan's limit),
 * undo / redo cursor, review-stale handling, compare best values with the WP-A metrics, drag-and-drop → request, and
 * the hi / ta strings of the new pure modules.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSLATIONS, type RoutePlanMetricsDto, type RoutePlanReviewDto, type RoutePlanVersionDto } from '@veetracer/shared';
import { COMPARE_STRINGS, e4Best, e4Text, excludedLines } from './plan-compare.ts';
import { planEditCall } from './plan-edit-call.ts';
import { initialReviewFlow, publishErrorAction, REVIEW_LOGIC_STRINGS, reviewFlow, reviewPublishState } from './plan-review.ts';
import { alternativesBody, alternativesError, defaultPreferencesDraft, maxRideCapS, preferencesDraftOf, preferencesRequest, runFields, STRATEGY_STRINGS, strategyDraftOf, toggleStrategy } from './plan-strategy.ts';
import { afterEdit, afterRestore, afterRestoreConflict, cursorFromHistory, dropToEdit, redoTarget, routeIssues, undoTarget, WORKSPACE_LOGIC_STRINGS } from './plan-workspace.ts';
import { optimizeOptions } from './planner-flow.ts';
import type { PlannerPlan } from './planner-format.ts';

// ───────────────────────────── strategy / preferences ─────────────────────────────

test('strategy is the primary control: no weights unless Advanced; Advanced sends complete weights + objective', () => {
  assert.deepEqual(runFields({ strategy: 'COMFORT', useWeights: false, weights: { vehicle: null, distance: null, time: null, routeDuration: null } }), { ok: true, value: { strategy: 'COMFORT' } });
  assert.equal(runFields({ strategy: 'BALANCED', useWeights: true, weights: { vehicle: 1, distance: null, time: 1, routeDuration: 0 } }).ok, false);
  assert.deepEqual(runFields({ strategy: 'BALANCED', useWeights: true, weights: { vehicle: 10, distance: 1, time: 0, routeDuration: 0 } }), { ok: true, value: { strategy: 'BALANCED', weights: { vehicle: 10, distance: 1, time: 0, routeDuration: 0 }, objective: 'distance' } });
  // The optimise body: strategy + preferences, no weights / objective.
  const body = optimizeOptions({ version: 4 }, { strategy: 'FEWER_VEHICLES', timeLimitS: 30, preferences: { vehicleSize: 'SMALLER' } });
  assert.deepEqual(body, { expectedVersion: 4, timeLimitS: 30, strategy: 'FEWER_VEHICLES', preferences: { vehicleSize: 'SMALLER' } });
  // Re-optimise prefill: the plan's strategy, else its raw weights under Advanced.
  assert.equal(strategyDraftOf({ strategy: 'FASTEST', weights: null }).strategy, 'FASTEST');
  assert.equal(strategyDraftOf({ strategy: null, weights: { vehicle: 1, distance: 0, time: 1, routeDuration: 0 } }).useWeights, true);
});

test('preferences: untouched form sends nothing; max ride is capped at the plan limit; bounds are checked', () => {
  const opts = { capS: 3600, preserve: true, canEditLocks: true };
  assert.deepEqual(preferencesRequest(defaultPreferencesDraft(), opts), { ok: true, value: undefined, capped: false });
  const capped = preferencesRequest({ ...defaultPreferencesDraft(), maxRideMinutes: '90' }, opts);
  assert.deepEqual(capped, { ok: true, value: { maxRideS: 3600 }, capped: true }, '90 min above a 60 min limit → 60 min');
  assert.deepEqual(preferencesRequest({ ...defaultPreferencesDraft(), maxRideMinutes: '45' }, opts), { ok: true, value: { maxRideS: 2700 }, capped: false });
  assert.equal(preferencesRequest({ ...defaultPreferencesDraft(), maxRideMinutes: '5' }, opts).ok, false, 'the MaxRideFields 15–240 rule');
  assert.equal(preferencesRequest({ ...defaultPreferencesDraft(), detourOn: true, detourRatio: '4' }, opts).ok, false);
  const full = preferencesRequest({ ...defaultPreferencesDraft(), detourOn: true, detourRatio: '1.5', detourExtraMin: '12', occupancy: '0.9', vehicleSize: 'LARGER', keepDirections: true, preservePins: false, preserveLocks: false }, opts);
  assert.deepEqual(full, { ok: true, capped: false, value: { detourGuard: { ratio: 1.5, extraMin: 12 }, preferredOccupancy: 0.9, vehicleSize: 'LARGER', groupingPreference: 'KEEP_DIRECTIONS', preservePins: false, preserveLocks: false } });
  // preserveLocks=false is never sent without etms_planning:edit; pins / locks only on a saved plan.
  const noEdit = preferencesRequest({ ...defaultPreferencesDraft(), preservePins: false, preserveLocks: false }, { ...opts, canEditLocks: false });
  assert.deepEqual(noEdit.ok && noEdit.value, { preservePins: false });
  assert.deepEqual(preferencesRequest({ ...defaultPreferencesDraft(), preservePins: false }, { ...opts, preserve: false }), { ok: true, value: undefined, capped: false });
  assert.equal(maxRideCapS(3600, 5400), 5400, 'the override is the limit');
  assert.equal(maxRideCapS(3600, null), 3600);
  assert.equal(maxRideCapS(null, null), null);
  assert.equal(preferencesDraftOf({ preferredOccupancy: 0.75, groupingPreference: 'KEEP_DIRECTIONS' }).occupancy, '0.75');
});

test('alternatives: 2–5 distinct strategies in the shared order; body carries expectedVersion and preferences', () => {
  let s = toggleStrategy([], 'COMFORT', true);
  s = toggleStrategy(s, 'BALANCED', true);
  assert.deepEqual(s, ['BALANCED', 'COMFORT']);
  assert.equal(alternativesError(['BALANCED']), 'Choose 2 to 5 strategies for alternatives.');
  assert.equal(alternativesError(s), null);
  assert.deepEqual(alternativesBody({ version: 3 }, { strategies: s, timeLimitS: 30, preferences: { maxRideS: 2700 } }), { strategies: ['BALANCED', 'COMFORT'], expectedVersion: 3, timeLimitS: 30, preferences: { maxRideS: 2700 } });
});

// ───────────────────────────── undo / redo ─────────────────────────────

const stop = (id: string, assignmentId: string | null, sequence: number | null, extra: Partial<PlannerPlan['stops'][number]> = {}) => ({ id, assignmentId, sequence, bookingId: null, stopKind: null, pinned: false, ...extra }) as PlannerPlan['stops'][number];
const planOf = (version: number, stops: PlannerPlan['stops'], assignments: Partial<PlannerPlan['assignments'][number]>[] = [{ id: 'a' }, { id: 'b' }]) => ({ version, stops, assignments: assignments as PlannerPlan['assignments'], violations: [], publishCheck: null }) as unknown as PlannerPlan;
const snap = (version: number, changeType: string, a: string[], b: string[], all = ['s1', 's2', 's3']): RoutePlanVersionDto => ({
  version,
  changeType,
  changedById: null,
  createdAt: '',
  snapshot: { status: 'PLANNED', assignments: [{ id: 'a', vehicleLabel: '', objectId: null, driverId: null, stopIds: a }, { id: 'b', vehicleLabel: '', objectId: null, driverId: null, stopIds: b }], stops: all.map((id) => ({ id, ref: id, assignmentId: null, sequence: null, etaS: null, unassignedReason: null })) },
});

test('undo / redo cursor: steps by membership, restore moves the cursor, a new edit drops redo, a stop-set change resets', () => {
  const v3 = planOf(3, [stop('s1', 'a', 0), stop('s2', 'b', 0), stop('s3', 'b', 1)]);
  const hist = [snap(1, 'OPTIMIZED', ['s1', 's2'], ['s3']), snap(2, 'EDITED', ['s1', 's2'], ['s3']) /* pin only: same membership */, snap(3, 'EDITED', ['s1'], ['s2', 's3'])];
  let c = cursorFromHistory(hist, v3);
  assert.deepEqual(c.steps.map((s) => s.version), [2, 3], 'v1 and v2 have the same membership: one step');
  assert.equal(undoTarget(c), 2);
  assert.equal(redoTarget(c), null);
  // Undo → restore(2) produced v4 with v2's membership.
  c = afterRestore(c, -1, { version: 4 });
  assert.equal(c.head, 4);
  assert.equal(undoTarget(c), null);
  assert.equal(redoTarget(c), 3);
  // A manual edit now drops the redo branch.
  const v5 = planOf(5, [stop('s1', 'b', 0), stop('s2', 'a', 0), stop('s3', 'b', 1)]);
  c = afterEdit(c, v5);
  assert.equal(redoTarget(c), null);
  assert.equal(undoTarget(c), 2);
  // A booking added (stop set changed): restore of older versions would conflict → new timeline.
  c = afterEdit(c, planOf(6, [...v5.stops, stop('s4', null, null)]));
  assert.equal(undoTarget(c), null);
  // Versions with another stop set are never offered.
  assert.deepEqual(cursorFromHistory([snap(1, 'OPTIMIZED', ['s1'], ['s2'], ['s1', 's2'])], v3).steps.map((s) => s.version), [3]);
  // PLAN_RESTORE_CONFLICT on undo: the steps before can no longer be restored.
  const c2 = afterRestoreConflict(cursorFromHistory(hist, v3), -1);
  assert.equal(undoTarget(c2), null);
});

// ───────────────────────────── review & publish ─────────────────────────────

const review = (o: Partial<RoutePlanReviewDto> = {}): RoutePlanReviewDto =>
  ({ planId: 'p', version: 7, status: 'PLANNED', planStartAt: null, assignmentIds: ['a'], routes: [{ assignmentId: 'a' }], unassigned: [], otherRoutes: [], manualChanges: { baselineVersion: 5, baselineChangeType: 'OPTIMIZED', routes: [] }, publishCheck: { hard: [], soft: [], fingerprint: null, canOverride: false, routeErrors: [] }, errors: [], reviewHash: 'h1', ...o }) as RoutePlanReviewDto;

test('review publish body: needs the confirmation of exactly this reviewHash; carries assignmentIds + reviewHash + decision', () => {
  const r = review();
  assert.equal(reviewPublishState(r, { confirmedHash: null, acknowledged: false, overrideOn: false, reason: '' }).allowed, false);
  assert.equal(reviewPublishState(r, { confirmedHash: 'old', acknowledged: false, overrideOn: false, reason: '' }).allowed, false, 'a stale confirmation does not count');
  assert.deepEqual(reviewPublishState(r, { confirmedHash: 'h1', acknowledged: false, overrideOn: false, reason: '' }).body, { expectedVersion: 7, assignmentIds: ['a'], reviewHash: 'h1' });
  const soft = review({ publishCheck: { hard: [], soft: [{ assignmentId: 'a', vehicleLabel: 'V', stopId: 's', ref: 'r', kind: 'early_wait', etaS: 1, window: [2, 3] }], fingerprint: 'w1', canOverride: false } });
  assert.equal(reviewPublishState(soft, { confirmedHash: 'h1', acknowledged: false, overrideOn: false, reason: '' }).allowed, false);
  assert.equal(reviewPublishState(soft, { confirmedHash: 'h1', acknowledged: true, overrideOn: false, reason: '' }).body?.acknowledgedWarnings, 'w1');
  // VEHICLE_BUSY (pre-check) blocks, whatever else.
  const busy = review({ errors: [{ assignmentId: 'a', vehicleLabel: 'V', code: 'VEHICLE_BUSY', message: '' }] });
  const s = reviewPublishState(busy, { confirmedHash: 'h1', acknowledged: true, overrideOn: true, reason: 'Site gate opens late today' });
  assert.equal(s.allowed, false);
  assert.equal(s.blocked, true);
});

test('review state machine: PLAN_REVIEW_STALE reloads and needs a fresh confirmation; other errors keep it', () => {
  let f = reviewFlow(initialReviewFlow, { type: 'confirm', hash: 'h1', on: true });
  f = reviewFlow(f, { type: 'publish' });
  assert.equal(f.phase, 'publishing');
  f = reviewFlow(f, { type: 'error', code: 'PLAN_REVIEW_STALE' });
  assert.deepEqual(f, { phase: 'review', confirmedHash: null, notice: 'stale' });
  assert.equal(reviewFlow(f, { type: 'publish' }).phase, 'review', 'no publish without a new confirmation');
  f = reviewFlow(f, { type: 'loaded', hash: 'h2' });
  f = reviewFlow(f, { type: 'confirm', hash: 'h2', on: true });
  assert.equal(f.confirmedHash, 'h2');
  assert.equal(f.notice, null);
  // A refetch with another hash clears the confirmation; a selection change too.
  assert.equal(reviewFlow(f, { type: 'loaded', hash: 'h3' }).confirmedHash, null);
  assert.equal(reviewFlow(f, { type: 'selection' }).confirmedHash, null);
  // A non-reload error keeps the confirmation (e.g. a network error: retry with the same key).
  assert.equal(reviewFlow({ ...f, phase: 'publishing' }, { type: 'error', code: 'VEHICLE_BUSY' }).confirmedHash, 'h2');
  for (const code of ['PLAN_REVIEW_STALE', 'PLAN_REVIEW_REQUIRED', 'PLAN_STALE', 'ROUTE_ALREADY_PUBLISHED']) assert.equal(publishErrorAction(code), 'reload', code);
  assert.equal(publishErrorAction('VEHICLE_BUSY'), 'show');
  assert.equal(reviewFlow(f, { type: 'success' }).phase, 'published');
});

// ───────────────────────────── compare ─────────────────────────────

const m = (o: Partial<RoutePlanMetricsDto>): RoutePlanMetricsDto => ({ planId: 'x', name: 'x', planDate: '', status: 'PLANNED', version: 1, routes: 2, activeRoutes: 2, stops: 0, passengers: 10, seats: 0, unassigned: 0, distanceM: null, durationS: null, seatUtilisation: null, violations: 0, graphVersion: null, ...o });

test('compare: best value per WP-A metric (fewer vehicles, more seated, higher occupancy / on time); ties and gaps have none', () => {
  const a = m({ planId: 'a', vehiclesUsed: 2, passengersAssigned: 9, totalDistanceM: 30000, maxRideS: 1800, avgOccupancy: 0.6, deadlineCompliance: { inside: 9, total: 9, ratio: 1 }, excludedBookings: 1, excluded: [{ reason: 'fleet_too_small', bookings: 1 }] });
  const b = m({ planId: 'b', vehiclesUsed: 3, passengersAssigned: 10, totalDistanceM: 30000, maxRideS: null, avgOccupancy: 0.5, deadlineCompliance: { inside: 9, total: 10, ratio: 0.9 }, excludedBookings: 0 });
  const best = e4Best([a, b]);
  assert.deepEqual(best.vehiclesUsed, [0]);
  assert.deepEqual(best.passengersAssigned, [1]);
  assert.deepEqual(best.totalDistanceM, [], 'tie → no marker');
  assert.deepEqual(best.maxRideS, [], 'only one plan has a value');
  assert.deepEqual(best.avgOccupancy, [0]);
  assert.deepEqual(best.deadlineCompliance, [0]);
  assert.deepEqual(best.excluded, [1]);
  assert.equal(e4Text(a, 'deadlineCompliance'), '9 / 9 (100 %)');
  assert.deepEqual(excludedLines(a), ['Not enough vehicles within the maximum ride time or arrival window: 1']);
});

// ───────────────────────────── drag and drop → request ─────────────────────────────

test('drag and drop: reorder within a route, move a passenger to another route at the dropped index, refusals before any call', () => {
  // IN plan: route a = [p1 (pickup of b1), d1 (site drop of b1)], route b = [p2, d2].
  const stops = [stop('p1', 'a', 0, { bookingId: 'b1', stopKind: 'PICKUP' }), stop('d1', 'a', 1, { bookingId: 'b1', stopKind: 'DROP' }), stop('p2', 'b', 0, { bookingId: 'b2', stopKind: 'PICKUP' }), stop('d2', 'b', 1, { bookingId: 'b2', stopKind: 'DROP' }), stop('g', 'a', 2)];
  const plan = planOf(1, stops);
  // Pickup of b1 dropped before row 0 of route b → move-passenger with pickupIndex 0.
  assert.deepEqual(dropToEdit(plan, 'p1', { assignmentId: 'b', before: 0 }), { ok: true, edit: { kind: 'move', bookingId: 'b1', toAssignmentId: 'b', pickupIndex: 0 } });
  // The site drop dragged to the end of route b: pickup goes before b's first drop (index 1), so the drop index is 3.
  assert.deepEqual(dropToEdit(plan, 'd1', { assignmentId: 'b', before: null }), { ok: true, edit: { kind: 'move', bookingId: 'b1', toAssignmentId: 'b', dropIndex: 3 } });
  // Reorder within route a: the generic stop to the top.
  assert.deepEqual(dropToEdit(plan, 'g', { assignmentId: 'a', before: 0 }), { ok: true, edit: { kind: 'sequence', assignments: [{ assignmentId: 'a', stopIds: ['g', 'p1', 'd1'] }] } });
  // A drop ahead of its own pickup is refused.
  assert.deepEqual(dropToEdit(plan, 'd1', { assignmentId: 'a', before: 0 }), { ok: false, reason: 'The drop must come after the pickup.' });
  // Unassigned list = remove from route.
  assert.deepEqual(dropToEdit(plan, 'p2', { assignmentId: null, before: null }), { ok: true, edit: { kind: 'move', bookingId: 'b2', toAssignmentId: null } });
  // Locked / published / pinned.
  assert.equal(dropToEdit(planOf(1, stops, [{ id: 'a' }, { id: 'b', locked: true }]), 'p1', { assignmentId: 'b', before: 0 }).ok, false);
  assert.deepEqual(dropToEdit(planOf(1, stops, [{ id: 'a', published: true }, { id: 'b' }]), 'p1', { assignmentId: 'b', before: 0 }), { ok: false, reason: 'Published routes cannot change.' });
  const pinned = planOf(1, stops.map((s) => (s.id === 'd1' ? { ...s, pinned: true } : s)));
  assert.deepEqual(dropToEdit(pinned, 'p1', { assignmentId: 'b', before: 0 }), { ok: false, reason: 'That stop is pinned to its vehicle. Unpin it first.' });
});

test('edits map to the WP-B requests with the version the user saw', async () => {
  const calls: unknown[][] = [];
  const rec = (name: string) => async (...args: unknown[]) => (calls.push([name, ...args]), {}) as never;
  const c = { movePassenger: rec('move'), restore: rec('restore'), removeBooking: rec('removeBooking'), pinBooking: rec('pinBooking'), updateAssignment: rec('assignment'), recalculate: rec('recalculate'), addBooking: rec('addBooking') } as never;
  const p = { id: 'p', version: 9 };
  await planEditCall(c, p, { kind: 'move', bookingId: 'b1', toAssignmentId: 'a', pickupIndex: 0 });
  await planEditCall(c, p, { kind: 'restore', version: 7 });
  await planEditCall(c, p, { kind: 'removeBooking', bookingId: 'b1' });
  await planEditCall(c, p, { kind: 'pinBooking', bookingId: 'b1', pinned: true });
  await planEditCall(c, p, { kind: 'driver', assignmentId: 'a', driverId: null });
  await planEditCall(c, p, { kind: 'recalculate' });
  await planEditCall(c, p, { kind: 'addBooking', bookingId: 'b9' });
  assert.deepEqual(calls, [
    ['move', 'p', { expectedVersion: 9, bookingId: 'b1', toAssignmentId: 'a', pickupIndex: 0 }],
    ['restore', 'p', { expectedVersion: 9, version: 7 }],
    ['removeBooking', 'p', 'b1', 9],
    ['pinBooking', 'p', 'b1', { expectedVersion: 9, pinned: true }],
    ['assignment', 'p', 'a', { expectedVersion: 9, driverId: null }],
    ['recalculate', 'p', { expectedVersion: 9 }],
    ['addBooking', 'p', { expectedVersion: 9, bookingId: 'b9' }],
  ]);
});

test('route issues: route errors and route violations block; stop warnings are counted per kind', () => {
  const plan = { ...planOf(1, [stop('s1', 'a', 0), stop('s2', 'a', 1)]), violations: [{ stopId: 's1', ref: 's1', kind: 'early_wait', etaS: 1, window: null }], publishCheck: { hard: [], soft: [], fingerprint: null, canOverride: false, routeErrors: [{ assignmentId: 'a', vehicleLabel: 'V', code: 'DRIVER_BUSY', message: 'busy' }] } } as unknown as PlannerPlan;
  const r = routeIssues(plan, { violations: [{ stopId: 's2', ref: 's2', kind: 'over_capacity', etaS: 1, window: null }], routeViolations: [{ assignmentId: 'b', code: 'VEHICLE_NO_SEATS', message: 'no seats' }] });
  assert.deepEqual(r.get('a')?.errors.map((e) => e.code).sort(), ['DRIVER_BUSY', 'OVER_CAPACITY']);
  assert.deepEqual(r.get('a')?.warnings, [{ kind: 'early_wait', n: 1 }]);
  assert.deepEqual(r.get('b')?.errors.map((e) => e.code), ['VEHICLE_NO_SEATS']);
});

test('the new texts have hi and ta translations', () => {
  for (const s of [...STRATEGY_STRINGS, ...WORKSPACE_LOGIC_STRINGS, ...REVIEW_LOGIC_STRINGS, ...COMPARE_STRINGS]) for (const lang of ['hi', 'ta'] as const) assert.ok(TRANSLATIONS[lang][s], `${lang}: ${s}`);
});
