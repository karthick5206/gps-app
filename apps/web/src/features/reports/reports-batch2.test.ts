import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewExportBody, viewLabel } from './export-view.ts';
import { buildInsight, durationBinLabel, durationHistogram, fuelKmPerL, rankedFilter, reportRowKey, rowMatches } from './insights.ts';
import { alertsReportLink, parseReportLink } from './report-link.ts';

const TZ = 'Asia/Kolkata';
const base = { from: '2026-11-03', to: '2026-11-05', tz: TZ };

// ---------------------------------------------------------------- histograms

test('duration bin labels', () => {
  assert.equal(durationBinLabel(0, 300), '<5 min');
  assert.equal(durationBinLabel(300, 900), '5–15 min');
  assert.equal(durationBinLabel(1800, 3600), '30–60 min');
  assert.equal(durationBinLabel(3600, 7200), '1–2 h');
  assert.equal(durationBinLabel(28800, null), '8 h+');
});

test('duration histogram: counts per bucket, split by segment, trims empty ends, skips unknown durations', () => {
  const segs = [
    { key: 'parked', label: 'Parked', tone: 'stopped' as const },
    { key: 'idle', label: 'Idle', tone: 'idle' as const },
  ];
  const rows = [{ d: 400 }, { d: 899, i: true }, { d: 900 }, { d: 3 * 3600 }, { d: null }].map((r) => ({ durationSec: r.d, ignitionOn: !!r.i }));
  const h = durationHistogram(rows, 'durationSec', segs, (r) => (r.ignitionOn ? 'idle' : 'parked'));
  assert.deepEqual(
    h.bins.map((b) => [b.label, b.values.parked, b.values.idle]),
    [
      ['5–15 min', 1, 1],
      ['15–30 min', 1, 0],
      ['30–60 min', 0, 0],
      ['1–2 h', 0, 0],
      ['2–4 h', 1, 0],
    ],
  );
  assert.equal(h.skipped, 1);
  assert.deepEqual(durationHistogram([], 'durationSec', segs).bins, []);
});

// ---------------------------------------------------------------- batch-2 insights

const stop = (id: string, obj: string, min: number, idle: boolean, extra: Record<string, unknown> = {}) => ({
  id,
  objectId: obj,
  objectName: obj.toUpperCase(),
  startTime: '2026-11-03T05:00:00.000Z',
  endTime: '2026-11-03T06:00:00.000Z',
  durationSec: min * 60,
  ignitionOn: idle,
  address: null,
  poiName: null,
  ...extra,
});

test('STOPS: KPIs from totals, row-derived ones flagged; histogram, vehicles, places', () => {
  const rows = [stop('a', 'v1', 10, false, { poiName: 'Depot' }), stop('b', 'v1', 50, true, { poiName: 'Depot' }), stop('c', 'v2', 120, false, { address: 'MG Road' })];
  const ins = buildInsight({ ...base, type: 'STOPS', rows, totals: { count: 30, durationSec: 99_000 } })!;
  const k = Object.fromEntries(ins.kpis.map((x) => [x.id, x]));
  assert.equal(k.count.value, 30); // API total, not rows.length
  assert.equal(k.time.value, 99_000);
  assert.equal(k.avg.value, 3300);
  assert.equal(k.longest.value, 7200);
  assert.equal(k.longest.fromRows, true);
  assert.equal(k.idleStops.value, 1);
  assert.deepEqual(ins.charts.map((c) => c.kind), ['histogram', 'ranked', 'ranked']);
  const places = ins.charts[2];
  assert.ok(places.kind === 'ranked');
  assert.deepEqual(places.items.map((i) => [i.label, i.value]), [
    ['MG Road', 7200],
    ['Depot', 3600],
  ]);
  // A place click filters the table to that POI.
  const f = rankedFilter(places.select, places.items[1]);
  assert.deepEqual(rows.filter((r) => rowMatches('STOPS', r, f)).map((r) => r.id), ['a', 'b']);
});

test('HALT and IDLE use their own labels and a single segment', () => {
  const halt = buildInsight({ ...base, type: 'HALT', rows: [stop('a', 'v1', 40, false)], totals: { count: 1, durationSec: 2400 } })!;
  assert.equal(halt.kpis[0].label, 'Halts');
  assert.equal(halt.charts[0].kind === 'histogram' && halt.charts[0].segments.length, 1);
  const idle = buildInsight({ ...base, type: 'IDLE', rows: [stop('a', 'v1', 40, true)], totals: { count: 1, durationSec: 2400 } })!;
  assert.equal(idle.kpis[0].label, 'Idle stops');
  assert.equal(idle.kpis[1].tone, 'warning');
});

test('GEOFENCE_VISITS: open visits counted, average over completed rows, day bars on enter time', () => {
  const v = (id: string, g: string, enter: string, dur: number | null) => ({ objectId: 'v1', objectName: 'Bus', geofenceId: g, geofenceName: g.toUpperCase(), enterTime: enter, exitTime: dur === null ? null : enter, durationSec: dur, id });
  const rows = [v('1', 'g1', '2026-11-03T20:00:00.000Z', 600), v('2', 'g1', '2026-11-04T05:00:00.000Z', 1800), v('3', 'g2', '2026-11-04T06:00:00.000Z', null)];
  const ins = buildInsight({ ...base, type: 'GEOFENCE_VISITS', rows, totals: { count: 3, durationSec: 2400 } })!;
  const k = Object.fromEntries(ins.kpis.map((x) => [x.id, x.value]));
  assert.equal(k.open, 1);
  assert.equal(k.avg, 1200);
  const bars = ins.charts.find((c) => c.kind === 'bars');
  assert.ok(bars && bars.kind === 'bars');
  // 20:00 UTC on 3 Nov is 4 Nov in India.
  assert.deepEqual(bars.data.map((d) => d.values.visits), [0, 3, 0]);
  const hist = ins.charts.find((c) => c.kind === 'histogram');
  assert.equal(hist && hist.kind === 'histogram' && hist.skipped, 1);
  assert.equal(rowMatches('GEOFENCE_VISITS', rows[0], { kind: 'day', value: '2026-11-04' }, TZ), true);
});

test('GEOFENCE_SUMMARY and GEOFENCE_DISTANCE', () => {
  const sum = buildInsight({ ...base, type: 'GEOFENCE_SUMMARY', rows: [{ objectId: 'v1', objectName: 'Bus', geofenceId: 'g1', geofenceName: 'Depot', visits: 4, insideSec: 4000, lastExit: null }], totals: { visits: 4, insideSec: 4000 } })!;
  assert.equal(sum.kpis.find((k) => k.id === 'avg')!.value, 1000);
  const rows = [
    { objectId: 'v1', objectName: 'Bus', fromGeofenceName: 'A', toGeofenceName: 'B', inTime: '2026-11-03T06:00:00Z', travelSec: 1200, distanceKm: 10 },
    { objectId: 'v1', objectName: 'Bus', fromGeofenceName: 'A', toGeofenceName: null, inTime: null, travelSec: 600, distanceKm: 3 },
  ];
  const dist = buildInsight({ ...base, type: 'GEOFENCE_DISTANCE', rows, totals: { count: 2, travelSec: 1800, distanceKm: 13 } })!;
  assert.equal(dist.kpis.find((k) => k.id === 'pending')!.value, 1);
  const pairs = dist.charts[0];
  assert.ok(pairs.kind === 'ranked');
  assert.equal(pairs.items[0].label, 'A → B');
  const f = rankedFilter(pairs.select, pairs.items[0]);
  assert.deepEqual(f, { kind: 'pair', from: 'A', to: 'B', label: 'A → B' });
  assert.equal(rowMatches('GEOFENCE_DISTANCE', rows[0], f), true);
  assert.equal(rowMatches('GEOFENCE_DISTANCE', rows[1], f), false);
});

test('FUEL: KPIs from totals (km/L 0 = not enough data), per-day bars on the row day', () => {
  const rows = [
    { objectId: 'v1', objectName: 'Truck', day: '2026-11-03', consumptionL: 20, refillL: 50, drainL: 0, distanceKm: 200 },
    { objectId: 'v1', objectName: 'Truck', day: '2026-11-04', consumptionL: 10, refillL: 0, drainL: 8, distanceKm: 90 },
  ];
  const ins = buildInsight({ ...base, type: 'FUEL', rows, totals: { vehicles: 1, refills: 1, refillL: 50, drains: 1, drainL: 8, consumptionL: 30, distanceKm: 290, kmPerL: 0 } })!;
  const k = Object.fromEntries(ins.kpis.map((x) => [x.id, x]));
  assert.equal(k.kmPerL.value, null);
  assert.equal(k.drained.tone, 'danger');
  const bars = ins.charts[0];
  assert.ok(bars.kind === 'bars');
  assert.deepEqual(bars.data.map((d) => d.values.consumed), [20, 10, 0]);
  assert.equal(rowMatches('FUEL', rows[1], { kind: 'day', value: '2026-11-04' }, TZ), true);
  assert.equal(fuelKmPerL(290, 30), 9.67);
  assert.equal(fuelKmPerL(0.5, 30), null);
});

test('FUEL_EVENTS and DRIVERS', () => {
  const ev = buildInsight({
    ...base,
    type: 'FUEL_EVENTS',
    rows: [
      { objectId: 'v1', objectName: 'Truck', type: 'REFILL', startTime: '2026-11-03T05:00:00Z', deltaL: 40 },
      { objectId: 'v1', objectName: 'Truck', type: 'DRAIN', startTime: '2026-11-03T09:00:00Z', deltaL: 12 },
    ],
    totals: { count: 2, refills: 1, refillL: 40, drains: 1, drainL: 12 },
  })!;
  const day = ev.charts[0];
  assert.ok(day.kind === 'bars');
  assert.deepEqual(day.data[0].values, { REFILL: 1, DRAIN: 1 });
  const drained = ev.charts[1];
  assert.ok(drained.kind === 'ranked');
  assert.deepEqual(drained.items.map((i) => i.value), [12]);

  const drv = buildInsight({
    ...base,
    type: 'DRIVERS',
    rows: [
      { driverId: 'd1', driverName: 'Ravi', employeeId: 'E1', distanceKm: 100, drivingSec: 7200, overspeedCount: 2 },
      { driverId: 'd2', driverName: 'Anu', employeeId: null, distanceKm: 300, drivingSec: 3600, overspeedCount: 0 },
    ],
    totals: { drivers: 2, sessions: 3, tripCount: 9, distanceKm: 400, drivingSec: 10_800, maxSpeedKph: 88, overspeedCount: 2 },
  })!;
  assert.equal(drv.kpis[0].value, 2);
  const km = drv.charts[0];
  assert.ok(km.kind === 'ranked');
  assert.deepEqual(km.items.map((i) => i.label), ['Anu', 'Ravi']);
  const f = rankedFilter(km.select, km.items[1]);
  assert.deepEqual(f, { kind: 'field', field: 'driverId', value: 'd1', label: 'Ravi', prefix: 'Driver' });
  assert.equal(drv.charts.length, 3); // overspeed by driver only when someone overspeeded
});

test('TRIPS gains a duration histogram; batch-1 charts unchanged', () => {
  const rows = [{ objectId: 'v1', objectName: 'Bus', startTime: '2026-11-03T05:00:00Z', distanceKm: 5, durationSec: 600 }];
  const ins = buildInsight({ ...base, type: 'TRIPS', rows, totals: { count: 1, distanceKm: 5, durationSec: 600, maxSpeedKph: 50 } })!;
  assert.deepEqual(ins.charts.map((c) => c.kind), ['bars', 'ranked', 'histogram']);
  assert.equal(rowMatches('TRIPS', rows[0], { kind: 'bucket', field: 'durationSec', min: 300, max: 900, label: '5–15 min' }), true);
  assert.equal(rowMatches('TRIPS', rows[0], { kind: 'bucket', field: 'durationSec', min: 900, max: null, label: '' }), false);
});

// ---------------------------------------------------------------- row keys / filtered view

test('row keys: 8 chars, stable, ignore address fields, differ on data', () => {
  const r = { objectId: 'v1', startTime: '2026-11-03T05:00:00Z', durationSec: 600, startAddress: null };
  const k = reportRowKey(r);
  assert.match(k, /^[0-9a-z]{8}$/);
  assert.equal(reportRowKey({ ...r, startAddress: 'MG Road' }), k);
  assert.notEqual(reportRowKey({ ...r, durationSec: 601 }), k);
  // Same as the key of the row after a JSON round trip (what the page holds).
  assert.equal(reportRowKey(JSON.parse(JSON.stringify(r))), k);
});

test('view export body: keys in table order, hidden headers, label', () => {
  const rows = [{ a: 1 }, { a: 2 }];
  const body = viewExportBody({ rows, hiddenHeaders: ['Idle'], label: viewLabel('Vehicle: Bus 07', ' depot '), differs: true });
  assert.equal(body.rows, reportRowKey(rows[0]) + reportRowKey(rows[1]));
  assert.deepEqual(body.hiddenColumns, ['Idle']);
  assert.equal(body.label, 'Vehicle: Bus 07 · “depot”');
  assert.equal(viewLabel(null, ''), '');
});

// ---------------------------------------------------------------- heatmap → Alerts link

test('alerts link round-trips through the page pre-fill', () => {
  const href = alertsReportLink({ objectId: '3f2b8c1e-1111-4222-8333-444455556666', objectName: 'Bus 07', alertType: 'OVERSPEED', from: '2026-11-03', to: '2026-11-09' });
  assert.ok(href.startsWith('/reports?type=ALERTS&'));
  const link = parseReportLink(href.slice(href.indexOf('?')), ['ALERTS', 'TRIPS']);
  assert.deepEqual(link, { type: 'ALERTS', from: '2026-11-03', to: '2026-11-09', objectIds: ['3f2b8c1e-1111-4222-8333-444455556666'], vehicleName: 'Bus 07', alertTypes: ['OVERSPEED'], run: true });
});

test('page pre-fill ignores malformed values', () => {
  assert.equal(parseReportLink('?type=NOPE', ['ALERTS']), null);
  assert.deepEqual(parseReportLink('?type=ALERTS', ['ALERTS']), { type: 'ALERTS', from: '', to: '', objectIds: [], vehicleName: undefined, alertTypes: [], run: false });
  const bad = parseReportLink('?type=ALERTS&from=2026-11-09&to=2026-11-03&vehicle=x&alertType=drop%20table&run=1', ['ALERTS'])!;
  assert.deepEqual([bad.from, bad.objectIds, bad.alertTypes, bad.run], ['', [], [], false]);
});
