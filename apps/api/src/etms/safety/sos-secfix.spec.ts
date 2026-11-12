import { ExecutionContext } from '@nestjs/common';
import type { AuthContext, TransportAgreementScope } from '../../access/auth-context';
import { customerContextOf } from '../../access/transport-scope';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { IncidentsController } from './safety.controller';
import { incidentAccess, incidentListWhere } from './sos-rules';

const PROV = '00000000-0000-4000-8000-0000000000aa';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const NOW = Date.now();
const agr = (customerCompanyId: string): TransportAgreementScope => ({ id: `agr-${customerCompanyId}`, customerCompanyId, grants: ['MANAGE_INCIDENTS'], siteIds: [], dataProfile: 'MINIMAL', validFrom: NOW - 86_400_000, validTo: null });
const providerDesk = (): AuthContext =>
  ({ userId: 'u', companyId: PROV, homeCompanyId: PROV, isSuperAdmin: false, permissions: { etms_incidents: ['view', 'edit'] }, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms', 'etmsProvider'], agreements: [agr(A), agr(B)], ip: null }) as AuthContext;
const paxSosOfB = { raiserType: 'PASSENGER', providerCompanyId: PROV, customerCompanyId: B };

describe('QA B1 (safety): the customer picker never narrows SOS / incidents', () => {
  it('a provider dispatcher narrowed to customer A (or to its own company) still manages B\'s passenger SOS', () => {
    for (const pick of [A, PROV]) {
      const narrowed = { ...providerDesk(), ...customerContextOf(providerDesk(), pick, NOW)! };
      expect(narrowed.agreements!.some((a) => a.customerCompanyId === B)).toBe(false);
      expect(incidentAccess(narrowed, paxSosOfB, NOW)).toBe('manage');
      const where = incidentListWhere(narrowed, NOW) as { OR: unknown[] };
      expect(where.OR).toContainEqual({ providerCompanyId: PROV, customerCompanyId: { in: [A, B] } });
    }
  });

  it('TransportFeatureGuard ignores X-Transport-Customer on the incidents controller (even an invalid id is no 404)', () => {
    const guard = new TransportFeatureGuard();
    const exec = (auth: AuthContext, header: string, cls: unknown) =>
      ({ getType: () => 'http', getHandler: () => IncidentsController.prototype.list, getClass: () => cls, switchToHttp: () => ({ getRequest: () => ({ auth, headers: { 'x-transport-customer': header } }) }) }) as unknown as ExecutionContext;
    const onLane = providerDesk();
    expect(guard.canActivate(exec(onLane, A, IncidentsController))).toBe(true);
    expect(onLane.transportCustomerId).toBeUndefined();
    expect(onLane.agreements!.map((a) => a.customerCompanyId)).toEqual([A, B]);
    expect(guard.canActivate(exec(providerDesk(), '99999999-9999-4999-8999-999999999999', IncidentsController))).toBe(true);
    // Any other ETMS controller is still narrowed by the header.
    class OtherController {}
    const elsewhere = providerDesk();
    expect(guard.canActivate(exec(elsewhere, A, OtherController))).toBe(true);
    expect(elsewhere.agreements!.map((a) => a.customerCompanyId)).toEqual([A]);
  });
});
