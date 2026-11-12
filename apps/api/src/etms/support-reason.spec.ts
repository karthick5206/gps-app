import { BadRequestException, ExecutionContext } from '@nestjs/common';
import type { AuthContext } from '../access/auth-context';
import { BookingsController, DispatchController, SchedulesController, ShiftsController, TransportTripsController } from './dispatch/e3.controllers';
import { RoutePlansController } from './planning/plans.controller';
import { IncidentsController } from './safety/safety.controller';
import { TransportFeatureGuard, TRANSPORT_RECORDS_ENTITY } from './transport-feature.guard';
import { requireSupportReason } from '../access/access-reason';

const CUST = '00000000-0000-4000-8000-00000000000c';
const PLATFORM = '00000000-0000-4000-8000-0000000000ff';
const ctxOf = (isSuperAdmin: boolean): AuthContext =>
  ({ userId: 'u1', companyId: CUST, homeCompanyId: isSuperAdmin ? PLATFORM : CUST, isSuperAdmin, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: '10.0.0.1' }) as AuthContext;
const exec = (auth: AuthContext, cls: unknown, reason?: string) =>
  ({
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ auth, method: 'GET', originalUrl: '/api/transport/bookings?page=2', headers: reason ? { 'x-access-reason': encodeURIComponent(reason) } : {} }) }),
  }) as unknown as ExecutionContext;

describe('VeeTrax support reason on every ETMS route that returns passenger personal data', () => {
  const PASSENGER_DATA_CONTROLLERS = [SchedulesController, BookingsController, DispatchController, TransportTripsController, RoutePlansController];

  it('Super Admin without a reason: 400 REASON_REQUIRED on each passenger-data controller; not on the others', () => {
    const guard = new TransportFeatureGuard();
    for (const cls of PASSENGER_DATA_CONTROLLERS) {
      expect(() => guard.canActivate(exec(ctxOf(true), cls))).toThrow(BadRequestException);
      expect(guard.canActivate(exec(ctxOf(true), cls, 'Ticket 42: wrong pickup'))).toBe(true);
      expect(guard.canActivate(exec(ctxOf(false), cls))).toBe(true); // company staff: no reason needed
    }
    expect(guard.canActivate(exec(ctxOf(true), ShiftsController))).toBe(true);
    // The incident lane itself is not gated (redacted for support); its detail asks in the controller (M1).
    expect(guard.canActivate(exec(ctxOf(true), IncidentsController))).toBe(true);
  });

  it('each support call is an ACCESS entry with the reason in the data owner log', async () => {
    const recordSystem = jest.fn(async () => undefined);
    const guard = new TransportFeatureGuard({ recordSystem } as never);
    await expect(guard.canActivate(exec(ctxOf(true), BookingsController, 'Ticket 42: wrong pickup'))).resolves.toBe(true);
    expect(recordSystem).toHaveBeenCalledWith(
      { companyId: CUST, userId: 'u1', ip: '10.0.0.1' },
      { action: 'ACCESS', entity: TRANSPORT_RECORDS_ENTITY, details: { what: 'transport-records', route: 'GET /api/transport/bookings', superAdmin: true, reason: 'Ticket 42: wrong pickup' } },
    );
    // Company staff: nothing extra is written by the guard.
    recordSystem.mockClear();
    expect(guard.canActivate(exec(ctxOf(false), BookingsController))).toBe(true);
    expect(recordSystem).not.toHaveBeenCalled();
  });
});

describe('Security review L8: REASON_REQUIRED names the data owner (the web remembers a reason per company)', () => {
  const bodyOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as BadRequestException).getResponse();
    }
    return null;
  };
  it('owner given, else the selected customer, else the acting company', () => {
    expect(bodyOf(() => requireSupportReason({ isSuperAdmin: true, companyId: CUST }, undefined, 'owner-co'))).toMatchObject({ code: 'REASON_REQUIRED', scopeCompanyId: 'owner-co' });
    expect(bodyOf(() => requireSupportReason({ isSuperAdmin: true, companyId: CUST, transportCustomerId: 'cust-b' }, undefined))).toMatchObject({ scopeCompanyId: 'cust-b' });
    expect(bodyOf(() => requireSupportReason({ isSuperAdmin: true, companyId: CUST }, undefined))).toMatchObject({ scopeCompanyId: CUST });
    expect(bodyOf(() => new TransportFeatureGuard().canActivate(exec(ctxOf(true), BookingsController)))).toMatchObject({ scopeCompanyId: CUST });
  });
});
