import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewCsv, previewGeoJson, splitCsvLine } from './import-parse.ts';

test('splitCsvLine handles quotes', () => {
  assert.deepEqual(splitCsvLine('"Depot, North",13.1,80.2,300'), ['Depot, North', '13.1', '80.2', '300']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
});

test('previewCsv skips header and invalid rows', () => {
  const p = previewCsv('name,lat,lng,radiusM\nDepot,13.08,80.27,300\nBad,abc,80,100\nTiny,13,80,5\n"Yard, East",13.1,80.3,1000\n');
  assert.equal(p.total, 2);
  assert.deepEqual(p.names, ['Depot', 'Yard, East']);
  assert.equal(p.skipped.length, 2);
});

test('previewGeoJson counts polygons and radius points', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { name: 'Estate' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [80, 13] }, properties: { name: 'Depot', radius: 300 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [80, 13] }, properties: { name: 'Pin' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
    ],
  };
  const p = previewGeoJson(JSON.stringify(fc));
  assert.equal(p.total, 2);
  assert.equal(p.polygons, 1);
  assert.equal(p.circles, 1);
  assert.equal(p.skipped.length, 2);
  assert.throws(() => previewGeoJson('{"type":"Feature"}'), /FeatureCollection/);
  assert.throws(() => previewGeoJson('nope'), /JSON/);
});
