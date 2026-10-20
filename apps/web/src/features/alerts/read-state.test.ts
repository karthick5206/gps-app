import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnread, unreadIds, withRead } from './read-state.ts';

const a = (id: string, read: boolean, status: 'NEW' | 'ACKNOWLEDGED' = 'NEW') => ({ id, read, status });

test('isUnread: only NEW alerts the user has not read', () => {
  assert.equal(isUnread(a('1', false)), true);
  assert.equal(isUnread(a('1', true)), false);
  assert.equal(isUnread(a('1', false, 'ACKNOWLEDGED')), false);
});

test('withRead marks the given ids, or all with null, and keeps identity when nothing changes', () => {
  const list = [a('1', false), a('2', false), a('3', true)];
  assert.deepEqual(withRead(list, new Set(['2'])).map((x) => x.read), [false, true, true]);
  assert.deepEqual(withRead(list, null).map((x) => x.read), [true, true, true]);
  assert.equal(withRead(list, new Set(['3'])), list);
  assert.equal(withRead(list, new Set(['9'])), list);
});

test('unreadIds lists unread alerts only', () => {
  assert.deepEqual(unreadIds([a('1', false), a('2', true), a('3', false, 'ACKNOWLEDGED')]), ['1']);
});
