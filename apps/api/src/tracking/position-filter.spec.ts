import { DEFAULT_THRESHOLDS, POSITION_FLAGS } from '@veetracer/shared';
import { EMPTY_TRACK_STATE, FilterInput, filterPosition, TrackState } from './position-filter';

const NOW = Date.UTC(2026, 9, 18, 6, 0, 0);
const ctx = { objectType: 'VEHICLE' as const, thresholds: DEFAULT_THRESHOLDS, now: NOW };
const base: FilterInput = {
  fixTime: NOW - 10_000,
  lat: 13.05,
  lng: 80.25,
  speedKph: 40,
  valid: true,
  satellites: 9,
  ignition: true,
};
const anchored: TrackState = {
  ...EMPTY_TRACK_STATE,
  lastValid: { lat: 13.05, lng: 80.25, fixTime: NOW - 20_000 },
  lastFixTime: NOW - 20_000,
};

describe('filterPosition', () => {
  it('phones: replay of the real standing-phone night (919444907658) — the marker never leaves home', () => {
    const HOME = { lat: 12.972, lng: 80.1855 };
    // [lat, lng, reported km/h, accuracy m] every ~10 s; the 100 m fixes are Wi-Fi / cell fallbacks seen on 20–21 Oct.
    const seq: [number, number, number, number][] = [
      [12.97199, 80.185501, 12.3, 13], [12.971951, 80.184649, 22.2, 100], [12.97199, 80.1855, 1, 20],
      [12.971922, 80.183845, 0, 100], [12.972017, 80.185549, 17.6, 33.2], [12.972251, 80.183147, 0, 100],
      [12.972251, 80.183147, 0, 100], [12.972017, 80.185517, 0, 45.5], [12.97125, 80.184891, 0, 100],
      [12.971988, 80.185589, 0, 100], [12.972017, 80.185518, 0, 87.8], [12.971922, 80.183845, 0, 100],
      [12.971992, 80.185519, 0.7, 41.7], [12.971922, 80.183845, 0, 100], [12.972001, 80.18552, 0.3, 22.7],
    ];
    let st: TrackState = { ...EMPTY_TRACK_STATE, lastValid: { ...HOME, fixTime: NOW - 200_000 }, lastFixTime: NOW - 200_000 };
    seq.forEach(([lat, lng, speedKph, accuracyM], i) => {
      const fixTime = NOW - 190_000 + i * 10_000;
      const r = filterPosition({ ...base, fixTime, satellites: null, ignition: null, lat, lng, speedKph, accuracyM }, st, { ...ctx, now: NOW });
      st = r.next;
      // Shown position stays within GPS noise of home (the spikes were 93–258 m away).
      expect(Math.abs(r.lat! - HOME.lat) * 111_000).toBeLessThan(40);
      expect(Math.abs(r.lng! - HOME.lng) * 108_000).toBeLessThan(40);
    });
  });

  it('phones: a coarse fix far beyond its own error radius is still accepted (phone really moved)', () => {
    const st: TrackState = { ...EMPTY_TRACK_STATE, lastValid: { lat: 12.972, lng: 80.1855, fixTime: NOW - 600_000 }, lastFixTime: NOW - 600_000 };
    const far = { ...base, fixTime: NOW, satellites: null, ignition: null, lat: 12.99, lng: 80.1855, speedKph: 0, accuracyM: 100 }; // 2 km, 10 min later
    expect(filterPosition(far, st, ctx).flags & (POSITION_FLAGS.JUMP | POSITION_FLAGS.DRIFT)).toBe(0);
  });

  it('phones: the real 180 m out-and-back spike at reported 0 km/h is a jump, not movement (919444907658, 00:58:59)', () => {
    const st: TrackState = { ...EMPTY_TRACK_STATE, lastValid: { lat: 12.971981, lng: 80.185516, fixTime: NOW - 9_000 }, lastFixTime: NOW - 9_000 };
    const spike = { ...base, fixTime: NOW, satellites: null, ignition: null, lat: 12.971922, lng: 80.183845, speedKph: 0, accuracyM: 100 };
    const r = filterPosition(spike, st, ctx);
    expect(r.flags & POSITION_FLAGS.JUMP).toBeTruthy();
    expect(r.lat).toBeCloseTo(12.971981, 6); // map stays put
    // A real walk/drive reports its speed, so it is accepted.
    const drive = { ...spike, speedKph: 40, accuracyM: 6 };
    expect(filterPosition(drive, st, ctx).flags & (POSITION_FLAGS.JUMP | POSITION_FLAGS.DRIFT)).toBe(0);
  });

  it('phones: a standing phone wobbling within its accuracy radius is drift, a real walk is not', () => {
    // ~45 m away, 4 km/h reported, accuracy 50 m, no ignition / satellites (phone).
    const phone = { ...base, satellites: null, ignition: null, speedKph: 4, accuracyM: 50, lat: 13.0504 };
    expect(filterPosition(phone, anchored, ctx).flags & POSITION_FLAGS.DRIFT).toBeTruthy();
    // Same move with a 5 m accuracy and walking speed above the running threshold: movement.
    const precise = { ...phone, accuracyM: 5, speedKph: 12 };
    expect(filterPosition(precise, anchored, ctx).flags & POSITION_FLAGS.DRIFT).toBe(0);
  });

  it('phones: a reported speed the position does not confirm is noise (919036353003, 23 Oct 09:22, at home)', () => {
    // Last accepted fix 08:41:52; at 09:22:08 the phone reported 20.2 km/h at ±43 m, 41 m away: drift, speed 0.
    const home: TrackState = { ...EMPTY_TRACK_STATE, lastValid: { lat: 39.287301, lng: -76.800455, fixTime: NOW - 40 * 60_000 }, lastFixTime: NOW - 3 * 60_000 };
    const fake = { ...base, fixTime: NOW, satellites: null, ignition: null, lat: 39.287477, lng: -76.800371, speedKph: 20.2, accuracyM: 43.2 };
    const r = filterPosition(fake, home, ctx);
    expect(r.flags & POSITION_FLAGS.DRIFT).toBeTruthy();
    expect(r.speedKph).toBe(0);
    expect([r.lat, r.lng]).toEqual([39.287301, -76.800455]);
    // Really starting to drive: 20 km/h over 10 s from a fresh anchor is ~55 m, beyond the ±43 m wobble → movement.
    const fresh: TrackState = { ...home, lastValid: { lat: 39.287301, lng: -76.800455, fixTime: NOW - 10_000 } };
    const drive = { ...fake, lat: 39.287301 + 0.0005 };
    expect(filterPosition(drive, fresh, ctx).flags & POSITION_FLAGS.DRIFT).toBe(0);
  });

  it('accepts a normal first point and makes it the last valid point', () => {
    const r = filterPosition(base, EMPTY_TRACK_STATE, ctx);
    expect(r.flags).toBe(0);
    expect(r.updatesLive).toBe(true);
    expect(r.next.lastValid).toEqual({ lat: 13.05, lng: 80.25, fixTime: base.fixTime });
    expect(r.next.lastFixTime).toBe(base.fixTime);
  });

  it.each([
    ['valid=false', { valid: false }],
    ['0/0 coordinates', { lat: 0, lng: 0 }],
    ['too few satellites', { satellites: 2 }],
  ])('flags INVALID_FIX for %s and keeps last valid coordinates', (_name, patch) => {
    const r = filterPosition({ ...base, lat: 13.06, ...patch }, anchored, ctx);
    expect(r.flags & POSITION_FLAGS.INVALID_FIX).toBeTruthy();
    expect([r.lat, r.lng]).toEqual([13.05, 80.25]);
    expect(r.speedKph).toBe(0);
    expect(r.updatesLive).toBe(true);
    expect(r.next.lastFixTime).toBe(base.fixTime);
  });

  it('flags JUMP when the implied speed is impossible', () => {
    // ~11 km in 10 s
    const r = filterPosition({ ...base, lat: 13.15 }, anchored, ctx);
    expect(r.flags).toBe(POSITION_FLAGS.JUMP);
    expect(r.lat).toBe(13.05);
    expect(r.next.jumpStreak).toBe(1);
  });

  it('accepts the new location after repeated jumps (stale anchor)', () => {
    let state = anchored;
    const flags: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = filterPosition({ ...base, lat: 13.15, fixTime: base.fixTime + i * 1000 }, state, ctx);
      flags.push(r.flags);
      state = r.next;
    }
    expect(flags).toEqual([POSITION_FLAGS.JUMP, POSITION_FLAGS.JUMP, 0]);
    expect(state.lastValid?.lat).toBe(13.15);
  });

  it('allows the same distance for a plausible time gap', () => {
    const r = filterPosition({ ...base, lat: 13.15, fixTime: NOW }, { ...anchored, lastValid: { lat: 13.05, lng: 80.25, fixTime: NOW - 600_000 } }, ctx);
    expect(r.flags).toBe(0);
  });

  it('flags DRIFT for small movement while parked and freezes coordinates', () => {
    const r = filterPosition({ ...base, lat: 13.0501, speedKph: 1, ignition: false }, anchored, ctx);
    expect(r.flags).toBe(POSITION_FLAGS.DRIFT);
    expect(r.lat).toBe(13.05);
    expect(r.next.lastValid).toEqual(anchored.lastValid);
  });

  // Concox V5 861896070025993 indoors (2026-10-20): 4-6 satellites, ignition off, the fix wanders 13-60 m and the
  // device reports 6-9 km/h at identical coordinates.
  it('treats a weak fix with fake low speed as drift: marker stays, speed 0', () => {
    const weakAnchor: TrackState = { ...anchored, lastValid: { lat: 12.972, lng: 80.18572, fixTime: NOW - 20_000 } };
    for (const [lat, lng, kph, sats] of [
      [12.97226, 80.18554, 9, 5],
      [12.97235, 80.1853, 7, 6],
      [12.97202, 80.18547, 6, 4],
    ] as const) {
      const r = filterPosition({ ...base, lat, lng, speedKph: kph, satellites: sats, ignition: false }, weakAnchor, ctx);
      expect([lat, sats, r.flags, r.speedKph]).toEqual([lat, sats, POSITION_FLAGS.DRIFT, 0]);
      expect(r.lat).toBe(12.972);
      expect(r.speedKph).toBe(0);
    }
  });

  it('ignition off: low noisy speed near the parked point is drift even with good satellites', () => {
    const r = filterPosition({ ...base, lat: 13.0502, speedKph: 8, ignition: false }, anchored, ctx);
    expect(r.flags).toBe(POSITION_FLAGS.DRIFT);
    expect(r.speedKph).toBe(0);
  });

  it('still accepts real movement: beyond the weak-fix radius, or above the noise speed', () => {
    const far = filterPosition({ ...base, lat: 13.0512, speedKph: 9, satellites: 5, ignition: false }, anchored, ctx); // ~130 m
    expect(far.flags).toBe(0);
    const fast = filterPosition({ ...base, lat: 13.0503, speedKph: 25, satellites: 5, ignition: null }, anchored, ctx);
    expect(fast.flags).toBe(0);
    expect(fast.speedKph).toBe(25);
  });

  it('does not flag DRIFT when ignition is on', () => {
    const r = filterPosition({ ...base, lat: 13.0501, speedKph: 1, ignition: true }, anchored, ctx);
    expect(r.flags).toBe(0);
  });

  it('flags FUTURE and does not touch live state', () => {
    const r = filterPosition({ ...base, fixTime: NOW + 6 * 60_000 }, anchored, ctx);
    expect(r.flags & POSITION_FLAGS.FUTURE).toBeTruthy();
    expect(r.updatesLive).toBe(false);
    expect(r.next).toBe(anchored);
  });

  it('flags LATE for out-of-order points and does not touch live state', () => {
    const r = filterPosition({ ...base, fixTime: NOW - 30_000 }, anchored, ctx);
    expect(r.flags).toBe(POSITION_FLAGS.LATE);
    expect(r.updatesLive).toBe(false);
    expect(r.next).toBe(anchored);
  });
});
