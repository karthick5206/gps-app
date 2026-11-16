import { archiveCutoffDay, archiveRunDeadline, dayDecision, DayInput, enabledCompanies, failedBackoffMs, STALE_CLAIM_MS, vehicleWide } from './archive-select';

const DAY = 86_400_000;

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

  const base: DayInput = { day: '2026-08-01', cutoffDay: '2026-08-17', dayEndMs: Date.parse('2026-08-01T18:30:00Z'), processedUntilMs: NOW - 60_000, lastPointMs: NOW - 120_000, hasDirty: false, existing: null, now: NOW };

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

  it('idle vehicle (watermark stays at its last point): archived once every point is processed and the day is older than afterDays + 1', () => {
    const last = Date.parse('2026-08-01T10:00:00Z');
    const idle = { ...base, processedUntilMs: last, lastPointMs: last };
    expect(dayDecision(idle)).toBe('archive');
    expect(dayDecision({ ...idle, lastPointMs: last + 1 })).toBe('not-summarised');
    expect(dayDecision({ ...idle, day: '2026-08-16' })).toBe('not-summarised');
    expect(dayDecision({ ...idle, processedUntilMs: null })).toBe('not-summarised');
  });

  it('FAILED days back off (1, 2, 4 … 7 days)', () => {
    expect(failedBackoffMs(1)).toBe(DAY);
    expect(failedBackoffMs(3)).toBe(4 * DAY);
    expect(failedBackoffMs(20)).toBe(7 * DAY);
    const failed = (attempts: number, agoMs: number): DayInput => ({ ...base, existing: { status: 'FAILED', keepUntilMs: null, claimedAtMs: null, attempts, updatedAtMs: NOW - agoMs } });
    expect(dayDecision(failed(1, DAY - 1000))).toBe('failed-backoff');
    expect(dayDecision(failed(1, DAY + 1000))).toBe('archive');
    expect(dayDecision(failed(3, 3 * DAY))).toBe('failed-backoff');
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

describe('archive run window (backup at 21:30 UTC)', () => {
  const H = 3_600_000;
  it('stops at 21:00 UTC and does not start between 21:00 and 22:30 UTC', () => {
    const at = (iso: string) => Date.parse(iso);
    expect(archiveRunDeadline(at('2026-11-15T02:00:00Z'), 2 * H)).toBe(at('2026-11-15T04:00:00Z'));
    expect(archiveRunDeadline(at('2026-11-15T20:00:00Z'), 2 * H)).toBe(at('2026-11-15T21:00:00Z'));
    expect(archiveRunDeadline(at('2026-11-15T21:00:00Z'), 2 * H)).toBeNull();
    expect(archiveRunDeadline(at('2026-11-15T22:29:00Z'), 2 * H)).toBeNull();
    expect(archiveRunDeadline(at('2026-11-15T22:30:00Z'), 2 * H)).toBe(at('2026-11-16T00:30:00Z'));
    expect(archiveRunDeadline(at('2026-11-15T23:00:00Z'), 23 * H)).toBe(at('2026-11-16T21:00:00Z'));
  });
});
