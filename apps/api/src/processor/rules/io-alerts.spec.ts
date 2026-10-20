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
});
