import { inAnyTimeWindow, inDailyRange, inTimeWindow, localParts } from './time-window';

const TZ = 'Asia/Kolkata'; // UTC+05:30
/** Local Kolkata wall time → epoch ms. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`);

describe('time windows (company timezone)', () => {
  it('computes local weekday and minutes in Asia/Kolkata', () => {
    // 2026-10-18 is a Sunday. 20:00 UTC Saturday = 01:30 IST Sunday.
    expect(localParts(Date.parse('2026-10-17T20:00:00Z'), TZ)).toEqual({ day: 7, minutes: 90 });
    expect(localParts(ist('2026-10-19T09:15:00'), TZ)).toEqual({ day: 1, minutes: 555 });
  });

  it('handles same-day windows with an exclusive end', () => {
    const w = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
    expect(inAnyTimeWindow([w], ist('2026-10-19T09:00:00'), TZ)).toBe(true); // Monday
    expect(inAnyTimeWindow([w], ist('2026-10-19T17:59:00'), TZ)).toBe(true);
    expect(inAnyTimeWindow([w], ist('2026-10-19T18:00:00'), TZ)).toBe(false);
    expect(inAnyTimeWindow([w], ist('2026-10-18T10:00:00'), TZ)).toBe(false); // Sunday
  });

  it('wraps across midnight and attributes the early hours to the starting day', () => {
    const fridayNight = { days: [5], from: '22:00', to: '06:00' };
    expect(inAnyTimeWindow([fridayNight], ist('2026-10-23T23:30:00'), TZ)).toBe(true); // Friday 23:30
    expect(inAnyTimeWindow([fridayNight], ist('2026-10-24T05:59:00'), TZ)).toBe(true); // Saturday 05:59 (Friday's window)
    expect(inAnyTimeWindow([fridayNight], ist('2026-10-24T06:00:00'), TZ)).toBe(false);
    expect(inAnyTimeWindow([fridayNight], ist('2026-10-23T05:00:00'), TZ)).toBe(false); // Friday 05:00 belongs to Thursday
    expect(inAnyTimeWindow([fridayNight], ist('2026-10-24T22:30:00'), TZ)).toBe(false); // Saturday night
    // UTC instant that is already the next local day.
    expect(inAnyTimeWindow([fridayNight], Date.parse('2026-10-23T19:00:00Z'), TZ)).toBe(true); // 00:30 IST Saturday
  });

  it('Sunday-night windows continue into Monday morning', () => {
    const w = { days: [7], from: '23:00', to: '02:00' };
    expect(inTimeWindow(w, { day: 1, minutes: 60 })).toBe(true);
    expect(inTimeWindow(w, { day: 2, minutes: 60 })).toBe(false);
  });

  it('empty list = always; from == to = whole day; daily ranges ignore weekdays', () => {
    expect(inAnyTimeWindow([], ist('2026-10-19T03:00:00'), TZ)).toBe(true);
    expect(inAnyTimeWindow(null, ist('2026-10-19T03:00:00'), TZ)).toBe(true);
    expect(inAnyTimeWindow([{ days: [1], from: '00:00', to: '00:00' }], ist('2026-10-19T23:59:00'), TZ)).toBe(true);
    expect(inDailyRange('22:00', '05:00', ist('2026-10-21T04:30:00'), TZ)).toBe(true);
    expect(inDailyRange('22:00', '05:00', ist('2026-10-21T12:00:00'), TZ)).toBe(false);
    expect(inDailyRange('bad', '05:00', ist('2026-10-21T04:30:00'), TZ)).toBe(false);
  });
});
