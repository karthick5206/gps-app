import { NO_DRIVER_GROUP_LABEL, NO_ROUTE_GROUP_LABEL, PerfStopInput, PerfTripInput, pathKm, plannedKmOf, plannedTripRow, plannedTripTotals, straightLegsKm, tripFacts, tripPerformance } from './trip-performance';
import { renderReport } from './report-files';
import { ReportData } from './report-data.service';

const T0 = Date.parse('2026-11-05T03:30:00.000Z'); // 09:00 IST
const at = (min: number) => new Date(T0 + min * 60_000);

/** Stops along a meridian: 0.01° of latitude ≈ 1.112 km. */
const stop = (seq: number, status: string, delaySec: number | null): PerfStopInput => ({ seq, lat: 13 + seq * 0.01, lng: 80, status, delaySec });

function trip(p: Partial<PerfTripInput> & { id: string }): PerfTripInput {
  return {
    routeId: 'r1',
    routeName: 'Route A',
    objectId: 'v1',
    driverId: 'd1',
    status: 'COMPLETED',
    closedBy: 'AUTO',
    plannedStart: at(0),
    plannedEnd: at(60),
    actualStart: null,
    actualEnd: null,
    path: null,
    distanceKm: null,
    deviationCount: 0,
    delaySec: null,
    stops: [],
    ...p,
  };
}

describe('planned km', () => {
  it('measures a [lng, lat] path and falls back to straight legs between the stops', () => {
    expect(pathKm([[80, 13], [80, 13.01], [80, 13.02]])).toBeCloseTo(2.224, 2);
    expect(pathKm([[80, 13]])).toBeNull();
    expect(pathKm(null)).toBeNull();
    expect(pathKm('junk')).toBeNull();
    const stops = [stop(2, 'PENDING', null), stop(0, 'PENDING', null), stop(1, 'PENDING', null)];
    expect(straightLegsKm(stops)).toBeCloseTo(2.224, 2); // sorted by seq, not by array order
    expect(plannedKmOf({ path: null, stops })).toBeCloseTo(2.224, 2);
    expect(plannedKmOf({ path: [[80, 13], [80.01, 13]], stops })).toBeCloseTo(1.083, 2);
  });
});

describe('tripFacts', () => {
  it('counts on-time stops within ±5 min, keeps skipped stops out of the denominator', () => {
    const f = tripFacts(
      trip({
        id: 't1',
        actualStart: at(4),
        stops: [stop(0, 'DEPARTED', 0), stop(1, 'DEPARTED', 300), stop(2, 'DEPARTED', -301), stop(3, 'SKIPPED', null), stop(4, 'ARRIVED', 600), stop(5, 'PENDING', null)],
      }),
    );
    expect(f).toMatchObject({ stopCount: 6, stopsDone: 4, skippedStops: 1, ratedStops: 4, onTimeStops: 2, stopDelaySumSec: 599, startDelaySec: 240 });
  });

  it('a skipped stop with a recorded delay still does not count as rated', () => {
    const f = tripFacts(trip({ id: 't', stops: [stop(0, 'SKIPPED', 10)] }));
    expect(f).toMatchObject({ skippedStops: 1, ratedStops: 0, onTimeStops: 0 });
  });
});

describe('tripPerformance', () => {
  const trips = [
    // Route A, driver d1, vehicle v1: started 4 min late, stops +0 / +6 min, 10 km driven on a 2.224 km plan.
    trip({ id: 'a1', actualStart: at(4), distanceKm: 10, deviationCount: 1, stops: [stop(0, 'DEPARTED', 0), stop(1, 'DEPARTED', 360), stop(2, 'ARRIVED', 120)] }),
    // Route A, driver d2: started 2 min early, one skipped stop, incomplete.
    trip({ id: 'a2', driverId: 'd2', status: 'INCOMPLETE', actualStart: at(-2), distanceKm: 1, stops: [stop(0, 'DEPARTED', -60), stop(1, 'SKIPPED', null), stop(2, 'PENDING', null)] }),
    // Route A cancelled: counts as a trip, adds nothing to km (not finished).
    trip({ id: 'a3', status: 'CANCELLED', distanceKm: 3, stops: [stop(0, 'PENDING', null), stop(1, 'PENDING', null)] }),
    // Route B (renamed since: snapshot "Route B old" on the earlier trip), no driver, vehicle v2.
    trip({ id: 'b1', routeId: 'r2', routeName: 'Route B old', objectId: 'v2', driverId: null, plannedStart: at(-1440), actualStart: at(-1430), distanceKm: 5, stops: [stop(0, 'DEPARTED', 600), stop(1, 'ARRIVED', 200)] }),
    trip({ id: 'b2', routeId: 'r2', routeName: 'Route B', objectId: 'v2', driverId: null, status: 'SCHEDULED', stops: [stop(0, 'PENDING', null), stop(1, 'PENDING', null)] }),
  ].map(tripFacts);

  it('groups per route with weighted on-time %, averages and finished-trip km', () => {
    const { rows, totals } = tripPerformance(trips, 'ROUTE');
    expect(rows.map((r) => r.groupName)).toEqual(['Route A', 'Route B']); // latest snapshot name
    const a = rows[0];
    expect(a).toMatchObject({ groupBy: 'ROUTE', groupId: 'r1', trips: 3, completed: 1, incomplete: 1, cancelled: 1, ratedStops: 4, onTimeStops: 3, onTimePct: 75, skippedStops: 1, deviations: 1 });
    expect(a.avgStartDelayMin).toBe(1); // (240 − 120) / 2 s
    expect(a.avgStopDelayMin).toBe(1.8); // (0 + 360 + 120 − 60) / 4 s = 105 s
    expect(a.plannedKm).toBe(4.4); // a1 + a2 straight legs (2 × 2.224), a3 cancelled
    expect(a.actualKm).toBe(11);
    expect(rows[1]).toMatchObject({ trips: 2, completed: 1, ratedStops: 2, onTimeStops: 1, onTimePct: 50, avgStartDelayMin: 10, avgStopDelayMin: 6.7, plannedKm: 1.1, actualKm: 5 });

    // Totals from every trip (not an average of the row percentages).
    expect(totals).toMatchObject({ groups: 2, trips: 5, completed: 2, incomplete: 1, cancelled: 1, ratedStops: 6, onTimeStops: 4, onTimePct: 66.7, skippedStops: 1, plannedKm: 5.6, actualKm: 16, deviations: 1 });
    expect(totals.avgStartDelayMin).toBe(4); // (240 − 120 + 600) / 3 s
    expect(totals.avgStopDelayMin).toBe(3.4); // (420 + 800) / 6 s
  });

  it('uses the current route name when given, and groups per driver with "No driver" last', () => {
    expect(tripPerformance(trips, 'ROUTE', { route: (id) => (id === 'r2' ? 'Route B (new)' : undefined) }).rows.map((r) => r.groupName)).toEqual(['Route A', 'Route B (new)']);
    const byDriver = tripPerformance(trips, 'DRIVER', { driver: (id) => ({ d1: 'Zed', d2: 'Anil' })[id] }).rows;
    expect(byDriver.map((r) => [r.groupId, r.groupName, r.trips])).toEqual([
      ['d2', 'Anil', 1],
      ['d1', 'Zed', 2],
      [null, 'No driver', 2],
    ]);
  });

  it('null keys: "No driver" only when grouping by driver; by route an ETMS trip without a route is labelled as such (C-12)', () => {
    const withEtms = [...trips, tripFacts(trip({ id: 'e1', routeId: null, routeName: 'Transport login', driverId: null, stops: [stop(0, 'DEPARTED', 0), stop(1, 'ARRIVED', 0)] }))];
    const byRoute = tripPerformance(withEtms, 'ROUTE').rows;
    expect(byRoute.map((r) => [r.groupId, r.groupName])).toEqual([
      ['r1', 'Route A'],
      ['r2', 'Route B'],
      [null, NO_ROUTE_GROUP_LABEL],
    ]);
    expect(byRoute.some((r) => r.groupName === NO_DRIVER_GROUP_LABEL)).toBe(false);
    const byDriver = tripPerformance(withEtms, 'DRIVER').rows;
    expect(byDriver.find((r) => r.groupId === null)).toMatchObject({ groupName: NO_DRIVER_GROUP_LABEL, trips: 3 });
    expect(plannedTripRow(withEtms[withEtms.length - 1], { vehicle: () => undefined, driver: () => undefined })).toMatchObject({ routeId: null, routeName: 'Transport login' });
  });

  it('groups per vehicle', () => {
    const rows = tripPerformance(trips, 'VEHICLE', { vehicle: (id) => ({ v1: 'Bus 01', v2: 'Bus 02' })[id] }).rows;
    expect(rows.map((r) => [r.groupName, r.trips, r.onTimePct])).toEqual([
      ['Bus 01', 3, 75],
      ['Bus 02', 2, 50],
    ]);
  });

  it('leaves the averages out when nothing was reached', () => {
    const { rows, totals } = tripPerformance([tripFacts(trip({ id: 'x', status: 'SCHEDULED', stops: [stop(0, 'PENDING', null)] }))], 'ROUTE');
    expect(rows[0]).toMatchObject({ onTimePct: null, avgStartDelayMin: null, avgStopDelayMin: null, plannedKm: 0, actualKm: 0 });
    expect(totals).toEqual({ groups: 1, trips: 1, completed: 0, incomplete: 0, cancelled: 0, ratedStops: 0, onTimeStops: 0, skippedStops: 0, plannedKm: 0, actualKm: 0, deviations: 0 });
    expect(tripPerformance([], 'DRIVER')).toEqual({ rows: [], totals: { groups: 0, trips: 0, completed: 0, incomplete: 0, cancelled: 0, ratedStops: 0, onTimeStops: 0, skippedStops: 0, plannedKm: 0, actualKm: 0, deviations: 0 } });
  });
});

describe('planned trips rows', () => {
  const f = tripFacts(
    trip({ id: 't9', actualStart: at(3), actualEnd: at(70), delaySec: 450, distanceKm: 2.34567, deviationCount: 2, path: [[80, 13], [80, 13.02]], stops: [stop(0, 'DEPARTED', 0), stop(1, 'SKIPPED', null), stop(2, 'ARRIVED', 450)] }),
  );

  it('one row per trip with names, delays, stops and km', () => {
    const row = plannedTripRow(f, { vehicle: () => ({ name: 'Bus 01', plateNumber: 'TN01' }), driver: () => 'Ravi' });
    expect(row).toEqual({
      tripId: 't9',
      routeId: 'r1',
      routeName: 'Route A',
      objectId: 'v1',
      objectName: 'Bus 01',
      plateNumber: 'TN01',
      driverId: 'd1',
      driverName: 'Ravi',
      status: 'COMPLETED',
      closedBy: 'AUTO',
      plannedStart: '2026-11-05T03:30:00.000Z',
      plannedEnd: '2026-11-05T04:30:00.000Z',
      actualStart: '2026-11-05T03:33:00.000Z',
      actualEnd: '2026-11-05T04:40:00.000Z',
      startDelayMin: 3,
      delayMin: 7.5,
      stopsDone: 2,
      stopCount: 3,
      skippedStops: 1,
      onTimeStops: 1,
      deviationCount: 2,
      plannedKm: 2.2,
      distanceKm: 2.346,
    });
    expect(plannedTripTotals([f, tripFacts(trip({ id: 'c', status: 'CANCELLED' }))])).toEqual({
      count: 2, completed: 1, incomplete: 0, cancelled: 1, stopsDone: 2, stopCount: 3, skippedStops: 1, onTimeStops: 1, deviationCount: 2, plannedKm: 2.2, distanceKm: 2.3,
    });
  });

  it('renders both reports to CSV with a totals row and the grouping in the header', async () => {
    const base = { from: '2026-11-05', to: '2026-11-05', companyName: 'Demo', tz: 'Asia/Kolkata', truncated: false };
    const perf = tripPerformance([f], 'DRIVER', { driver: () => 'Ravi' });
    const planned: ReportData = { ...base, type: 'PLANNED_TRIPS', rows: [plannedTripRow(f, { vehicle: () => ({ name: 'Bus 01', plateNumber: null }), driver: () => 'Ravi' })], totals: plannedTripTotals([f]), totalRows: 1 };
    const grouped: ReportData = { ...base, type: 'TRIP_PERFORMANCE', groupBy: 'DRIVER', rows: perf.rows, totals: perf.totals, totalRows: perf.rows.length };
    const csv = (await renderReport([grouped, planned], 'CSV', T0)).buffer.toString('utf8');
    expect(csv).toContain('Trip performance report');
    expect(csv).toContain('Period: 2026-11-05 to 2026-11-05 (Asia/Kolkata) · grouped by driver');
    expect(csv).toContain('Driver,Trips,Completed,Incomplete,Cancelled,On time %,Stops on time,Avg start delay (min),Avg stop delay (min),Skipped stops,Planned km,Actual km,Deviations');
    expect(csv).toContain('Ravi,1,1,0,0,50%,1 / 2,3,3.8,1,2.2,2.3,2');
    expect(csv).toContain('Total (1 drivers),1,1,0,0,50%,1 / 2,3,3.8,1,2.2,2.3,2');
    expect(csv).toContain('Route,Vehicle,Plate,Driver,Status,Planned start,Actual start,Planned end,Actual end,Start delay (min),Delay (min),Stops done,Skipped,Deviations,Planned km,Distance (km)');
    expect(csv).toContain('Route A,Bus 01,,Ravi,Completed,2026-11-05 09:00:00,2026-11-05 09:03:00,2026-11-05 10:00:00,2026-11-05 10:10:00,3,7.5,2 / 3,1,2,2.2,2.35');
    expect(csv).toContain('Total (1 trips),,,,1 completed,,,,,,,2 / 3,1,2,2.2,2.3');
  });
});
