/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KeyValueStore } from './event-queue';
import { loadSyncCursor, saveSyncCursor, SYNC_CURSOR_MAX_AGE_MS, syncCursorKey, usableCursor } from './sync-cursor.ts';

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

test('sync cursor: survives a restart (stored per user) and is read back', async () => {
  const store = memStore();
  const cursor = new Date(Date.now() - 60_000).toISOString();
  await saveSyncCursor(store, 'user-1', cursor);
  assert.equal(store.map.get('vt.dsync.user-1'), cursor);
  // "Restart": a new lifecycle reads it from the same store.
  assert.equal(await loadSyncCursor(store, 'user-1'), cursor);
  // Another user on the same phone does not inherit it.
  assert.equal(await loadSyncCursor(store, 'user-2'), null);
});

test('sync cursor: implausible values are dropped (garbage, future, older than the server look-back)', async () => {
  const now = Date.parse('2026-11-11T10:00:00.000Z');
  assert.equal(usableCursor(null, now), null);
  assert.equal(usableCursor('nope', now), null);
  assert.equal(usableCursor(new Date(now + 10 * 60_000).toISOString(), now), null);
  assert.equal(usableCursor(new Date(now - SYNC_CURSOR_MAX_AGE_MS - 1).toISOString(), now), null);
  assert.equal(usableCursor(new Date(now - 3600_000).toISOString(), now), new Date(now - 3600_000).toISOString());
  const store = memStore();
  store.map.set('vt.dsync.user-1', 'garbage');
  assert.equal(await loadSyncCursor(store, 'user-1', now), null);
  assert.equal(store.map.has('vt.dsync.user-1'), false, 'an unusable stored cursor is removed');
});

test('sync cursor: a failing store never breaks the sync; bad user ids are refused', async () => {
  const broken: KeyValueStore = { get: async () => { throw new Error('keystore'); }, set: async () => { throw new Error('keystore'); }, delete: async () => undefined };
  assert.equal(await loadSyncCursor(broken, 'user-1'), null);
  await saveSyncCursor(broken, 'user-1', new Date().toISOString());
  assert.throws(() => syncCursorKey('../x'));
});
