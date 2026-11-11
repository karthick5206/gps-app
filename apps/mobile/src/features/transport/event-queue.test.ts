/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionDisplay,
  assertQueueable,
  BACKOFF_MAX_MS,
  backoffMs,
  BATCH_MAX,
  EventQueue,
  INACTIVE_PAUSE_MS,
  QueueSendError,
  SOFT_LIMIT,
  uuidv7,
  type EventOutcome,
  type KeyValueStore,
  type QueuedEvent,
  type QueueTransport,
} from './event-queue.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const TRIP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRIP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function memStore(): KeyValueStore & { map: Map<string, string>; failNextSet?: boolean } {
  const map = new Map<string, string>();
  const s = {
    map,
    failNextSet: false,
    async get(k: string) {
      return map.get(k) ?? null;
    },
    async set(k: string, v: string) {
      if (s.failNextSet) {
        s.failNextSet = false;
        throw new Error('keystore unavailable');
      }
      map.set(k, v);
    },
    async delete(k: string) {
      map.delete(k);
    },
  };
  return s;
}

function clock(start = Date.parse('2026-11-11T08:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

type Answer = (tripId: string, events: readonly QueuedEvent[]) => EventOutcome[] | Error;

function transport(answer: Answer): QueueTransport & { calls: { tripId: string; ids: string[]; types: string[] }[] } {
  const calls: { tripId: string; ids: string[]; types: string[] }[] = [];
  return {
    calls,
    async send(tripId, events) {
      calls.push({ tripId, ids: events.map((e) => e.clientEventId), types: events.map((e) => e.type) });
      const r = answer(tripId, events);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const acceptAll: Answer = (_t, events) => events.map((e) => ({ clientEventId: e.clientEventId, outcome: 'ACCEPTED', serverTime: '2026-11-11T08:00:01Z' }));

async function loaded() {
  const store = memStore();
  const c = clock();
  const q = new EventQueue({ store, now: c.now });
  await q.load(USER);
  return { store, c, q };
}

test('uuidv7: version 7, variant 10xx, time-ordered', () => {
  const a = uuidv7(1_700_000_000_000);
  const b = uuidv7(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a.slice(0, 13) < b.slice(0, 13));
});

test('enqueue stores the event durably before any send, with seq per trip and a client id', async () => {
  const { store, q } = await loaded();
  const e1 = await q.enqueue({ tripId: TRIP_A, type: 'ACKNOWLEDGE' });
  const e2 = await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  const e3 = await q.enqueue({ tripId: TRIP_B, type: 'ACKNOWLEDGE' });
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 1]);
  assert.equal(e1.state, 'PENDING');
  assert.notEqual(e1.clientEventId, e2.clientEventId);
  assert.ok(store.map.has(`vt.dq.${USER}.e.${e1.localId}`));
  assert.equal(q.snapshot().pending, 3);

  // A fresh queue on the same store (app restart) sees the same events and continues the per-trip seq.
  const q2 = new EventQueue({ store });
  await q2.load(USER);
  assert.deepEqual(q2.snapshot().events.map((e) => e.clientEventId), [e1, e2, e3].map((e) => e.clientEventId));
  const e4 = await q2.enqueue({ tripId: TRIP_A, type: 'BOARDED', passengerTripId: 'p1' });
  assert.equal(e4.seq, 3);
});

test('enqueue throws (and keeps nothing) when the store fails', async () => {
  const { store, q } = await loaded();
  store.failNextSet = true;
  await assert.rejects(q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 }));
  assert.equal(q.snapshot().events.length, 0);
});

test('online-only commands are never queued', async () => {
  const { q } = await loaded();
  assert.throws(() => assertQueueable('START_TRIP'));
  await assert.rejects(q.enqueue({ tripId: TRIP_A, type: 'START_TRIP' }));
  await assert.rejects(q.enqueue({ tripId: TRIP_A, type: 'SOS' }));
});

test('drain: oldest first, per trip in order of the oldest event; deleted only after ACCEPTED / DUPLICATE', async () => {
  const { store, q } = await loaded();
  const a1 = await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  const b1 = await q.enqueue({ tripId: TRIP_B, type: 'ACKNOWLEDGE' });
  const a2 = await q.enqueue({ tripId: TRIP_A, type: 'BOARDED', passengerTripId: 'p1' });
  const tr = transport((_t, events) => events.map((e, i) => ({ clientEventId: e.clientEventId, outcome: i === 0 ? 'ACCEPTED' : 'DUPLICATE' })));
  await q.drain(tr);
  assert.deepEqual(tr.calls.map((c) => c.tripId), [TRIP_A, TRIP_B]);
  assert.deepEqual(tr.calls[0].ids, [a1.clientEventId, a2.clientEventId]);
  assert.deepEqual(tr.calls[1].ids, [b1.clientEventId]);
  assert.equal(q.snapshot().events.length, 0);
  assert.ok(![...store.map.keys()].some((k) => k.includes('.e.')));
  assert.ok(q.snapshot().lastConfirmedAt);
});

test('an event without an answer stays pending (never deleted on a partial reply)', async () => {
  const { q } = await loaded();
  const a1 = await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  const a2 = await q.enqueue({ tripId: TRIP_A, type: 'BOARDED', passengerTripId: 'p1' });
  await q.drain(transport(() => [{ clientEventId: a1.clientEventId, outcome: 'ACCEPTED' }]));
  const left = q.snapshot().events;
  assert.deepEqual(left.map((e) => e.clientEventId), [a2.clientEventId]);
  assert.equal(left[0].state, 'PENDING');
  assert.equal(left[0].attempts, 1);
});

test('REJECTED is terminal and LATE is received-without-effect: both kept with the code, never retried, dismissable', async () => {
  const { q, c } = await loaded();
  const a1 = await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  const a2 = await q.enqueue({ tripId: TRIP_A, type: 'COMPLETE_TRIP' });
  const tr = transport((_t, events) =>
    events.map((e) => (e.type === 'ARRIVED' ? { clientEventId: e.clientEventId, outcome: 'REJECTED', code: 'NOT_AT_STOP' } : { clientEventId: e.clientEventId, outcome: 'LATE', code: 'TRIP_CLOSED' })),
  );
  await q.drain(tr);
  const snap = q.snapshot();
  assert.equal(snap.pending, 0);
  assert.equal(snap.rejected, 1);
  assert.equal(snap.late, 1);
  assert.deepEqual(snap.events.map((e) => [e.state, e.code]), [
    ['REJECTED', 'NOT_AT_STOP'],
    ['LATE', 'TRIP_CLOSED'],
  ]);
  c.advance(10 * 60_000);
  await q.drain(tr, true);
  assert.equal(tr.calls.length, 1, 'rejected events are not sent again');
  assert.equal(await q.dismiss(a1.clientEventId), true);
  assert.deepEqual(q.snapshot().events.map((e) => e.clientEventId), [a2.clientEventId]);
});

test('pending events cannot be dismissed', async () => {
  const { q } = await loaded();
  const a1 = await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  assert.equal(await q.dismiss(a1.clientEventId), false);
  assert.equal(q.snapshot().pending, 1);
});

test('RETRY keeps that event and every later one of the trip pending, with backoff', async () => {
  const { q, c } = await loaded();
  const a1 = await q.enqueue({ tripId: TRIP_A, type: 'BOARDED', passengerTripId: 'p1' });
  const a2 = await q.enqueue({ tripId: TRIP_A, type: 'DROPPED', passengerTripId: 'p1' });
  const tr = transport((_t, events) => [
    { clientEventId: events[0].clientEventId, outcome: 'RETRY', code: 'OUT_OF_ORDER' },
    ...events.slice(1).map((e) => ({ clientEventId: e.clientEventId, outcome: 'ACCEPTED' as const })),
  ]);
  await q.drain(tr);
  const snap = q.snapshot();
  assert.deepEqual(snap.events.map((e) => [e.clientEventId, e.state]), [
    [a1.clientEventId, 'PENDING'],
    [a2.clientEventId, 'PENDING'],
  ]);
  assert.equal(snap.events[0].code, 'OUT_OF_ORDER');
  assert.equal(snap.nextAttemptAt, c.now() + 5_000);
  assert.equal(q.due(), false);
  c.advance(5_000);
  assert.equal(q.due(), true);
});

test('network failure: everything stays pending, exponential backoff 5 s → 5 min, later trips are not sent', async () => {
  const { q, c } = await loaded();
  await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  await q.enqueue({ tripId: TRIP_B, type: 'ACKNOWLEDGE' });
  const tr = transport(() => new QueueSendError('network'));
  await q.drain(tr);
  assert.equal(tr.calls.length, 1);
  assert.equal(q.snapshot().pending, 2);
  assert.equal(q.snapshot().nextAttemptAt, c.now() + 5_000);
  await q.drain(tr); // backoff not over: no call
  assert.equal(tr.calls.length, 1);
  c.advance(5_000);
  await q.drain(tr);
  assert.equal(q.snapshot().nextAttemptAt, c.now() + 10_000);
  assert.equal(backoffMs(20), BACKOFF_MAX_MS);
  // "Sync now" ignores the backoff.
  await q.drain(tr, true);
  assert.equal(tr.calls.length, 3);
});

test('a plain thrown error counts as a network failure', async () => {
  const { q } = await loaded();
  await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  await q.drain(transport(() => new Error('boom')));
  assert.equal(q.snapshot().pending, 1);
  assert.ok(q.snapshot().nextAttemptAt);
});

test('whole-batch terminal rejection (trip revoked) marks the batch rejected and continues with other trips', async () => {
  const { q } = await loaded();
  await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  const b1 = await q.enqueue({ tripId: TRIP_B, type: 'ACKNOWLEDGE' });
  const tr = transport((tripId, events) => (tripId === TRIP_A ? new QueueSendError('rejected', 'NOT_ASSIGNED') : acceptAll(tripId, events)));
  await q.drain(tr);
  const snap = q.snapshot();
  assert.deepEqual(snap.events.map((e) => [e.tripId, e.state, e.code]), [[TRIP_A, 'REJECTED', 'NOT_ASSIGNED']]);
  assert.ok(!snap.events.some((e) => e.clientEventId === b1.clientEventId));
});

test('401: paused until resume(); 403 DRIVER_INACTIVE: paused for an hour', async () => {
  const { q, c } = await loaded();
  await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  let mode: 'auth' | 'inactive' | 'ok' = 'auth';
  const tr = transport((t, e) => (mode === 'ok' ? acceptAll(t, e) : new QueueSendError(mode)));
  await q.drain(tr);
  assert.equal(q.snapshot().paused, 'AUTH');
  await q.drain(tr, true);
  assert.equal(tr.calls.length, 1, 'no sends while signed out');
  q.resume();
  mode = 'inactive';
  await q.drain(tr);
  assert.equal(q.snapshot().paused, 'INACTIVE');
  assert.equal(q.snapshot().nextAttemptAt, c.now() + INACTIVE_PAUSE_MS);
  c.advance(INACTIVE_PAUSE_MS);
  mode = 'ok';
  await q.drain(tr);
  assert.equal(q.snapshot().pending, 0);
  assert.equal(q.snapshot().paused, null);
});

test('batches of at most 50 per request', async () => {
  const { q } = await loaded();
  for (let i = 0; i < 120; i++) await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: i });
  assert.equal(q.snapshot().syncRequired, true);
  const tr = transport(acceptAll);
  await q.drain(tr);
  assert.deepEqual(tr.calls.map((c) => c.ids.length), [BATCH_MAX, BATCH_MAX, 20]);
  assert.equal(q.snapshot().syncRequired, false);
  assert.ok(SOFT_LIMIT <= 120);
});

test('queues are per user: another login neither sees nor sends them', async () => {
  const { store, q } = await loaded();
  await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 1 });
  q.unload();
  await q.load('22222222-2222-4222-8222-222222222222');
  assert.equal(q.snapshot().events.length, 0);
  const tr = transport(acceptAll);
  await q.drain(tr);
  assert.equal(tr.calls.length, 0);
  const again = new EventQueue({ store });
  await again.load(USER);
  assert.equal(again.snapshot().pending, 1);
});

test('seq continues above the server lastSeq (reinstall / second phone)', async () => {
  const { q } = await loaded();
  await q.ensureSeqAtLeast(TRIP_A, 7);
  const e = await q.enqueue({ tripId: TRIP_A, type: 'ARRIVED', stopSeq: 2 });
  assert.equal(e.seq, 8);
  await q.ensureSeqAtLeast(TRIP_A, 3); // never lowers
  assert.equal((await q.enqueue({ tripId: TRIP_A, type: 'DEPARTED', stopSeq: 2 })).seq, 9);
});

test('notes are capped so a stored row stays small', async () => {
  const { q } = await loaded();
  const e = await q.enqueue({ tripId: TRIP_A, type: 'REPORT_DELAY', note: 'x'.repeat(5000), etaMin: 10 });
  assert.equal(e.note?.length, 280);
});

test('actionDisplay never shows a local event as confirmed', () => {
  assert.equal(actionDisplay(false, [{ state: 'PENDING' }]), 'PENDING');
  assert.equal(actionDisplay(false, [{ state: 'REJECTED' }]), 'REJECTED');
  assert.equal(actionDisplay(false, []), 'NONE');
  assert.equal(actionDisplay(false, [{ state: 'LATE' }]), 'LATE');
  assert.equal(actionDisplay(true, [{ state: 'PENDING' }]), 'CONFIRMED');
});
