import { decodePolyline, plausibleRoute } from './route-estimate';

describe('decodePolyline', () => {
  it('decodes the reference example at precision 5', () => {
    // Google's documented example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('returns nothing for an empty string', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('plausibleRoute', () => {
  // Chennai: Egmore to Marina, ~3.2 km straight.
  const gap = { fromLat: 13.0741, fromLng: 80.2637, toLat: 13.05, toLng: 80.2785, seconds: 15 * 60 };

  it('accepts a normal road route', () => {
    expect(plausibleRoute(gap, 4_500, 12 * 60)).toBe(true);
  });

  it('rejects a long detour', () => {
    expect(plausibleRoute(gap, 20_000, 30 * 60)).toBe(false);
  });

  it('rejects a route that cannot be driven in the gap time', () => {
    expect(plausibleRoute({ ...gap, seconds: 5 * 60 }, 4_500, 25 * 60)).toBe(false);
  });

  it('ignores the time check when the gap time is unknown', () => {
    expect(plausibleRoute({ ...gap, seconds: 0 }, 4_500, 25 * 60)).toBe(true);
  });

  it('does not guess very long gaps', () => {
    expect(plausibleRoute({ ...gap, toLat: 15.0, toLng: 80.2785, seconds: 6 * 3600 }, 230_000, 4 * 3600)).toBe(false);
  });
});
