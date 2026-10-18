import { normalizeRfidTag } from '@veetracer/shared';
import { aggregateDriverActivity } from './report-queries';

const T = (h: number) => new Date(Date.UTC(2026, 9, 18, h));
const range = { gte: T(0), lt: T(24) };
const name = (id: string) => ({ v1: 'Truck 01', v2: 'Van 02' })[id] ?? id;
const trip = (objectId: string, h: number, km: number, maxSpeedKph = 60) => ({ objectId, startTime: T(h), distanceKm: km, durationSec: 3600, idleSec: 600, maxSpeedKph });

describe('aggregateDriverActivity', () => {
  it('credits trips and overspeeds to the driver whose session covered them', () => {
    const rows = aggregateDriverActivity(
      [
        { driverId: 'd1', driverName: 'Arun', employeeId: 'E1', objectId: 'v1', fromTime: T(6), toTime: T(10) },
        { driverId: 'd2', driverName: 'Bala', employeeId: null, objectId: 'v1', fromTime: T(10), toTime: T(14) },
        { driverId: 'd1', driverName: 'Arun', employeeId: 'E1', objectId: 'v2', fromTime: T(15), toTime: T(18) },
      ],
      [trip('v1', 7, 20, 72), trip('v1', 11, 30), trip('v2', 16, 12.34), trip('v1', 20, 99)],
      [{ objectId: 'v1', occurredAt: T(8) }, { objectId: 'v1', occurredAt: T(12) }],
      range,
      name,
      T(23),
    );
    expect(rows).toEqual([
      expect.objectContaining({ driverName: 'Arun', vehicles: 'Truck 01, Van 02', sessions: 2, tripCount: 2, distanceKm: 32.3, drivingSec: 6000, maxSpeedKph: 72, overspeedCount: 1, firstStart: T(6).toISOString(), lastEnd: T(18).toISOString() }),
      expect.objectContaining({ driverName: 'Bala', sessions: 1, tripCount: 1, distanceKm: 30, overspeedCount: 1 }),
    ]);
  });

  it('clips sessions to the range and marks an open session as driving now', () => {
    const rows = aggregateDriverActivity(
      [{ driverId: 'd1', driverName: 'Arun', employeeId: null, objectId: 'v1', fromTime: new Date(Date.UTC(2026, 9, 17, 20)), toTime: null }],
      [trip('v1', 1, 5)],
      [],
      range,
      name,
      T(12),
    );
    expect(rows[0]).toMatchObject({ sessions: 1, tripCount: 1, firstStart: T(0).toISOString(), lastEnd: null });
  });

  it('ignores sessions outside the range', () => {
    expect(aggregateDriverActivity([{ driverId: 'd1', driverName: 'A', employeeId: null, objectId: 'v1', fromTime: T(-5), toTime: T(-1) }], [], [], range, name, T(12))).toEqual([]);
  });
});

describe('normalizeRfidTag', () => {
  it('keeps hex digits, upper-cases and drops separators and leading zeros', () => {
    expect(normalizeRfidTag('00:1a-2B 3c')).toBe('1A2B3C');
    expect(normalizeRfidTag('0000')).toBe('0');
  });
});
