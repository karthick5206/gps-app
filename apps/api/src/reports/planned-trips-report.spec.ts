import { ForbiddenException } from '@nestjs/common';
import { PlannedTripReportRow, ReportRequest, TripPerformanceReportRow } from '@veetracer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ReportDataService } from './report-data.service';
import { renderReport } from './report-files';

type Ctx = Parameters<ReportDataService['generate']>[0];
const ctx = (permissions: Record<string, string[]>, extra: Partial<Ctx> = {}) =>
  ({ companyId: 'c1', dataScope: 'COMPANY', branchIds: [], objectIds: [], permissions, ...extra }) as unknown as Ctx;
const allowed = ctx({ reports: ['view'], plannedTrips: ['view'] });
const req = (type: ReportRequest['type'], options?: ReportRequest['options']): ReportRequest => ({ type, scope: { branchIds: [], groupIds: [], objectIds: [] }, from: '2026-11-05', to: '2026-11-05', ...(options ? { options } : {}) });

const stop = (seq: number, status: string, delaySec: number | null) => ({ seq, lat: 13 + seq * 0.01, lng: 80, status, delaySec });
const t0 = new Date('2026-11-05T03:30:00.000Z');
const trip = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  routeId: 'r1',
  routeName: 'Old name',
  objectId: 'v1',
  driverId: 'd1',
  status: 'COMPLETED',
  closedBy: 'AUTO',
  plannedStart: t0,
  plannedEnd: new Date(t0.getTime() + 3_600_000),
  actualStart: new Date(t0.getTime() + 120_000),
  actualEnd: new Date(t0.getTime() + 3_900_000),
  path: null,
  distanceKm: 2.5,
  deviationCount: 1,
  delaySec: 60,
  stops: [stop(0, 'DEPARTED', 120), stop(1, 'ARRIVED', 400)],
  ...over,
});

function setup(trips: ReturnType<typeof trip>[]) {
  const prisma = {
    company: { findUniqueOrThrow: jest.fn(async () => ({ name: 'Acme', timezone: 'Asia/Kolkata' })) },
    trackedObject: {
      findMany: jest.fn(async () => [{ id: 'v1', name: 'Bus 01', plateNumber: 'TN01', branchId: null, branch: null, groups: [], type: 'VEHICLE', vehicleType: null, speedLimitKph: null }]),
    },
    plannedTrip: { findMany: jest.fn(async () => trips) },
    route: { findMany: jest.fn(async () => [{ id: 'r1', name: 'Morning run' }]) },
    driver: { findMany: jest.fn(async () => [{ id: 'd1', name: 'Ravi' }]) },
  };
  const service = new ReportDataService(prisma as unknown as PrismaService, { enrichReport: async () => undefined } as never);
  return { prisma, service };
}

describe('planned-trip reports in ReportDataService', () => {
  it('need the planned trips view permission besides reports', async () => {
    const { service, prisma } = setup([trip('t1')]);
    await expect(service.generate(ctx({ reports: ['view'] }), req('TRIP_PERFORMANCE'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.generate(ctx({ reports: ['view'] }), req('PLANNED_TRIPS'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.plannedTrip.findMany).not.toHaveBeenCalled();
    await expect(service.generate(ctx({}, { isSuperAdmin: true } as Partial<Ctx>), req('PLANNED_TRIPS'))).resolves.toBeTruthy();
  });

  it('reads only trips of vehicles in scope, by planned start in the company day', async () => {
    const { service, prisma } = setup([trip('t1')]);
    await service.generate(allowed, req('PLANNED_TRIPS'));
    const where = (prisma.plannedTrip.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toEqual({
      companyId: 'c1',
      objectId: { in: ['v1'] },
      plannedStart: { gte: new Date('2026-11-04T18:30:00.000Z'), lt: new Date('2026-11-05T18:30:00.000Z') },
    });
  });

  it('reads no trips when no vehicle is in scope', async () => {
    const { service, prisma } = setup([trip('t1')]);
    prisma.trackedObject.findMany.mockResolvedValueOnce([]);
    const data = await service.generate(allowed, req('TRIP_PERFORMANCE'));
    expect(prisma.plannedTrip.findMany).not.toHaveBeenCalled();
    expect(data).toMatchObject({ rows: [], totalRows: 0, groupBy: 'ROUTE', totals: { groups: 0, trips: 0 } });
  });

  it('TRIP_PERFORMANCE defaults to per route with the current route name; renders XLSX and PDF', async () => {
    const { service } = setup([trip('t1'), trip('t2', { status: 'CANCELLED', actualStart: null, stops: [stop(0, 'PENDING', null)] })]);
    const data = await service.generate(allowed, req('TRIP_PERFORMANCE'));
    expect(data.groupBy).toBe('ROUTE');
    expect(data.rows as TripPerformanceReportRow[]).toEqual([
      expect.objectContaining({ groupName: 'Morning run', trips: 2, completed: 1, cancelled: 1, ratedStops: 2, onTimeStops: 1, onTimePct: 50, avgStartDelayMin: 2, plannedKm: 1.1, actualKm: 2.5, deviations: 2 }),
    ]);
    expect((await renderReport([data], 'XLSX')).buffer.subarray(0, 2).toString()).toBe('PK');
    expect((await renderReport([data], 'PDF')).buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('TRIP_PERFORMANCE per driver names drivers', async () => {
    const { service } = setup([trip('t1'), trip('t2', { driverId: null })]);
    const data = await service.generate(allowed, req('TRIP_PERFORMANCE', { groupBy: 'DRIVER' }));
    expect((data.rows as TripPerformanceReportRow[]).map((r) => [r.groupName, r.trips])).toEqual([
      ['Ravi', 1],
      ['No driver', 1],
    ]);
  });

  it('PLANNED_TRIPS pages through long ranges and caps the rows, totals over all', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => trip(`a${i}`));
    const page2 = [trip('b1', { status: 'INCOMPLETE' })];
    const { service, prisma } = setup([]);
    prisma.plannedTrip.findMany.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const data = await service.generate(allowed, req('PLANNED_TRIPS'), 10);
    expect(prisma.plannedTrip.findMany).toHaveBeenCalledTimes(2);
    expect((prisma.plannedTrip.findMany.mock.calls[1] as unknown as [{ cursor: { id: string }; skip: number }])[0]).toMatchObject({ cursor: { id: 'a499' }, skip: 1 });
    expect(data).toMatchObject({ totalRows: 501, truncated: true, totals: { count: 501, completed: 500, incomplete: 1 } });
    expect(data.rows).toHaveLength(10);
    expect((data.rows as PlannedTripReportRow[])[0]).toMatchObject({ objectName: 'Bus 01', driverName: 'Ravi', routeName: 'Old name', startDelayMin: 2, delayMin: 1, stopsDone: 2, stopCount: 2 });
  });
});
