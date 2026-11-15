import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DispatchOptionDto, DispatchRequestDto, LiveDispatchDecisionDto } from '@veetracer/shared';
import { chosenAlternative, chosenOption, decideFlow, initialDecide, needsDispatcher, proposalActionable, proposalsOf, statusCounts, type DecideState } from './live-dispatch.ts';

const option = (id: string, over: Partial<DispatchOptionDto> = {}): DispatchOptionDto => ({
  optionId: id,
  kind: 'INSERT',
  tripId: 't1',
  objectId: 'v1',
  vehicleName: 'Cab 1',
  target: 'SCHEDULED',
  pickupEta: '2026-11-15T09:00:00.000Z',
  dropEta: '2026-11-15T09:30:00.000Z',
  addedS: 240,
  affectedPassengers: 2,
  changes: [],
  autoApplicable: true,
  servedAs: 'SHARED',
  engine: 'FALLBACK',
  ...over,
});
const decision = (options: DispatchOptionDto[]): LiveDispatchDecisionDto => ({ requestId: 'r1', bookingId: 'b1', status: options.length ? 'DECIDED' : 'REJECTED', options, chosenOptionId: null, changeSetId: null, reasons: options.length ? [] : ['CAPACITY'] });

test('find → options pre-choose the best (server order)', () => {
  let s: DecideState = decideFlow(initialDecide, { type: 'find', bookingId: 'b1' });
  assert.equal(s.step, 'finding');
  s = decideFlow(s, { type: 'found', decision: decision([option('o1'), option('o2')]) });
  assert.equal(s.step === 'options' && s.chosen, 'o1');
  s = decideFlow(s, { type: 'choose', optionId: 'o2' });
  assert.equal(chosenOption(s)?.optionId, 'o2');
});

test('no feasible option leaves nothing chosen', () => {
  const s = decideFlow(decideFlow(initialDecide, { type: 'find', bookingId: 'b1' }), { type: 'found', decision: decision([]) });
  assert.equal(s.step === 'options' && s.chosen, null);
  assert.equal(decideFlow(s, { type: 'apply', newKey: () => 'k' }), s);
});

test('apply keeps the Idempotency-Key for a retry after a network / server failure only', () => {
  let n = 0;
  const newKey = () => `k${++n}`;
  let s: DecideState = decideFlow(decideFlow(initialDecide, { type: 'find', bookingId: 'b1' }), { type: 'found', decision: decision([option('o1')]) });
  s = decideFlow(s, { type: 'apply', newKey });
  assert.equal(s.step === 'applying' && s.key, 'k1');
  s = decideFlow(s, { type: 'failed', code: 'NETWORK', message: 'offline' });
  s = decideFlow(s, { type: 'apply', newKey });
  assert.equal(s.step === 'applying' && s.key, 'k1');
  s = decideFlow(s, { type: 'failed', code: 'NO_FEASIBLE_OPTION', message: 'gone' });
  assert.equal(s.step === 'error' && s.key, null);
  s = decideFlow(s, { type: 'apply', newKey });
  assert.equal(s.step === 'applying' && s.key, 'k2');
  s = decideFlow(s, { type: 'applied', decision: { ...decision([option('o1')]), status: 'APPLIED', chosenOptionId: 'o1', changeSetId: 'cs1' } });
  assert.equal(s.step, 'applied');
  assert.equal(decideFlow(s, { type: 'reset' }).step, 'idle');
});

test('stale answers do not move the flow', () => {
  const s = decideFlow(initialDecide, { type: 'found', decision: decision([option('o1')]) });
  assert.equal(s.step, 'idle');
});

test('ACTIVE / non-auto options need the dispatcher', () => {
  assert.equal(needsDispatcher(option('a', { target: 'ACTIVE', autoApplicable: false })), true);
  assert.equal(needsDispatcher(option('b', { autoApplicable: false })), true);
  assert.equal(needsDispatcher(option('c')), false);
});

const req = (id: string, over: Partial<DispatchRequestDto> = {}): DispatchRequestDto => ({
  id,
  trigger: 'DELAY',
  status: 'PROPOSED',
  bookingId: `b-${id}`,
  tripId: null,
  bookingStatus: 'PENDING_ASSIGNMENT',
  chosenOptionId: 'o2',
  changeSetId: null,
  reasons: [],
  alternatives: [
    { optionId: 'o1', kind: 'INSERT', tripId: 't', objectId: 'v', addedS: 100, target: 'SCHEDULED' },
    { optionId: 'o2', kind: 'NEW_TRIP', tripId: null, objectId: 'v2', addedS: 900, target: 'IDLE' },
  ],
  attempts: 1,
  createdAt: '2026-11-15T08:00:00.000Z',
  decidedAt: null,
  durationMs: null,
  ...over,
});

test('proposals: PROPOSED only, oldest first, dismissed hidden', () => {
  const rows = [req('b', { createdAt: '2026-11-15T09:00:00.000Z' }), req('a'), req('c', { status: 'APPLIED' })];
  assert.deepEqual(proposalsOf(rows).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(proposalsOf(rows, new Set(['a'])).map((r) => r.id), ['b']);
  assert.equal(proposalActionable(req('x', { bookingStatus: 'ASSIGNED' })), false);
  assert.equal(proposalActionable(req('x', { bookingId: null })), false);
  assert.equal(chosenAlternative(req('x'))?.optionId, 'o2');
  assert.equal(statusCounts(rows).PROPOSED, 2);
});
