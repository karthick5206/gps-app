import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSLATIONS, type TransportFleetAllocationDto } from '@veetracer/shared';
import { accessActorText, accessWhatLabel, allocationInput, allocationLabel, allocationState, fleetErrorText, sortAllocations } from './fleet-format.ts';

const row = (over: Partial<TransportFleetAllocationDto>): TransportFleetAllocationDto => ({
  id: 'f1',
  agreementId: 'a1',
  providerCompanyId: 'p',
  customerCompanyId: 'c',
  vehicle: { id: 'v1', name: 'Bus 12', plateNumber: 'TN 01 AB 1234' },
  driver: null,
  validFrom: '2026-11-01T00:00:00.000Z',
  validTo: null,
  active: true,
  note: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  canEnd: true,
  ...over,
});
const NOW = new Date('2026-11-12T00:00:00.000Z');

test('allocationLabel joins vehicle (with plate) and driver', () => {
  assert.equal(allocationLabel(row({})), 'Bus 12 (TN 01 AB 1234)');
  assert.equal(allocationLabel(row({ vehicle: { id: 'v', name: 'KA01', plateNumber: 'KA01' }, driver: { id: 'd', name: 'Driver One' } })), 'KA01 · Driver One');
  assert.equal(allocationLabel(row({ vehicle: null, driver: { id: 'd', name: 'Driver One' } })), 'Driver One');
});

test('allocationState and sort order', () => {
  assert.equal(allocationState(row({}), NOW), 'active');
  assert.equal(allocationState(row({ active: false, validTo: '2026-11-05T00:00:00.000Z' }), NOW), 'ended');
  assert.equal(allocationState(row({ active: false, validFrom: '2026-12-01T00:00:00.000Z' }), NOW), 'scheduled');
  assert.equal(allocationState(row({ active: false }), NOW), 'inactive');
  const sorted = sortAllocations([row({ id: 'e', active: false, validTo: '2026-11-05T00:00:00.000Z' }), row({ id: 's', active: false, validFrom: '2026-12-01T00:00:00.000Z' }), row({ id: 'a' })], NOW);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ['a', 's', 'e'],
  );
});

test('allocationInput validates the form', () => {
  assert.deepEqual(allocationInput({ objectId: null, driverId: null, validFrom: '', validTo: '', note: '' }), { ok: false, error: 'Choose a vehicle, a driver or both.' });
  assert.equal(allocationInput({ objectId: 'v', driverId: null, validFrom: '2026-11-10T10:00', validTo: '2026-11-10T09:00', note: '' }).ok, false);
  assert.deepEqual(allocationInput({ objectId: 'v', driverId: null, validFrom: '', validTo: '', note: '  night shift  ' }), { ok: true, input: { objectId: 'v', driverId: null, note: 'night shift' } });
});

test('fleet error codes and access-log text', () => {
  assert.match(fleetErrorText('ALLOCATION_OVERLAP') ?? '', /overlapping/);
  assert.equal(fleetErrorText('OTHER'), null);
  assert.equal(accessWhatLabel('detail'), 'Opened passenger details');
  assert.equal(accessWhatLabel('custom'), 'custom');
  assert.equal(accessWhatLabel('incident-detail'), 'Opened an SOS incident');
  assert.equal(accessWhatLabel('transport-records'), 'Opened bookings, trips or route plans');
  assert.equal(accessActorText({ actorKind: 'PROVIDER', actorName: 'Dispatcher One', actorCompanyName: 'Prov Co' }), 'Dispatcher One · Prov Co');
  assert.equal(accessActorText({ actorKind: 'SUPPORT', actorName: null, actorCompanyName: null }), 'VeeTrax support');
  // QA B7: translated in hi / ta (the server no longer sends an English name for support).
  const hi = (s: string) => (TRANSLATIONS.hi as Record<string, string>)[s] ?? s;
  assert.equal(accessActorText({ actorKind: 'SUPPORT', actorName: null, actorCompanyName: null }, hi), 'VeeTrax सहायता');
  assert.notEqual(accessActorText({ actorKind: 'SUPPORT', actorName: null, actorCompanyName: null }, (s) => (TRANSLATIONS.ta as Record<string, string>)[s] ?? s), 'VeeTrax support');
});
