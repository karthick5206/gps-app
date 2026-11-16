/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PHOTO_NOTE_RETRY_BACKOFF_MS, photoNoteBackoffMs, PhotoNoteQueue, photoNoteRetryable, PhotoNoteSendError, randomUuid, type NewQueuedNote, type PhotoNoteQueueStorage, type QueuedNote } from './photo-note-queue.ts';

function memStorage(): PhotoNoteQueueStorage & { json: string | null; removed: string[]; wiped: number } {
  const s = {
    json: null as string | null,
    removed: [] as string[],
    wiped: 0,
    async read() {
      return s.json;
    },
    async write(json: string) {
      s.json = json;
    },
    async removeFiles(id: string) {
      s.removed.push(id);
    },
    async removeAll() {
      s.wiped++;
      s.json = null;
    },
  };
  return s;
}

function note(clientId: string): NewQueuedNote {
  return { clientId, takenAt: '2026-11-15T10:00:00.000Z', lat: 12.9, lng: 77.6, accuracyM: 8, category: 'BILL', note: 'Lunch', amountMinor: 25000, currency: 'INR', photos: [{ file: '0.jpg', mimeType: 'image/jpeg' }] };
}

function transport(answers: (number | 'ok' | 'net')[]) {
  const sent: string[] = [];
  return {
    sent,
    async send(item: QueuedNote) {
      sent.push(item.clientId);
      const a = answers.shift() ?? 'ok';
      if (a === 'ok') return;
      throw new PhotoNoteSendError(a === 'net' ? undefined : a);
    },
  };
}

test('retryable statuses: no answer, 401, 408, 429 and 5xx; other 4xx are final', () => {
  for (const s of [undefined, 0, 401, 408, 429, 500, 502, 503]) assert.equal(photoNoteRetryable(s), true, String(s));
  for (const s of [400, 403, 404, 409, 413, 415, 422]) assert.equal(photoNoteRetryable(s), false, String(s));
});

test('back-off grows and then stays at the last step', () => {
  assert.equal(photoNoteBackoffMs(0), 0);
  assert.equal(photoNoteBackoffMs(1), PHOTO_NOTE_RETRY_BACKOFF_MS[0]);
  assert.equal(photoNoteBackoffMs(2), PHOTO_NOTE_RETRY_BACKOFF_MS[1]);
  const last = PHOTO_NOTE_RETRY_BACKOFF_MS[PHOTO_NOTE_RETRY_BACKOFF_MS.length - 1];
  assert.equal(photoNoteBackoffMs(50), last);
});

test('a delivered note leaves the queue and its files are deleted', async () => {
  const storage = memStorage();
  const delivered: string[] = [];
  const q = new PhotoNoteQueue({ storage, onDelivered: (id) => delivered.push(id) });
  await q.load('u1');
  await q.add(note('a'));
  assert.ok(storage.json?.includes('"a"'), 'stored before sending');
  await q.drain(transport(['ok']));
  assert.equal(q.snapshot().items.length, 0);
  assert.deepEqual(storage.removed, ['a']);
  assert.deepEqual(delivered, ['a']);
});

test('network error and 5xx back off; force ignores the back-off; it survives a reload', async () => {
  let now = 1_000_000;
  const storage = memStorage();
  const q = new PhotoNoteQueue({ storage, now: () => now });
  await q.load('u1');
  await q.add(note('a'));
  const t = transport(['net', 503, 'ok']);
  await q.drain(t);
  let item = q.snapshot().items[0];
  assert.equal(item.state, 'PENDING');
  assert.equal(item.attempts, 1);
  assert.equal(item.nextAttemptAt, now + PHOTO_NOTE_RETRY_BACKOFF_MS[0]);
  assert.equal(q.due(), false);
  assert.equal(q.nextDueIn(), PHOTO_NOTE_RETRY_BACKOFF_MS[0]);
  await q.drain(t); // not due yet
  assert.equal(t.sent.length, 1);
  now += PHOTO_NOTE_RETRY_BACKOFF_MS[0];
  assert.equal(q.due(), true);
  await q.drain(t);
  item = q.snapshot().items[0];
  assert.equal(item.attempts, 2);
  assert.equal(item.nextAttemptAt, now + PHOTO_NOTE_RETRY_BACKOFF_MS[1]);

  // Restart: a new queue object reads the same storage.
  const q2 = new PhotoNoteQueue({ storage, now: () => now });
  await q2.load('u1');
  assert.equal(q2.snapshot().pending, 1);
  await q2.drain(t, true);
  assert.equal(q2.snapshot().items.length, 0);
  assert.equal(t.sent.length, 3);
});

test('another 4xx marks it FAILED (kept, not retried) until "Try again"', async () => {
  const storage = memStorage();
  const q = new PhotoNoteQueue({ storage });
  await q.load('u1');
  await q.add(note('a'));
  const t = transport([422, 'ok']);
  await q.drain(t);
  assert.equal(q.snapshot().failed, 1);
  assert.equal(q.snapshot().items[0].lastError, 'Photo note send failed (422)');
  await q.drain(t, true);
  assert.equal(t.sent.length, 1, 'a failed note is not sent again by itself');
  await q.retry('a');
  await q.drain(t);
  assert.equal(q.snapshot().items.length, 0);
});

test('no connection stops the round; later notes wait for the next trigger', async () => {
  const storage = memStorage();
  let now = 0;
  const q = new PhotoNoteQueue({ storage, now: () => (now += 1) });
  await q.load('u1');
  await q.add(note('a'));
  await q.add(note('b'));
  const t = transport(['net']);
  await q.drain(t);
  assert.equal(t.sent.length, 1);
});

test('remove deletes the note and its files; a queue of another owner is wiped on load; clear wipes all', async () => {
  const storage = memStorage();
  const q = new PhotoNoteQueue({ storage });
  await q.load('u1');
  await q.add(note('a'));
  await q.add(note('b'));
  await q.remove('a');
  assert.deepEqual(storage.removed, ['a']);
  assert.equal(q.snapshot().items.length, 1);

  const other = new PhotoNoteQueue({ storage });
  await other.load('u2');
  assert.equal(other.snapshot().items.length, 0);
  assert.equal(storage.wiped, 1);

  await q.clear();
  assert.equal(q.snapshot().owner, null);
  assert.equal(storage.wiped, 2);
  await assert.rejects(q.add(note('c')));
});

test('randomUuid is a v4 UUID', () => {
  assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
