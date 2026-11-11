import { Prisma } from '@prisma/client';
import { PlannedTripJobService } from './planned-trip-job.service';

const NOW = Date.parse('2026-11-10T00:00:00.000Z'); // Tuesday 05:30 IST
const route = {
  id: 'r1',
  companyId: 'c1',
  name: 'Run',
  corridorM: 200,
  path: null,
  isActive: true,
  stops: [
    { seq: 0, name: 'A', lat: 13, lng: 80, radiusM: 100, offsetMin: 0, waitMin: 0 },
    { seq: 1, name: 'B', lat: 13.1, lng: 80.1, radiusM: 100, offsetMin: 30, waitMin: 0 },
  ],
};
const schedule = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  companyId: 'c1',
  routeId: 'r1',
  route,
  days: [0, 1, 2, 3, 4, 5, 6],
  startMin: 450, // 07:30 IST = 02:00 UTC
  objectId: 'o1',
  driverId: 'd1',
  validFrom: null,
  validTo: null,
  isActive: true,
  ...over,
});

function setup(opts: { schedules?: unknown[]; existing?: { scheduleId: string; plannedStart: Date }[]; insertError?: unknown; companyStatus?: string } = {}) {
  const prisma = {
    routeSchedule: { findMany: jest.fn().mockResolvedValue(opts.schedules ?? [schedule()]) },
    company: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', timezone: 'Asia/Kolkata', status: opts.companyStatus ?? 'ACTIVE' }]) },
    trackedObject: { findMany: jest.fn().mockResolvedValue([{ id: 'o1', companyId: 'c1', branchId: 'b1', isActive: true }]) },
    plannedTrip: { findMany: jest.fn().mockResolvedValue(opts.existing ?? []) },
  };
  const trips = {
    insertTrip: opts.insertError ? jest.fn().mockRejectedValue(opts.insertError) : jest.fn().mockResolvedValue({ id: 't1' }),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const job = new PlannedTripJobService(prisma as never, {} as never, trips as never);
  return { job, prisma, trips };
}

describe('PlannedTripJobService.generate', () => {
  it('creates the trip of the next 24 h with the schedule defaults and invalidates the company', async () => {
    const { job, trips } = setup();
    expect(await job.generate(NOW)).toBe(1);
    expect(trips.insertTrip).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'c1', routeId: 'r1', objectId: 'o1', branchId: 'b1', driverId: 'd1', scheduleId: 's1', plannedStartMs: Date.parse('2026-11-10T02:00:00.000Z'), createdById: null }),
    );
    expect(trips.invalidate).toHaveBeenCalledWith('c1');
  });

  it('is idempotent: an existing trip for the slot means nothing is created', async () => {
    const { job, trips } = setup({ existing: [{ scheduleId: 's1', plannedStart: new Date('2026-11-10T02:00:00.000Z') }] });
    expect(await job.generate(NOW)).toBe(0);
    expect(trips.insertTrip).not.toHaveBeenCalled();
    expect(trips.invalidate).not.toHaveBeenCalled();
  });

  it('treats a unique violation (created elsewhere) as done', async () => {
    const dup = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
    const { job } = setup({ insertError: dup });
    expect(await job.generate(NOW)).toBe(0);
  });

  it('skips suspended companies and routes with fewer than 2 stops', async () => {
    expect(await setup({ companyStatus: 'SUSPENDED' }).job.generate(NOW)).toBe(0);
    expect(await setup({ schedules: [schedule({ route: { ...route, stops: route.stops.slice(0, 1) } })] }).job.generate(NOW)).toBe(0);
  });

  it('asks only for active schedules with a vehicle on active routes', async () => {
    const { job, prisma } = setup({ schedules: [] });
    await job.generate(NOW, ['s1']);
    expect(prisma.routeSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, objectId: { not: null }, route: { isActive: true }, id: { in: ['s1'] } } }),
    );
  });
});

describe('PlannedTripJobService sweeps', () => {
  it('times out open trips and skips their pending stops', async () => {
    const tx = {
      plannedTrip: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      plannedTripStop: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      plannedTrip: { findMany: jest.fn().mockResolvedValue([{ id: 't1', companyId: 'c1', status: 'IN_PROGRESS' }]) },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const trips = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const job = new PlannedTripJobService(prisma as never, {} as never, trips as never);
    expect(await job.sweepIncomplete(NOW)).toBe(1);
    expect(tx.plannedTrip.updateMany).toHaveBeenCalledWith({ where: { id: 't1', status: 'IN_PROGRESS' }, data: { status: 'INCOMPLETE', closedBy: 'TIMEOUT', nextStopSeq: null } });
    expect(tx.plannedTripStop.updateMany).toHaveBeenCalledWith({ where: { tripId: 't1', status: 'PENDING' }, data: { status: 'SKIPPED' } });
    expect(trips.invalidate).toHaveBeenCalledWith('c1');
  });

  it('fires the not-started hook once per trip', async () => {
    const trip = { id: 't1', routeName: 'Run', plannedStart: new Date(NOW - 40 * 60_000), plannedEnd: new Date(NOW + 60 * 60_000) };
    const prisma = { plannedTrip: { findMany: jest.fn().mockResolvedValue([trip]) } };
    const set = jest.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const job = new PlannedTripJobService(prisma as never, { client: { set } } as never, {} as never);
    const hook = jest.spyOn(job as unknown as { onTripNotStarted: (t: unknown) => Promise<void> }, 'onTripNotStarted');
    expect(await job.sweepNotStarted(NOW)).toBe(1);
    expect(await job.sweepNotStarted(NOW)).toBe(0);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe('vt:plannedtrips:notstarted:t1');
  });
});
