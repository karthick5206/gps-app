import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeEntries, isEmail, normalizeMobile, parseContacts } from './recipients.ts';

test('normalizeMobile accepts common Indian formats', () => {
  for (const v of ['9876543210', '+919876543210', '+91 98765 43210', '09876543210', '919876543210', '+91-98765-43210']) {
    assert.equal(normalizeMobile(v), '+919876543210', v);
  }
  for (const v of ['12345', '5876543210', '+14155550100', '98765432101', 'abc']) assert.equal(normalizeMobile(v), null, v);
});

test('isEmail', () => {
  assert.equal(isEmail('ops@acme.in'), true);
  assert.equal(isEmail(' ops@acme.in '), true);
  assert.equal(isEmail('ops@acme'), false);
  assert.equal(isEmail('ops acme@x.com'), false);
});

test('parseContacts splits, validates and dedupes', () => {
  const r = parseContacts('a@x.com, A@X.com; bad\nb@y.org', 'EMAIL');
  assert.deepEqual(r.entries.map((e) => e.value), ['a@x.com', 'b@y.org']);
  assert.deepEqual(r.invalid, ['bad']);
  const m = parseContacts('9876543210, +91 98765 43210, 123', 'MOBILE');
  assert.deepEqual(m.entries, [{ kind: 'MOBILE', value: '+919876543210' }]);
  assert.deepEqual(m.invalid, ['123']);
});

test('dedupeEntries keeps first and is kind-aware', () => {
  const out = dedupeEntries([
    { kind: 'USER', value: 'u1', label: 'Asha' },
    { kind: 'USER', value: 'u1' },
    { kind: 'ROLE', value: 'u1' },
    { kind: 'EMAIL', value: 'X@y.com' },
    { kind: 'EMAIL', value: 'x@Y.com' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].label, 'Asha');
});
