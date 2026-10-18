import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  areaM2,
  bbox,
  circleRing,
  destination,
  distanceToSegmentM,
  formatArea,
  formatRadius,
  haversineM,
  labelPoint,
  pointInGeometry,
  pointInPolygon,
  rectangleFromCorners,
  validateGeometry,
} from './geometry.ts';

const chennai = { lat: 13.0827, lng: 80.2707 };

test('haversine and destination agree', () => {
  for (const brg of [0, 45, 90, 180, 270, 333]) {
    const p = destination(chennai, 1000, brg);
    assert.ok(Math.abs(haversineM(chennai, p) - 1000) < 0.5, `bearing ${brg}`);
  }
  // 1 degree of latitude ≈ 111.2 km
  assert.ok(Math.abs(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111_195) < 50);
});

test('circleRing is closed with every vertex at the radius', () => {
  const ring = circleRing(chennai, 300, 32);
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring[32]);
  for (const [lng, lat] of ring) assert.ok(Math.abs(haversineM(chennai, { lat, lng }) - 300) < 0.5);
});

test('rectangleFromCorners normalises any drag direction to NW, NE, SE, SW', () => {
  const a = { lat: 13.1, lng: 80.3 };
  const b = { lat: 13.0, lng: 80.2 };
  const expected = [
    { lat: 13.1, lng: 80.2 },
    { lat: 13.1, lng: 80.3 },
    { lat: 13.0, lng: 80.3 },
    { lat: 13.0, lng: 80.2 },
  ];
  assert.deepEqual(rectangleFromCorners(a, b), expected);
  assert.deepEqual(rectangleFromCorners(b, a), expected);
  assert.deepEqual(rectangleFromCorners({ lat: 13.1, lng: 80.2 }, { lat: 13.0, lng: 80.3 }), expected);
});

test('pointInPolygon handles concave shapes', () => {
  // U shape opening north
  const u = [
    { lat: 0, lng: 0 },
    { lat: 3, lng: 0 },
    { lat: 3, lng: 1 },
    { lat: 1, lng: 1 },
    { lat: 1, lng: 2 },
    { lat: 3, lng: 2 },
    { lat: 3, lng: 3 },
    { lat: 0, lng: 3 },
  ];
  assert.equal(pointInPolygon({ lat: 0.5, lng: 1.5 }, u), true); // base
  assert.equal(pointInPolygon({ lat: 2, lng: 0.5 }, u), true); // left arm
  assert.equal(pointInPolygon({ lat: 2, lng: 1.5 }, u), false); // notch
  assert.equal(pointInPolygon({ lat: 4, lng: 1.5 }, u), false); // outside
});

test('pointInGeometry for circles uses metres', () => {
  const g = { type: 'CIRCLE' as const, center: chennai, radiusM: 500 };
  assert.equal(pointInGeometry(destination(chennai, 499, 10), g), true);
  assert.equal(pointInGeometry(destination(chennai, 501, 10), g), false);
});

test('bbox, labelPoint and area', () => {
  const rect = { type: 'RECTANGLE' as const, points: rectangleFromCorners({ lat: 0, lng: 0 }, { lat: 0.01, lng: 0.01 }) };
  assert.deepEqual(bbox(rect), { west: 0, south: 0, east: 0.01, north: 0.01 });
  assert.deepEqual(labelPoint(rect), { lat: 0.005, lng: 0.005 });
  // ~1.112 km × 1.112 km at the equator
  assert.ok(Math.abs(areaM2(rect) - 1_236_400) / 1_236_400 < 0.01);
  const circle = { type: 'CIRCLE' as const, center: chennai, radiusM: 1000 };
  const b = bbox(circle);
  assert.ok(Math.abs(haversineM(chennai, { lat: b.north, lng: chennai.lng }) - 1000) < 1);
  assert.ok(Math.abs(areaM2(circle) - Math.PI * 1e6) < 1);
});

test('validateGeometry enforces API limits', () => {
  assert.match(validateGeometry(null)!, /Draw/);
  assert.equal(validateGeometry({ type: 'CIRCLE', center: chennai, radiusM: 20 }), null);
  assert.match(validateGeometry({ type: 'CIRCLE', center: chennai, radiusM: 19 })!, /20 m/);
  assert.match(validateGeometry({ type: 'CIRCLE', center: chennai, radiusM: 50_001 })!, /50 km/);
  assert.match(validateGeometry({ type: 'POLYGON', points: [chennai, chennai] })!, /3 points/);
  assert.match(validateGeometry({ type: 'RECTANGLE', points: [chennai, chennai, chennai] })!, /4 corners/);
});

test('distanceToSegmentM', () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0, lng: 0.01 };
  const p = destination({ lat: 0, lng: 0.005 }, 100, 0);
  assert.ok(Math.abs(distanceToSegmentM(p, a, b) - 100) < 1);
  assert.ok(Math.abs(distanceToSegmentM({ lat: 0, lng: -0.001 }, a, b) - 111.2) < 1);
});

test('formatters', () => {
  assert.equal(formatRadius(300), '300 m');
  assert.equal(formatRadius(1250), '1.3 km');
  assert.equal(formatRadius(25_000), '25 km');
  assert.equal(formatArea(500), '500 m²');
  assert.equal(formatArea(45_000), '4.5 ha');
  assert.equal(formatArea(2_100_000), '2.1 km²');
});
