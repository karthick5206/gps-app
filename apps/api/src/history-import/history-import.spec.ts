import { heldRetentionDays, historyHoldOf, parseOldPlatformSheet, straightLineKm } from '@veetracer/shared';
import { bearing, localToUtcMs } from './history-import.service';

describe('old platform sheet', () => {
  const sheet = [
    ['Device Name', 'Distance (Kms)', 'Average Speed (Km/h)'],
    ['TN 01 BH 2992', '191.7', '36.8'],
    [],
    ['Positions'],
    ['Speed (Km/h)', 'Ignition', 'Distance (Kms)', 'Motion', 'Address', 'Coords', 'GPS Time'],
    ['0', 'OFF', '0', 'STOPPED', 'Tirumala', '13.6847, 79.3523', '2026-09-01 00:02:50'],
    ['9', 'ON', '0.02', 'MOVING', '', '13.68456, 79.35224', '2026-09-01 00:57:11'],
    ['9', 'ON', '0.02', 'MOVING', '', '13.68456, 79.35224', '2026-09-01 00:57:11'],
    ['5', 'ON', '0', 'MOVING', '', '0, 0', '2026-09-01 00:58:00'],
    ['Device Name', 'Distance (Kms)'],
    ['TN 01 BH 2992', '10.3'],
    ['Speed (Km/h)', 'Ignition', 'Coords', 'GPS Time'],
    ['40', 'ON', '13.6, 79.3', '2026-09-02 08:00:00'],
  ];
  it('reads every daily block, drops duplicates and bad coordinates, sums the old km', () => {
    const p = parseOldPlatformSheet(sheet);
    expect(p.deviceNames).toEqual(['TN 01 BH 2992']);
    expect(p.rows.map((r) => r[0])).toEqual(['2026-09-01 00:02:50', '2026-09-01 00:57:11', '2026-09-02 08:00:00']);
    expect(p.rows[1]).toEqual(['2026-09-01 00:57:11', 13.68456, 79.35224, 9, 1]);
    expect(p.skipped).toBe(1);
    expect(p.oldKm).toBe(202);
    expect(straightLineKm(p.rows)).toBeGreaterThan(9);
  });
});

describe('time and heading', () => {
  it('converts India local time to UTC', () => {
    expect(new Date(localToUtcMs('2026-09-01 00:02:50', 'Asia/Kolkata')).toISOString()).toBe('2026-08-31T18:32:50.000Z');
    expect(Number.isNaN(localToUtcMs('nonsense', 'Asia/Kolkata'))).toBe(true);
  });
  it('gives compass bearings', () => {
    expect(bearing(13, 80, 14, 80)).toBe(0);
    expect(bearing(13, 80, 13, 81)).toBe(90);
    expect(bearing(13, 80, 12, 80)).toBe(180);
    expect(bearing(13, 80, 13, 80)).toBe(0);
  });
});

describe('migration hold', () => {
  const settings = { historyHold: { from: '2026-09-01', until: '2027-02-15' } };
  it('keeps imported history until the hold ends, then the normal retention applies', () => {
    expect(historyHoldOf(settings)).toEqual({ from: '2026-09-01', until: '2027-02-15' });
    expect(heldRetentionDays(90, settings, Date.parse('2026-11-17T12:00:00Z'))).toBe(90); // 77 days: within 90 anyway
    expect(heldRetentionDays(90, settings, Date.parse('2027-01-15T12:00:00Z'))).toBe(138); // Sep 1 still kept (136.5 days back, +1 day margin)
    expect(heldRetentionDays(90, settings, Date.parse('2027-02-20T12:00:00Z'))).toBe(90); // hold over
    expect(heldRetentionDays(90, {}, Date.now())).toBe(90);
    expect(historyHoldOf({ historyHold: { from: '2027-01-01', until: '2026-01-01' } })).toBeNull();
  });
});
