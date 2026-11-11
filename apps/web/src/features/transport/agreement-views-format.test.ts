import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TransportAgreementHistoryEntryDto, TransportAgreementSummaryDto } from '@veetracer/shared';
import { historyActor, historyDetail, historyLabel, lookupOption, lookupQuery, pastedCompanyId, summaryCount } from './agreement-views-format.ts';

const entry = (over: Partial<TransportAgreementHistoryEntryDto>): TransportAgreementHistoryEntryDto => ({
  id: 'h1',
  at: '2026-11-11T10:00:00.000Z',
  kind: 'EDITED',
  actorSide: 'CUSTOMER',
  actorName: null,
  fromStatus: null,
  toStatus: null,
  changedFields: [],
  reason: null,
  ...over,
});

test('lookupQuery: trimmed, whitespace collapsed, null below 3 characters', () => {
  assert.equal(lookupQuery('ab'), null);
  assert.equal(lookupQuery('  a b '), 'a b');
  assert.equal(lookupQuery(' a  '), null);
  assert.equal(lookupQuery('  acme   corp '), 'acme corp');
});

test('pastedCompanyId: accepts a UUID with spaces around it, lower-cased; rejects anything else', () => {
  assert.equal(pastedCompanyId(' 11111111-1111-4111-8111-11111111111A '), '11111111-1111-4111-8111-11111111111a');
  assert.equal(pastedCompanyId('acme'), null);
  assert.equal(pastedCompanyId(''), null);
});

test('lookupOption: name plus city when known', () => {
  assert.deepEqual(lookupOption({ id: 'c1', name: 'Acme', city: 'Pune' }), { value: 'c1', label: 'Acme', description: 'Pune' });
  assert.deepEqual(lookupOption({ id: 'c1', name: 'Acme', city: null }), { value: 'c1', label: 'Acme' });
});

test('historyLabel: every kind, and the activating approval', () => {
  assert.equal(historyLabel({ kind: 'CREATED', toStatus: 'DRAFT' }), 'Draft created');
  assert.equal(historyLabel({ kind: 'APPROVED', toStatus: null }), 'Approved');
  assert.equal(historyLabel({ kind: 'APPROVED', toStatus: 'ACTIVE' }), 'Approved: agreement active');
  for (const k of ['EDITED', 'PROPOSED', 'SUSPENDED', 'RESUMED', 'ENDED'] as const) assert.ok(historyLabel({ kind: k, toStatus: null }).length > 0);
});

test('historyActor: name when shared, otherwise the side; platform is VeeTrax support', () => {
  assert.deepEqual(historyActor(entry({ actorName: 'Priya', actorSide: 'PROVIDER' })), { name: 'Priya', sideLabel: 'Provider' });
  assert.deepEqual(historyActor(entry({ actorName: null, actorSide: 'CUSTOMER' })), { name: null, sideLabel: 'Customer' });
  assert.deepEqual(historyActor(entry({ actorName: null, actorSide: 'PLATFORM' })), { name: null, sideLabel: 'VeeTrax support' });
  assert.deepEqual(historyActor(entry({ actorName: null, actorSide: null })), { name: null, sideLabel: 'System' });
});

test('historyDetail: changed terms only for edits; reason passed through', () => {
  assert.deepEqual(historyDetail(entry({ kind: 'EDITED', changedFields: ['grants', 'siteIds'] })), { fields: ['grants', 'sites'], reason: null });
  assert.deepEqual(historyDetail(entry({ kind: 'SUSPENDED', changedFields: ['grants'], reason: 'audit' })), { fields: [], reason: 'audit' });
});

test('summaryCount: undefined while loading, 0 for a missing status', () => {
  const s = { byStatus: { DRAFT: 2, PROPOSED: 1, ACTIVE: 0, SUSPENDED: 0, ENDED: 4 }, total: 7, awaitingMyApproval: 1, awaiting: [] } as TransportAgreementSummaryDto;
  assert.equal(summaryCount(undefined, 'DRAFT'), undefined);
  assert.equal(summaryCount(s, 'ENDED'), 4);
  assert.equal(summaryCount({ ...s, byStatus: {} as TransportAgreementSummaryDto['byStatus'] }, 'ACTIVE'), 0);
});
