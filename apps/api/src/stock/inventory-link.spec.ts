import type { DeviceAssignmentFacts } from '@veetracer/shared';
import { locationCode, movementKind, wantedStock } from './inventory-link';

const places = { supplierReturn: 'loc-rts', scrap: 'loc-scrap' };
const free: DeviceAssignmentFacts = { companyId: null, hasOpenAssignment: false, shippedAt: null, claimedAt: null };
const assigned: DeviceAssignmentFacts = { ...free, companyId: 'co-1' };
const fitted: DeviceAssignmentFacts = { ...assigned, hasOpenAssignment: true };

describe('Purchases & sales → Stock & movements', () => {
  it('maps each Purchases & sales state to one register state', () => {
    expect(wantedStock({ status: 'IN_STOCK', locationId: 'loc-main', holderPartnerId: null }, free, places)).toMatchObject({ status: 'IN_STOCK', locationId: 'loc-main' });
    expect(wantedStock({ status: 'IN_STOCK', locationId: 'loc-res', holderPartnerId: 'p-1' }, free, places)).toMatchObject({ status: 'IN_STOCK', holderPartnerId: 'p-1' });
    expect(wantedStock({ status: 'DAMAGED', locationId: 'loc-dmg', holderPartnerId: null }, free, places)).toMatchObject({ status: 'FAULTY', locationId: 'loc-dmg' });
    expect(wantedStock({ status: 'WITH_SUPPLIER', locationId: null, holderPartnerId: null }, free, places)).toMatchObject({ status: 'RETURNED', locationId: 'loc-rts' });
    expect(wantedStock({ status: 'SCRAPPED', locationId: null, holderPartnerId: null }, free, places)).toMatchObject({ status: 'RETIRED', locationId: 'loc-scrap' });
  });

  it('a sold tracker mirrors the customer assignment, or leaves stock when the buyer has no account', () => {
    const sold = { status: 'SOLD' as const, locationId: null, holderPartnerId: null };
    expect(wantedStock(sold, assigned, places)).toMatchObject({ status: 'ASSIGNED', locationId: null });
    expect(wantedStock(sold, fitted, places)).toMatchObject({ status: 'ACTIVE' });
    expect(wantedStock(sold, free, places)).toMatchObject({ status: 'RETIRED', why: 'Sold to a customer outside VeeTrax' });
    expect(wantedStock({ ...sold, status: 'USED' }, fitted, places)).toMatchObject({ status: 'ACTIVE', why: 'Own use' });
  });

  it('an IMEI no longer in Purchases & sales is left alone by the mapping', () => {
    expect(wantedStock(null, free, places)).toBeNull();
  });

  it('picks the movement kind', () => {
    const inMain = { status: 'IN_STOCK' as const, locationId: 'loc-main', holderPartnerId: null, why: '' };
    expect(movementKind(null, inMain)).toBe('RECEIVE');
    expect(movementKind(null, { ...inMain, status: 'ASSIGNED', locationId: null })).toBe('ADJUST');
    expect(movementKind({ status: 'IN_STOCK', locationId: 'loc-main', holderPartnerId: null }, inMain)).toBeNull();
    // Sold to a reseller: same status, its store.
    expect(movementKind({ status: 'IN_STOCK', locationId: 'loc-main', holderPartnerId: null }, { ...inMain, locationId: 'loc-res', holderPartnerId: 'p-1' })).toBe('TRANSFER');
    // Sold to a customer company / fitted.
    expect(movementKind({ status: 'IN_STOCK', locationId: 'loc-main', holderPartnerId: null }, { ...inMain, status: 'ASSIGNED', locationId: null })).toBe('SYNC');
    // Customer return back into stock.
    expect(movementKind({ status: 'ASSIGNED', locationId: null, holderPartnerId: null }, inMain)).toBe('SYNC');
    expect(movementKind({ status: 'ASSIGNED', locationId: null, holderPartnerId: null }, { ...inMain, status: 'FAULTY' })).toBe('STATUS');
    // Allowed change vs correction.
    expect(movementKind({ status: 'FAULTY', locationId: 'loc-dmg', holderPartnerId: null }, { ...inMain, status: 'RETURNED', locationId: 'loc-rts' })).toBe('STATUS');
    expect(movementKind({ status: 'RETIRED', locationId: 'loc-scrap', holderPartnerId: null }, inMain)).toBe('ADJUST');
  });

  it('makes location codes', () => {
    expect(locationCode('Main store')).toBe('MAIN-STORE');
    expect(locationCode('Ravi Motors store (ab12)')).toBe('RAVI-MOTORS-STORE-AB');
    expect(locationCode('***')).toBe('STORE');
  });
});
