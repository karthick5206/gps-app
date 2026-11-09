import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DATE_PRESETS, matchPreset, presetRange } from './date-presets.ts';
import { buildInsight, daysBetween, idlePct, rowMatches, utilisation } from './insights.ts';
import { cleanFavourites, cleanRecents, pushRecent, searchCatalog, toggleFavourite } from './report-catalog.ts';
import { dayKeyInZone, formatReportTime, getReportTimeZone, reportZoneLabel, setReportTimeZone, todayInZone, zoneAbbreviation } from './report-time.ts';
import { prefillFromRun, scheduleOptionsPayload } from './schedule-options.ts';
import { columnsKey, filterRows, quickFilterText, visibleColumnIds } from './table-state.ts';

// ---------------------------------------------------------------- catalogue (RP-1)
const CATALOG = [
  { type: 'SUMMARY', label: 'Summary', category: 'Activity', description: 'Distance, running/idle/stop time and trips per vehicle by day, week or month.' },
  { type: 'TRIPS', label: 'Trips', category: 'Activity', description: 'Every trip with start/end, duration, distance and speeds.' },
  { type: 'HALT', label: 'Halts', category: 'Activity', description: 'Long stoppages with the engine off.' },
  { type: 'OVERSPEED', label: 'Over-speed', category: 'Driving', description: "Speeding episodes above each vehicle's limit." },
  { type: 'CONTINUOUS_DRIVING', label: 'Continuous driving', category: 'Driving', description: 'Driving stretches without a proper break.' },
  { type: 'FUEL_EVENTS', label: 'Fuel refills & drains', category: 'Fuel', description: 'Every detected refill and drain (possible fuel theft).' },
  { type: 'DOCUMENTS', label: 'Documents & services', category: 'Compliance', description: 'Document expiry and service status.' },
];

test('catalogue search: label first, then keywords, then group/description', () => {
  assert.deepEqual(searchCatalog(CATALOG, 'speed').map((e) => e.type), ['OVERSPEED', 'CONTINUOUS_DRIVING', 'TRIPS']);
  assert.deepEqual(searchCatalog(CATALOG, 'theft').map((e) => e.type), ['FUEL_EVENTS']);
  assert.deepEqual(searchCatalog(CATALOG, 'insurance').map((e) => e.type), ['DOCUMENTS']);
  assert.deepEqual(searchCatalog(CATALOG, 'driving').map((e) => e.type)[0], 'CONTINUOUS_DRIVING');
  assert.deepEqual(searchCatalog(CATALOG, 'parking').map((e) => e.type), ['HALT']);
  assert.equal(searchCatalog(CATALOG, '  ').length, CATALOG.length);
  assert.equal(searchCatalog(CATALOG, 'zzz').length, 0);
});

test('catalogue search: every word must match; group names match; case/diacritics ignored', () => {
  assert.deepEqual(searchCatalog(CATALOG, 'FUEL theft').map((e) => e.type), ['FUEL_EVENTS']);
  assert.deepEqual(searchCatalog(CATALOG, 'compliance').map((e) => e.type), ['DOCUMENTS']);
  assert.deepEqual(searchCatalog(CATALOG, 'over speed').map((e) => e.type)[0], 'OVERSPEED');
});

test('catalogue search matches translated labels', () => {
  const hi: Record<string, string> = { Trips: 'यात्राएँ' };
  assert.deepEqual(searchCatalog(CATALOG, 'यात्राएँ', (s) => hi[s] ?? s).map((e) => e.type), ['TRIPS']);
});

test('favourites toggle and recents keep one entry per type, newest first, max 5', () => {
  assert.deepEqual(toggleFavourite(['TRIPS'], 'HALT'), ['TRIPS', 'HALT']);
  assert.deepEqual(toggleFavourite(['TRIPS', 'HALT'], 'TRIPS'), ['HALT']);
  let r = pushRecent([], { type: 'TRIPS', from: '2026-11-03', to: '2026-11-09' });
  r = pushRecent(r, { type: 'HALT', from: '2026-11-01', to: '2026-11-02' });
  r = pushRecent(r, { type: 'TRIPS', from: '2026-11-05', to: '2026-11-06' });
  assert.deepEqual(r.map((x) => `${x.type}:${x.from}`), ['TRIPS:2026-11-05', 'HALT:2026-11-01']);
  for (const t of ['A', 'B', 'C', 'D', 'E']) r = pushRecent(r, { type: t, from: '2026-11-01', to: '2026-11-01' });
  assert.equal(r.length, 5);
  assert.equal(r[0].type, 'E');
});

test('stored lists are cleaned of unknown or malformed entries', () => {
  assert.deepEqual(cleanFavourites(['TRIPS', 'NOPE', 3, 'TRIPS'], ['TRIPS']), ['TRIPS']);
  assert.deepEqual(cleanFavourites('x', ['TRIPS']), []);
  assert.deepEqual(cleanRecents([{ type: 'TRIPS', from: '2026-11-01', to: '2026-11-02' }, { type: 'TRIPS', from: 'bad', to: '2026-11-02' }, null, { type: 'X', from: '2026-11-01', to: '2026-11-02' }], ['TRIPS']).length, 1);
});

// ---------------------------------------------------------------- time zone (D-1)
test('report times render in the company zone, not the browser zone', () => {
  const iso = '2026-11-02T23:00:00.000Z'; // 3 Nov 04:30 IST, 2 Nov 15:00 PST
  assert.match(formatReportTime(iso, 'Asia/Kolkata'), /03/);
  assert.match(formatReportTime(iso, 'Asia/Kolkata'), /04:30/);
  assert.match(formatReportTime(iso, 'America/Los_Angeles'), /02/);
  assert.equal(formatReportTime(null, 'Asia/Kolkata'), '—');
  assert.equal(formatReportTime('garbage', 'Asia/Kolkata'), '—');
});

test('zone labels: IST for Kolkata, DST-aware names for other zones', () => {
  assert.equal(zoneAbbreviation('Asia/Kolkata'), 'IST');
  assert.equal(zoneAbbreviation('America/New_York', new Date('2026-01-15T12:00:00Z')), 'EST');
  assert.equal(zoneAbbreviation('America/New_York', new Date('2026-07-15T12:00:00Z')), 'EDT');
  assert.equal(zoneAbbreviation('Asia/Kathmandu'), 'NPT');
  setReportTimeZone('Asia/Kolkata');
  assert.equal(getReportTimeZone(), 'Asia/Kolkata');
  assert.equal(reportZoneLabel(), 'IST');
  setReportTimeZone('Not/AZone');
  assert.equal(getReportTimeZone(), undefined);
  assert.equal(reportZoneLabel(), '');
});

test('day keys and today follow the company zone', () => {
  assert.equal(dayKeyInZone('2026-11-02T23:00:00.000Z', 'Asia/Kolkata'), '2026-11-03');
  assert.equal(dayKeyInZone('2026-11-02T23:00:00.000Z', 'America/Los_Angeles'), '2026-11-02');
  assert.equal(todayInZone('Asia/Kolkata', new Date('2026-11-09T20:00:00Z')), '2026-11-10');
});

// ---------------------------------------------------------------- date presets
test('date presets on company days', () => {
  assert.deepEqual(presetRange('today', '2026-11-09'), ['2026-11-09', '2026-11-09']);
  assert.deepEqual(presetRange('yesterday', '2026-11-01'), ['2026-10-31', '2026-10-31']);
  assert.deepEqual(presetRange('last7', '2026-11-09'), ['2026-11-03', '2026-11-09']);
  assert.deepEqual(presetRange('last30', '2026-11-09'), ['2026-10-11', '2026-11-09']);
  assert.deepEqual(presetRange('thisMonth', '2026-11-09'), ['2026-11-01', '2026-11-09']);
  assert.deepEqual(presetRange('lastMonth', '2026-03-15'), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(presetRange('lastMonth', '2026-01-10'), ['2025-12-01', '2025-12-31']);
  assert.equal(matchPreset('2026-11-03', '2026-11-09', '2026-11-09'), 'last7');
  assert.equal(matchPreset('2026-11-01', '2026-11-01', '2026-11-01'), 'today'); // today wins over this month on the 1st
  assert.equal(matchPreset('2026-10-02', '2026-11-09', '2026-11-09'), null);
  assert.equal(DATE_PRESETS.length, 6);
});

// ---------------------------------------------------------------- insights (RP-2)
test('formulas match the server: idle % and utilisation', () => {
  assert.equal(idlePct(74470, 1182688), 6.3); // golden fixture ENGINE_HOURS totals.idlePct
  assert.equal(idlePct(5, 0), 0);
  assert.equal(utilisation({ runningSec: 50, idleSec: 25, stopSec: 25 }), 50);
  assert.equal(utilisation({}), null);
  assert.deepEqual(daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

const TRIPS = [
  { objectId: 'a', objectName: 'Bike 04', startTime: '2026-11-02T23:00:00.000Z', distanceKm: 10 }, // 3 Nov IST
  { objectId: 'a', objectName: 'Bike 04', startTime: '2026-11-03T10:00:00.000Z', distanceKm: 5 },
  { objectId: 'b', objectName: 'Truck 01', startTime: '2026-11-04T10:00:00.000Z', distanceKm: 30 },
];

test('trips insight: KPIs from API totals, per-day bars in the company zone, ranked vehicles', () => {
  const i = buildInsight({ type: 'TRIPS', rows: TRIPS, totals: { count: 3, distanceKm: 45, durationSec: 3600, idleSec: 0, maxSpeedKph: 80 }, from: '2026-11-03', to: '2026-11-05', tz: 'Asia/Kolkata' })!;
  const kpi = Object.fromEntries(i.kpis.map((k) => [k.id, k.value]));
  assert.deepEqual(kpi, { trips: 3, distance: 45, driving: 3600, avg: 15, longest: 30, top: 80 });
  assert.equal(i.kpis.find((k) => k.id === 'longest')?.fromRows, true);
  const bars = i.charts[0];
  assert.equal(bars.kind, 'bars');
  if (bars.kind === 'bars') assert.deepEqual(bars.data.map((d) => [d.key, d.values.trips]), [['2026-11-03', 2], ['2026-11-04', 1], ['2026-11-05', 0]]);
  const ranked = i.charts[1];
  if (ranked.kind === 'ranked') assert.deepEqual(ranked.items.map((x) => [x.label, x.value]), [['Truck 01', 30], ['Bike 04', 15]]);
});

test('KPIs keep the API totals even when rows are truncated', () => {
  const i = buildInsight({ type: 'TRIPS', rows: TRIPS.slice(0, 1), totals: { count: 640, distanceKm: 14962.24, durationSec: 1, idleSec: 0, maxSpeedKph: 99 }, from: '2026-11-03', to: '2026-11-03' })!;
  assert.equal(i.kpis.find((k) => k.id === 'trips')?.value, 640);
  assert.equal(i.kpis.find((k) => k.id === 'distance')?.value, 14962.24);
  assert.equal(i.chartsFromRows, true);
});

test('alerts insight stacks severities per day and ranks types', () => {
  const rows = [
    { objectId: 'a', type: 'OVERSPEED', severity: 'CRITICAL', occurredAt: '2026-11-03T05:00:00Z' },
    { objectId: 'a', type: 'OVERSPEED', severity: 'WARNING', occurredAt: '2026-11-03T06:00:00Z' },
    { objectId: 'b', type: 'SOS', severity: 'CRITICAL', occurredAt: '2026-11-04T06:00:00Z' },
  ];
  const i = buildInsight({ type: 'ALERTS', rows, totals: { count: 3, CRITICAL: 2, WARNING: 1, INFO: 0 }, from: '2026-11-03', to: '2026-11-04', tz: 'Asia/Kolkata', alertLabel: (c) => (c === 'SOS' ? 'SOS button' : 'Overspeed') })!;
  const bars = i.charts[0];
  if (bars.kind === 'bars') assert.deepEqual(bars.data.map((d) => d.values), [{ CRITICAL: 1, WARNING: 1, INFO: 0 }, { CRITICAL: 1, WARNING: 0, INFO: 0 }]);
  const types = i.charts[1];
  if (types.kind === 'ranked') assert.deepEqual(types.items.map((t) => [t.label, t.value]), [['Overspeed', 2], ['SOS button', 1]]);
  assert.equal(i.kpis.find((k) => k.id === 'critical')?.tone, 'danger');
});

test('event summary heatmap: vehicles × types sorted by volume, cells sum count/critical', () => {
  const rows = [
    { objectId: 'a', objectName: 'A', type: 'OVERSPEED', count: 5, criticalCount: 1 },
    { objectId: 'a', objectName: 'A', type: 'SOS', count: 1, criticalCount: 1 },
    { objectId: 'b', objectName: 'B', type: 'OVERSPEED', count: 9, criticalCount: 0 },
  ];
  const i = buildInsight({ type: 'EVENT_SUMMARY', rows, totals: { count: 15, criticalCount: 2 }, from: '2026-11-03', to: '2026-11-09' })!;
  const h = i.charts[0];
  assert.equal(h.kind, 'heatmap');
  if (h.kind === 'heatmap') {
    assert.deepEqual(h.rows.map((r) => r.key), ['b', 'a']);
    assert.deepEqual(h.cols.map((c) => c.key), ['OVERSPEED', 'SOS']);
    assert.deepEqual(h.cells['a|OVERSPEED'], { count: 5, critical: 1 });
    assert.equal(h.max, 9);
  }
  assert.deepEqual(i.kpis.map((k) => k.value), [15, 2, 2, 2]);
});

test('engine hours, consolidated, summary and over-speed insights use server totals', () => {
  const eh = buildInsight({ type: 'ENGINE_HOURS', rows: [{ objectId: 'a', period: '2026-11-03', runningSec: 7200, idleSec: 3600 }], totals: { engineSec: 1182688, runningSec: 1108218, idleSec: 74470, idlePct: 6.3, distanceKm: 1, vehicles: 20 }, from: '2026-11-03', to: '2026-11-03' })!;
  assert.equal(eh.kpis.find((k) => k.id === 'idlePct')?.value, 6.3);
  const bars = eh.charts[0];
  if (bars.kind === 'bars') assert.deepEqual(bars.data, [{ key: '2026-11-03', values: { running: 2, idle: 1 } }]);
  const c = buildInsight({ type: 'CONSOLIDATED', rows: [{ objectId: 'a', activeDays: 2, distanceKm: 1, alertCount: 3 }, { objectId: 'b', activeDays: 0, distanceKm: 0, alertCount: 0 }], totals: { vehicles: 2, engineSec: 100, idleSec: 25, alertCount: 3, criticalAlertCount: 1 }, from: '2026-11-03', to: '2026-11-03' })!;
  assert.equal(c.kpis.find((k) => k.id === 'idlePct')?.value, 25);
  assert.deepEqual(c.kpis.find((k) => k.id === 'vehicles')?.hint?.vars, { n: 1 });
  const s = buildInsight({ type: 'SUMMARY', rows: [], totals: { vehicles: 20, distanceKm: 15578.813, runningSec: 50, idleSec: 25, stopSec: 25, offlineSec: 0, tripCount: 640, overspeedCount: 3 }, from: '2026-11-03', to: '2026-11-03' })!;
  assert.equal(s.kpis.find((k) => k.id === 'utilisation')?.value, 50);
  assert.equal(s.kpis.find((k) => k.id === 'distance')?.value, 15578.813);
  const o = buildInsight({ type: 'OVERSPEED', rows: [{ objectId: 'a', startTime: '2026-11-03T05:00:00Z', durationSec: 90 }], totals: { count: 678, durationSec: 59588, maxSpeedKph: 103 }, from: '2026-11-03', to: '2026-11-03' })!;
  assert.deepEqual(o.kpis.map((k) => k.value), [678, 59588, 103, 88, 1]);
  assert.equal(buildInsight({ type: 'POSITIONS', rows: [], from: 'x', to: 'y' }), null);
});

test('chart selections filter rows', () => {
  assert.equal(rowMatches('TRIPS', TRIPS[0], { kind: 'day', value: '2026-11-03' }, 'Asia/Kolkata'), true);
  assert.equal(rowMatches('TRIPS', TRIPS[0], { kind: 'day', value: '2026-11-02' }, 'Asia/Kolkata'), false);
  assert.equal(rowMatches('TRIPS', TRIPS[2], { kind: 'vehicle', value: 'b', label: 'Truck 01' }), true);
  assert.equal(rowMatches('ALERTS', { occurredAt: '2026-11-03T05:00:00Z', type: 'SOS' }, { kind: 'alertType', value: 'SOS', label: 'SOS' }), true);
  assert.equal(rowMatches('EVENT_SUMMARY', { objectId: 'a', type: 'SOS' }, { kind: 'cell', objectId: 'a', type: 'SOS', label: '' }), true);
  assert.equal(rowMatches('SUMMARY', { period: '2026-W45' }, { kind: 'period', value: '2026-W45' }), true);
});

// ---------------------------------------------------------------- table state (RP-6)
test('quick filter matches any visible column text, case-insensitive; all words required', () => {
  const cols = [
    { id: 'objectName', value: (r: Record<string, unknown>) => r.objectName as string },
    { id: 'distanceKm', value: (r: Record<string, unknown>) => r.distanceKm as number },
  ];
  const rows = [
    { objectName: 'Bike 04', distanceKm: 12.5 },
    { objectName: 'Truck 01', distanceKm: 30 },
  ];
  assert.deepEqual(filterRows(rows, cols, 'truck').map((r) => r.objectName), ['Truck 01']);
  assert.deepEqual(filterRows(rows, cols, 'bike 12').map((r) => r.objectName), ['Bike 04']);
  assert.equal(filterRows(rows, cols, '').length, 2);
  assert.equal(quickFilterText({ a: 1 }, [{ id: 'a', value: () => null }]), '');
});

test('column visibility: defaults to all, never hides the first column, stored per report type', () => {
  const ids = ['objectName', 'startTime', 'endTime'];
  assert.deepEqual(visibleColumnIds(ids, {}), ids);
  assert.deepEqual(visibleColumnIds(ids, { startTime: false }), ['objectName', 'endTime']);
  assert.deepEqual(visibleColumnIds(ids, { objectName: false, startTime: false, endTime: false }), ['objectName']);
  assert.equal(columnsKey('TRIPS'), 'vt.columns.report.TRIPS');
});

// ---------------------------------------------------------------- scheduled report options (D-2)
const KEYS = { HALT: ['minDurationMin'], ALERTS: ['alertTypes'], OVERSPEED: ['minOverspeedSec'] } as const;

test('schedule options payload keeps selected types, allowed keys and set values only', () => {
  assert.deepEqual(
    scheduleOptionsPayload(['HALT', 'ALERTS', 'TRIPS'], { HALT: { minDurationMin: 45, alertTypes: ['X'] }, ALERTS: { alertTypes: [] }, OVERSPEED: { minOverspeedSec: 5 }, TRIPS: {} }, KEYS),
    { HALT: { minDurationMin: 45 } },
  );
  assert.deepEqual(scheduleOptionsPayload(['HALT'], {}, KEYS), {});
});

test('"Schedule this" pre-fills type, scope, grouping and options from the run', () => {
  const scope = { branchIds: [], groupIds: [], objectIds: ['v1'] };
  assert.deepEqual(prefillFromRun({ type: 'OVERSPEED', scope, options: { minOverspeedSec: 30 } }, 'Over-speed report', KEYS), {
    name: 'Over-speed report',
    reportTypes: ['OVERSPEED'],
    scope,
    period: 'DAY',
    options: { OVERSPEED: { minOverspeedSec: 30 } },
  });
  assert.equal(prefillFromRun({ type: 'SUMMARY', scope, period: 'WEEK' }, 'S', KEYS).period, 'WEEK');
});
