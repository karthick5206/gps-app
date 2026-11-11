import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordsBounds, corridorLineWidth, metresPerPixel, midLatitude } from './corridor.ts';

const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('metresPerPixel: equator, zoom 0 and halving per zoom level', () => {
  close(metresPerPixel(0, 0), 78_271.517, 0.01);
  close(metresPerPixel(1, 0), 78_271.517 / 2, 0.01);
  // cos(60°) = 0.5
  close(metresPerPixel(10, 60), 78_271.517 / 1024 / 2, 0.001);
});

test('corridorLineWidth draws the full width (2 × half-width) in pixels at any zoom', () => {
  const lat = 13.08;
  const expr = corridorLineWidth(200, lat);
  assert.deepEqual(expr.slice(0, 3), ['interpolate', ['exponential', 2], ['zoom']]);
  const [, , , z0, w0, z1, w1] = expr;
  assert.equal(z0, 0);
  assert.equal(z1, 24);
  close(w0 * metresPerPixel(0, lat), 400, 1e-6);
  close(w1 * metresPerPixel(24, lat), 400, 1e-6);
  // Exponential base 2 between the stops gives the exact width at an intermediate zoom.
  const z = 15;
  const wz = w0 * 2 ** z;
  close(wz * metresPerPixel(z, lat), 400, 1e-6);
});

test('corridorLineWidth clamps negative widths to 0', () => {
  const expr = corridorLineWidth(-5, 0);
  assert.equal(expr[4], 0);
  assert.equal(expr[6], 0);
});

test('midLatitude and coordsBounds', () => {
  assert.equal(midLatitude([]), 0);
  assert.equal(midLatitude([[80, 12], [81, 14], [80.5, 13.5]]), 13);
  assert.equal(coordsBounds([]), null);
  assert.deepEqual(coordsBounds([[80, 12], [81, 14], [79.5, 13]]), [
    [79.5, 12],
    [81, 14],
  ]);
});
