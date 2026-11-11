import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInsight, rankedFilter, rowMatches } from './insights.ts';
import { REPORT_KEYWORDS, searchCatalog } from './report-catalog.ts';
import { scheduleOptionsPayload } from './schedule-options.ts';

const TZ = 'Asia/Kolkata';
const base = { from: '2026-11-03', to: '2026-11-05', tz: TZ };

test('trip performance insight: KPIs from totals, on-time and skipped charts per grouping', () => {
  const rows = [
    { groupBy: 'DRIVER', groupId: 'd1', groupName: 'Ravi', onTimePct: 87, skippedStops: 2 },
    { groupBy: 'DRIVER', groupId: null, groupName: 'No driver', onTimePct: 50, skippedStops: 0 },
  ];
  const totals = { trips: 12, completed: 10, onTimePct: 86.7, onTimeStops: 52, ratedStops: 60, avgStartDelayMin: 2.5, avgStopDelayMin: -0.4, skippedStops: 2, deviations: 3, plannedKm: 120, actualKm: 131.5 };
  const ins = buildInsight({ type: 'TRIP_PERFORMANCE', rows, totals, ...base });
  assert.ok(ins);
  const kpi = Object.fromEntries(ins.kpis.map((k) => [k.id, k]));
  assert.equal(kpi.onTime.value, 86.7);
  assert.deepEqual(kpi.onTime.hint, { text: '{{n}} of {{m}} stops', vars: { n: 52, m: 60 } });
  assert.equal(kpi.stopDelay.value, -0.4);
  assert.equal(kpi.stopDelay.format, 'min');
  assert.equal(kpi.deviations.tone, 'danger');
  assert.deepEqual(ins.charts.map((c) => c.title), ['On-time % by driver', 'Skipped stops by driver']);
  const ranked = ins.charts[0];
  assert.equal(ranked.kind, 'ranked');
  if (ranked.kind !== 'ranked') return;
  // "No driver" (null id) is still selectable: the filter matches on the group name.
  const f = rankedFilter(ranked.select, ranked.items[1]);
  assert.equal(rowMatches('TRIP_PERFORMANCE', rows[1], f), true);
  assert.equal(rowMatches('TRIP_PERFORMANCE', rows[0], f), false);
});

test('trip performance insight without stops reached shows blanks, not zeros', () => {
  const ins = buildInsight({ type: 'TRIP_PERFORMANCE', rows: [{ groupBy: 'ROUTE', groupName: 'A', onTimePct: null, skippedStops: 0 }], totals: { trips: 1, skippedStops: 0, deviations: 0 }, ...base });
  const kpi = Object.fromEntries(ins!.kpis.map((k) => [k.id, k]));
  assert.equal(kpi.onTime.value, null);
  assert.equal(kpi.startDelay.value, null);
  assert.equal(ins!.charts[0].title, 'On-time % by route');
});

test('planned trips insight: trips per day by status (planned start, company day) and per route', () => {
  const rows = [
    { routeName: 'A', status: 'COMPLETED', plannedStart: '2026-11-03T03:30:00.000Z' },
    { routeName: 'A', status: 'CANCELLED', plannedStart: '2026-11-03T20:00:00.000Z' }, // 01:30 IST on the 4th
    { routeName: 'B', status: 'IN_PROGRESS', plannedStart: '2026-11-05T03:30:00.000Z' },
  ];
  const ins = buildInsight({ type: 'PLANNED_TRIPS', rows, totals: { count: 3, completed: 1, incomplete: 0, cancelled: 1, skippedStops: 0, deviationCount: 0, stopsDone: 4, stopCount: 6 }, ...base });
  assert.ok(ins);
  const bars = ins.charts[0];
  assert.equal(bars.kind, 'bars');
  if (bars.kind !== 'bars') return;
  assert.deepEqual(
    bars.data.map((d) => [d.key, d.values]),
    [
      ['2026-11-03', { COMPLETED: 1, INCOMPLETE: 0, CANCELLED: 0, OTHER: 0 }],
      ['2026-11-04', { COMPLETED: 0, INCOMPLETE: 0, CANCELLED: 1, OTHER: 0 }],
      ['2026-11-05', { COMPLETED: 0, INCOMPLETE: 0, CANCELLED: 0, OTHER: 1 }],
    ],
  );
  assert.equal(rowMatches('PLANNED_TRIPS', rows[1], { kind: 'day', value: '2026-11-04' }, TZ), true);
  const byRoute = ins.charts[1];
  assert.equal(byRoute.kind === 'ranked' && byRoute.items.map((i) => [i.label, i.value]).join('|'), 'A,2|B,1');
});

test('catalogue finds the planned-trip reports by everyday words', () => {
  const entries = [
    { type: 'TRIP_PERFORMANCE', label: 'Trip performance', category: 'Routes & trips', description: 'Planned trips per route, driver or vehicle.' },
    { type: 'PLANNED_TRIPS', label: 'Planned trips', category: 'Routes & trips', description: 'Every planned trip.' },
    { type: 'TRIPS', label: 'Trips', category: 'Activity', description: 'Every trip.' },
  ];
  assert.deepEqual(searchCatalog(entries, 'punctuality').map((e) => e.type), ['TRIP_PERFORMANCE']);
  assert.deepEqual(searchCatalog(entries, 'timetable').map((e) => e.type), ['PLANNED_TRIPS']);
  assert.ok(REPORT_KEYWORDS.TRIP_PERFORMANCE.includes('on time'));
});

test('a schedule keeps the trip performance grouping', () => {
  const keys = { TRIP_PERFORMANCE: ['groupBy'] as const };
  assert.deepEqual(scheduleOptionsPayload(['TRIP_PERFORMANCE', 'PLANNED_TRIPS'], { TRIP_PERFORMANCE: { groupBy: 'DRIVER' }, PLANNED_TRIPS: { groupBy: 'ROUTE' } }, keys), { TRIP_PERFORMANCE: { groupBy: 'DRIVER' } });
});
