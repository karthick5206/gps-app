import type { LiveObject } from '@veetracer/shared';
import { objectReadScopeWhere, objectScopeWhere, shareOf } from '../access/access-rules';
import { asSharedLive } from '../live/shared-live';

const share = { objectId: 'x', ownerCompanyId: 'owner', startAt: 1000, alertsOn: false };
const ctx = { companyId: 'c', dataScope: 'COMPANY' as const, branchIds: [], objectIds: [], shares: [share] };

describe('vehicle sharing scope', () => {
  it('the scope used for changes never includes a shared vehicle', () => {
    expect(objectScopeWhere(ctx)).toEqual({ companyId: 'c' });
  });

  it('the read scope adds the shared vehicles', () => {
    expect(objectReadScopeWhere(ctx)).toEqual({ OR: [{ companyId: 'c' }, { id: { in: ['x'] } }] });
  });

  it('without shares the read scope is the normal one', () => {
    expect(objectReadScopeWhere({ ...ctx, shares: [] })).toEqual({ companyId: 'c' });
    expect(objectReadScopeWhere({ ...ctx, shares: undefined })).toEqual({ companyId: 'c' });
  });

  it('finds the share behind a vehicle', () => {
    expect(shareOf(ctx, 'x')).toBe(share);
    expect(shareOf(ctx, 'y')).toBeUndefined();
    expect(shareOf({}, 'x')).toBeUndefined();
  });

  it('the other company gets no tracker identity or owner branch', () => {
    const live = { objectId: 'x', name: 'Truck', uniqueId: '8612345', simNumber: '9876', branchId: 'b', lat: 13 } as unknown as LiveObject;
    expect(asSharedLive(live)).toEqual({ objectId: 'x', name: 'Truck', uniqueId: null, simNumber: null, branchId: null, lat: 13, shared: true });
  });
});
