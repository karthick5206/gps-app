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
