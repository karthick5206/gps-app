import { AlertTypeCode, EffectiveAlertSetting, nextParkingStart, parkingArmedWindow, parkingScheduleError } from '@veetracer/shared';
import { resolveEffectiveSettings } from '../../alerts/logic/settings-resolution';
import { emptyAlertState, EvalContext, evaluatePosition, RuleInput } from './evaluate';

const TZ = 'Asia/Kolkata';
// Monday 2026-10-19 23:00 IST.
const MON_2300 = Date.parse('2026-10-19T17:30:00Z');
const min = (m: number) => MON_2300 + m * 60_000;

const settings = (): Map<AlertTypeCode, EffectiveAlertSetting> =>
  new Map(resolveEffectiveSettings({ groups: [], object: {} }, ['ignition', 'sos', 'power_cut'], [], MON_2300).map((s) => [s.alertType, s]));

let ids = 0;
const armed = (alarmAllAlerts = true): EvalContext => ({
  settings: settings(),
  geofences: [],
  timezone: TZ,
  newId: () => `p-${++ids}`,
  parking: { start: min(-60), end: min(420), alarmAllAlerts },
});

const object = { objectId: 'o1', companyId: 'c1', branchId: null, name: 'Car 01', plateNumber: 'TN-01', deviceId: 'd1', speedLimitKph: 60 };
const at = (t: number, p: Partial<RuleInput> = {}): RuleInput => ({ object, fixTime: t, receivedAt: t, lat: 13.08, lng: 80.27, speedKph: 0, ignition: false, attributes: {}, ...p });

describe('parking mode windows', () => {
  const nights = [{ days: [1, 2, 3, 4, 5], startMin: 22 * 60, endMin: 6 * 60 }];

  it('is armed from the start day into the next morning (overnight window)', () => {
    expect(parkingArmedWindow(nights, MON_2300, TZ)).toEqual({ start: min(-60), end: min(420) });
    // Tuesday 05:59 IST: still Monday night's window.
    expect(parkingArmedWindow(nights, min(419), TZ)).not.toBeNull();
    // Tuesday 06:00: over.
    expect(parkingArmedWindow(nights, min(420), TZ)).toBeNull();
  });

  it('is not armed on a day that is not chosen, and finds the next start', () => {
    const sat2300 = MON_2300 + 5 * 86_400_000;
    expect(parkingArmedWindow(nights, sat2300, TZ)).toBeNull();
    // Next: Monday 22:00, 47 hours later.
    expect(nextParkingStart(nights, sat2300, TZ)).toBe(sat2300 + 47 * 3_600_000);
  });

  it('validates the schedule', () => {
    expect(parkingScheduleError({ enabled: true, windows: [], alarmAllAlerts: true })).toMatch(/Add a time window/);
    expect(parkingScheduleError({ enabled: true, windows: [{ days: [], startMin: 0, endMin: 60 }], alarmAllAlerts: true })).toMatch(/at least one day/);
    expect(parkingScheduleError({ enabled: true, windows: nights, alarmAllAlerts: true })).toBeNull();
  });
});

describe('parking mode breach', () => {
  it('raises a breach when the ignition comes on, marked as an alarm', () => {
    const c = armed();
    const state = emptyAlertState();
    expect(evaluatePosition(at(min(0)), state, c).alerts).toHaveLength(0);
    const out = evaluatePosition(at(min(1), { ignition: true }), state, c);
    const breach = out.alerts.find((a) => a.type === 'PARKING_BREACH')!;
    expect(breach.message).toMatch(/ignition on/);
    expect(breach.data.parkingAlarm).toBe(true);
    expect(breach.ackRequired).toBe(true);
  });

  it('raises a breach when the vehicle is moved away (towing, engine off)', () => {
    const c = armed();
    const state = emptyAlertState();
    evaluatePosition(at(min(0)), state, c);
    const out = evaluatePosition(at(min(2), { lat: 13.08 + 300 / 111_320 }), state, c);
    expect(out.alerts.find((a) => a.type === 'PARKING_BREACH')?.message).toMatch(/300 m from where it was parked/);
  });

  it('ignores GPS wobble while parked and repeats a lasting breach only after 10 minutes', () => {
    const c = armed();
    const state = emptyAlertState();
    evaluatePosition(at(min(0)), state, c);
    expect(evaluatePosition(at(min(1), { lat: 13.08 + 40 / 111_320 }), state, c).alerts).toHaveLength(0);
    const first = evaluatePosition(at(min(2), { speedKph: 30, lat: 13.081 }), state, c).alerts.filter((a) => a.type === 'PARKING_BREACH');
    const soon = evaluatePosition(at(min(5), { speedKph: 30, lat: 13.083 }), state, c).alerts.filter((a) => a.type === 'PARKING_BREACH');
    const later = evaluatePosition(at(min(13), { speedKph: 30, lat: 13.09 }), state, c).alerts.filter((a) => a.type === 'PARKING_BREACH');
    expect([first.length, soon.length, later.length]).toEqual([1, 0, 1]);
  });

  it('rings other alerts as alarms only with "every alert"', () => {
    const sos = (c: EvalContext) => evaluatePosition(at(min(0), { attributes: { alarm: 'sos' } }), emptyAlertState(), c).alerts.find((a) => a.type === 'SOS')!;
    expect(sos(armed(true)).data.parkingAlarm).toBe(true);
    expect(sos(armed(false)).data.parkingAlarm).toBeUndefined();
  });

  it('does nothing when not armed', () => {
    const c: EvalContext = { ...armed(), parking: null };
    expect(evaluatePosition(at(min(0), { ignition: true, speedKph: 40 }), emptyAlertState(), c).alerts.some((a) => a.type === 'PARKING_BREACH')).toBe(false);
  });
});
