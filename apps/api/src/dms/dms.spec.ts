import { BadRequestException } from '@nestjs/common';
import { DMS_COLUMN_OF } from '@veetracer/shared';
import { daysBetween, dmsRange } from './dms.service';

const TZ = 'Asia/Kolkata';
// Friday 2026-10-30 15:00 IST.
const NOW = Date.UTC(2026, 9, 30, 9, 30);
const iso = (ms: number) => new Date(ms).toISOString();

describe('dms', () => {
  it('today / week / month start at local midnight and end now', () => {
    expect(iso(dmsRange('today', TZ, NOW).from)).toBe('2026-10-29T18:30:00.000Z');
    expect(iso(dmsRange('week', TZ, NOW).from)).toBe('2026-10-25T18:30:00.000Z'); // Monday 26th
    expect(iso(dmsRange('month', TZ, NOW).from)).toBe('2026-09-30T18:30:00.000Z');
    expect(dmsRange('month', TZ, NOW).to).toBe(NOW);
  });

  it('custom covers whole days, inclusive', () => {
    const r = dmsRange('custom', TZ, NOW, '2026-10-01', '2026-10-03');
    expect(iso(r.from)).toBe('2026-09-30T18:30:00.000Z');
    expect(iso(r.to)).toBe('2026-10-03T18:30:00.000Z');
    expect(daysBetween(r.from, r.to, TZ)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('rejects bad custom ranges', () => {
    expect(() => dmsRange('custom', TZ, NOW)).toThrow(BadRequestException);
    expect(() => dmsRange('custom', TZ, NOW, '2026-10-05', '2026-10-01')).toThrow(BadRequestException);
    expect(() => dmsRange('custom', TZ, NOW, '2026-01-01', '2026-10-01')).toThrow(BadRequestException);
    expect(() => dmsRange('custom', TZ, NOW, '2026-11-05', '2026-11-06')).toThrow(BadRequestException);
  });

  it('maps alert types to columns', () => {
    expect(DMS_COLUMN_OF.DRIVER_FATIGUE).toBe('fatigue');
    expect(DMS_COLUMN_OF.DRIVER_ABSENT).toBe('noFace');
    expect(DMS_COLUMN_OF.HARSH_BRAKING).toBe('braking');
    expect(DMS_COLUMN_OF.OVERSPEED).toBeUndefined();
  });
});
