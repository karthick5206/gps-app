import { BadRequestException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { AuthContext, TransportAgreementScope } from '../../access/auth-context';
import { accessReasonOf, requireSupportReason } from '../../access/access-reason';
import { actingCustomers, assertTransportAccess, customerContextOf, includesOwnCompany, NO_COMPANY, transportReadScope } from '../../access/transport-scope';
import { bookingReadWhere, tripReadWhere } from '../dispatch/e3-common';
import { passengerReadWhere, passengerView } from '../people/people-access';
import { TransportFeatureGuard } from '../transport-feature.guard';

/** E1b pure rules: customer context (07 §2.5), trip visibility under agreements (10 §2.3), Super Admin reason (10 §2.2 item 8). */
const DAY = 86_400_000;
const NOW = Date.parse('2026-12-01T00:00:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const PROV = '44444444-4444-4444-8444-444444444444';
const agr = (over: Partial<TransportAgreementScope>): TransportAgreementScope => ({
  id: `agr-${over.customerCompanyId}`,
  customerCompanyId: A,
  grants: ['VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_MINIMAL'],
  siteIds: [],
  dataProfile: 'MINIMAL',
  validFrom: NOW - DAY,
  validTo: null,
  ...over,
});
// Provider PROV: customer A (all sites), customer B (site s1 only), customer C expired.
const provider = (): Pick<AuthContext, 'companyId' | 'agreements' | 'agreementsAll' | 'transportCustomerId' | 'dataScope' | 'branchIds'> => ({
  companyId: PROV,
  dataScope: 'COMPANY',
  branchIds: [],
  agreements: [agr({ customerCompanyId: A }), agr({ customerCompanyId: B, siteIds: ['s1'] }), agr({ customerCompanyId: C, validTo: NOW - 1 })],
});

describe('customer context (X-Transport-Customer, doc 07 §2.5)', () => {
  it('no header = all customers, unchanged', () => {
    expect(customerContextOf(provider(), undefined, NOW)).toBeNull();
    expect(customerContextOf(provider(), '  ', NOW)).toBeNull();
  });

  it('a customer with an in-force agreement narrows to that agreement and hides own-company rows', () => {
    const n = customerContextOf(provider(), A, NOW)!;
    expect(n.transportCustomerId).toBe(A);
    expect(n.agreements!.map((a) => a.customerCompanyId)).toEqual([A]);
    expect(n.agreementsAll).toHaveLength(3);
    const ctx = { ...provider(), ...n };
    expect(includesOwnCompany(ctx)).toBe(false);
    expect(actingCustomers(ctx, undefined, NOW).map((c) => c.customerCompanyId)).toEqual([A]);
    expect(transportReadScope(ctx, 'VIEW_BOOKINGS', { now: NOW }).OR).toEqual([{ providerCompanyId: PROV, customerCompanyId: A }]);
    expect(() => assertTransportAccess(ctx, { customerCompanyId: PROV, providerCompanyId: PROV }, 'VIEW_BOOKINGS', NOW)).toThrow(NotFoundException);
    expect(() => assertTransportAccess(ctx, { customerCompanyId: B, providerCompanyId: PROV, siteId: 's1' }, 'VIEW_BOOKINGS', NOW)).toThrow(NotFoundException);
    assertTransportAccess(ctx, { customerCompanyId: A, providerCompanyId: PROV }, 'VIEW_BOOKINGS', NOW);
  });

  it('the own company narrows to own rows only (no agreements)', () => {
    const ctx = { ...provider(), ...customerContextOf(provider(), PROV, NOW)! };
    expect(ctx.agreements).toEqual([]);
    expect(includesOwnCompany(ctx)).toBe(true);
    expect(transportReadScope(ctx, 'VIEW_BOOKINGS', { now: NOW }).OR).toEqual([{ customerCompanyId: PROV }]);
  });

  it('unknown, expired, foreign or malformed ids are 404 (never 403: the header cannot probe tenants)', () => {
    for (const bad of [C, '55555555-5555-4555-8555-555555555555', 'not-a-uuid', "'; DROP TABLE x;--"]) {
      expect(() => customerContextOf(provider(), bad, NOW)).toThrow(NotFoundException);
    }
    // A customer company has no agreements as provider: only itself is valid.
    const customer = { companyId: A, agreements: [] };
    expect(() => customerContextOf(customer, B, NOW)).toThrow(NotFoundException);
    expect(customerContextOf(customer, A, NOW)!.transportCustomerId).toBe(A);
  });

  it('re-narrowing uses the unnarrowed list (agreementsAll)', () => {
    const once = { ...provider(), ...customerContextOf(provider(), A, NOW)! };
    expect(customerContextOf(once, B, NOW)!.agreements!.map((a) => a.customerCompanyId)).toEqual([B]);
  });

  it('TransportFeatureGuard applies the header to the request context before the handler; a bad id is 404', () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const guard = new TransportFeatureGuard();
    const exec = (auth: AuthContext, header?: string) =>
      ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ auth, headers: header ? { 'x-transport-customer': header } : {} }) }) }) as unknown as ExecutionContext;
    const auth = { ...provider(), userId: 'u', homeCompanyId: PROV, isSuperAdmin: false, permissions: {}, objectIds: [], features: ['etms', 'etmsProvider'], ip: null, agreements: [agr({ customerCompanyId: A }), agr({ customerCompanyId: B })] } as AuthContext;
    expect(guard.canActivate(exec(auth, A))).toBe(true);
    expect(auth.transportCustomerId).toBe(A);
    expect(auth.agreements!.map((a) => a.customerCompanyId)).toEqual([A]);
    const fresh = { ...auth, transportCustomerId: undefined, agreements: [agr({ customerCompanyId: A })], agreementsAll: undefined } as AuthContext;
    expect(() => guard.canActivate(exec(fresh, C))).toThrow(NotFoundException);
    jest.useRealTimers();
  });

  it('passengers: narrowed to a customer, own passengers drop out of the list and the detail', () => {
    const ctx = { ...provider(), ...customerContextOf(provider(), A, NOW)! };
    expect(passengerReadWhere(ctx, NOW)).toEqual({ OR: [{ companyId: A, isActive: true }] });
    expect(passengerView(ctx, { companyId: PROV, branchId: null, officePoiId: null, isActive: true }, NOW)).toBeNull();
    expect(passengerView(ctx, { companyId: A, branchId: null, officePoiId: null, isActive: true }, NOW)?.projection).toBe('MINIMAL');
    expect(passengerView(ctx, { companyId: B, branchId: null, officePoiId: 's1', isActive: true }, NOW)).toBeNull();
  });
});

describe('never an empty OR (Prisma: OR [] inside AND matches everything)', () => {
  it('narrowed to a customer whose agreement lacks the grant, every scope still matches nothing instead of everything', () => {
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      const view = { ...provider(), agreements: [agr({ customerCompanyId: A, grants: ['VIEW_REPORTS'] })] };
      const ctx = { ...view, ...customerContextOf(view, A, NOW)! };
      expect(transportReadScope(ctx, 'VIEW_BOOKINGS', { now: NOW }).OR).toEqual([{ customerCompanyId: NO_COMPANY }]);
      expect(tripReadWhere(ctx, null)).toEqual({ OR: [{ customerCompanyId: NO_COMPANY }] });
      expect(bookingReadWhere(ctx)).toEqual({ OR: [{ customerCompanyId: NO_COMPANY }] });
      expect(passengerReadWhere(ctx, NOW)).toEqual({ OR: [{ companyId: NO_COMPANY }] });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('trip visibility under agreements (doc 10 §2.3, doc 11 §3.2 case 1)', () => {
  it('own trips, operator trips without a customer, and trips for customers whose in-force agreement grants MANAGE_DISPATCH (at its sites)', () => {
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      const ctx = provider();
      expect(tripReadWhere(ctx, null)).toEqual({
        OR: [
          { customerCompanyId: PROV },
          { providerCompanyId: PROV, customerCompanyId: null },
          { providerCompanyId: PROV, customerCompanyId: A },
          { providerCompanyId: PROV, customerCompanyId: B, sitePoiId: { in: ['s1'] } },
        ],
      });
      // Agreement ended / suspended (no longer in ctx.agreements) → the provider no longer reads that customer's trips.
      expect(JSON.stringify(tripReadWhere({ ...ctx, agreements: [] }, null))).not.toContain(A);
      // A view-only agreement (no MANAGE_DISPATCH) gives no trips.
      expect(JSON.stringify(tripReadWhere({ ...ctx, agreements: [agr({ customerCompanyId: A, grants: ['VIEW_BOOKINGS'] })] }, null))).not.toContain(A);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Super Admin reason (X-Access-Reason, doc 10 §2.2 item 8)', () => {
  it('required (≥ 5 characters) for the Super Admin only; URI-decoded, trimmed, capped at 300', () => {
    expect(() => requireSupportReason({ isSuperAdmin: true }, undefined)).toThrow(BadRequestException);
    expect(() => requireSupportReason({ isSuperAdmin: true }, ' abc ')).toThrow(BadRequestException);
    try {
      requireSupportReason({ isSuperAdmin: true }, '');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'REASON_REQUIRED' });
    }
    expect(requireSupportReason({ isSuperAdmin: true }, encodeURIComponent('टिकट 42 की जाँच'))).toBe('टिकट 42 की जाँच');
    expect(requireSupportReason({ isSuperAdmin: false }, undefined)).toBeNull();
    expect(requireSupportReason({ isSuperAdmin: false }, 'checking')).toBe('checking');
    expect(accessReasonOf('x'.repeat(400))).toHaveLength(300);
    expect(accessReasonOf('%E0%A4')).toBe('%E0%A4'); // malformed encoding: kept as typed
  });
});
