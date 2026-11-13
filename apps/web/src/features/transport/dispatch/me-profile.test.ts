import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeTransportProfileDto } from '@veetracer/shared';
import { buildHomeInput, buildProfileUpdate, emptyContact, hasProfileErrors, homeDraftOf, homeSavedText, parseLatLng, profileDraftOf, validateHome, validateProfile } from './me-profile.ts';

const profile = (over: Partial<MeTransportProfileDto> = {}): MeTransportProfileDto => ({
  displayName: 'Test Passenger',
  employeeCode: 'T-001',
  branchName: 'Branch A',
  officeName: 'Main office',
  defaultStop: { id: 's1', name: 'Gate 1' },
  email: 'passenger@example.test',
  mobile: '+910000000000',
  home: { address: 'Test street 1', lat: 13.01, lng: 80.21, source: 'PIN' },
  emergencyContacts: [{ name: 'Contact A', phone: '+91 90000 00000', relation: null }],
  accessibility: { wheelchair: false, notes: null },
  routingConsent: true,
  ...over,
});

test('profile edit: unchanged → null; only changed parts are sent; blank contact rows dropped', () => {
  const p = profile();
  const d = profileDraftOf(p);
  assert.equal(buildProfileUpdate(d, p), null);
  assert.equal(buildProfileUpdate({ ...d, contacts: [...d.contacts, emptyContact()] }, p), null);
  assert.deepEqual(buildProfileUpdate({ ...d, defaultStopId: null }, p), { defaultStopId: null });
  const withContact = { ...d, contacts: [...d.contacts, { name: ' Contact B ', phone: '9000000001', relation: 'Sister' }] };
  assert.deepEqual(buildProfileUpdate(withContact, p)?.emergencyContacts, [
    { name: 'Contact A', phone: '+91 90000 00000', relation: null },
    { name: 'Contact B', phone: '9000000001', relation: 'Sister' },
  ]);
  assert.deepEqual(buildProfileUpdate({ ...d, wheelchair: true, notes: ' Low step ' }, p), { accessibility: { wheelchair: true, notes: 'Low step' } });
});

test('profile validation: at most 3 contacts, name + phone required per filled row, notes length', () => {
  const d = profileDraftOf(profile());
  assert.equal(hasProfileErrors(validateProfile(d)), false);
  const four = { ...d, contacts: Array.from({ length: 4 }, () => ({ name: 'X', phone: '9000000000', relation: '' })) };
  assert.ok(validateProfile(four).contacts);
  const bad = validateProfile({ ...d, contacts: [{ name: '', phone: 'abc', relation: '' }, emptyContact()] });
  assert.ok(bad.contact?.[0]?.name);
  assert.ok(bad.contact?.[0]?.phone);
  assert.equal(bad.contact?.[1], undefined);
  assert.ok(validateProfile({ ...d, notes: 'x'.repeat(501) }).notes);
});

test('home: typed coordinates parsed and bounded; consent and a chosen point required; saved text names kept bookings', () => {
  assert.deepEqual(parseLatLng('12.9716', ' 77.5946 '), { lat: 12.9716, lng: 77.5946 });
  assert.ok('error' in parseLatLng('91', '77'));
  assert.ok('error' in parseLatLng('12', '181'));
  assert.ok('error' in parseLatLng('abc', '77'));
  assert.ok('error' in parseLatLng('0', '0'));
  const fresh = homeDraftOf(profile());
  assert.deepEqual(fresh.point, { lat: 13.01, lng: 80.21 });
  assert.ok(validateHome(fresh, true)); // nothing new chosen yet
  const chosen = { ...fresh, point: { lat: 13.02, lng: 80.22 }, source: 'PHOTON' as const, address: ' New street ' };
  assert.equal(validateHome(chosen, true), undefined);
  assert.match(validateHome(chosen, false) ?? '', /consent/);
  assert.deepEqual(buildHomeInput(chosen), { lat: 13.02, lng: 80.22, address: 'New street', source: 'PHOTON' });
  assert.equal(homeDraftOf(profile({ home: { address: 'Kept', lat: null, lng: null, source: null } })).point, null);
  assert.match(homeSavedText(0), /New bookings use it\.$/);
  assert.match(homeSavedText(2), /2 booking\(s\) already made keep their earlier pickup/);
});
