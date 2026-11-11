import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSPORT_AGREEMENT_STATUSES, TRANSPORT_GRANTS, type TransportAgreementDto } from '@veetracer/shared';
import {
  ACTION_META,
  AGREEMENT_STATUS_LABEL,
  AGREEMENT_STATUS_TONE,
  agreementButtons,
  agreementErrorKind,
  agreementTimeline,
  approvalState,
  counterpartyName,
  dayStartIso,
  draftFromAgreement,
  emptyDraft,
  GRANT_META,
  lastDayToValidTo,
  nextDay,
  orderedGrants,
  proposeBlockers,
  reasonError,
  validateAgreementDraft,
  validToLastDay,
  type AgreementDraft,
} from './agreement-format.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const TZ = 'Asia/Kolkata';

function agreement(over: Partial<TransportAgreementDto> = {}): TransportAgreementDto {
  return {
    id: 'a1',
    version: 1,
    status: 'DRAFT',
    providerCompanyId: OTHER,
    providerCompanyName: 'Fleet Co',
    customerCompanyId: ME,
    customerCompanyName: 'Acme',
    validFrom: '2026-11-30T18:30:00.000Z',
    validTo: null,
    grants: ['VIEW_BOOKINGS'],
    siteIds: [],
    dataProfile: 'MINIMAL',
    approvedByCustomerAt: null,
    approvedByCustomerUserId: null,
    approvedByProviderAt: null,
    approvedByProviderUserId: null,
    suspendedAt: null,
    endedAt: null,
    statusReason: null,
    inForce: false,
    side: 'CUSTOMER',
    allowedActions: ['edit', 'propose', 'end'],
    createdById: null,
    createdAt: '2026-11-11T05:00:00.000Z',
    updatedAt: '2026-11-11T05:00:00.000Z',
    ...over,
  };
}

const draft = (over: Partial<AgreementDraft> = {}): AgreementDraft => ({ ...emptyDraft('2026-12-01'), providerCompanyId: OTHER, customerCompanyId: ME, grants: ['VIEW_BOOKINGS'], ...over });
const tenant = { create: true, companyId: ME, isSuperAdmin: false };

test('every status and grant has a label; tones are distinct for live statuses', () => {
  for (const s of TRANSPORT_AGREEMENT_STATUSES) assert.ok(AGREEMENT_STATUS_LABEL[s] && AGREEMENT_STATUS_TONE[s]);
  for (const g of TRANSPORT_GRANTS) assert.ok(GRANT_META[g].label);
  assert.equal(AGREEMENT_STATUS_LABEL.PROPOSED, 'Awaiting approval');
  assert.equal(new Set(['DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED'].map((s) => AGREEMENT_STATUS_TONE[s as 'DRAFT'])).size, 4);
});

test('orderedGrants puts view grants before write grants, keeps catalogue order', () => {
  assert.deepEqual(orderedGrants(['MANAGE_DISPATCH', 'VIEW_REPORTS', 'VIEW_BOOKINGS']), ['VIEW_BOOKINGS', 'VIEW_REPORTS', 'MANAGE_DISPATCH']);
  assert.equal(orderedGrants().length, TRANSPORT_GRANTS.length);
});

test('agreementButtons shows exactly the server actions, ordered, and nothing without edit rights', () => {
  assert.deepEqual(agreementButtons(['end', 'propose', 'edit'], true), ['propose', 'edit', 'end']);
  assert.deepEqual(agreementButtons(['end', 'approve'], true), ['approve', 'end']);
  assert.deepEqual(agreementButtons(['resume', 'end'], true), ['resume', 'end']);
  assert.deepEqual(agreementButtons(['suspend', 'end'], true), ['suspend', 'end']);
  assert.deepEqual(agreementButtons([], true), []);
  assert.deepEqual(agreementButtons(['approve', 'end'], false), []);
});

test('only suspend and end ask for a reason; end is destructive', () => {
  const withReason = Object.entries(ACTION_META).filter(([, m]) => m.needsReason).map(([a]) => a).sort();
  assert.deepEqual(withReason, ['end', 'suspend']);
  assert.equal(ACTION_META.end.variant, 'destructive');
});

test('reasonError: required, trimmed, at most 500', () => {
  assert.equal(reasonError('   '), 'Give a reason');
  assert.equal(reasonError(' ok '), null);
  assert.equal(reasonError('x'.repeat(500)), null);
  assert.equal(reasonError('x'.repeat(501)), 'At most 500 characters');
});

test('proposeBlockers mirrors the server: grants needed, validTo in the future', () => {
  const now = new Date('2026-11-11T00:00:00Z');
  assert.deepEqual(proposeBlockers({ grants: ['VIEW_BOOKINGS'], validTo: null }, now), []);
  assert.equal(proposeBlockers({ grants: [], validTo: null }, now).length, 1);
  assert.equal(proposeBlockers({ grants: ['VIEW_BOOKINGS'], validTo: '2026-11-10T00:00:00Z' }, now).length, 1);
});

test('validateAgreementDraft: valid draft passes', () => {
  assert.deepEqual(validateAgreementDraft(draft(), tenant), {});
  assert.deepEqual(validateAgreementDraft(draft({ lastDay: '2026-12-01' }), tenant), {}, 'a one-day agreement is valid');
});

test('validateAgreementDraft: parties required, valid ids, different, caller is a party', () => {
  assert.equal(validateAgreementDraft(draft({ providerCompanyId: '' }), tenant).providerCompanyId, 'Required');
  assert.equal(validateAgreementDraft(draft({ providerCompanyId: 'abc' }), tenant).providerCompanyId, 'Enter a valid company ID');
  assert.equal(validateAgreementDraft(draft({ providerCompanyId: ME }), tenant).customerCompanyId, 'Provider and customer must be different companies');
  assert.equal(validateAgreementDraft(draft({ providerCompanyId: OTHER, customerCompanyId: THIRD }), tenant).customerCompanyId, 'Your company must be the provider or the customer');
  assert.deepEqual(validateAgreementDraft(draft({ providerCompanyId: OTHER, customerCompanyId: THIRD }), { ...tenant, isSuperAdmin: true }), {});
  assert.deepEqual(validateAgreementDraft(draft({ providerCompanyId: '' }), { ...tenant, create: false }), {}, 'edit does not re-check parties');
});

test('validateAgreementDraft: validity dates', () => {
  assert.equal(validateAgreementDraft(draft({ validFrom: '' }), tenant).validFrom, 'Required');
  assert.equal(validateAgreementDraft(draft({ lastDay: '2026-11-30' }), tenant).lastDay, 'The last day must be on or after the first day');
  assert.equal(validateAgreementDraft(draft({ lastDay: '31/12/2026' }), tenant).lastDay, 'Invalid date');
});

test('validateAgreementDraft: grants and sites', () => {
  assert.equal(validateAgreementDraft(draft({ grants: ['VIEW_BOOKINGS', 'VIEW_BOOKINGS'] }), tenant).grants, 'Invalid grants');
  assert.equal(validateAgreementDraft(draft({ siteIds: ['nope'] }), tenant).siteIds, 'Invalid site');
  assert.equal(validateAgreementDraft(draft({ siteIds: Array.from({ length: 501 }, () => OTHER) }), tenant).siteIds, 'At most 500 sites');
  assert.deepEqual(validateAgreementDraft(draft({ grants: [] }), tenant), {}, 'a draft may be saved without grants (propose needs them)');
});

test('validity days ↔ ISO in the company zone (last day inclusive, validTo exclusive)', () => {
  assert.equal(dayStartIso('2026-12-01', TZ), '2026-11-30T18:30:00.000Z');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
  assert.equal(lastDayToValidTo('2026-12-31', TZ), '2026-12-31T18:30:00.000Z');
  assert.equal(validToLastDay('2026-12-31T18:30:00.000Z', TZ), '2026-12-31');
  assert.equal(lastDayToValidTo('', TZ), null);
});

test('draftFromAgreement round-trips the validity', () => {
  const d = draftFromAgreement(agreement({ validTo: '2026-12-31T18:30:00.000Z', grants: ['MANAGE_DISPATCH', 'VIEW_BOOKINGS'] }), TZ);
  assert.equal(d.validFrom, '2026-12-01');
  assert.equal(d.lastDay, '2026-12-31');
  assert.deepEqual(d.grants, ['VIEW_BOOKINGS', 'MANAGE_DISPATCH']);
});

test('counterpartyName follows the caller side', () => {
  assert.equal(counterpartyName(agreement()), 'Fleet Co');
  assert.equal(counterpartyName(agreement({ side: 'PROVIDER' })), 'Acme');
  assert.equal(counterpartyName(agreement({ side: null })), 'Fleet Co → Acme');
});

test('approvalState per side', () => {
  assert.equal(approvalState(agreement(), 'CUSTOMER'), 'notYet');
  assert.equal(approvalState(agreement({ status: 'PROPOSED' }), 'CUSTOMER'), 'waiting');
  assert.equal(approvalState(agreement({ status: 'PROPOSED', approvedByCustomerAt: '2026-11-12T00:00:00Z' }), 'CUSTOMER'), 'approved');
});

test('agreementTimeline: chronological, reason only on the current status', () => {
  const tl = agreementTimeline(
    agreement({
      status: 'ENDED',
      approvedByCustomerAt: '2026-11-13T00:00:00Z',
      approvedByProviderAt: '2026-11-12T00:00:00Z',
      suspendedAt: '2026-11-14T00:00:00Z',
      endedAt: '2026-11-15T00:00:00Z',
      statusReason: 'Contract over',
    }),
  );
  assert.deepEqual(tl.map((e) => e.key), ['created', 'approvedProvider', 'approvedCustomer', 'suspended', 'ended']);
  assert.equal(tl[3].detail, null);
  assert.equal(tl[4].detail, 'Contract over');
});

test('agreementErrorKind maps server codes', () => {
  assert.equal(agreementErrorKind('VERSION_CONFLICT'), 'conflict');
  assert.equal(agreementErrorKind('AGREEMENT_DUPLICATE'), 'duplicate');
  assert.equal(agreementErrorKind('INVALID_STATE'), 'state');
  assert.equal(agreementErrorKind(null), 'other');
});
