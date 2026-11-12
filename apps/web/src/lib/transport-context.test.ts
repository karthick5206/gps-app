import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCESS_REASON_TTL_MS,
  accessReasonApplies,
  accessReasonKey,
  decodeStoredReason,
  encodeStoredReason,
  reasonScopeFromError,
  reasonScopeOf,
  customerFromSearch,
  customerPickerOptions,
  isTransportApiPath,
  showsCustomerPicker,
  transportRequestHeaders,
  validAccessReason,
  withCustomerParam,
} from './transport-context.ts';

const C = '11111111-2222-4333-8444-555555555555';

test('customer param: read, set, clear (page reset, other params kept)', () => {
  assert.equal(customerFromSearch(`?customer=${C}`), C);
  assert.equal(customerFromSearch(`?customer=${C.toUpperCase()}`), C);
  assert.equal(customerFromSearch('?customer=nope'), null);
  assert.equal(customerFromSearch(''), null);
  assert.equal(withCustomerParam('?q=x&page=3', C), `?q=x&customer=${C}`);
  assert.equal(withCustomerParam(`?customer=${C}`, null), '');
});

test('headers: customer only on /transport API calls from a transport page; reason only on passenger calls', () => {
  const loc = { pathname: '/transport/bookings', search: `?customer=${C}` };
  assert.deepEqual(transportRequestHeaders('/transport/bookings', loc, null), { 'X-Transport-Customer': C });
  assert.deepEqual(transportRequestHeaders('/objects', loc, 'why not'), {});
  assert.deepEqual(transportRequestHeaders('/transport/bookings', { pathname: '/live', search: `?customer=${C}` }, null), {});
  assert.deepEqual(transportRequestHeaders('/transport/passengers/abc', { pathname: '/transport/passengers', search: '' }, 'Ticket 12 check'), { 'X-Access-Reason': 'Ticket%2012%20check' });
  assert.deepEqual(transportRequestHeaders('/transport/shifts', null, 'Ticket 12'), {});
  assert.deepEqual(transportRequestHeaders('/transport/bookings', null, 'Ticket 12'), { 'X-Access-Reason': 'Ticket%2012' });
  // QA B1 (safety): a provider dispatcher on ?customer=A still gets every customer's SOS: no customer header on the lane.
  for (const p of ['/transport/incidents', '/transport/incidents?open=1', '/transport/incidents/abc/ack']) assert.deepEqual(transportRequestHeaders(p, loc, null), {});
  assert.deepEqual(transportRequestHeaders('/transport/incidents', { pathname: '/transport/dispatch', search: `?customer=${C}` }, null), {});
  assert.equal(isTransportApiPath('/transportation'), false);
  assert.equal(accessReasonApplies('/transport/passengers'), true);
  // M1: an incident detail needs the reason; the (redacted) lane does not.
  assert.equal(accessReasonApplies('/transport/incidents/3f1c2a4e-9b7d-4c1e-8a2b-1234567890ab'), true);
  assert.equal(accessReasonApplies('/transport/incidents'), false);
  // Every route with passenger personal data (bookings, schedules, dispatch, trips, route plans); not shifts or settings.
  for (const p of ['/transport/bookings', '/transport/bookings/abc', '/transport/schedules?q=1', '/transport/dispatch/board', '/transport/trips/abc', '/transport/route-plans']) assert.equal(accessReasonApplies(p), true, p);
  for (const p of ['/transport/shifts', '/transport/settings', '/transport/agreements', '/transport/tripsx']) assert.equal(accessReasonApplies(p), false, p);
});

test('reason rule and picker pages / options', () => {
  assert.equal(validAccessReason('  ab  '), null);
  assert.equal(validAccessReason('  Ticket   4521 '), 'Ticket 4521');
  assert.equal(validAccessReason('x'.repeat(301)), null);
  assert.equal(showsCustomerPicker('/transport'), true);
  assert.equal(showsCustomerPicker('/transport/bookings/'), true);
  assert.equal(showsCustomerPicker('/transport/trips/abc'), false);
  assert.equal(showsCustomerPicker('/transport/partners'), false);
  const opts = customerPickerOptions(
    [
      { customerCompanyId: 'b', name: 'Beta Corp', mode: 'AGREEMENT' },
      { customerCompanyId: 'own', name: 'Our Co', mode: 'SELF' },
    ],
    { all: 'All customers', own: (n) => `${n} (our company)` },
  );
  assert.deepEqual(
    opts.map((o) => o.label),
    ['All customers', 'Our Co (our company)', 'Beta Corp'],
  );
});

test('L8: the Super Admin reason is kept per customer company and expires after 30 minutes', () => {
  const A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
  const B = '11111111-2222-4333-8444-bbbbbbbbbbbb';
  const T0 = Date.parse('2026-11-12T10:00:00Z');
  assert.notEqual(accessReasonKey('acting', A), accessReasonKey('acting', B));
  assert.equal(accessReasonKey(null, null), 'vt:access-reason:own:own');
  const stored = encodeStoredReason('Ticket 4521 check', T0);
  assert.equal(decodeStoredReason(stored, T0 + 29 * 60_000), 'Ticket 4521 check');
  assert.equal(decodeStoredReason(stored, T0 + ACCESS_REASON_TTL_MS), null);
  assert.equal(decodeStoredReason('Ticket 4521 check', T0), null); // the old session-wide plain value is not reused
  assert.equal(decodeStoredReason('{"reason":"ab","at":0}', 0), null);
  assert.equal(ACCESS_REASON_TTL_MS, 30 * 60_000);
  // Scope before sending: the selected customer on a transport page, else the acting company; unknown for an incident.
  assert.equal(reasonScopeOf('/transport/bookings', { pathname: '/transport/bookings', search: `?customer=${A}` }, 'acting'), A);
  assert.equal(reasonScopeOf('/transport/bookings', { pathname: '/live', search: `?customer=${A}` }, 'acting'), 'acting');
  assert.equal(reasonScopeOf('/transport/incidents/x', { pathname: '/transport/incidents', search: '' }, 'acting'), null);
  assert.equal(reasonScopeFromError({ code: 'REASON_REQUIRED', scopeCompanyId: B.toUpperCase() }), B);
  assert.equal(reasonScopeFromError({ scopeCompanyId: 'nope' }), null);
  assert.equal(reasonScopeFromError(null), null);
});
