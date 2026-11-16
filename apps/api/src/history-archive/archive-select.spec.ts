import { archiveCutoffDay, dayDecision, DayInput, enabledCompanies, STALE_CLAIM_MS, vehicleWide } from './archive-select';

const NOW = Date.parse('2026-11-15T06:00:00.000Z'); // 11:30 in India
const TZ = 'Asia/Kolkata';

describe('archive day selection', () => {
  it('only companies with the switch on (malformed / missing = off), afterDays clamped', () => {
    const rows = [
      { id: 'a', timezone: TZ, settings: { historyArchive: { enabled: true, afterDays: 90 } } },
      { id: 'b', timezone: TZ, settings: { historyArchive: { enabled: false, afterDays: 90 } } },
      { id: 'c', timezone: TZ, settings: {} },
      { id: 'd', timezone: TZ, settings: { historyArchive: { enabled: 'yes' } } },
      { id: 'e', timezone: TZ, settings: { historyArchive: { enabled: true, afterDays: 5 } } },
      { id: 'f', timezone: TZ, settings: null },
    ];
    const out = enabledCompanies(rows);
    expect(out.map((c) => c.id)).toEqual(['a', 'e']);
    expect(out[1].settings.afterDays).toBe(30);
  });

  it('cutoff: days older than afterDays (company-local day)', () => {
    expect(archiveCutoffDay(NOW, 90, TZ)).toBe('2026-08-17');
    expect(archiveCutoffDay(NOW, 30, TZ)).toBe('2026-10-16');
    // 20:00 UTC on the 15th is already the 16th in India.
    expect(archiveCutoffDay(Date.parse('2026-11-15T20:00:00Z'), 90, TZ)).toBe('2026-08-18');
  });

  const base: DayInput = { day: '2026-08-01', cutoffDay: '2026-08-17', dayEndMs: Date.parse('2026-08-01T18:30:00Z'), processedUntilMs: NOW - 60_000, hasDirty: false, existing: null, now: NOW };

  it('archives an old, summarised, clean day', () => {
    expect(dayDecision(base)).toBe('archive');
  });

  it('respects afterDays', () => {
    expect(dayDecision({ ...base, day: '2026-08-17' })).toBe('too-recent');
    expect(dayDecision({ ...base, day: '2026-08-16' })).toBe('archive');
  });

  it('skips vehicles with dirty days, and days the summarizer has not processed to their end', () => {
    expect(dayDecision({ ...base, hasDirty: true })).toBe('dirty');
    expect(dayDecision({ ...base, processedUntilMs: null })).toBe('not-summarised');
    expect(dayDecision({ ...base, processedUntilMs: base.dayEndMs - 1 })).toBe('not-summarised');
    expect(dayDecision({ ...base, processedUntilMs: base.dayEndMs })).toBe('archive');
    expect(vehicleWide('dirty') && vehicleWide('not-summarised') && vehicleWide('too-recent')).toBe(true);
    expect(vehicleWide('restored-held')).toBe(false);
  });

  it('restores, keep periods and claims', () => {
    const ex = (status: 'CLAIMED' | 'ARCHIVED' | 'RESTORING' | 'RESTORED' | 'FAILED', keepUntilMs: number | null = null, claimedAtMs: number | null = null): DayInput => ({ ...base, existing: { status, keepUntilMs, claimedAtMs } });
    expect(dayDecision(ex('RESTORING'))).toBe('restoring');
    expect(dayDecision(ex('RESTORED', NOW + 1000))).toBe('restored-held');
    expect(dayDecision(ex('RESTORED', NOW - 1000))).toBe('archive');
    expect(dayDecision(ex('CLAIMED', null, NOW - 1000))).toBe('in-progress');
    expect(dayDecision(ex('CLAIMED', null, NOW - STALE_CLAIM_MS - 1))).toBe('archive');
    expect(dayDecision(ex('FAILED'))).toBe('archive');
    expect(dayDecision(ex('ARCHIVED'))).toBe('archive'); // late points folded into the file
  });
});
