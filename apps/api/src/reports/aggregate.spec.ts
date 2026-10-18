import { DailySummaryDto } from '@veetracer/shared';
import { isoWeekKey, localDayKey, localMidnight } from '../summarizer/tz';
import { aggregateSummaries, intersectScope, periodKey, summaryTotals } from './aggregate';
import { hhmmss } from './format';

function day(objectId: string, d: string, over: Partial<DailySummaryDto> = {}): DailySummaryDto {
  return {
    objectId,
    objectName: objectId === 'a' ? 'Alpha' : 'Bravo',
    plateNumber: null,
    branchName: null,
    day: d,
    distanceKm: 10,
    runningSec: 3600,
    idleSec: 600,
    stopSec: 1800,
    offlineSec: 80_400,
    overspeedSec: 0,
    overspeedCount: 1,
    tripCount: 2,
    maxSpeedKph: 60,
    avgSpeedKph: 40,
    engineSec: 4200,
    firstStart: `${d}T03:00:00.000Z`,
    lastStop: `${d}T12:00:00.000Z`,
    ...over,
  };
}

describe('period keys', () => {
  it('ISO weeks start on Monday and use the ISO week-numbering year', () => {
    expect(isoWeekKey('2026-10-12')).toBe('2026-W42'); // Monday
    expect(isoWeekKey('2026-10-18')).toBe('2026-W42'); // Sunday, same week
    expect(isoWeekKey('2026-10-19')).toBe('2026-W43');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53'); // Friday → belongs to 2026's last week
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01'); // Monday → first week of 2025
    expect(periodKey('2026-10-18', 'MONTH')).toBe('2026-10');
    expect(periodKey('2026-10-18', 'DAY')).toBe('2026-10-18');
  });

  it('local day boundaries follow the company timezone', () => {
    expect(localDayKey(Date.parse('2026-10-17T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-10-17');
    expect(localDayKey(Date.parse('2026-10-17T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-18');
    expect(new Date(localMidnight('2026-10-18', 'Asia/Kolkata')).toISOString()).toBe('2026-10-17T18:30:00.000Z');
  });
});

describe('summary aggregation', () => {
  const days = [
    day('a', '2026-10-17'), // Saturday W42
    day('a', '2026-10-18', { avgSpeedKph: 70, runningSec: 1800, maxSpeedKph: 90, firstStart: null, lastStop: null }), // Sunday W42
    day('a', '2026-10-19'), // Monday W43
    day('b', '2026-10-18', { distanceKm: 5.5 }),
  ];

  it('DAY keeps one row per vehicle-day', () => {
    expect(aggregateSummaries(days, 'DAY')).toHaveLength(4);
  });

  it('WEEK groups by ISO week (Monday start)', () => {
    const rows = aggregateSummaries(days, 'WEEK');
    expect(rows.map((r) => `${r.objectName} ${r.period}`)).toEqual(['Alpha 2026-W42', 'Alpha 2026-W43', 'Bravo 2026-W42']);
    const w42 = rows[0];
    expect(w42.distanceKm).toBe(20);
    expect(w42.runningSec).toBe(5400);
    expect(w42.tripCount).toBe(4);
    expect(w42.maxSpeedKph).toBe(90);
    expect(w42.avgSpeedKph).toBe(50); // (40×3600 + 70×1800) / 5400
    expect(w42.firstStart).toBe('2026-10-17T03:00:00.000Z');
    expect(w42.lastStop).toBe('2026-10-17T12:00:00.000Z');
  });

  it('MONTH groups the whole month; totals equal the daily sums', () => {
    const rows = aggregateSummaries(days, 'MONTH');
    expect(rows).toHaveLength(2);
    const totals = summaryTotals(rows);
    const daily = summaryTotals(aggregateSummaries(days, 'DAY'));
    expect(totals).toEqual(daily);
    expect(totals.distanceKm).toBe(35.5);
    expect(totals.vehicles).toBe(2);
  });

  it('formats durations as hh:mm:ss', () => {
    expect(hhmmss(0)).toBe('00:00:00');
    expect(hhmmss(3661)).toBe('01:01:01');
    expect(hhmmss(90_000)).toBe('25:00:00');
    expect(hhmmss(null)).toBe('');
  });
});

describe('report scope intersection', () => {
  const visible = [
    { id: 'o1', branchId: 'b1', groupIds: ['g1'] },
    { id: 'o2', branchId: 'b1', groupIds: [] },
    { id: 'o3', branchId: 'b2', groupIds: ['g1', 'g2'] },
    { id: 'o4', branchId: null, groupIds: [] },
  ];
  const scope = (s: Partial<{ branchIds: string[]; groupIds: string[]; objectIds: string[] }>) => ({
    branchIds: [],
    groupIds: [],
    objectIds: [],
    ...s,
  });

  it('empty scope = everything the caller can see', () => {
    expect(intersectScope(visible, scope({}))).toEqual(['o1', 'o2', 'o3', 'o4']);
  });

  it('is the union of branches, groups and objects', () => {
    expect(intersectScope(visible, scope({ branchIds: ['b2'], objectIds: ['o2'] }))).toEqual(['o2', 'o3']);
    expect(intersectScope(visible, scope({ groupIds: ['g1'] }))).toEqual(['o1', 'o3']);
  });

  it('never includes objects outside the caller’s data scope', () => {
    expect(intersectScope(visible, scope({ objectIds: ['o9', 'o4'] }))).toEqual(['o4']);
    expect(intersectScope(visible.slice(0, 2), scope({ branchIds: ['b2'] }))).toEqual([]);
  });
});
