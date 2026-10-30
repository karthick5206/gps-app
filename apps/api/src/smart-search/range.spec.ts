import { resolveRange } from './smart-search.service';

const TZ = 'Asia/Kolkata';
// Thursday 2026-10-29 15:30 IST.
const NOW = Date.parse('2026-10-29T10:00:00Z');
const ist = (s: string) => Date.parse(`${s}+05:30`);

describe('resolveRange', () => {
  it('today so far by default, and yesterday at a time', () => {
    expect(resolveRange(null, TZ, NOW)).toEqual({ from: ist('2026-10-29T00:00:00'), to: NOW, label: 'today' });
    const y = resolveRange({ kind: 'day', offset: -1, atMin: 15 * 60 }, TZ, NOW);
    expect(y).toEqual({ from: ist('2026-10-28T00:00:00'), to: ist('2026-10-29T00:00:00'), label: 'yesterday', at: ist('2026-10-28T15:00:00') });
  });

  it('this week starts on Monday; last week is the full previous week', () => {
    expect(resolveRange({ kind: 'week', offset: 0 }, TZ, NOW)).toMatchObject({ from: ist('2026-10-26T00:00:00'), to: NOW });
    expect(resolveRange({ kind: 'week', offset: -1 }, TZ, NOW)).toMatchObject({ from: ist('2026-10-19T00:00:00'), to: ist('2026-10-26T00:00:00') });
  });

  it('this month, last 3 days and last night', () => {
    expect(resolveRange({ kind: 'month', offset: 0 }, TZ, NOW).from).toBe(ist('2026-10-01T00:00:00'));
    expect(resolveRange({ kind: 'lastDays', days: 3 }, TZ, NOW).from).toBe(ist('2026-10-27T00:00:00'));
    expect(resolveRange({ kind: 'lastNight' }, TZ, NOW)).toMatchObject({ from: ist('2026-10-28T22:00:00'), to: ist('2026-10-29T05:00:00') });
  });
});
