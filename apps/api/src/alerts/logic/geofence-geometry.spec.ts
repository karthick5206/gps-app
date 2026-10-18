import { GeofenceGeometry } from '@veetracer/shared';
import { containsPoint, geometryBBox, inBBox, MembershipState, signedDistanceM, updateMembership, validateGeometry } from './geofence-geometry';

const circle: GeofenceGeometry = { type: 'CIRCLE', center: { lat: 13.06, lng: 80.25 }, radiusM: 300 };
const square: GeofenceGeometry = {
  type: 'POLYGON',
  points: [
    { lat: 13.0, lng: 80.2 },
    { lat: 13.0, lng: 80.21 },
    { lat: 13.01, lng: 80.21 },
    { lat: 13.01, lng: 80.2 },
  ],
};
const M_PER_DEG_LAT = 110_574;

describe('geofence geometry', () => {
  it('validates geometry limits', () => {
    expect(validateGeometry(circle)).toBeNull();
    expect(validateGeometry({ ...circle, radiusM: 10 })).toMatch(/radius/);
    expect(validateGeometry({ ...circle, radiusM: 60_000 })).toMatch(/radius/);
    expect(validateGeometry({ type: 'POLYGON', points: square.type === 'POLYGON' ? square.points.slice(0, 2) : [] })).toMatch(/3–500/);
    expect(validateGeometry({ type: 'RECTANGLE', points: square.type === 'POLYGON' ? square.points.slice(0, 3) : [] })).toMatch(/exactly 4/);
    expect(validateGeometry({ type: 'TRIANGLE' })).toMatch(/type/);
    expect(validateGeometry({ type: 'CIRCLE', center: { lat: 100, lng: 0 }, radiusM: 100 })).toMatch(/centre/);
  });

  it('point in circle and polygon with signed distance', () => {
    expect(containsPoint(circle, 13.06, 80.25)).toBe(true);
    expect(signedDistanceM(circle, 13.06, 80.25)).toBeCloseTo(-300, 0);
    const north = 13.06 + 310 / M_PER_DEG_LAT; // ~10 m outside
    expect(signedDistanceM(circle, north, 80.25)).toBeGreaterThan(5);
    expect(signedDistanceM(circle, north, 80.25)).toBeLessThan(15);
    expect(containsPoint(square, 13.005, 80.205)).toBe(true);
    expect(containsPoint(square, 13.02, 80.205)).toBe(false);
    // 10 m south of the southern edge.
    const d = signedDistanceM(square, 13.0 - 10 / M_PER_DEG_LAT, 80.205);
    expect(d).toBeGreaterThan(9);
    expect(d).toBeLessThan(11);
    // Inside, ~20 m from the western edge.
    expect(signedDistanceM(square, 13.005, 80.2 + 20 / (111_320 * Math.cos((13.005 * Math.PI) / 180)))).toBeCloseTo(-20, 0);
  });

  it('bbox pre-filter with margin', () => {
    const b = geometryBBox(circle);
    expect(inBBox(b, 13.06, 80.25)).toBe(true);
    expect(inBBox(b, 13.0631, 80.25)).toBe(false); // ~343 m north
    expect(inBBox(b, 13.0631, 80.25, 50)).toBe(true);
  });

  describe('anti-flapping membership', () => {
    const outside: MembershipState = { inside: false, since: 0, pendingCount: 0, pendingSince: null };

    it('needs two consecutive inside points to enter, enter time = first of them', () => {
      const a = updateMembership(outside, -5, 1000);
      expect(a.event).toBeNull();
      expect(a.state.inside).toBe(false);
      const b = updateMembership(a.state, -8, 2000);
      expect(b.event).toBe('ENTER');
      expect(b.at).toBe(1000);
      expect(b.state).toEqual({ inside: true, since: 1000, pendingCount: 0, pendingSince: null });
    });

    it('a single stray point does not flip', () => {
      const a = updateMembership(outside, -5, 1000);
      const b = updateMembership(a.state, 40, 2000);
      expect(b.event).toBeNull();
      expect(b.state.pendingCount).toBe(0);
      const c = updateMembership(b.state, -5, 3000);
      expect(c.event).toBeNull(); // counting restarts
    });

    it('exit needs to be beyond the 15 m buffer twice', () => {
      const inside: MembershipState = { inside: true, since: 0, pendingCount: 0, pendingSince: null };
      // Jitter just outside the boundary (within the buffer) never exits.
      let s = inside;
      for (const d of [5, 12, 14, 3, 10]) {
        const r = updateMembership(s, d, 1000);
        expect(r.event).toBeNull();
        s = r.state;
      }
      const a = updateMembership(s, 20, 5000);
      expect(a.event).toBeNull();
      const b = updateMembership(a.state, 30, 6000);
      expect(b.event).toBe('EXIT');
      expect(b.at).toBe(5000);
    });

    it('first observation initialises without an event flip', () => {
      expect(updateMembership(undefined, -10, 1).event).toBe('INIT_INSIDE');
      expect(updateMembership(undefined, 10, 1).event).toBe('INIT_OUTSIDE');
    });
  });
});
