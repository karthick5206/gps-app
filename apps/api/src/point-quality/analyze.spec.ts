import { haversineMeters } from '../tracking/geo';
import { analyzeTrack, InPoint, maxSpeedKph } from './analyze';

const T0 = Date.parse('2026-10-28T08:00:00Z');
const LAT = 13.05;
const LNG = 80.25;
const M_LAT = 1 / 111_320; // degrees per metre north

/** Driving north at `mps`, one fix every `step` s, accuracy `acc`. */
function drive(count: number, { start = 0, mps = 11, step = 3, acc = 5 } = {}): InPoint[] {
  return Array.from({ length: count }, (_, k) => ({
    t: T0 + (start + k * step) * 1000,
    lat: LAT + (start * mps + k * step * mps) * M_LAT,
    lng: LNG,
    acc,
    spdKph: mps * 3.6,
    mock: false,
  }));
}

/** Deterministic pseudo-random noise in [-1, 1] (hash, not a smooth wave). */
const noise = (k: number) => {
  const s = Math.sin(k * 12.9898 + 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
};

describe('analyzeTrack', () => {
  it('keeps a clean drive good', () => {
    const r = analyzeTrack(drive(60));
    expect(r.labels.every((l) => l === 'good')).toBe(true);
    expect(r.clean).toHaveLength(60);
  });

  it('labels a single out-and-back spike, not its neighbours', () => {
    const pts = drive(40);
    pts[20] = { ...pts[20], lat: pts[20].lat + 2000 * M_LAT };
    const r = analyzeTrack(pts);
    expect(r.labels[20]).toBe('spike');
    expect(r.labels.filter((l) => l !== 'good')).toHaveLength(1);
  });

  it('labels a group of 3 displaced points (e.g. a wrong Wi-Fi cluster) as a spike', () => {
    const pts = drive(40);
    for (const k of [15, 16, 17]) pts[k] = { ...pts[k], lng: pts[k].lng + 0.03 };
    const r = analyzeTrack(pts);
    expect([15, 16, 17].map((k) => r.labels[k])).toEqual(['spike', 'spike', 'spike']);
    expect(r.labels.filter((l) => l !== 'good')).toHaveLength(3);
  });

  it('does not call a vague point a jump when its error radius explains the offset', () => {
    const pts = drive(40);
    pts[20] = { ...pts[20], lng: pts[20].lng + 80 / 108_000, acc: 40 };
    const r = analyzeTrack(pts);
    expect(r.labels[20]).not.toBe('spike');
  });

  it('flags fake GPS, bad coordinates, duplicates and very inaccurate fixes', () => {
    const pts = drive(30);
    pts[5] = { ...pts[5], mock: true };
    pts[8] = { ...pts[8], lat: 0, lng: 0 };
    pts[12] = { ...pts[12], t: pts[11].t };
    pts[18] = { ...pts[18], acc: 400 };
    const r = analyzeTrack(pts);
    expect([r.labels[5], r.labels[8], r.labels[12], r.labels[18]]).toEqual(['mock', 'invalid', 'duplicate', 'inaccurate']);
  });

  it('flags a fix much vaguer than its neighbours as inaccurate', () => {
    const pts = drive(30);
    pts[15] = { ...pts[15], acc: 90 };
    expect(analyzeTrack(pts).labels[15]).toBe('inaccurate');
  });

  it('turns a parked phone into one stop and marks the far wobble as drift', () => {
    // 20 min parked with Wi-Fi fixes every 30 s wobbling up to 40 m, a few up to 120 m (accuracy 100 m).
    const parked: InPoint[] = Array.from({ length: 40 }, (_, k) => {
      const far = k % 10 === 5;
      const off = far ? 45 : 15 * noise(k);
      return { t: T0 + k * 30_000, lat: LAT + off * M_LAT, lng: LNG + (off / 108_000) * noise(k + 7), acc: far ? 30 : 20, spdKph: 0, mock: false };
    });
    const r = analyzeTrack(parked);
    expect(r.labels.filter((l) => l === 'drift').length).toBeGreaterThanOrEqual(3);
    expect(r.labels.filter((l) => l === 'spike' || l === 'jump')).toHaveLength(0);
    // the whole stop becomes one spot (start and end)
    expect(r.clean).toHaveLength(2);
    expect(r.clean[0][1]).toBeCloseTo(r.clean[1][1], 9);
  });

  it('smooths GPS noise: the clean track is closer to the true path than the raw fixes', () => {
    const truth = drive(80);
    const noisy = truth.map((p, k) => ({ ...p, lng: p.lng + (6 * noise(k)) / 108_000, acc: 8 }));
    const r = analyzeTrack(noisy);
    const err = (pts: [number, number][]) => pts.reduce((s, [lat, lng], k) => s + haversineMeters(lat, lng, truth[k].lat, truth[k].lng), 0) / pts.length;
    const rawErr = err(noisy.map((p) => [p.lat, p.lng]));
    const cleanErr = err(r.clean.map((c) => [c[1], c[2]]));
    expect(cleanErr).toBeLessThan(rawErr * 0.7);
  });

  it('keeps a real turn (no false jumps)', () => {
    const north = drive(30);
    const last = north[north.length - 1];
    const east: InPoint[] = Array.from({ length: 30 }, (_, k) => ({
      t: last.t + (k + 1) * 3000,
      lat: last.lat,
      lng: last.lng + ((k + 1) * 33) / 108_000,
      acc: 5,
      spdKph: 40,
      mock: false,
    }));
    const r = analyzeTrack([...north, ...east]);
    expect(r.labels.filter((l) => l !== 'good')).toHaveLength(0);
  });

  it('treats a long gap as a gap, not a jump', () => {
    const before = drive(20);
    const after = drive(20, { start: 3600 }).map((p) => ({ ...p, lat: p.lat + 0.3 }));
    const r = analyzeTrack([...before, ...after]);
    expect(r.labels.every((l) => l === 'good')).toBe(true);
  });
  it('uses the receiver speed: a walking phone jumping 250 m for one fix is a spike (far below the 200 km/h limit)', () => {
    const pts = drive(40, { mps: 1.4, step: 5, acc: 8 });
    pts[20] = { ...pts[20], lng: pts[20].lng + 250 / 108_000 };
    const r = analyzeTrack(pts);
    expect(r.labels[20]).toBe('spike');
    expect(r.labels.filter((l) => l !== 'good')).toHaveLength(1);
  });

  it('keeps a car pulling away from rest good (reported speed rises with the movement)', () => {
    const pts: InPoint[] = [];
    let y = 0;
    for (let k = 0; k < 20; k++) {
      const v = Math.min(20, k * 2); // 0 → 72 km/h in 30 s
      pts.push({ t: T0 + k * 3000, lat: LAT + y * M_LAT, lng: LNG, acc: 5, spdKph: v * 3.6, mock: false });
      y += v * 3;
    }
    expect(analyzeTrack(pts).labels.every((l) => l === 'good')).toBe(true);
  });

  it('ignores the speed check for network fixes without speed (fast drive stays good)', () => {
    const pts = drive(30, { mps: 30, step: 10, acc: 120 }).map((p) => ({ ...p, spdKph: 0 }));
    expect(analyzeTrack(pts).labels.every((l) => l === 'good')).toBe(true);
  });

  it('applies the object type top speed: 110 km/h out and back is a spike for an auto, fine for a car', () => {
    expect(maxSpeedKph('VEHICLE', 'AUTO')).toBe(90);
    expect(maxSpeedKph('PERSON', null)).toBe(200);
    const before = drive(20, { mps: 8, step: 10 });
    // 3 fixes 330 m to the side (10 s apart): ~110 km/h out and back, then on the line again.
    const pts = before.map((p, k) => (k >= 10 && k <= 12 ? { ...p, lng: p.lng + 330 / 108_000, spdKph: 0, acc: null } : { ...p, spdKph: 0, acc: null }));
    expect(analyzeTrack(pts, { maxSpeedKph: 200 }).labels.slice(10, 13)).toEqual(['good', 'good', 'good']);
    expect(analyzeTrack(pts, { maxSpeedKph: 90 }).labels.slice(10, 13)).toEqual(['spike', 'spike', 'spike']);
  });
});
