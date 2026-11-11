import { buildTripSnapshot, cleanPath, shiftTripTimes } from './snapshot';

const route = {
  name: 'Morning school run',
  corridorM: 250,
  path: [
    [80.27, 13.08],
    [80.26, 13.07],
    [80.25, 13.05],
  ],
  stops: [
    { seq: 1, name: 'Stop A', lat: 13.07, lng: 80.26, radiusM: 80, offsetMin: 15, waitMin: 2 },
    { seq: 0, name: 'Depot', lat: 13.08, lng: 80.27, radiusM: 100, offsetMin: 0, waitMin: 5 },
    { seq: 2, name: 'School', lat: 13.05, lng: 80.25, radiusM: 150, offsetMin: 40, waitMin: 10 },
  ],
};

const START = Date.parse('2026-11-12T02:00:00.000Z'); // 07:30 IST

describe('buildTripSnapshot', () => {
  it('copies the route and plans every stop from the start', () => {
    const s = buildTripSnapshot(route, START);
    expect(s.routeName).toBe('Morning school run');
    expect(s.corridorM).toBe(250);
    expect(s.path).toEqual(route.path);
    expect(s.plannedStart.toISOString()).toBe('2026-11-12T02:00:00.000Z');
    expect(s.stops.map((x) => [x.seq, x.name, x.plannedArrival.toISOString(), x.plannedDeparture.toISOString()])).toEqual([
      [0, 'Depot', '2026-11-12T02:00:00.000Z', '2026-11-12T02:05:00.000Z'],
      [1, 'Stop A', '2026-11-12T02:15:00.000Z', '2026-11-12T02:17:00.000Z'],
      [2, 'School', '2026-11-12T02:40:00.000Z', '2026-11-12T02:50:00.000Z'],
    ]);
    // plannedEnd = last stop's planned arrival (its wait is not part of the trip).
    expect(s.plannedEnd.toISOString()).toBe('2026-11-12T02:40:00.000Z');
    expect(s.stops[1]).toMatchObject({ lat: 13.07, lng: 80.26, radiusM: 80 });
  });

  it('does not share the path array with the route', () => {
    const s = buildTripSnapshot(route, START);
    expect(s.path).not.toBe(route.path);
  });

  it('stores null for a missing or malformed path', () => {
    expect(buildTripSnapshot({ ...route, path: null }, START).path).toBeNull();
    expect(buildTripSnapshot({ ...route, path: [[1, 'x'], [2, 3]] }, START).path).toBeNull();
  });

  it('refuses a route with fewer than 2 stops', () => {
    expect(() => buildTripSnapshot({ ...route, stops: route.stops.slice(0, 1) }, START)).toThrow();
  });
});

describe('cleanPath', () => {
  it('keeps only [lng, lat]', () => {
    expect(cleanPath([[1, 2, 3], [4, 5]])).toEqual([[1, 2], [4, 5]]);
    expect(cleanPath([[1, 2]])).toBeNull();
    expect(cleanPath('x')).toBeNull();
  });
});

describe('shiftTripTimes', () => {
  it('moves the trip and every stop by the same amount', () => {
    const s = buildTripSnapshot(route, START);
    const moved = shiftTripTimes(s, s.stops, START + 90 * 60_000);
    expect(moved.plannedStart.toISOString()).toBe('2026-11-12T03:30:00.000Z');
    expect(moved.plannedEnd.toISOString()).toBe('2026-11-12T04:10:00.000Z');
    expect(moved.stops[2].plannedDeparture.toISOString()).toBe('2026-11-12T04:20:00.000Z');
    expect(moved.stops[2].name).toBe('School');
  });
});
