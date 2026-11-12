/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SosReceipt } from '@veetracer/shared';
import type { KeyValueStore } from './event-queue.ts';
import { shouldPromptCall, SOS_PROMPT_CALL_AFTER_MS, SOS_RETRY_BACKOFF_MS, sosBackoffMs, sosRetryable, SosQueue, SosSendError, sosStage, type SosItem, type SosTransport } from './sos-queue.ts';

const USER = '22222222-2222-4222-8222-222222222222';
const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function memStore(): KeyValueStore & { map: Map<string, string>; failNextSet: boolean } {
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

const receipt = (over: Partial<SosReceipt> = {}): SosReceipt => ({
  incidentId: 'inc-1',
  status: 'RECEIVED_BY_SERVER',
  receivedAt: new Date().toISOString(),
  incidentStatus: 'OPEN',
  acknowledgement: null,
  resolvedAt: null,
  merged: false,
  tripLinked: true,
  notify: 'QUEUED',
  ...over,
});

/** A transport that answers from a script (an Error = that failure) and records what it was sent. */
function scripted(answers: (SosReceipt | SosSendError)[]): SosTransport & { sent: SosItem[] } {
  const sent: SosItem[] = [];
  return {
    sent,
    async send(item) {
      sent.push(item);
      const a = answers.shift();
      if (!a) throw new SosSendError(undefined);
      if (a instanceof SosSendError) throw a;
      return a;
    },
  };
}

async function setup(now = { t: 1_800_000_000_000 }) {
  const store = memStore();
  const q = new SosQueue({ store, now: () => now.t });
  await q.load(USER);
  return { store, q, now };
}

test('SOS is stored on the phone BEFORE any network call, with a UUIDv7 key made at tap time', async () => {
  const { store, q } = await setup();
  const t = scripted([]);
  const item = await q.raise({ tripId: TRIP, note: '  help  ' });
  assert.equal(t.sent.length, 0);
  assert.match(item.clientIncidentId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(item.state, 'PENDING');
  assert.equal(item.note, 'help');
  assert.ok(store.map.get(`vt.sos.${USER}.i.${item.clientIncidentId}`));
  assert.deepEqual(JSON.parse(store.map.get(`vt.sos.${USER}.meta`)!).ids, [item.clientIncidentId]);
  assert.equal(sosStage(item), 'QUEUED_ON_DEVICE');
});

test('a store failure throws (the UI then says "call now"); nothing half-written', async () => {
  const { store, q } = await setup();
  store.failNextSet = true;
  await assert.rejects(q.raise({ tripId: null }));
  assert.equal(q.snapshot().items.length, 0);
});

test('network / 5xx / 429 / 401 keep it pending with back-off 1, 2, 5, 10, then 15 s; same key every time', async () => {
  const { q, now } = await setup();
  const item = await q.raise({ tripId: TRIP });
  const t = scripted([new SosSendError(undefined), new SosSendError(503), new SosSendError(429), new SosSendError(401), new SosSendError(500), new SosSendError(502), receipt()]);
  const expected = [1_000, 2_000, 5_000, 10_000, 15_000, 15_000];
  for (const wait of expected) {
    await q.drain(t);
    const cur = q.snapshot().items[0];
    assert.equal(cur.state, 'PENDING');
    assert.equal(cur.nextAttemptAt, now.t + wait);
    // Not due before the back-off: a drain does nothing.
    const before = t.sent.length;
    await q.drain(t);
    assert.equal(t.sent.length, before);
    now.t += wait;
  }
  await q.drain(t);
  assert.equal(q.snapshot().items[0].state, 'RECEIVED');
  assert.ok(t.sent.every((s) => s.clientIncidentId === item.clientIncidentId));
  assert.deepEqual(SOS_RETRY_BACKOFF_MS, [1_000, 2_000, 5_000, 10_000, 15_000]);
});

test('2xx → RECEIVED with the receipt; only an acknowledgement is shown as acknowledged; never dropped by itself', async () => {
  const { q } = await setup();
  const item = await q.raise({ tripId: TRIP });
  await q.drain(scripted([receipt()]));
  let cur = q.snapshot().latest!;
  assert.equal(sosStage(cur), 'RECEIVED');
  await q.updateReceipt(item.clientIncidentId, receipt({ acknowledgement: { by: 'Desk', at: new Date().toISOString() }, incidentStatus: 'ACKNOWLEDGED' }));
  cur = q.snapshot().latest!;
  assert.equal(sosStage(cur), 'ACKNOWLEDGED');
  await q.updateReceipt(item.clientIncidentId, receipt({ incidentStatus: 'RESOLVED', resolvedAt: new Date().toISOString() }));
  assert.equal(sosStage(q.snapshot().latest!), 'RESOLVED');
  assert.equal(q.snapshot().items.length, 1);
});

test('422 IDEMPOTENCY_KEY_REUSED counts as delivered (the first request is stored)', async () => {
  const { q } = await setup();
  await q.raise({ tripId: null });
  await q.drain(scripted([new SosSendError(422, 'IDEMPOTENCY_KEY_REUSED')]));
  assert.equal(q.snapshot().latest!.state, 'RECEIVED');
});

test('404 (server without passenger SOS) / 403 / 400 → UNDELIVERED: kept, shown, retried only on "Try again"', async () => {
  const { q, now } = await setup();
  const item = await q.raise({ tripId: TRIP });
  const t = scripted([new SosSendError(404, 'NOT_FOUND'), receipt()]);
  await q.drain(t);
  let cur = q.snapshot().latest!;
  assert.equal(cur.state, 'UNDELIVERED');
  assert.equal(cur.lastError, 'NOT_FOUND');
  assert.equal(sosStage(cur), 'UNDELIVERED');
  now.t += 3_600_000;
  assert.equal(q.due(), false);
  await q.drain(t);
  assert.equal(t.sent.length, 1);
  assert.equal(await q.retry(item.clientIncidentId), true);
  await q.drain(t);
  cur = q.snapshot().latest!;
  assert.equal(cur.state, 'RECEIVED');
  assert.equal(t.sent[1].clientIncidentId, item.clientIncidentId);
});

test('a pending SOS cannot be dismissed; a settled one can, only by the person', async () => {
  const { store, q } = await setup();
  const item = await q.raise({ tripId: null });
  assert.equal(await q.dismiss(item.clientIncidentId), false);
  await q.drain(scripted([receipt()]));
  assert.equal(await q.dismiss(item.clientIncidentId), true);
  assert.equal(q.snapshot().items.length, 0);
  assert.equal(store.map.has(`vt.sos.${USER}.i.${item.clientIncidentId}`), false);
});

test('survives a restart: a pending SOS is reloaded and retried at once (no stale back-off); per-user keys', async () => {
  const store = memStore();
  const now = { t: 1_800_000_000_000 };
  const q1 = new SosQueue({ store, now: () => now.t });
  await q1.load(USER);
  const item = await q1.raise({ tripId: TRIP });
  await q1.drain(scripted([new SosSendError(undefined), new SosSendError(undefined), new SosSendError(undefined)]));
  const q2 = new SosQueue({ store, now: () => now.t });
  await q2.load(USER);
  assert.equal(q2.snapshot().pending, 1);
  assert.equal(q2.due(), true);
  const t = scripted([receipt()]);
  await q2.drain(t);
  assert.equal(t.sent[0].clientIncidentId, item.clientIncidentId);
  // Another user on the same phone neither sees nor sends it.
  const q3 = new SosQueue({ store, now: () => now.t });
  await q3.load('33333333-3333-4333-8333-333333333333');
  assert.equal(q3.snapshot().items.length, 0);
});

test('settled rows older than a day are pruned at load; pending ones never', async () => {
  const store = memStore();
  const now = { t: 1_800_000_000_000 };
  const q = new SosQueue({ store, now: () => now.t });
  await q.load(USER);
  await q.raise({ tripId: null });
  await q.drain(scripted([receipt()]));
  await q.raise({ tripId: null });
  now.t += 25 * 3600_000;
  const q2 = new SosQueue({ store, now: () => now.t });
  await q2.load(USER);
  assert.deepEqual(q2.snapshot().items.map((i) => i.state), ['PENDING']);
});

test('call prompt: until acknowledged, and for a received SOS after promptCallAfterMs without acknowledgement', () => {
  const base = { raisedAt: new Date(0).toISOString() };
  assert.equal(shouldPromptCall({ ...base, state: 'PENDING', receipt: null }, 1), true);
  assert.equal(shouldPromptCall({ ...base, state: 'UNDELIVERED', receipt: null }, 1), true);
  assert.equal(shouldPromptCall({ ...base, state: 'RECEIVED', receipt: receipt() }, SOS_PROMPT_CALL_AFTER_MS - 1), false);
  assert.equal(shouldPromptCall({ ...base, state: 'RECEIVED', receipt: receipt() }, SOS_PROMPT_CALL_AFTER_MS), true);
  assert.equal(shouldPromptCall({ ...base, state: 'RECEIVED', receipt: receipt({ acknowledgement: { by: 'D', at: '' } }) }, 10 * SOS_PROMPT_CALL_AFTER_MS), false);
});

test('retry rule matches the shared contract (sosShouldRetry)', () => {
  for (const s of [undefined, 0, 401, 408, 429, 500, 503]) assert.equal(sosRetryable(s), true, String(s));
  for (const s of [200, 201, 400, 403, 404, 422]) assert.equal(sosRetryable(s), false, String(s));
  assert.equal(sosBackoffMs(0), 0);
  assert.equal(sosBackoffMs(99), 15_000);
});
