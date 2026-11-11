// drivers.service (imported by PlannedTripsService) pulls @nestjs/mapped-types, an ESM-only package jest cannot load.
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { ConflictException } from '@nestjs/common';
import { PlannedTripsService } from './planned-trips.service';
import { driverLockKey, lockTripResources, vehicleLockKey } from './trip-locks';

/** WP 3.1 (docs/employee-transport/15 §7.1, 05 §2.6): ETMS trips are not editable through /api/planned-trips. */

const ctx = { companyId: 'c1', userId: 'u1', dataScope: 'COMPANY', branchIds: [], objectIds: [] } as never;

function service(origin: 'ROUTE' | 'ETMS', etmsBusy: { objectId?: string; driverId?: string } | null = null) {
  const row = { id: 't1', companyId: 'c1', origin, status: 'SCHEDULED', objectId: 'v1', driverId: null, routeId: origin === 'ETMS' ? null : 'r1', plannedStart: new Date(), plannedEnd: new Date(), path: null, stops: [], events: [] };
  const executed: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(String(values[0]));
      return 1;
    }),
    plannedTrip: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      // E3 security review M3: the ETMS overlap query (an active ETMS run on this vehicle / driver, or none).
      findFirst: jest.fn(async ({ where }: { where: { origin?: string; objectId?: string; driverId?: string } }) =>
        where.origin === 'ETMS' && etmsBusy && ((where.objectId && where.objectId === etmsBusy.objectId) || (where.driverId && where.driverId === etmsBusy.driverId)) ? { id: 'etms-run' } : null,
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => row),
    },
    plannedTripStop: { update: jest.fn() },
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

  it('M3: a ROUTE trip (create / generator / edit) is refused 409 VEHICLE_BUSY / DRIVER_BUSY over an active ETMS run, under the same locks', async () => {
    const input = {
      companyId: 'c1',
      routeId: 'r1',
      route: { name: 'R', corridorM: 200, path: null, stops: [{ seq: 0, name: 'A', lat: 13, lng: 80, radiusM: 100, offsetMin: 0, waitMin: 0 }, { seq: 1, name: 'B', lat: 13.1, lng: 80, radiusM: 100, offsetMin: 30, waitMin: 0 }] },
      objectId: 'v1',
      branchId: null,
      driverId: 'd1',
      scheduleId: null,
      plannedStartMs: Date.parse('2026-11-12T03:30:00Z'),
      createdById: null,
    };
    const code = (e: unknown) => ((e as ConflictException).getResponse() as { code?: string }).code;
    const vehicle = service('ROUTE', { objectId: 'v1' });
    expect(code(await vehicle.s.insertTrip(input).catch((e: unknown) => e))).toBe('VEHICLE_BUSY');
    expect(vehicle.tx.plannedTrip.create).not.toHaveBeenCalled();
    expect(vehicle.executed).toEqual([vehicleLockKey('v1'), driverLockKey('d1')]); // locks first, then the check
    const driver = service('ROUTE', { driverId: 'd1' });
    expect(code(await driver.s.insertTrip(input).catch((e: unknown) => e))).toBe('DRIVER_BUSY');
    // Edit: re-assigning a scheduled ROUTE trip's driver onto an ETMS run's driver is refused the same way.
    const edit = service('ROUTE', { driverId: 'd1' });
    (edit.s as unknown as { checkDriver: () => Promise<string> }).checkDriver = async () => 'd1';
    expect(code(await edit.s.update(ctx, 't1', { driverId: 'd1' }).catch((e: unknown) => e))).toBe('DRIVER_BUSY');
    expect(edit.tx.plannedTrip.updateMany).not.toHaveBeenCalled();
    // No ETMS run: the v1.8 behaviour is unchanged.
    const free = service('ROUTE');
    await free.s.insertTrip(input);
    expect(free.tx.plannedTrip.create).toHaveBeenCalled();
  });

  it('H1: an ETMS trip read through /api/planned-trips has no path, no stop or event coordinates and no personal label', async () => {
    const etms = {
      id: 't9', companyId: 'c1', origin: 'ETMS', status: 'SCHEDULED', objectId: 'v1', driverId: null, routeId: null, scheduleId: null, routeName: 'Transport', corridorM: 200, branchId: null,
      plannedStart: new Date(), plannedEnd: new Date(), actualStart: null, actualEnd: null, closedBy: null, cancelReason: null, notes: null, distanceKm: null, deviationCount: 0, maxDeviationM: null, nextStopSeq: 0, etaNextStop: null, delaySec: null, createdAt: new Date(), updatedAt: new Date(),
      path: [[80.241234, 13.061234], [80.25, 13.05]],
      stops: [
        { id: 's0', seq: 0, name: '5 Secret Lane', lat: 13.061234, lng: 80.241234, radiusM: 100, profileId: 'p1', poiId: null, plannedArrival: new Date(), plannedDeparture: new Date(), actualArrival: null, actualDeparture: null, status: 'PENDING', delaySec: null },
        { id: 's1', seq: 1, name: 'Office', lat: 13.05, lng: 80.25, radiusM: 100, profileId: null, poiId: 'poi1', plannedArrival: new Date(), plannedDeparture: new Date(), actualArrival: null, actualDeparture: null, status: 'PENDING', delaySec: null },
      ],
      events: [{ id: 'e1', kind: 'DEVIATION', startAt: new Date(), endAt: null, lat: 13.061, lng: 80.241, data: null }],
    };
    const prisma = { plannedTrip: { findFirst: async () => etms }, trackedObject: { findMany: async () => [] }, driver: { findMany: async () => [] } };
    const s = new PlannedTripsService(prisma as never, { record: jest.fn() } as never, { invalidate: jest.fn() } as never);
    const dto = await s.get(ctx, 't9');
    expect(dto.path).toBeNull();
    expect(dto.stops.map((x) => [x.name, x.lat, x.lng])).toEqual([['Stop 1', null, null], ['Office', null, null]]);
    expect(dto.events[0]).toMatchObject({ lat: null, lng: null });
    const text = JSON.stringify(dto);
    for (const leak of ['13.0612', '80.2412', 'Secret Lane', '13.061']) expect(text).not.toContain(leak);
  });

  it('locks are taken in a fixed order (vehicles sorted, then drivers sorted), duplicates and nulls dropped', async () => {
    const keys: string[] = [];
    const tx = { $executeRaw: async (_s: TemplateStringsArray, k: string) => keys.push(k) };
    await lockTripResources(tx as never, { objectIds: ['v2', null, 'v1', 'v2'], driverIds: [undefined, 'd9', 'd1'] });
    expect(keys).toEqual([vehicleLockKey('v1'), vehicleLockKey('v2'), driverLockKey('d1'), driverLockKey('d9')]);
  });
});
