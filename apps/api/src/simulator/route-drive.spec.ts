import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { haversineMeters } from '../tracking/geo';
import { buildTimeline, distanceToPathM, DriveFix, DriveScenario, DriveTimeline, LngLat, MAX_IMPLIED_KPH, RouteStop } from './route-drive';
import { parsePath, parseRouteFile, parseStopsArg } from './route-source';

const SCENARIOS = join(__dirname, 'scenarios');
const route = parseRouteFile(JSON.parse(readFileSync(join(SCENARIOS, 'chennai-route.json'), 'utf8')));
const path = route.path as LngLat[];
const stops = route.stops;
const INTERVAL = 5;

function scenarioFile(name: string): { cruiseKph: number; scenario: DriveScenario } {
  return JSON.parse(readFileSync(join(SCENARIOS, `${name}.json`), 'utf8'));
}

function run(name: string, extra: DriveScenario = {}): DriveTimeline {
  const f = scenarioFile(name);
  return buildTimeline(path, stops, { cruiseKph: f.cruiseKph, intervalSec: INTERVAL, scenario: { ...f.scenario, ...extra } });
}

const distTo = (fix: DriveFix, s: RouteStop) => haversineMeters(fix.lat, fix.lng, s.lat, s.lng);
const ALL = ['on-time', 'late-stop', 'deviation', 'skip-stop', 'unscheduled-stop'];

/** Seconds spent standing (speed 0) at the stop position, from the fixes. */
function standingSec(tl: DriveTimeline, s: RouteStop): number {
  const at = tl.fixes.filter((f) => f.speedKph === 0 && distTo(f, s) < 2);
  return at.length ? at[at.length - 1].t - at[0].t : 0;
}

describe('route-drive timeline', () => {
  it.each(ALL)('%s: time starts at 0, strictly increases, one fix per interval', (name) => {
    const tl = run(name);
    expect(tl.fixes[0].t).toBe(0);
    for (let i = 1; i < tl.fixes.length; i++) {
      expect(tl.fixes[i].t).toBeGreaterThan(tl.fixes[i - 1].t);
      expect(tl.fixes[i].t - tl.fixes[i - 1].t).toBeLessThanOrEqual(INTERVAL);
    }
    expect(tl.fixes[tl.fixes.length - 1].t).toBe(tl.durationSec);
  });

  it.each(ALL)('%s: reaches every stop within its radius except a skipped one, in order', (name) => {
    const tl = run(name);
    const skip = scenarioFile(name).scenario.skipStop;
    let prevArrive = -1;
    stops.forEach((s, i) => {
      const min = Math.min(...tl.fixes.map((f) => distTo(f, s)));
      if (i === skip) return;
      expect(min).toBeLessThanOrEqual(s.radiusM!);
      expect(tl.stops[i].arriveT).toBeGreaterThanOrEqual(prevArrive);
      prevArrive = tl.stops[i].arriveT!;
    });
    // Ends parked at the last stop.
    const lastFix = tl.fixes[tl.fixes.length - 1];
    expect(distTo(lastFix, stops[stops.length - 1])).toBeLessThan(5);
    expect(lastFix.speedKph).toBe(0);
  });

  it.each(ALL)('%s: implied speed between fixes stays at the cruise speed and below the jump filter', (name) => {
    for (const factor of [1, 5]) {
      const tl = run(name, { speedFactor: factor });
      for (let i = 1; i < tl.fixes.length; i++) {
        const a = tl.fixes[i - 1];
        const b = tl.fixes[i];
        const kph = (haversineMeters(a.lat, a.lng, b.lat, b.lng) / (b.t - a.t)) * 3.6;
        expect(kph).toBeLessThanOrEqual(30 * factor * 1.05 + 1);
        expect(kph).toBeLessThan(200);
      }
    }
  });

  it('dwells waitSec at each stop with speed 0 and slows down when approaching', () => {
    const tl = run('on-time');
    for (const i of [1, 2, 3]) {
      expect(tl.stops[i].dwellSec).toBe(120);
      expect(Math.abs(standingSec(tl, stops[i]) - 120)).toBeLessThanOrEqual(INTERVAL);
      const firstStanding = tl.fixes.findIndex((f) => f.speedKph === 0 && distTo(f, stops[i]) < 2);
      expect(tl.fixes[firstStanding - 1].speedKph).toBeLessThan(30);
    }
    // Cruise speed in between.
    expect(Math.max(...tl.fixes.map((f) => f.speedKph))).toBe(30);
  });

  it('late-stop: the extra delay is spent at the stop before, so the late stop is reached ~15 min later', () => {
    const onTime = run('on-time');
    const late = run('late-stop');
    expect(late.stops[1].dwellSec).toBe(120 + 900);
    expect(Math.abs(standingSec(late, stops[1]) - 1020)).toBeLessThanOrEqual(INTERVAL);
    const delay = late.stops[2].arriveT! - onTime.stops[2].arriveT!;
    expect(delay).toBe(900);
    // Against the route's planned offsets: on time within 2 min, late by more than the 10 min alert threshold.
    expect(Math.abs(onTime.stops[2].arriveT! / 60 - stops[2].offsetMin!)).toBeLessThan(2);
    expect(late.stops[2].arriveT! / 60 - stops[2].offsetMin!).toBeGreaterThan(10);
  });

  it('deviation: > 300 m off the path on the detour, < 50 m outside the window, ≥ 2 fixes beyond the corridor', () => {
    const tl = run('deviation');
    const core = tl.fixes.filter((f) => Math.abs(f.offsetM) >= 399.9);
    const outside = tl.fixes.filter((f) => f.offsetM === 0);
    expect(core.length).toBeGreaterThanOrEqual(2);
    for (const f of core) expect(distanceToPathM(path, f.lat, f.lng)).toBeGreaterThan(300);
    for (const f of outside) expect(distanceToPathM(path, f.lat, f.lng)).toBeLessThan(50);
    // Window = 68–80 % of the path.
    const L = tl.pathLengthM;
    for (const f of tl.fixes.filter((x) => x.offsetM !== 0)) {
      expect(f.alongM / L).toBeGreaterThan(0.679);
      expect(f.alongM / L).toBeLessThan(0.801);
    }
    const beyond = tl.fixes.filter((f) => distanceToPathM(path, f.lat, f.lng) > 200);
    expect(beyond.length).toBeGreaterThanOrEqual(2);
    expect(tl.events.filter((e) => e.type === 'deviation-on')).toHaveLength(1);
    expect(tl.events.filter((e) => e.type === 'deviation-off')).toHaveLength(1);
  });

  it('skip-stop: passes the skipped stop more than radius + 50 m away, without leaving the corridor', () => {
    const tl = run('skip-stop');
    const skipped = stops[3];
    for (const f of tl.fixes) {
      expect(distTo(f, skipped)).toBeGreaterThan(skipped.radiusM! + 50);
      expect(distanceToPathM(path, f.lat, f.lng)).toBeLessThan(200);
    }
    expect(tl.stops[3].skipped).toBe(true);
    expect(tl.stops[3].arriveT).toBeUndefined();
    expect(tl.events.some((e) => e.type === 'skip' && e.stop === 3)).toBe(true);
    expect(tl.events.some((e) => e.type === 'arrive' && e.stop === 3)).toBe(false);
  });

  it('unscheduled-stop: stands still for the given time on the road, outside every stop radius', () => {
    const tl = run('unscheduled-stop');
    const standing = tl.fixes.filter((f) => f.speedKph === 0 && stops.every((s) => distTo(f, s) > s.radiusM!));
    expect(standing.length).toBeGreaterThan(0);
    expect(standing[standing.length - 1].t - standing[0].t).toBeGreaterThanOrEqual(420 - INTERVAL);
    expect(new Set(standing.map((f) => `${f.lat},${f.lng}`)).size).toBe(1);
    expect(standing[0].alongM / tl.pathLengthM).toBeCloseTo(0.45, 2);
    // Not compressed by the speed factor: the tracker's 5 min threshold is wall-clock.
    const fast = run('unscheduled-stop', { speedFactor: 5 });
    const fastStanding = fast.fixes.filter((f) => f.speedKph === 0 && stops.every((s) => distTo(f, s) > s.radiusM!));
    expect(fastStanding[fastStanding.length - 1].t - fastStanding[0].t).toBeGreaterThanOrEqual(420 - INTERVAL);
  });

  it('is deterministic', () => {
    for (const name of ALL) expect(JSON.stringify(run(name))).toBe(JSON.stringify(run(name)));
  });

  it('scenarios combine', () => {
    const tl = buildTimeline(path, stops, {
      cruiseKph: 30,
      intervalSec: INTERVAL,
      scenario: { skipStop: 3, delayAtStopSec: { stop: 2, sec: 600 }, deviation: { fromFrac: 0.68, toFrac: 0.8, offsetM: 400 }, unscheduledStop: { atFrac: 0.45, sec: 360 } },
    });
    expect(tl.stops[3].skipped).toBe(true);
    expect(tl.stops[1].dwellSec).toBe(720);
    expect(tl.events.map((e) => e.type)).toEqual(expect.arrayContaining(['skip', 'deviation-on', 'deviation-off', 'unscheduled-start', 'unscheduled-end']));
  });

  it('speed factor compresses driving and planned dwells, not wall-clock timestamps', () => {
    const slow = run('on-time');
    const fast = run('on-time', { speedFactor: 4 });
    expect(fast.durationSec).toBeLessThan(slow.durationSec / 3);
    expect(fast.stops[2].dwellSec).toBe(30);
    expect(fast.fixes[1].t - fast.fixes[0].t).toBe(INTERVAL);
    // Reported speed stays nominal.
    expect(Math.max(...fast.fixes.map((f) => f.speedKph))).toBe(30);
    expect(() => run('on-time', { speedFactor: MAX_IMPLIED_KPH / 30 + 1 })).toThrow(/implied speed/);
  });

  it('course follows the bearing; straight lines between stops when there is no path', () => {
    const north: RouteStop[] = [
      { name: 'A', lat: 13.0, lng: 80.2, waitSec: 0 },
      { name: 'B', lat: 13.03, lng: 80.2, waitSec: 0 },
      { name: 'C', lat: 13.03, lng: 80.23, waitSec: 0 },
    ];
    const tl = buildTimeline([], north, { cruiseKph: 40, intervalSec: 5 });
    const moving = tl.fixes.filter((f) => f.speedKph > 0);
    const northbound = moving.filter((f) => f.lat > 13.002 && f.lat < 13.028);
    const eastbound = moving.filter((f) => f.lng > 80.202 && f.lng < 80.228);
    expect(northbound.length).toBeGreaterThan(5);
    expect(eastbound.length).toBeGreaterThan(5);
    for (const f of northbound) expect(f.course === 0 || f.course === 359 || f.course === 1).toBe(true);
    for (const f of eastbound) expect(Math.abs(f.course - 90)).toBeLessThanOrEqual(1);
    expect(tl.pathLengthM).toBeGreaterThan(6500);
  });

  it('rejects impossible scenarios', () => {
    expect(() => run('on-time', { skipStop: 0 })).toThrow(/skipStop/);
    expect(() => run('on-time', { skipStop: 4 })).toThrow(/skipStop/);
    expect(() => run('on-time', { delayAtStopSec: { stop: 0, sec: 60 } })).toThrow(/delayAtStopSec/);
    expect(() => run('on-time', { deviation: { fromFrac: 0.8, toFrac: 0.7, offsetM: 400 } })).toThrow(/deviation/);
  });
});

describe('route sources', () => {
  it('parses --stops', () => {
    const s = parseStopsArg('13.0694,80.1948; 13.0866,80.2104');
    expect(s.map((x) => [x.name, x.lat, x.lng])).toEqual([
      ['Stop 1', 13.0694, 80.1948],
      ['Stop 2', 13.0866, 80.2104],
    ]);
    expect(() => parseStopsArg('13.0,80.2')).toThrow();
  });

  it('accepts [lng,lat][], GeoJSON and GraphHopper responses (plain and encoded)', () => {
    const coords: LngLat[] = [
      [80.1948, 13.0694],
      [80.2104, 13.0866],
    ];
    expect(parsePath(coords)).toEqual(coords);
    expect(parsePath({ type: 'LineString', coordinates: coords })).toEqual(coords);
    expect(parsePath({ paths: [{ distance: 1, points: { type: 'LineString', coordinates: coords } }] })).toEqual(coords);
    // Google polyline, precision 5: (38.5,-120.2), (40.7,-120.95)
    expect(parsePath({ paths: [{ points: '_p~iF~ps|U_ulLnnqC' }] })).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
    ]);
    expect(() => parsePath({ foo: 1 })).toThrow(/Unrecognised/);
  });

  it('reads the GET /api/routes/:id shape (waitMin, offsetMin, radiusM, path null)', () => {
    const r = parseRouteFile({
      data: {
        corridorM: 250,
        path: null,
        stops: [
          { name: 'Depot', lat: '13.0694', lng: '80.1948', radiusM: 80, offsetMin: 0, waitMin: 5 },
          { name: 'School', lat: 13.0866, lng: 80.2104, radiusM: null, offsetMin: 12, waitMin: 0 },
        ],
      },
    });
    expect(r.path).toBeNull();
    expect(r.corridorM).toBe(250);
    expect(r.stops[0]).toMatchObject({ name: 'Depot', lat: 13.0694, waitSec: 300, radiusM: 80, offsetMin: 0 });
    expect(r.stops[1]).toMatchObject({ radiusM: 100, offsetMin: 12, waitSec: 0 });
  });
});
