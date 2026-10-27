import { POSITION_FLAGS } from '@veetracer/shared';
import { isParkedRepeat, ParkedInput, PARKED_KEEP_MS } from './parked-thinning';

const T0 = Date.parse('2026-10-27T10:00:00Z');
const base: ParkedInput = {
  speedKph: 0,
  flags: 0,
  lat: 13.0827,
  lng: 80.2707,
  accuracyM: 80,
  fixTime: T0 + 60_000,
  alarm: false,
  statusChanged: false,
  lastValid: { lat: 13.0827, lng: 80.2707 },
  storedAt: T0,
};

describe('isParkedRepeat', () => {
  it('skips a parked heartbeat at the same place', () => {
    expect(isParkedRepeat(base)).toBe(true);
  });

  it('skips a drift-frozen point even when its raw position is far off', () => {
    expect(isParkedRepeat({ ...base, flags: POSITION_FLAGS.DRIFT, lat: 13.09, accuracyM: 10 })).toBe(true);
  });

  it('keeps one parked point every PARKED_KEEP_MS', () => {
    expect(isParkedRepeat({ ...base, fixTime: T0 + PARKED_KEEP_MS - 1 })).toBe(true);
    expect(isParkedRepeat({ ...base, fixTime: T0 + PARKED_KEEP_MS })).toBe(false);
  });

  it('keeps moving points, alarms and status changes', () => {
    expect(isParkedRepeat({ ...base, speedKph: 12 })).toBe(false);
    expect(isParkedRepeat({ ...base, alarm: true })).toBe(false);
    expect(isParkedRepeat({ ...base, statusChanged: true })).toBe(false);
  });

  it('keeps a point outside the accuracy radius (it moved)', () => {
    // ~220 m north, accuracy 80 m
    expect(isParkedRepeat({ ...base, lat: 13.0847 })).toBe(false);
  });

  it('uses at least 30 m for very accurate fixes', () => {
    // ~22 m north, accuracy 5 m: still the same place
    expect(isParkedRepeat({ ...base, lat: 13.0829, accuracyM: 5 })).toBe(true);
  });

  it('stores when nothing was stored yet or the time goes backwards', () => {
    expect(isParkedRepeat({ ...base, storedAt: null })).toBe(false);
    expect(isParkedRepeat({ ...base, fixTime: T0 - 1 })).toBe(false);
  });

  it('stores when there is no trusted point to compare with', () => {
    expect(isParkedRepeat({ ...base, lastValid: null })).toBe(false);
  });
});
