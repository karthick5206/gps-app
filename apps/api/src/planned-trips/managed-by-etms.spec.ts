// drivers.service (imported by PlannedTripsService) pulls @nestjs/mapped-types, an ESM-only package jest cannot load.
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { ConflictException } from '@nestjs/common';
import { PlannedTripsService } from './planned-trips.service';
import { driverLockKey, lockTripResources, vehicleLockKey } from './trip-locks';

/** WP 3.1 (docs/employee-transport/15 §7.1, 05 §2.6): ETMS trips are not editable through /api/planned-trips. */

const ctx = { companyId: 'c1', userId: 'u1', dataScope: 'COMPANY', branchIds: [], objectIds: [] } as never;

function service(origin: 'ROUTE' | 'ETMS') {
  const row = { id: 't1', companyId: 'c1', origin, status: 'SCHEDULED', objectId: 'v1', driverId: null, routeId: origin === 'ETMS' ? null : 'r1', plannedStart: new Date(), plannedEnd: new Date(), path: null, stops: [], events: [] };
  const executed: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(String(values[0]));
      return 1;
    }),
    plannedTrip: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })) },
  };
  const prisma = {
    plannedTrip: { findFirst: jest.fn(async () => row) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const s = new PlannedTripsService(prisma as never, { record: jest.fn() } as never, { invalidate: jest.fn() } as never);
  return { s, tx, executed };
}

describe('PlannedTripsService and ETMS trips (WP 3.1)', () => {
  it('refuses edit and cancel of an origin ETMS trip with 409 MANAGED_BY_ETMS', async () => {
    const { s } = service('ETMS');
    for (const call of [() => s.update(ctx, 't1', { notes: 'x' }), () => s.cancel(ctx, 't1', { reason: 'x' })]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'MANAGED_BY_ETMS' });
    }
  });

  it('a ROUTE trip is inserted with origin ROUTE under the vehicle / driver advisory locks', async () => {
    const { s, tx, executed } = service('ROUTE');
    await s.insertTrip({
      companyId: 'c1',
      routeId: 'r1',
      route: { name: 'R', corridorM: 200, path: null, stops: [{ seq: 0, name: 'A', lat: 13, lng: 80, radiusM: 100, offsetMin: 0, waitMin: 0 }, { seq: 1, name: 'B', lat: 13.1, lng: 80, radiusM: 100, offsetMin: 30, waitMin: 0 }] },
      objectId: 'v1',
      branchId: null,
      driverId: 'd1',
      scheduleId: null,
      plannedStartMs: Date.parse('2026-11-12T03:30:00Z'),
      createdById: null,
    });
    expect(tx.plannedTrip.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ origin: 'ROUTE', routeId: 'r1' }) }));
    expect(executed).toEqual([vehicleLockKey('v1'), driverLockKey('d1')]);
  });

  it('locks are taken in a fixed order (vehicles sorted, then drivers sorted), duplicates and nulls dropped', async () => {
    const keys: string[] = [];
    const tx = { $executeRaw: async (_s: TemplateStringsArray, k: string) => keys.push(k) };
    await lockTripResources(tx as never, { objectIds: ['v2', null, 'v1', 'v2'], driverIds: [undefined, 'd9', 'd1'] });
    expect(keys).toEqual([vehicleLockKey('v1'), vehicleLockKey('v2'), driverLockKey('d1'), driverLockKey('d9')]);
  });
});
