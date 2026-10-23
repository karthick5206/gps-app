import { AlertTypeCode, EffectiveAlertSetting } from '@veetracer/shared';
import { resolveEffectiveSettings, SettingOverride } from '../../alerts/logic/settings-resolution';
import { deviceCapabilities } from '../../alerts/rules-data';
import { AlertState, emptyAlertState, EvalContext, evaluatePosition, IoAlertInput, RuleInput } from './evaluate';

const T0 = Date.parse('2026-10-20T06:00:00Z');
const sec = (s: number) => T0 + s * 1000;
const ov = (p: Partial<SettingOverride>): SettingOverride => ({ enabled: null, params: {}, schedule: null, cooldownMin: 0, severity: null, channels: null, ...p });

function settings(caps: string[], object: Partial<Record<AlertTypeCode, Partial<SettingOverride>>> = {}): Map<AlertTypeCode, EffectiveAlertSetting> {
  const chain = { groups: [], object: Object.fromEntries(Object.entries(object).map(([k, v]) => [k, ov(v!)])) };
  return new Map(resolveEffectiveSettings(chain, caps, [], T0).map((s) => [s.alertType, s]));
}
let n = 0;
const ctx = (s: Map<AlertTypeCode, EffectiveAlertSetting>): EvalContext => ({ settings: s, geofences: [], timezone: 'Asia/Kolkata', newId: () => `a${++n}` });
const object = { objectId: 'o1', companyId: 'c1', branchId: null, name: 'Bus 7', plateNumber: 'TN-07', deviceId: 'd1', speedLimitKph: 60 };
const io = (p: Partial<IoAlertInput>): IoAlertInput => ({ acOn: null, doorOpen: null, transitions: [], ...p });
const at = (t: number, p: Partial<RuleInput> = {}): RuleInput => ({ object, fixTime: t, lat: 13.08, lng: 80.27, speedKph: 0, ignition: true, attributes: {}, ...p });

function run(points: RuleInput[], c: EvalContext, state: AlertState = emptyAlertState()) {
  return points.flatMap((p) => evaluatePosition(p, state, c).alerts).filter((a) => !a.type.startsWith('IGNITION'));
}

const CAPS = deviceCapabilities({ model: { capabilities: ['ignition'] }, ioSensors: [{ kind: 'AC' }, { kind: 'DOOR' }] });

describe('AC / door alerts', () => {
  it('capabilities come from the configured sensors', () => {
    expect(CAPS).toEqual(['ignition', 'ac', 'door']);
    const s = settings(['ignition']);
    expect(s.get('AC_ON_ENGINE_OFF')!.supported).toBe(false);
    expect(settings(CAPS).get('AC_ON_ENGINE_OFF')).toMatchObject({ supported: true, enabled: true });
    expect(settings(CAPS).get('AC_ON')!.enabled).toBe(false); // INFO, off by default
  });

  it('AC_ON / AC_OFF and DOOR_OPEN / DOOR_CLOSED on transitions when enabled', () => {
    const c = ctx(settings(CAPS, { AC_ON: { enabled: true }, AC_OFF: { enabled: true }, DOOR_OPEN: { enabled: true }, DOOR_CLOSED: { enabled: true } }));
    const alerts = run(
      [
        at(sec(0), { io: io({ acOn: true, transitions: [{ kind: 'AC', on: true, at: sec(0), previousSec: 100 }] }) }),
        at(sec(60), { io: io({ acOn: false, doorOpen: true, transitions: [{ kind: 'AC', on: false, at: sec(50), previousSec: 50 }, { kind: 'DOOR', on: true, at: sec(55), previousSec: null }] }) }),
        at(sec(90), { io: io({ doorOpen: false, transitions: [{ kind: 'DOOR', on: false, at: sec(90), previousSec: 35 }] }) }),
      ],
      c,
    );
    expect(alerts.map((a) => a.type)).toEqual(['AC_ON', 'AC_OFF', 'DOOR_OPEN', 'DOOR_CLOSED']);
    expect(alerts[1]).toMatchObject({ occurredAt: sec(50), data: expect.objectContaining({ durationSec: 50 }) });
    expect(alerts[3].data).toMatchObject({ durationSec: 35 });
  });

  it('AC_ON_ENGINE_OFF after the configured minutes, once per episode', () => {
    const c = ctx(settings(CAPS, { AC_ON_ENGINE_OFF: { params: { minutes: 10 } } }));
    const state = emptyAlertState();
    const off = (s: number) => at(sec(s), { ignition: false, io: io({ acOn: true }) });
    expect(run([off(0), off(300), off(599)], c, state)).toHaveLength(0);
    const raised = run([off(600), off(900)], c, state);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: 'AC_ON_ENGINE_OFF', severity: 'WARNING', data: expect.objectContaining({ durationSec: 600 }) });
    // Ignition on resets the episode; a new 10 minutes is needed.
    expect(run([at(sec(1000), { ignition: true, io: io({ acOn: true }) }), off(1100), off(1600)], c, state)).toHaveLength(0);
    expect(run([off(1700)], c, state)).toHaveLength(1);
  });

  it('DOOR_OPEN_WHILE_MOVING above the speed, once per door-open period', () => {
    const c = ctx(settings(CAPS));
    const state = emptyAlertState();
    const open = (s: number, kph: number) => at(sec(s), { speedKph: kph, io: io({ doorOpen: true }) });
    expect(run([open(0, 5), open(10, 9)], c, state)).toHaveLength(0);
    expect(run([open(20, 25), open(30, 40)], c, state).map((a) => a.type)).toEqual(['DOOR_OPEN_WHILE_MOVING']);
    run([at(sec(40), { speedKph: 30, io: io({ doorOpen: false }) })], c, state);
    expect(run([open(50, 30)], c, state)).toHaveLength(0); // 5 min cooldown
    run([at(sec(60), { speedKph: 30, io: io({ doorOpen: false }) })], c, state);
    expect(run([open(400, 30)], c, state)).toHaveLength(1);
  });

  it('no sensor alerts without io input or when not supported', () => {
    expect(run([at(sec(0), { ignition: false })], ctx(settings(CAPS)))).toHaveLength(0);
    expect(run([at(sec(0), { speedKph: 50, io: io({ doorOpen: true }) })], ctx(settings(['ignition'])))).toHaveLength(0);
  });

  it('extVoltage wired to the AC (GT800 purple wire) is not treated as a low vehicle battery', () => {
    const c = ctx(settings(CAPS, { POWER_LOW: { params: { afterMin: 0 } } }));
    const v9 = (t: number, wired?: string[]) => at(sec(t), { attributes: { extVoltage: 9 }, io: io({ acOn: true, wired }) });
    expect(run([v9(0, ['extVoltage']), v9(60, ['extVoltage'])], c).map((a) => a.type)).not.toContain('POWER_LOW');
    expect(run([v9(0), v9(60)], c).map((a) => a.type)).toContain('POWER_LOW');
  });
});

describe('connection alerts', () => {
  const all = (points: RuleInput[], c: EvalContext, state: AlertState) => points.flatMap((p) => evaluatePosition(p, state, c).alerts);
  const rx = (s: number, attributes: Record<string, unknown> = {}) => at(sec(s), { receivedAt: sec(s), attributes });

  it('DEVICE_ONLINE once when an object marked OFFLINE sends data again', () => {
    const c = ctx(settings(CAPS));
    const state = emptyAlertState();
    expect(all([rx(0), rx(60)], c, state).map((a) => a.type)).not.toContain('DEVICE_ONLINE');
    const back = all([{ ...rx(4000), offlineSince: sec(60) }], c, state).filter((a) => a.type === 'DEVICE_ONLINE');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ severity: 'INFO', data: expect.objectContaining({ durationSec: 3940 }) });
  });

  it('SIM_CHANGED only when a different ICCID follows a known one', () => {
    const c = ctx(settings(CAPS));
    const state = emptyAlertState();
    const types = (pts: RuleInput[]) => all(pts, c, state).map((a) => a.type);
    expect(types([rx(0, { iccid: '89914500001234567890' }), rx(60, { iccid: '89914500001234567890' }), rx(120)])).not.toContain('SIM_CHANGED');
    const changed = all([rx(180, { iccid: '89914599998888777766' })], c, state).filter((a) => a.type === 'SIM_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ severity: 'CRITICAL', data: { previousIccid: '89914500001234567890', iccid: '89914599998888777766' } });
  });
});

describe('harsh driving alerts', () => {
  it('tracker-reported harsh acceleration / braking / cornering become alerts with the speed', () => {
    const c = ctx(settings(CAPS));
    const state = emptyAlertState();
    const out = (alarm: string, t: number, extra: Record<string, unknown> = {}) => evaluatePosition(at(sec(t), { speedKph: 42, attributes: { alarm, ...extra } }), state, c).alerts;
    expect(out('harshBraking', 0)).toEqual([expect.objectContaining({ type: 'HARSH_BRAKING', severity: 'WARNING', message: 'Harsh braking at 42 km/h' })]);
    expect(out('harshAcceleration', 100, { greenDrivingValue: 3.1 })[0]).toMatchObject({ type: 'HARSH_ACCELERATION', message: 'Harsh acceleration at 42 km/h (3.1)' });
    expect(out('harshCornering', 200)[0].type).toBe('HARSH_CORNERING');
  });
});

describe('power cut without a voltage reading', () => {
  it('vehicle tracker: external power connected → disconnected raises POWER_CUT; a person / ID card on a charger does not', () => {
    const c = ctx(settings([...CAPS, 'power_cut']));
    const veh = { ...object, type: 'VEHICLE' };
    const run1 = (o: typeof veh, chg: boolean, t: number, state: AlertState) => evaluatePosition(at(sec(t), { object: o, receivedAt: sec(t), attributes: { charging: chg } }), state, c).alerts.map((a) => a.type);
    const st = emptyAlertState();
    expect(run1(veh, true, 0, st)).not.toContain('POWER_CUT');
    expect(run1(veh, false, 60, st)).toContain('POWER_CUT');
    const card = { ...object, type: 'PERSON' };
    const st2 = emptyAlertState();
    run1(card, true, 0, st2);
    expect(run1(card, false, 60, st2)).not.toContain('POWER_CUT');
  });
});

describe('device alarms', () => {
  const types = (alarm: string, attrs: Record<string, unknown> = {}, caps: string[] = CAPS, enable: Partial<Record<AlertTypeCode, Partial<SettingOverride>>> = {}) =>
    evaluatePosition(at(sec(0), { attributes: { alarm, ...attrs } }), emptyAlertState(), ctx(settings(caps, enable))).alerts.map((a) => [a.type, a.message]);

  it('anti-theft, GPS and power alarms map to their alert types', () => {
    expect(types('towing')).toEqual([['TOWING', 'Vehicle moved with the engine off (towing?)']]);
    expect(types('illegalIgnition')[0][0]).toBe('TOWING');
    expect(types('illegalDoorOpen')[0][0]).toBe('TOWING');
    expect(types('gpsAntennaCut')).toEqual([['DEVICE_TAMPER', 'GPS antenna disconnected (possible tampering)']]);
    expect(types('gpsAntennaShort')[0][0]).toBe('GPS_FAULT');
    expect(types('gnssFault')[0][0]).toBe('GPS_FAULT');
    expect(types('powerLow')[0][0]).toBe('POWER_LOW');
  });

  it('vibration is off by default and alerts once enabled', () => {
    expect(types('vibration')).toEqual([]);
    expect(types('vibration', {}, CAPS, { VIBRATION: { enabled: true } })[0][0]).toBe('VIBRATION');
  });

  it('device-side overspeed and geofence alarms are left to the server rules', () => {
    expect(types('overspeed')).toEqual([]);
    expect(types('geofenceEnter')).toEqual([]);
  });

  it("the tracker's low-battery alarm alerts without a battery %; with one it is not raised twice", () => {
    expect(types('lowBattery')).toEqual([['LOW_BATTERY', 'Tracker battery low']]);
    expect(types('lowBattery', { batteryLevel: 12 })).toEqual([['LOW_BATTERY', 'Tracker battery low (12%)']]);
  });

  it('unrecognised codes from any protocol become UNKNOWN_ALARM; alarm_0 is no alarm', () => {
    for (const code of ['alarm_52', 'alarm_bit15', 'alarm_XY', 'alarm_XY_31']) expect(types(code)[0][0]).toBe('UNKNOWN_ALARM');
    expect(types('alarm_0')).toEqual([]);
  });

  it('safety alarms alert even when the device model lacks the capability', () => {
    expect(types('sos', {}, [])[0][0]).toBe('SOS');
    expect(types('powerCut', {}, [])[0][0]).toBe('POWER_CUT');
    expect(types('crash', {}, [])[0][0]).toBe('CRASH');
  });

  it('late points (alarmsOnly): the alarm alerts, dated by the server clock; other rules do not run', () => {
    const c = ctx(settings(CAPS));
    const late = (alarm: string) =>
      evaluatePosition(at(sec(-3600), { receivedAt: sec(0), alarmsOnly: true, ignition: false, attributes: { alarm, batteryLevel: 5 } }), emptyAlertState(), c).alerts;
    const sos = late('sos');
    expect(sos.map((a) => a.type)).toEqual(['SOS']); // no LOW_BATTERY from the stale reading
    expect(sos[0].occurredAt).toBe(sec(0));
    expect(late('crash').map((a) => a.type)).toEqual(['CRASH']);
  });
});

describe('alerts without a GPS fix', () => {
  it('carry noFix and the time of the last fix their location comes from; normal alerts do not', () => {
    const c = ctx(settings(CAPS));
    const noFix = evaluatePosition(at(sec(0), { locationValid: false, lastFixAt: sec(-600), receivedAt: sec(0), attributes: { alarm: 'sos' } }), emptyAlertState(), c).alerts[0];
    expect(noFix.data).toMatchObject({ noFix: true, lastFixAt: new Date(sec(-600)).toISOString() });
    const unknown = evaluatePosition(at(sec(0), { locationValid: false, lat: Number.NaN, lng: Number.NaN, attributes: { alarm: 'sos' } }), emptyAlertState(), c).alerts[0];
    expect(unknown).toMatchObject({ lat: null, data: { noFix: true } });
    expect(unknown.data.lastFixAt).toBeUndefined();
    const ok = evaluatePosition(at(sec(0), { attributes: { alarm: 'sos' } }), emptyAlertState(), c).alerts[0];
    expect(ok.data.noFix).toBeUndefined();
  });
});
