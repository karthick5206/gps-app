import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accessReasonApplies,
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
  assert.deepEqual(transportRequestHeaders('/transport/bookings', null, 'Ticket 12'), {});
  assert.equal(isTransportApiPath('/transportation'), false);
  assert.equal(accessReasonApplies('/transport/passengers'), true);
  // M1: an incident detail needs the reason; the (redacted) lane does not.
  assert.equal(accessReasonApplies('/transport/incidents/3f1c2a4e-9b7d-4c1e-8a2b-1234567890ab'), true);
  assert.equal(accessReasonApplies('/transport/incidents'), false);
  assert.equal(accessReasonApplies('/transport/bookings'), false);
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
