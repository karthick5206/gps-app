import { fillLegs, parseGraphHopperRoute, parseValhallaTrip } from './route-via';

// Google's documented polyline example at precision 5: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
const P5 = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

describe('parseGraphHopperRoute', () => {
  it('decodes the path as [lng, lat] and converts time to seconds', () => {
    const r = parseGraphHopperRoute({ paths: [{ distance: 1234.6, time: 61_500, points: P5, points_encoded_multiplier: 1e5 }] });
    expect(r).toEqual({
      path: [
        [-120.2, 38.5],
        [-120.95, 40.7],
        [-126.453, 43.252],
      ],
      distanceM: 1235,
      durationSec: 62,
    });
  });

  it('defaults to precision 5 when the multiplier is missing', () => {
    expect(parseGraphHopperRoute({ paths: [{ distance: 1, time: 1000, points: P5 }] })?.path[0]).toEqual([-120.2, 38.5]);
  });

  it('returns null for an unusable answer', () => {
    expect(parseGraphHopperRoute({})).toBeNull();
    expect(parseGraphHopperRoute(null)).toBeNull();
    expect(parseGraphHopperRoute({ paths: [{ distance: 1, time: 1, points: '' }] })).toBeNull();
  });
});

describe('parseValhallaTrip', () => {
  // Precision 6 shapes: leg 1 (1,1)→(2,2), leg 2 (2,2)→(3,3).
  const enc = (pts: [number, number][]) => {
    let out = '';
    let pl = 0;
    let pg = 0;
    const one = (v: number) => {
      let n = v < 0 ? ~(v << 1) : v << 1;
      let s = '';
      while (n >= 0x20) {
        s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
        n >>= 5;
      }
      return s + String.fromCharCode(n + 63);
    };
    for (const [lat, lng] of pts) {
      const a = Math.round(lat * 1e6);
      const b = Math.round(lng * 1e6);
      out += one(a - pl) + one(b - pg);
      pl = a;
      pg = b;
    }
    return out;
  };

  it('joins leg shapes without repeating the shared point and keeps per-leg values', () => {
    const json = {
      trip: {
        legs: [
          { shape: enc([[1, 1], [2, 2]]), summary: { length: 1.5, time: 100.4 } },
          { shape: enc([[2, 2], [3, 3]]), summary: { length: 2, time: 200 } },
        ],
      },
    };
    expect(parseValhallaTrip(json, 3)).toEqual({
      path: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      distanceM: 3500,
      durationSec: 300,
      legs: [
        { distanceM: 1500, durationSec: 100 },
        { distanceM: 2000, durationSec: 200 },
      ],
    });
  });

  it('returns null when the leg count does not match the points', () => {
    expect(parseValhallaTrip({ trip: { legs: [] } }, 3)).toBeNull();
  });
});

describe('fillLegs', () => {
  const points = [
    { lat: 13, lng: 80 },
    { lat: 13.01, lng: 80 },
    { lat: 13.03, lng: 80 },
  ];

  it('keeps routed legs', () => {
    const legs = [
      { distanceM: 1, durationSec: 2 },
      { distanceM: 3, durationSec: 4 },
    ];
    expect(fillLegs(points, legs, 100, 100)).toEqual(legs);
  });

  it('splits the remainder of the total over missing legs by straight length', () => {
    expect(fillLegs(points, [null, null], 3000, 300)).toEqual([
      { distanceM: 1000, durationSec: 100 },
      { distanceM: 2000, durationSec: 200 },
    ]);
    expect(fillLegs(points, [{ distanceM: 1200, durationSec: 90 }, null], 3000, 300)).toEqual([
      { distanceM: 1200, durationSec: 90 },
      { distanceM: 1800, durationSec: 210 },
    ]);
  });
});
