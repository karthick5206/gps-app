import { attendanceOf, attendanceSettingsError, DEFAULT_ATTENDANCE, shiftOf, signalGaps, siteCountsFor, type OutingKind } from '@veetracer/shared';

const D = Date.parse('2026-10-30T00:00:00+05:30');
const at = (h: number, m = 0) => D + (h * 60 + m) * 60_000;
const W = { workingDay: true, dayStart: D, dayEnd: D + 86_400_000, start: at(9, 30), grace: at(9, 45), end: at(18, 30), shortExitMin: 5, halfDayMin: 240, fullDayMin: 480 };
const site = 'Office';
const decided = (...d: [number, OutingKind][]) => new Map(d.map(([t, kind]) => [t, { kind, note: null }]));

describe('attendanceOf', () => {
  it('on time: first in, last out and time on site', () => {
    const r = attendanceOf([{ enter: at(9, 20), exit: at(13), site }, { enter: at(14), exit: at(18, 40), site }], W, at(20));
    expect(r).toMatchObject({ status: 'PRESENT', firstIn: at(9, 20), lastOut: at(18, 40), onSiteMin: 220 + 280, site, lateMin: 0, unexplainedMin: 60, workedMin: 500, halfDay: false });
  });

  it('late after the grace period; still inside has no last out', () => {
    const r = attendanceOf([{ enter: at(10, 5), exit: null, site: 'Site A' }], W, at(12));
    expect(r).toMatchObject({ status: 'LATE', lateMin: 20, lastOut: null, onSiteMin: 115, state: 'INSIDE' });
  });

  it('upcoming before the grace ends, not arrived during the day, absent after the end', () => {
    expect(attendanceOf([], W, at(9, 40)).status).toBe('UPCOMING');
    expect(attendanceOf([], W, at(11)).status).toBe('NOT_ARRIVED');
    expect(attendanceOf([], W, at(19)).status).toBe('ABSENT');
  });

  it('day off on non-working days (visits still shown)', () => {
    expect(attendanceOf([{ enter: at(10), exit: at(11), site }], { ...W, workingDay: false }, at(20))).toMatchObject({ status: 'DAY_OFF', onSiteMin: 60 });
  });

  it('the worked example: official duty, short exit, unexplained exit and no signal', () => {
    const visits = [
      { enter: at(9, 22), exit: at(11), site },
      { enter: at(12, 30), exit: at(14), site },
      { enter: at(14, 4), exit: at(16), site },
      { enter: at(16, 40), exit: at(18, 35), site },
    ];
    const r = attendanceOf(visits, W, at(20), [{ from: at(17), to: at(17, 20) }], decided([at(11), 'OFFICIAL']));
    expect(r).toMatchObject({ status: 'PRESENT', halfDay: false, onSiteMin: 403, officialMin: 90, unexplainedMin: 40, noSignalMin: 20, personalMin: 0, workedMin: 493, lateMin: 0, earlyMin: 0, overtimeMin: 0 });
    expect(r.outings.map((o) => [o.leftAt, o.kind, o.minutes])).toEqual([[at(11), 'OFFICIAL', 90], [at(16), 'UNEXPLAINED', 40]]);
  });

  it('a short exit is no outing while it is short; after that it is one', () => {
    const visits = [{ enter: at(9), exit: at(11), site }];
    expect(attendanceOf(visits, W, at(11, 3))).toMatchObject({ outings: [], state: 'OUT' });
    expect(attendanceOf(visits, W, at(11, 10)).outings).toEqual([expect.objectContaining({ leftAt: at(11), returnedAt: null, minutes: 10, kind: 'UNEXPLAINED' })]);
  });

  it('time outside before the shift or after it is no outing', () => {
    const visits = [{ enter: at(8), exit: at(8, 30), site }, { enter: at(9), exit: at(18, 30), site }, { enter: at(19), exit: at(20), site }];
    const r = attendanceOf(visits, W, at(21));
    expect(r.outings).toEqual([]);
    expect(r.unexplainedMin).toBe(0);
    // Only time after the shift end is overtime (19:00–20:00); coming early adds to worked time, not overtime.
    expect(r.overtimeMin).toBe(60);
  });

  it('overtime: late and staying late to make up is none; under 15 minutes is none; a long evening counts', () => {
    // 2 h late (11:30), left 20:30: 9 h worked = a full shift, nothing beyond it.
    expect(attendanceOf([{ enter: at(11, 30), exit: at(20, 30), site }], W, at(23)).overtimeMin).toBe(0);
    // On time, left 10 min after the end.
    expect(attendanceOf([{ enter: at(9, 30), exit: at(18, 40), site }], W, at(23)).overtimeMin).toBe(0);
    // On time, left 1 h 30 min after the end.
    expect(attendanceOf([{ enter: at(9, 30), exit: at(20), site }], W, at(23)).overtimeMin).toBe(90);
    // Came very late and stayed a while after the end: short day, no overtime.
    expect(attendanceOf([{ enter: at(17), exit: at(19), site }], W, at(23)).overtimeMin).toBe(0);
  });

  it('personal time is not worked; marking it official counts it', () => {
    const visits = [{ enter: at(9, 30), exit: at(14), site }, { enter: at(16), exit: at(18, 30), site }];
    expect(attendanceOf(visits, W, at(19), [], decided([at(14), 'PERSONAL']))).toMatchObject({ personalMin: 120, workedMin: 420, halfDay: true });
    expect(attendanceOf(visits, W, at(19), [], decided([at(14), 'OFFICIAL']))).toMatchObject({ officialMin: 120, workedMin: 540, halfDay: false });
  });

  it('left early: counted as out until the shift end; official duty is not an early leave', () => {
    const visits = [{ enter: at(9, 30), exit: at(16), site }];
    expect(attendanceOf(visits, W, at(19))).toMatchObject({ earlyMin: 150, unexplainedMin: 150, workedMin: 390, halfDay: true, lastOut: at(16) });
    expect(attendanceOf(visits, W, at(19), [], decided([at(16), 'OFFICIAL']))).toMatchObject({ earlyMin: 0, officialMin: 150, workedMin: 540, halfDay: false });
  });

  it('below the half-day hours is absent even with a check-in', () => {
    expect(attendanceOf([{ enter: at(9, 30), exit: at(12), site }], W, at(19))).toMatchObject({ status: 'ABSENT', halfDay: false, firstIn: at(9, 30), workedMin: 150 });
  });

  it('a shift shorter than the limits can be a full day', () => {
    const short = { ...W, start: at(9), grace: at(9, 15), end: at(12) };
    expect(attendanceOf([{ enter: at(9), exit: at(12), site }], short, at(13))).toMatchObject({ status: 'PRESENT', halfDay: false });
  });

  it('a silent phone inside the fence earns no hours and shows as no signal', () => {
    const r = attendanceOf([{ enter: at(9, 30), exit: null, site }], W, at(13), [{ from: at(10), to: at(13) }]);
    expect(r).toMatchObject({ onSiteMin: 30, noSignalMin: 180, workedMin: 30, state: 'NO_SIGNAL', lastOut: null });
  });

  it('a phone left inside overnight is flagged and counts only from the attendance window', () => {
    const r = attendanceOf([{ enter: at(0) - 3_600_000, exit: null, site }], W, at(7));
    expect(r).toMatchObject({ carriedOver: true, firstIn: at(6, 30), onSiteMin: 30, inFix: null });
  });

  it('still inside past midnight is no last out; the next day shows it as carried over', () => {
    const stay = [{ enter: at(20), exit: at(24 + 7), site }];
    expect(attendanceOf(stay, W, at(24 + 10))).toMatchObject({ lastOut: null, firstIn: at(20) });
  });

  it('neighbouring sites are one stay; the first site is shown', () => {
    const r = attendanceOf([{ enter: at(9, 30), exit: at(12), site: 'A' }, { enter: at(11, 59), exit: at(18, 30), site: 'B' }], W, at(19));
    expect(r).toMatchObject({ site: 'A', outings: [], onSiteMin: 540 });
  });

  it('keeps the location of the first entry and last exit', () => {
    const f1 = { lat: 13, lng: 80, accuracyM: 8 };
    const f2 = { lat: 13.1, lng: 80.1, accuracyM: null };
    const r = attendanceOf([{ enter: at(9, 30), exit: at(18, 30), site, enterFix: f1, exitFix: f2 }], W, at(19));
    expect(r).toMatchObject({ inFix: f1, outFix: f2 });
  });
});

describe('signalGaps', () => {
  const MIN20 = 20 * 60_000;
  it('no data at all is one gap', () => {
    expect(signalGaps([], null, null, at(9), at(10), MIN20)).toEqual([{ from: at(9), to: at(10) }]);
  });
  it('adds the start and the end, keeps only long pauses', () => {
    const pauses = [{ from: at(11), to: at(11, 30) }, { from: at(12), to: at(12, 10) }];
    expect(signalGaps(pauses, at(10), at(14), at(9), at(15), MIN20)).toEqual([{ from: at(9), to: at(10) }, { from: at(11), to: at(11, 30) }, { from: at(14), to: at(15) }]);
  });
});

describe('shifts and sites', () => {
  const shift = { id: 's', name: 'Store', days: [1], startMin: 600, endMin: 1200, branchIds: ['b1'], objectIds: [] };
  const own = { ...shift, id: 'o', name: 'Own', branchIds: [], objectIds: ['p2'] };
  const s = { ...DEFAULT_ATTENDANCE, shifts: [shift, own] };
  it('person beats branch beats default', () => {
    expect(shiftOf(s, 'p2', 'b1').name).toBe('Own');
    expect(shiftOf(s, 'p1', 'b1').name).toBe('Store');
    expect(shiftOf(s, 'p1', 'b2')).toMatchObject({ name: 'Default', startMin: DEFAULT_ATTENDANCE.startMin });
    expect(shiftOf(s, 'p1', null).name).toBe('Default');
  });
  it('home branch only, unless allowed', () => {
    expect(siteCountsFor(s, 'p', 'b1', 'b1')).toBe(true);
    expect(siteCountsFor(s, 'p', 'b1', 'b2')).toBe(false);
    expect(siteCountsFor(s, 'p', 'b1', null)).toBe(true);
    expect(siteCountsFor(s, 'p', null, 'b2')).toBe(true);
    expect(siteCountsFor({ anyBranchObjectIds: ['p'] }, 'p', 'b1', 'b2')).toBe(true);
  });
});

describe('attendanceSettingsError', () => {
  const ok = { ...DEFAULT_ATTENDANCE, enabled: true, geofenceIds: ['g'] };
  it('validates settings', () => {
    expect(attendanceSettingsError({ ...DEFAULT_ATTENDANCE, enabled: true })).toMatch(/geofence/);
    expect(attendanceSettingsError({ ...ok, endMin: 60 })).toMatch(/after the start/);
    expect(attendanceSettingsError(ok)).toBeNull();
  });
  it('validates limits and shifts', () => {
    expect(attendanceSettingsError({ ...ok, noSignalMin: 5 })).toMatch(/No signal/);
    expect(attendanceSettingsError({ ...ok, halfDayMin: 500 })).toMatch(/Half day/);
    const shift = { id: 's', name: 'A', days: [1], startMin: 600, endMin: 1200, branchIds: [], objectIds: [] };
    expect(attendanceSettingsError({ ...ok, shifts: [shift] })).toBeNull();
    expect(attendanceSettingsError({ ...ok, shifts: [{ ...shift, name: ' ' }] })).toMatch(/name/);
    expect(attendanceSettingsError({ ...ok, shifts: [shift, { ...shift, id: 't', name: 'a' }] })).toMatch(/different/);
    expect(attendanceSettingsError({ ...ok, shifts: [{ ...shift, endMin: 100 }] })).toMatch(/after the start/);
  });
});
