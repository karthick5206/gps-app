import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TRANSPORT_GRANTS } from '@veetracer/shared';
import { objectReadScopeWhere, objectScopeWhere } from './access-rules';
import type { TransportAgreementScope } from './auth-context';
import {
  actingCustomers,
  assertTransportAccess,
  customerGrants,
  hasTransportGrant,
  transportDataProfile,
  transportReadScope,
  transportWriteScope,
} from './transport-scope';

const NOW = Date.parse('2026-12-01T00:00:00Z');
const DAY = 86_400_000;
const agr = (over: Partial<TransportAgreementScope>): TransportAgreementScope => ({
  id: 'a1',
  customerCompanyId: 'custA',
  grants: ['VIEW_BOOKINGS', 'MANAGE_DISPATCH'],
  siteIds: [],
  dataProfile: 'MINIMAL',
  validFrom: NOW - DAY,
  validTo: null,
  ...over,
});
// Provider P acts for customer A (all sites) and customer B (site s1 only, view only); C's agreement has expired.
const provider = {
  companyId: 'prov',
  agreements: [
    agr({}),
    agr({ id: 'a2', customerCompanyId: 'custB', grants: ['VIEW_BOOKINGS'], siteIds: ['s1'], dataProfile: 'STANDARD' }),
    agr({ id: 'a3', customerCompanyId: 'custC', validTo: NOW - 1 }),
  ],
};
const customer = { companyId: 'custA', agreements: [] };

describe('transport-scope (D1 helpers)', () => {
  it('own company is always a customer with every grant (corporate-managed); agreements add customers', () => {
    const all = actingCustomers(provider, undefined, NOW);
    expect(all.map((c) => [c.customerCompanyId, c.mode])).toEqual([['prov', 'SELF'], ['custA', 'AGREEMENT'], ['custB', 'AGREEMENT']]);
    expect(all[0].grants).toEqual([...TRANSPORT_GRANTS]);
    expect(actingCustomers(provider, 'MANAGE_DISPATCH', NOW).map((c) => c.customerCompanyId)).toEqual(['prov', 'custA']);
  });

  it('expired or not-yet-valid agreements give nothing, even if still in a long-lived context', () => {
    expect(customerGrants(provider, 'custC', NOW)).toEqual([]);
    const future = { companyId: 'prov', agreements: [agr({ validFrom: NOW + DAY })] };
    expect(customerGrants(future, 'custA', NOW)).toEqual([]);
  });

  it('an agreement naming the own company is ignored (corporate-managed has no row)', () => {
    const odd = { companyId: 'prov', agreements: [agr({ customerCompanyId: 'prov', grants: ['VIEW_REPORTS'] })] };
    expect(actingCustomers(odd, undefined, NOW)).toHaveLength(1);
  });

  it('grants and sites per customer', () => {
    expect(customerGrants(provider, 'custB', NOW)).toEqual(['VIEW_BOOKINGS']);
    expect(hasTransportGrant(provider, 'custB', 'VIEW_BOOKINGS', 's1', NOW)).toBe(true);
    expect(hasTransportGrant(provider, 'custB', 'VIEW_BOOKINGS', 's2', NOW)).toBe(false);
    expect(hasTransportGrant(provider, 'custB', 'MANAGE_DISPATCH', 's1', NOW)).toBe(false);
    expect(hasTransportGrant(provider, 'custA', 'MANAGE_DISPATCH', 'anything', NOW)).toBe(true);
    expect(hasTransportGrant(provider, 'stranger', 'VIEW_BOOKINGS', null, NOW)).toBe(false);
  });

  it('data profile: FULL for the own company, the agreement profile for a customer, null otherwise', () => {
    expect(transportDataProfile(customer, 'custA', NOW)).toBe('FULL');
    expect(transportDataProfile(provider, 'custB', NOW)).toBe('STANDARD');
    expect(transportDataProfile(provider, 'custC', NOW)).toBeNull();
  });

  it('read scope: own customer rows + provider rows of customers whose agreement holds the grant (site-limited)', () => {
    expect(transportReadScope(provider, 'VIEW_BOOKINGS', { siteColumn: true, now: NOW })).toEqual({
      OR: [
        { customerCompanyId: 'prov' },
        { providerCompanyId: 'prov', customerCompanyId: 'custA' },
        { providerCompanyId: 'prov', customerCompanyId: 'custB', siteId: { in: ['s1'] } },
      ],
    });
    expect(transportReadScope(customer, 'VIEW_BOOKINGS', { now: NOW })).toEqual({ OR: [{ customerCompanyId: 'custA' }] });
  });

  it('write scope accepts only write grants', () => {
    expect(transportWriteScope(provider, 'MANAGE_DISPATCH', { now: NOW })).toEqual({ OR: [{ customerCompanyId: 'prov' }, { providerCompanyId: 'prov', customerCompanyId: 'custA' }] });
    expect(() => transportWriteScope(provider, 'VIEW_BOOKINGS')).toThrow(/not a write grant/);
  });

  it('single row: 404 when not visible, 403 when visible without the grant', () => {
    expect(() => assertTransportAccess(customer, { customerCompanyId: 'custA', providerCompanyId: 'prov' }, 'MANAGE_DISPATCH', NOW)).not.toThrow();
    expect(() => assertTransportAccess(customer, { customerCompanyId: 'custB', providerCompanyId: 'prov' }, 'VIEW_BOOKINGS', NOW)).toThrow(NotFoundException);
    expect(() => assertTransportAccess(provider, { customerCompanyId: 'custB', providerCompanyId: 'prov', siteId: 's2' }, 'VIEW_BOOKINGS', NOW)).toThrow(NotFoundException);
    expect(() => assertTransportAccess(provider, { customerCompanyId: 'custB', providerCompanyId: 'prov', siteId: 's1' }, 'MANAGE_DISPATCH', NOW)).toThrow(ForbiddenException);
    expect(() => assertTransportAccess(provider, { customerCompanyId: 'custB', providerCompanyId: 'other', siteId: 's1' }, 'VIEW_BOOKINGS', NOW)).toThrow(NotFoundException);
    expect(() => assertTransportAccess(provider, { customerCompanyId: 'custC', providerCompanyId: 'prov' }, 'VIEW_BOOKINGS', NOW)).toThrow(NotFoundException);
    expect(() => assertTransportAccess(provider, null, 'VIEW_BOOKINGS', NOW)).toThrow(NotFoundException);
  });

  it('existing GPS scopes ignore agreements (provider users never switch company)', () => {
    const ctx = { ...provider, dataScope: 'COMPANY' as const, branchIds: [], objectIds: [], shares: [] };
    expect(objectScopeWhere(ctx)).toEqual({ companyId: 'prov' });
    expect(objectReadScopeWhere(ctx)).toEqual({ companyId: 'prov' });
  });
});
