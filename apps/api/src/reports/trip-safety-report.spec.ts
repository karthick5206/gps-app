import type { TripDto } from '@veetracer/shared';
import { tripSafetyRows, tripSafetyScore, tripSafetyTypes } from './trip-safety-report';

const trip = (id: string, objectId: string, start: string, end: string): TripDto => ({
  id,
  objectId,
  objectName: objectId.toUpperCase(),
  startTime: start,
  endTime: end,
  durationSec: 600,
  idleSec: 0,
  startLat: 13,
  startLng: 80,
  endLat: 13.1,
  endLng: 80.1,
  startAddress: null,
  endAddress: null,
  distanceKm: 5,
  maxSpeedKph: 60,
  avgSpeedKph: 30,
});
const alert = (id: string, objectId: string, type: string, at: string, speedKph?: number) => ({
  id,
  objectId,
  type,
  occurredAt: new Date(at),
  lat: 13.05,
  lng: 80.05,
  address: id === 'a1' ? 'OMR, Chennai' : null,
  data: speedKph === undefined ? {} : { speedKph },
});

describe('trip safety report', () => {
  const trips = [trip('t1', 'v1', '2026-11-24T04:00:00Z', '2026-11-24T04:30:00Z'), trip('t2', 'v1', '2026-11-24T06:00:00Z', '2026-11-24T06:20:00Z'), trip('t3', 'v2', '2026-11-24T04:00:00Z', '2026-11-24T05:00:00Z')];
  const alerts = [
    alert('a1', 'v1', 'SEATBELT_OFF', '2026-11-24T04:05:00Z', 22.4),
    alert('a2', 'v1', 'DRIVER_PHONE', '2026-11-24T04:10:00Z'),
    alert('a3', 'v1', 'SEATBELT_OFF', '2026-11-24T04:29:59Z'),
    alert('a4', 'v1', 'SEATBELT_OFF', '2026-11-24T05:00:00Z'), // between trips: not counted
    alert('a5', 'v1', 'GEOFENCE_ENTER', '2026-11-24T04:06:00Z'), // not a violation type
    alert('a6', 'v2', 'HARSH_BRAKING', '2026-11-24T04:45:00Z'),
  ];

  it('counts each violation in the trip it happened in, with score, driver and clip links', () => {
    const rows = tripSafetyRows(
      trips,
      alerts,
      [{ id: 'e1', alertId: 'a1', hasClip: true }],
      [{ objectId: 'v1', driverName: 'Kumar', fromTime: new Date('2026-11-24T00:00:00Z'), toTime: null }],
    );
    const [t1, t2, t3] = rows;
    expect(t1.counts).toEqual({ SEATBELT_OFF: 2, DRIVER_PHONE: 1 });
    expect(t1.total).toBe(3);
    expect(t1.score).toBe(100 - 2 * 5 - 8);
    expect(t1.driverName).toBe('Kumar');
    expect(t1.occurrences[0]).toMatchObject({ alertId: 'a1', type: 'SEATBELT_OFF', address: 'OMR, Chennai', speedKph: 22, driverEventId: 'e1', hasClip: true });
    expect(t1.occurrences[1]).toMatchObject({ alertId: 'a2', driverEventId: null, hasClip: false, speedKph: null });
    expect(t2.total).toBe(0);
    expect(t2.score).toBe(100);
    expect(t3).toMatchObject({ counts: { HARSH_BRAKING: 1 }, total: 1, driverName: null });
  });

  it('only counts the chosen violation types', () => {
    const rows = tripSafetyRows(trips, alerts, [], [], tripSafetyTypes(['DRIVER_PHONE', 'GEOFENCE_ENTER']));
    expect(rows[0].counts).toEqual({ DRIVER_PHONE: 1 });
    expect(tripSafetyTypes([])).toContain('SEATBELT_OFF');
  });

  it('never scores below 0', () => {
    expect(tripSafetyScore({ CRASH: 9 })).toBe(0);
  });
});
