import { cleanDays, corridorError, normaliseStops, scheduleError, suggestOffsets } from './route-stops';

const a = { name: 'Depot', lat: 13.08, lng: 80.27 };
const b = { name: 'School', lat: 13.05, lng: 80.25, offsetMin: 30 };

describe('normaliseStops', () => {
  it('applies defaults and numbers stops from 0', () => {
    const r = normaliseStops([a, { ...b, waitMin: 5, radiusM: 150 }]);
    expect(r).toEqual({
      ok: true,
      stops: [
        { seq: 0, name: 'Depot', lat: 13.08, lng: 80.27, radiusM: 100, offsetMin: 0, waitMin: 0, geofenceId: null },
        { seq: 1, name: 'School', lat: 13.05, lng: 80.25, radiusM: 150, offsetMin: 30, waitMin: 5, geofenceId: null },
      ],
    });
  });

  it('trims names', () => {
    const r = normaliseStops([{ ...a, name: '  Depot ' }, b]);
    expect(r.ok && r.stops[0].name).toBe('Depot');
  });

  it('needs at least two stops', () => {
    expect(normaliseStops([a])).toEqual({ ok: false, error: 'A route needs at least 2 stops' });
  });

  it('rejects too many stops', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...a, offsetMin: i }));
    expect(normaliseStops(many).ok).toBe(false);
  });

  it('requires the start stop at offset 0', () => {
    expect(normaliseStops([{ ...a, offsetMin: 5 }, b])).toEqual({ ok: false, error: 'The start stop must have an arrival offset of 0' });
  });

  it('rejects decreasing offsets but accepts equal ones', () => {
    expect(normaliseStops([a, b, { ...b, name: 'C', offsetMin: 20 }]).ok).toBe(false);
    expect(normaliseStops([a, b, { ...b, name: 'C', offsetMin: 30 }]).ok).toBe(true);
  });

  it('defaults a missing offset to the previous stop', () => {
    const r = normaliseStops([a, b, { name: 'C', lat: 13, lng: 80 }]);
    expect(r.ok && r.stops[2].offsetMin).toBe(30);
  });

  it('checks ranges', () => {
    expect(normaliseStops([{ ...a, radiusM: 10 }, b]).ok).toBe(false);
    expect(normaliseStops([{ ...a, radiusM: 2001 }, b]).ok).toBe(false);
    expect(normaliseStops([a, { ...b, radiusM: 20.5 }]).ok).toBe(false);
    expect(normaliseStops([{ ...a, lat: 91 }, b]).ok).toBe(false);
    expect(normaliseStops([{ ...a, lng: -181 }, b]).ok).toBe(false);
    expect(normaliseStops([{ ...a, lat: Number.NaN }, b]).ok).toBe(false);
    expect(normaliseStops([a, { ...b, waitMin: -1 }]).ok).toBe(false);
    expect(normaliseStops([{ ...a, name: ' ' }, b]).ok).toBe(false);
  });
});

describe('corridorError', () => {
  it('accepts 50–2000 m integers', () => {
    expect(corridorError(50)).toBeNull();
    expect(corridorError(2000)).toBeNull();
    expect(corridorError(49)).not.toBeNull();
    expect(corridorError(2001)).not.toBeNull();
    expect(corridorError(100.5)).not.toBeNull();
  });
});

describe('suggestOffsets', () => {
  it('adds the previous wait and the leg time rounded up', () => {
    expect(suggestOffsets([600, 61, 0], [0, 5, 10])).toEqual([0, 10, 17, 27]);
  });
});

describe('scheduleError', () => {
  it('accepts a valid schedule', () => {
    expect(scheduleError({ days: [1, 2, 3], startMin: 450, validFrom: '2026-11-01', validTo: '2026-12-31' })).toBeNull();
  });

  it('rejects bad days, times and dates', () => {
    expect(scheduleError({ days: [] })).toBe('Choose at least one day');
    expect(scheduleError({ days: [7] })).not.toBeNull();
    expect(scheduleError({ startMin: 1440 })).not.toBeNull();
    expect(scheduleError({ startMin: -1 })).not.toBeNull();
    expect(scheduleError({ validFrom: '2026-02-30' })).not.toBeNull();
    expect(scheduleError({ validFrom: '2026-12-01', validTo: '2026-11-01' })).toBe('Valid from must not be after valid to');
  });

  it('sorts and de-duplicates days', () => {
    expect(cleanDays([3, 1, 3, 0])).toEqual([0, 1, 3]);
  });
});
