import { attendanceOf, attendanceSettingsError, DEFAULT_ATTENDANCE } from '@veetracer/shared';

const D = Date.parse('2026-10-30T00:00:00+05:30');
const at = (h: number, m = 0) => D + (h * 60 + m) * 60_000;
const W = { workingDay: true, dayStart: D, dayEnd: D + 86_400_000, start: at(9, 30), grace: at(9, 45), end: at(18, 30) };

describe('attendanceOf', () => {
  it('on time: first in, last out and time on site', () => {
    const r = attendanceOf([{ enter: at(9, 20), exit: at(13), site: 'Office' }, { enter: at(14), exit: at(18, 40), site: 'Office' }], W, at(20));
    expect(r).toEqual({ status: 'PRESENT', firstIn: at(9, 20), lastOut: at(18, 40), onSiteMin: 220 + 280, site: 'Office', lateMin: 0 });
  });

  it('late after the grace period; still inside has no last out', () => {
    const r = attendanceOf([{ enter: at(10, 5), exit: null, site: 'Site A' }], W, at(12));
    expect(r).toMatchObject({ status: 'LATE', lateMin: 20, lastOut: null, onSiteMin: 115 });
  });

  it('upcoming before the grace ends, not arrived during the day, absent after the end', () => {
    expect(attendanceOf([], W, at(9, 40)).status).toBe('UPCOMING');
    expect(attendanceOf([], W, at(11)).status).toBe('NOT_ARRIVED');
    expect(attendanceOf([], W, at(19)).status).toBe('ABSENT');
  });

  it('day off on non-working days (visits still shown)', () => {
    expect(attendanceOf([{ enter: at(10), exit: at(11), site: 'Office' }], { ...W, workingDay: false }, at(20))).toMatchObject({ status: 'DAY_OFF', onSiteMin: 60 });
  });

  it('validates settings', () => {
    expect(attendanceSettingsError({ ...DEFAULT_ATTENDANCE, enabled: true })).toMatch(/geofence/);
    expect(attendanceSettingsError({ ...DEFAULT_ATTENDANCE, enabled: true, geofenceIds: ['g'], endMin: 60 })).toMatch(/after the start/);
    expect(attendanceSettingsError({ ...DEFAULT_ATTENDANCE, enabled: true, geofenceIds: ['g'] })).toBeNull();
  });
});
