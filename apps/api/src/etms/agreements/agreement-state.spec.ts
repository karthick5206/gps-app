import { agreementActions, agreementInForce, nextAgreementStatus, type AgreementStateView } from '@veetracer/shared';

const a = (status: AgreementStateView['status'], c: boolean = false, p: boolean = false): AgreementStateView => ({
  status,
  approvedByCustomerAt: c ? new Date() : null,
  approvedByProviderAt: p ? new Date() : null,
});

describe('ETMS agreement state machine (P1)', () => {
  it('DRAFT: both parties and the Super Admin edit, propose and end; nobody approves yet', () => {
    for (const actor of ['PROVIDER', 'CUSTOMER', 'PLATFORM'] as const) expect(agreementActions(a('DRAFT'), actor)).toEqual(['edit', 'propose', 'end']);
    expect(nextAgreementStatus(a('DRAFT'), 'propose', 'PROVIDER')).toBe('PROPOSED');
    expect(nextAgreementStatus(a('DRAFT'), 'end', 'PLATFORM')).toBe('ENDED');
  });

  it('PROPOSED: each party approves its own side once; the Super Admin never approves', () => {
    expect(agreementActions(a('PROPOSED'), 'CUSTOMER')).toEqual(['approve', 'end']);
    expect(agreementActions(a('PROPOSED'), 'PLATFORM')).toEqual(['end']);
    expect(agreementActions(a('PROPOSED', true), 'CUSTOMER')).toEqual(['end']);
    expect(agreementActions(a('PROPOSED', true), 'PROVIDER')).toEqual(['approve', 'end']);
    expect(() => nextAgreementStatus(a('PROPOSED'), 'approve', 'PLATFORM')).toThrow(/INVALID_STATE/);
    expect(() => nextAgreementStatus(a('PROPOSED'), 'edit', 'CUSTOMER')).toThrow(/INVALID_STATE/);
  });

  it('becomes ACTIVE only when the second side approves', () => {
    expect(nextAgreementStatus(a('PROPOSED'), 'approve', 'CUSTOMER')).toBe('PROPOSED');
    expect(nextAgreementStatus(a('PROPOSED', true), 'approve', 'PROVIDER')).toBe('ACTIVE');
    expect(nextAgreementStatus(a('PROPOSED', false, true), 'approve', 'CUSTOMER')).toBe('ACTIVE');
  });

  it('ACTIVE ⇄ SUSPENDED: the customer (or Super Admin) suspends and resumes, the provider can only end', () => {
    expect(agreementActions(a('ACTIVE', true, true), 'CUSTOMER')).toEqual(['suspend', 'end']);
    expect(agreementActions(a('ACTIVE', true, true), 'PROVIDER')).toEqual(['end']);
    expect(agreementActions(a('ACTIVE', true, true), 'PLATFORM')).toEqual(['suspend', 'end']);
    expect(nextAgreementStatus(a('ACTIVE', true, true), 'suspend', 'CUSTOMER')).toBe('SUSPENDED');
    expect(nextAgreementStatus(a('SUSPENDED', true, true), 'resume', 'CUSTOMER')).toBe('ACTIVE');
    expect(() => nextAgreementStatus(a('SUSPENDED', true, true), 'resume', 'PROVIDER')).toThrow(/INVALID_STATE/);
  });

  it('ENDED is final', () => {
    for (const actor of ['PROVIDER', 'CUSTOMER', 'PLATFORM'] as const) expect(agreementActions(a('ENDED', true, true), actor)).toEqual([]);
    expect(() => nextAgreementStatus(a('ENDED'), 'resume', 'CUSTOMER')).toThrow(/INVALID_STATE/);
  });

  it('in force only when ACTIVE and inside [validFrom, validTo)', () => {
    const now = new Date('2026-12-01T00:00:00Z');
    const base = { validFrom: '2026-11-01T00:00:00Z', validTo: null };
    expect(agreementInForce({ ...base, status: 'ACTIVE' }, now)).toBe(true);
    expect(agreementInForce({ ...base, status: 'SUSPENDED' }, now)).toBe(false);
    expect(agreementInForce({ ...base, status: 'ACTIVE', validTo: '2026-12-01T00:00:00Z' }, now)).toBe(false);
    expect(agreementInForce({ status: 'ACTIVE', validFrom: '2026-12-02T00:00:00Z', validTo: null }, now)).toBe(false);
  });
});
