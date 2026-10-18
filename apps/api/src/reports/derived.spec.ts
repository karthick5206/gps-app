import { continuousDriving, deviceStatus, ignitionChanges, overspeedEpisodes } from './derived';

const T0 = Date.parse('2026-10-18T04:00:00Z');
const s = (sec: number) => T0 + sec * 1000;
const m = (min: number) => T0 + min * 60_000;

describe('overspeedEpisodes', () => {
  const p = (sec: number, speedKph: number) => ({ t: s(sec), speedKph, lat: 13 + sec / 1e4, lng: 80 });

  it('groups consecutive points and splits on gaps longer than maxGap', () => {
    const eps = overspeedEpisodes([p(0, 85), p(10, 92), p(20, 88), p(400, 95), p(410, 97)], { maxGapMs: 60_000, minDurationSec: 5 });
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ start: s(0), end: s(20), maxSpeedKph: 92, avgSpeedKph: 88.3, points: 3, lat: 13 + 10 / 1e4 });
    expect(eps[1]).toMatchObject({ start: s(400), end: s(410), maxSpeedKph: 97, points: 2 });
  });

  it('drops episodes shorter than the minimum duration', () => {
    expect(overspeedEpisodes([p(0, 90)], { minDurationSec: 10 })).toEqual([]);
    expect(overspeedEpisodes([p(0, 90)], { minDurationSec: 0 })).toHaveLength(1);
  });
});

describe('ignitionChanges', () => {
  const p = (min: number, ignition: boolean) => ({ t: m(min), ignition, lat: 1, lng: 2 });

  it('reports each change with the duration of the previous state', () => {
    const out = ignitionChanges([p(0, false), p(5, false), p(10, true), p(70, true), p(75, false)]);
    expect(out.map((c) => [c.state, c.previousStateSec])).toEqual([
      ['ON', 600],
      ['OFF', 3900],
    ]);
  });

  it('a known state before the range makes the first point a change with unknown duration', () => {
    expect(ignitionChanges([p(0, true)], false)).toEqual([{ t: m(0), state: 'ON', previousStateSec: null, lat: 1, lng: 2 }]);
    expect(ignitionChanges([p(0, true)], true)).toEqual([]);
  });
});

describe('continuousDriving', () => {
  const trip = (startMin: number, endMin: number, km = 10) => ({
    start: m(startMin),
    end: m(endMin),
    durationSec: (endMin - startMin) * 60,
    distanceKm: km,
    startAddress: `A${startMin}`,
    endAddress: `B${endMin}`,
  });

  it('joins trips separated by short breaks and reports stretches over the driving limit', () => {
    // 3 h + 5 min break + 1.5 h = 4.5 h driving → reported; then a 30 min break; then 1 h → not reported.
    const out = continuousDriving([trip(0, 180, 150), trip(185, 275, 70), trip(305, 365, 40)], { drivingMin: 240, breakMin: 15 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: m(0), end: m(275), drivingSec: 270 * 60, spanSec: 275 * 60, distanceKm: 220, trips: 2, longestBreakSec: 300, startAddress: 'A0', endAddress: 'B275' });
  });

  it('a break at least as long as breakMin resets the stretch', () => {
    expect(continuousDriving([trip(0, 150), trip(165, 300)], { drivingMin: 240, breakMin: 15 })).toEqual([]);
  });
});

describe('deviceStatus', () => {
  const now = m(1000);
  const opts = { inactiveAfterSec: 3600, noGpsAfterSec: 1800 };
  it('classifies like a fleet criticality board', () => {
    expect(deviceStatus({ hasDevice: false, lastSeenAt: null, lastFixAt: null }, now, opts)).toBe('NO_DEVICE');
    expect(deviceStatus({ hasDevice: true, lastSeenAt: null, lastFixAt: null }, now, opts)).toBe('NEVER_CONNECTED');
    expect(deviceStatus({ hasDevice: true, lastSeenAt: m(900), lastFixAt: m(900) }, now, opts)).toBe('INACTIVE');
    expect(deviceStatus({ hasDevice: true, lastSeenAt: m(999), lastFixAt: m(900) }, now, opts)).toBe('NO_GPS');
    expect(deviceStatus({ hasDevice: true, lastSeenAt: m(999), lastFixAt: m(995) }, now, opts)).toBe('ACTIVE');
  });
});
