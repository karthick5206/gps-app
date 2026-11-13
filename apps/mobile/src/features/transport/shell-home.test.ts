/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appHome, SHELL_HOME, transportRoles } from './roles.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('appHome: each shell lands on its own home, never on a group without an index', () => {
  assert.equal(appHome('authenticated', 'fleet'), '/');
  assert.equal(appHome('authenticated', 'passenger'), '/my-commute');
  assert.equal(appHome('authenticated', 'driver'), '/my-duty');
  assert.equal(appHome('authenticated', null), '/');
  assert.equal(appHome('anonymous', 'passenger'), '/login');
  assert.equal(appHome('loading', null), '/login');
  assert.equal(appHome('offline', 'driver'), '/offline-sos');
  assert.deepEqual(SHELL_HOME, { fleet: '/', passenger: '/my-commute', driver: '/my-duty' });
});

test('appHome follows transportRoles: passenger-only, driver-only and dual-role users', () => {
  const me = (permissions: Record<string, string[]>) => ({ permissions, company: { features: ['etms'] } }) as never;
  assert.equal(appHome('authenticated', transportRoles(me({ etms_self: ['view'] })).shell), '/my-commute');
  assert.equal(appHome('authenticated', transportRoles(me({ etms_driver: ['view'], etms_self: ['view'] })).shell), '/my-duty');
  assert.equal(appHome('authenticated', transportRoles(me({ etms_self: ['view'], live: ['view'] })).shell), '/');
});

test('the shell home routes exist and the root layout redirects every guard to it', () => {
  const app = join(here, '..', '..', 'app');
  for (const file of ['(tabs)/index.tsx', '(passenger)/my-commute.tsx', '(driver)/my-duty.tsx', 'login.tsx', 'offline-sos.tsx']) {
    assert.ok(readFileSync(join(app, file), 'utf8').length > 0, file);
  }
  const layout = readFileSync(join(app, '_layout.tsx'), 'utf8');
  const guards = layout.match(/<Stack\.Protected\b[^>]*>/g) ?? [];
  assert.ok(guards.length >= 5, 'expected the Stack.Protected guards');
  for (const g of guards) assert.match(g, /redirectTo=\{home\}/, g);
  assert.match(layout, /const home = appHome\(status, shell\)/);
});
