/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MANIFEST_CAPTURE_KEY, manifestScreenGuard } from './screen-guard.ts';
import { routeUuid } from '../push-target.ts';

// expo-screen-capture is a native module: the tests use a recording stand-in for usePreventScreenCapture.
test('M3: the manifest screen guard calls usePreventScreenCapture with its own key on every render', () => {
  const calls: (string | undefined)[] = [];
  const useGuard = manifestScreenGuard((key) => void calls.push(key), 'android');
  useGuard();
  useGuard();
  assert.deepEqual(calls, [MANIFEST_CAPTURE_KEY, MANIFEST_CAPTURE_KEY]);
  // Expo web: never touches the native module (its cleanup would throw).
  const web: (string | undefined)[] = [];
  manifestScreenGuard((key) => void web.push(key), 'web')();
  assert.deepEqual(web, []);
});

test('I1: route ids are used only when they are UUIDs', () => {
  const id = '0190f3c2-1a2b-7c3d-8e4f-123456789abc';
  assert.equal(routeUuid(id), id);
  assert.equal(routeUuid(id.toUpperCase()), id);
  assert.equal(routeUuid([id, 'x']), id);
  for (const bad of [undefined, null, '', '../me', `${id}/../../users`, `${id}?x=1`, 'not-a-uuid', 42, ['..']]) assert.equal(routeUuid(bad), null);
});
