import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFlagAttributes, applyFlagList, flagAttribute, flags, resolveFlags, UI_FLAGS } from './flags.ts';

test('defaults: on in development, off in production', () => {
  assert.deepEqual(resolveFlags({ dev: true }), { uiRefresh: true, etmsRouting: true });
  assert.deepEqual(resolveFlags({ dev: false }), { uiRefresh: false, etmsRouting: false });
});

test('VITE_UI_FLAGS turns flags on or off', () => {
  assert.equal(resolveFlags({ dev: false, env: 'uiRefresh' }).uiRefresh, true);
  assert.equal(resolveFlags({ dev: false, env: ' uiRefresh , ' }).uiRefresh, true);
  assert.equal(resolveFlags({ dev: true, env: '-uiRefresh' }).uiRefresh, false);
  assert.equal(resolveFlags({ dev: true, env: '!uiRefresh' }).uiRefresh, false);
});

test('localStorage override wins over the build value', () => {
  assert.equal(resolveFlags({ dev: false, env: '', override: 'uiRefresh' }).uiRefresh, true);
  assert.equal(resolveFlags({ dev: false, env: 'uiRefresh', override: '-uiRefresh' }).uiRefresh, false);
  assert.equal(resolveFlags({ dev: true, override: null }).uiRefresh, true);
});

test('unknown and malformed names are ignored', () => {
  const base = { uiRefresh: false, etmsRouting: false };
  assert.deepEqual(applyFlagList(base, 'nope,-alsoNope,,uirefresh'), base);
  assert.deepEqual(applyFlagList(base, undefined), base);
  assert.notEqual(applyFlagList(base, ''), base, 'returns a copy, never mutates');
});

test('module value under node (no Vite env, no localStorage) uses production defaults', () => {
  for (const f of UI_FLAGS) assert.equal(flags[f], false);
  assert.ok(Object.isFrozen(flags));
});

test('etmsRouting (route planner) is off in production builds and can be switched on per build or browser', () => {
  assert.equal(resolveFlags({ dev: false }).etmsRouting, false);
  assert.equal(resolveFlags({ dev: false, env: 'etmsRouting' }).etmsRouting, true);
  assert.equal(resolveFlags({ dev: false, env: 'etmsRouting', override: '-etmsRouting' }).etmsRouting, false);
  assert.equal(flagAttribute('etmsRouting'), 'data-etms-routing');
});

test('flag attributes are kebab-case data attributes mirrored onto the root', () => {
  assert.equal(flagAttribute('uiRefresh'), 'data-ui-refresh');
  const set = new Map<string, boolean>();
  const root = { toggleAttribute: (name: string, force?: boolean) => (set.set(name, !!force), !!force) };
  applyFlagAttributes(root, { uiRefresh: true, etmsRouting: false });
  assert.equal(set.get('data-ui-refresh'), true);
  applyFlagAttributes(root, { uiRefresh: false, etmsRouting: false });
  assert.equal(set.get('data-ui-refresh'), false);
});
