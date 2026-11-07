import { aggregateIoDays, IoSessionLite } from './io-aggregate';

const TZ = 'Asia/Kolkata';
const ist = (s: string) => Date.parse(`${s}+05:30`);
const s = (p: Partial<IoSessionLite>): IoSessionLite => ({ objectId: 'o1', kind: 'AC', on: true, startTime: 0, endTime: 0, distanceKm: 0, engineOffSec: 0, ...p });

describe('aggregateIoDays (AC / Door daily totals)', () => {
  it('sums AC on time, engine-off time, switch-ons, distance and door openings per day', () => {
    const rows = aggregateIoDays(
      [
        s({ startTime: ist('2026-10-20T09:00:00'), endTime: ist('2026-10-20T10:00:00'), distanceKm: 30, engineOffSec: 600 }),
        s({ on: false, startTime: ist('2026-10-20T10:00:00'), endTime: ist('2026-10-20T12:00:00'), distanceKm: 50 }),
        s({ startTime: ist('2026-10-20T12:00:00'), endTime: ist('2026-10-20T12:30:00'), distanceKm: 10 }),
        s({ kind: 'DOOR', startTime: ist('2026-10-20T08:00:00'), endTime: ist('2026-10-20T08:02:00') }),
        s({ kind: 'DOOR', startTime: ist('2026-10-20T13:00:00'), endTime: ist('2026-10-20T13:01:00') }),
      ],
      '2026-10-20',
      '2026-10-20',
      TZ,
      ist('2026-10-21T00:00:00'),
    );
    expect(rows).toEqual([
      { objectId: 'o1', day: '2026-10-20', acOnSec: 5400, acOnEngineOffSec: 600, acOnCount: 2, acDistanceKm: 40, doorOpenCount: 2, doorOpenSec: 180 },
    ]);
  });

  it('splits a session at local midnight and shares distance / engine-off time by duration', () => {
    const rows = aggregateIoDays(
      [s({ startTime: ist('2026-10-20T23:00:00'), endTime: ist('2026-10-21T01:00:00'), distanceKm: 20, engineOffSec: 3600 })],
      '2026-10-20',
      '2026-10-21',
      TZ,
      ist('2026-10-22T00:00:00'),
    );
    expect(rows).toEqual([
      expect.objectContaining({ day: '2026-10-20', acOnSec: 3600, acOnEngineOffSec: 1800, acOnCount: 1, acDistanceKm: 10 }),
      expect.objectContaining({ day: '2026-10-21', acOnSec: 3600, acOnEngineOffSec: 1800, acOnCount: 0, acDistanceKm: 10 }),
    ]);
  });

  it('clips to the range and counts open sessions up to now', () => {
    const rows = aggregateIoDays(
      [
        s({ startTime: ist('2026-10-19T22:00:00'), endTime: ist('2026-10-20T01:00:00') }),
        s({ startTime: ist('2026-10-20T10:00:00'), endTime: null }),
      ],
      '2026-10-20',
      '2026-10-20',
      TZ,
      ist('2026-10-20T10:30:00'),
    );
    expect(rows).toEqual([expect.objectContaining({ day: '2026-10-20', acOnSec: 3600 + 1800, acOnCount: 1 })]);
  });
});

describe('ioSessionsReport (AC / Door sessions)', () => {
  it('lists periods sorted by vehicle with open-session duration and totals', async () => {
    const { ioSessionsReport } = await import('./io-report');
    const row = (p: Record<string, unknown>) => ({ id: 'x', companyId: 'c1', objectId: 'o1', kind: 'AC', on: true, startTime: new Date(ist('2026-10-20T09:00:00')), endTime: null, startLat: 13, startLng: 80, endLat: null, endLng: null, distanceKm: 1.234, durationSec: 0, engineOffSec: 0, ...p });
    const prisma = {
      ioSession: {
        findMany: jest.fn().mockResolvedValue([
          row({ id: 'a', endTime: new Date(ist('2026-10-20T10:00:00')), durationSec: 3600, engineOffSec: 300 }),
          row({ id: 'b', kind: 'DOOR', startTime: new Date(ist('2026-10-20T09:30:00')), endTime: new Date(ist('2026-10-20T09:31:00')), durationSec: 60 }),
          row({ id: 'c', on: false, startTime: new Date(ist('2026-10-20T10:00:00')) }),
          row({ id: 'd', objectId: 'o0', startTime: new Date(ist('2026-10-20T11:00:00')) }),
        ]),
      },
    };
    const objects = new Map([
      ['o1', { name: 'Bus B', plateNumber: 'TN-2' }],
      ['o0', { name: 'Bus A', plateNumber: null }],
    ]) as never;
    const range = { gte: new Date(ist('2026-10-20T00:00:00')), lt: new Date(ist('2026-10-21T00:00:00')) };
    const r = await ioSessionsReport(prisma as never, 'c1', objects, range, 100, ist('2026-10-20T11:30:00'));
    expect(r.rows.map((x) => x.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(r.rows[0]).toMatchObject({ objectName: 'Bus A', endTime: null, durationSec: 1800, distanceKm: 1.23 });
    expect(r.totals).toEqual({ count: 4, acOnSec: 3600 + 1800, acOnEngineOffSec: 300, doorOpenCount: 1, doorOpenSec: 60 });
  });
});
