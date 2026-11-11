import { missingOccurrences, scheduleOccurrences } from './schedule-occurrences';

const IST = 'Asia/Kolkata';
const H = 3_600_000;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const isoAll = (xs: number[]) => xs.map((x) => new Date(x).toISOString());

// 2026-11-10 is a Tuesday.
const NOW = Date.parse('2026-11-10T00:00:00.000Z'); // 05:30 IST Tuesday

describe('scheduleOccurrences', () => {
  it('returns the local start on the chosen weekdays in the window (IST, no DST)', () => {
    // Every day at 07:30 IST = 02:00 UTC.
    const s = { days: [0, 1, 2, 3, 4, 5, 6], startMin: 450, validFrom: null, validTo: null };
    expect(isoAll(scheduleOccurrences(s, IST, NOW, NOW + 24 * H))).toEqual(['2026-11-10T02:00:00.000Z']);
    expect(isoAll(scheduleOccurrences(s, IST, NOW, NOW + 48 * H))).toEqual(['2026-11-10T02:00:00.000Z', '2026-11-11T02:00:00.000Z']);
  });

  it('skips days not in the schedule', () => {
    // Wednesday (3) only.
    const s = { days: [3], startMin: 450, validFrom: null, validTo: null };
    expect(isoAll(scheduleOccurrences(s, IST, NOW, NOW + 24 * H))).toEqual([]);
    expect(isoAll(scheduleOccurrences(s, IST, NOW, NOW + 7 * 24 * H))).toEqual(['2026-11-11T02:00:00.000Z']);
  });

  it('uses the local weekday, not the UTC one', () => {
    // 01:00 IST Wednesday = 19:30 UTC Tuesday.
    const s = { days: [3], startMin: 60, validFrom: null, validTo: null };
    expect(isoAll(scheduleOccurrences(s, IST, NOW, NOW + 48 * H))).toEqual(['2026-11-10T19:30:00.000Z']);
  });

  it('excludes starts already past', () => {
    const s = { days: [2], startMin: 300, validFrom: null, validTo: null }; // 05:00 IST Tue, before 05:30 now
    expect(scheduleOccurrences(s, IST, NOW, NOW + 24 * H)).toEqual([]);
  });

  it('honours validity dates (inclusive, local)', () => {
    const s = { days: [0, 1, 2, 3, 4, 5, 6], startMin: 450, validFrom: d('2026-11-11'), validTo: d('2026-11-12') };
    expect(isoAll(scheduleOccurrences(s, IST, NOW, NOW + 5 * 24 * H))).toEqual(['2026-11-11T02:00:00.000Z', '2026-11-12T02:00:00.000Z']);
  });

  it('keeps local wall-clock time across a DST change', () => {
    // New York: DST ends 2026-11-01. 08:00 local = 12:00 UTC before, 13:00 UTC after.
    const s = { days: [0, 1, 2, 3, 4, 5, 6], startMin: 480, validFrom: null, validTo: null };
    const from = Date.parse('2026-10-31T00:00:00.000Z');
    expect(isoAll(scheduleOccurrences(s, 'America/New_York', from, from + 72 * H))).toEqual([
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
      '2026-11-02T13:00:00.000Z',
    ]);
  });

  it('returns nothing for an empty window or no days', () => {
    expect(scheduleOccurrences({ days: [], startMin: 0, validFrom: null, validTo: null }, IST, NOW, NOW + 24 * H)).toEqual([]);
    expect(scheduleOccurrences({ days: [2], startMin: 600, validFrom: null, validTo: null }, IST, NOW, NOW)).toEqual([]);
  });
});

describe('missingOccurrences', () => {
  const slot = Date.parse('2026-11-11T02:00:00.000Z');

  it('is idempotent: an existing trip at the slot means nothing to create', () => {
    expect(missingOccurrences([slot], [slot])).toEqual([]);
    expect(missingOccurrences([slot], [])).toEqual([slot]);
  });

  it('treats a trip moved within 12 h as the same occurrence', () => {
    expect(missingOccurrences([slot], [slot + 3 * H])).toEqual([]);
    expect(missingOccurrences([slot], [slot - 24 * H])).toEqual([slot]);
  });
});
