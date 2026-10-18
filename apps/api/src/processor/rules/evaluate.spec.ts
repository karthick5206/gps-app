import { AlertTypeCode, EffectiveAlertSetting, GeofenceGeometry } from '@veetracer/shared';
import { geometryBBox } from '../../alerts/logic/geofence-geometry';
import { resolveEffectiveSettings, SettingOverride, SettingsChain } from '../../alerts/logic/settings-resolution';
import { GeofenceRuntime } from '../../alerts/rules-data';
import { AlertState, emptyAlertState, EvalContext, evaluatePosition, overspeedLimit, RuleInput } from './evaluate';

const T0 = Date.parse('2026-10-19T06:00:00Z'); // 11:30 IST Monday
const sec = (s: number) => T0 + s * 1000;
const GT06 = ['ignition', 'sos', 'power_cut', 'battery'];

const ov = (p: Partial<SettingOverride>): SettingOverride => ({ enabled: null, params: {}, schedule: null, cooldownMin: null, severity: null, channels: null, ...p });

function settings(object: Partial<Record<AlertTypeCode, Partial<SettingOverride>>> = {}, snoozeUntil?: number): Map<AlertTypeCode, EffectiveAlertSetting> {
  const chain: SettingsChain = { groups: [], object: Object.fromEntries(Object.entries(object).map(([k, v]) => [k, ov(v!)])) };
  const snoozes = snoozeUntil ? [{ alertTypes: [], until: snoozeUntil }] : [];
  return new Map(resolveEffectiveSettings(chain, GT06, snoozes, T0).map((s) => [s.alertType, s]));
}

function geofence(id: string, geometry: GeofenceGeometry, extra: Partial<GeofenceRuntime> = {}): GeofenceRuntime {
  return {
    id,
    name: id,
    branchId: null,
    geometry,
    bbox: geometryBBox(geometry),
    mode: 'NORMAL',
    notifyEnter: true,
    notifyExit: true,
    maxStayMin: null,
    speedLimitKph: null,
    timeWindows: [],
    appliesToAll: true,
    branchTargets: new Set(),
    groupTargets: new Set(),
    objectTargets: new Set(),
    ...extra,
  };
}

let ids = 0;
function ctx(s = settings(), geofences: GeofenceRuntime[] = []): EvalContext {
  return { settings: s, geofences, timezone: 'Asia/Kolkata', newId: () => `id-${++ids}` };
}

const object = { objectId: 'o1', companyId: 'c1', branchId: 'b1', name: 'Car 01', plateNumber: 'TN-01', deviceId: 'd1', speedLimitKph: 60 };
const at = (t: number, p: Partial<RuleInput> = {}): RuleInput => ({
  object,
  fixTime: t,
  lat: 13.08,
  lng: 80.27,
  speedKph: 0,
  ignition: true,
  attributes: {},
  ...p,
});

/** Feed a sequence and collect all alerts / visits / data updates. */
function run(points: RuleInput[], c: EvalContext, state: AlertState = emptyAlertState()) {
  const alerts = [];
  const visits = [];
  const updates = [];
  for (const p of points) {
    const out = evaluatePosition(p, state, c);
    alerts.push(...out.alerts);
    visits.push(...out.visits);
    updates.push(...out.dataUpdates);
  }
  return { alerts, visits, updates, state };
}

describe('overspeed episodes', () => {
  it('respects tolerance and minimum duration, then alerts once per episode with an end summary', () => {
    const c = ctx(settings({ OVERSPEED: { params: { toleranceKph: 5, minDurationSec: 10 } } }));
    const r = run(
      [
        at(sec(0), { speedKph: 64 }), // within tolerance
        at(sec(5), { speedKph: 70 }), // over: episode starts
        at(sec(10), { speedKph: 72 }), // 5 s
        at(sec(15), { speedKph: 75 }), // 10 s → alert
        at(sec(20), { speedKph: 78 }), // no repeat
        at(sec(25), { speedKph: 50 }), // ends
      ],
      c,
    );
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ type: 'OVERSPEED', severity: 'WARNING', occurredAt: sec(15) });
    expect(r.alerts[0].data).toMatchObject({ limitKph: 60, toleranceKph: 5, durationSec: 10 });
    expect(r.updates).toEqual([{ alertId: r.alerts[0].id, data: expect.objectContaining({ durationSec: 15, maxSpeedKph: 78, limitKph: 60 }) }]);
    expect(r.state.os).toBeUndefined();
  });

  it('short bursts below the minimum duration never alert', () => {
    const c = ctx(settings({ OVERSPEED: { params: { minDurationSec: 30 } } }));
    const r = run([at(sec(0), { speedKph: 90 }), at(sec(10), { speedKph: 90 }), at(sec(20), { speedKph: 40 })], c);
    expect(r.alerts).toHaveLength(0);
  });

  it('starts CRITICAL when over the critical tier, escalates a WARNING episode once, and repeats when configured', () => {
    const crit = run([at(sec(0), { speedKph: 85 }), at(sec(10), { speedKph: 85 })], ctx(settings({ OVERSPEED: { params: { minDurationSec: 10, criticalOverKph: 20 } } })));
    expect(crit.alerts.map((a) => a.severity)).toEqual(['CRITICAL']);

    const c = ctx(settings({ OVERSPEED: { params: { minDurationSec: 0, criticalOverKph: 20, repeatEveryMin: 1 } } }));
    const r = run(
      [
        at(sec(0), { speedKph: 70 }), // WARNING immediately (min duration 0)
        at(sec(20), { speedKph: 90 }), // escalation to CRITICAL
        at(sec(40), { speedKph: 95 }), // nothing
        at(sec(85), { speedKph: 92 }), // repeat after ≥ 60 s since the last alert
      ],
      c,
    );
    expect(r.alerts.map((a) => [a.severity, a.data.escalated ?? false, a.data.repeat ?? false])).toEqual([
      ['WARNING', false, false],
      ['CRITICAL', true, false],
      ['CRITICAL', false, true],
    ]);
  });

  it('uses the night limit inside the night window (company timezone)', () => {
    const night = Date.parse('2026-10-19T17:00:00Z'); // 22:30 IST
    const c = ctx(settings({ OVERSPEED: { params: { nightLimitKph: 40, minDurationSec: 0 } } }));
    const r = run([at(night, { speedKph: 50 })], c);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].data).toMatchObject({ limitKph: 40, night: true });
    expect(run([at(sec(0), { speedKph: 50 })], ctx(settings({ OVERSPEED: { params: { nightLimitKph: 40, minDurationSec: 0 } } }))).alerts).toHaveLength(0);
  });

  it('honours enable, snooze and schedule gates without breaking the episode', () => {
    expect(run([at(sec(0), { speedKph: 90 }), at(sec(20), { speedKph: 90 })], ctx(settings({ OVERSPEED: { enabled: false } }))).alerts).toHaveLength(0);
    expect(run([at(sec(0), { speedKph: 90 }), at(sec(20), { speedKph: 90 })], ctx(settings({}, sec(3600)))).alerts).toHaveLength(0);
    // Schedule 09:00–10:00 IST; T0 is 11:30 IST.
    const scheduled = settings({ OVERSPEED: { schedule: { days: [1, 2, 3, 4, 5, 6, 7], from: '09:00', to: '10:00' } } });
    expect(run([at(sec(0), { speedKph: 90 }), at(sec(20), { speedKph: 90 })], ctx(scheduled)).alerts).toHaveLength(0);
  });
});

describe('idling', () => {
  const idle = (t: number, p: Partial<RuleInput> = {}) => at(t, { speedKph: 1, ignition: true, ...p });

  it('alerts after the threshold, escalates to critical, and ignores small movement', () => {
    const c = ctx(settings({ IDLING: { params: { thresholdMin: 10, criticalMin: 20, movementToleranceM: 50, repeatEveryMin: 0 } } }));
    const pts = [];
    for (let m = 0; m <= 21; m++) pts.push(idle(sec(m * 60), { lat: 13.08 + (m % 2) * 0.0002 })); // ~22 m jitter
    const r = run(pts, c);
    expect(r.alerts.map((a) => [a.severity, Math.round((a.occurredAt - T0) / 60_000)])).toEqual([
      ['WARNING', 10],
      ['CRITICAL', 20],
    ]);
    // Moving away ends the episode with a summary.
    const end = evaluatePosition(at(sec(22 * 60), { speedKph: 30 }), r.state, c);
    expect(end.dataUpdates).toHaveLength(1);
    expect(end.dataUpdates[0].data.durationSec).toBe(21 * 60);
  });

  it('movement beyond the tolerance restarts the timer; engine off is not idling', () => {
    const c = ctx(settings({ IDLING: { params: { thresholdMin: 2, movementToleranceM: 20 } } }));
    const r = run([idle(sec(0)), idle(sec(60)), idle(sec(110), { lat: 13.081 }), idle(sec(170), { lat: 13.081 })], c);
    expect(r.alerts).toHaveLength(0); // restarted at 110 s, only 60 s idle since
    expect(run([idle(sec(0), { ignition: false }), idle(sec(300), { ignition: false })], c).alerts).toHaveLength(0);
  });

  it('uses external voltage when there is no ignition signal', () => {
    const c = ctx(settings({ IDLING: { params: { thresholdMin: 1 } } }));
    const on = run([idle(sec(0), { ignition: null, attributes: { extVoltage: 13.8 } }), idle(sec(61), { ignition: null, attributes: { extVoltage: 13.8 } })], c);
    expect(on.alerts).toHaveLength(1);
    const off = run([idle(sec(0), { ignition: null, attributes: { extVoltage: 12.4 } }), idle(sec(61), { ignition: null, attributes: { extVoltage: 12.4 } })], c);
    expect(off.alerts).toHaveLength(0);
  });

  it('does not alert inside excluded geofences', () => {
    const depot = geofence('depot', { type: 'CIRCLE', center: { lat: 13.08, lng: 80.27 }, radiusM: 200 });
    const c = ctx(settings({ IDLING: { params: { thresholdMin: 1, excludeGeofenceIds: ['depot'] } }, GEOFENCE_ENTER: { enabled: false } }), [depot]);
    const r = run([idle(sec(0)), idle(sec(30)), idle(sec(90)), idle(sec(150))], c);
    expect(r.alerts.filter((a) => a.type === 'IDLING')).toHaveLength(0);
  });

  it('repeats while idling', () => {
    const c = ctx(settings({ IDLING: { params: { thresholdMin: 1, criticalMin: 100, repeatEveryMin: 2 } } }));
    const pts = [0, 60, 120, 180, 240, 300].map((s) => idle(sec(s)));
    expect(run(pts, c).alerts.map((a) => (a.occurredAt - T0) / 1000)).toEqual([60, 180, 300]);
  });
});

describe('geofences', () => {
  const zone = geofence('zone', { type: 'CIRCLE', center: { lat: 13.08, lng: 80.27 }, radiusM: 100 });
  const outsideLat = 13.08 + 500 / 110_574;
  const edgeLat = 13.08 + 108 / 110_574; // 8 m outside the boundary (inside the 15 m buffer)

  it('enters/exits with anti-flapping, writes visits, and ignores boundary jitter', () => {
    const c = ctx(settings(), [zone]);
    const r = run(
      [
        at(sec(0), { lat: outsideLat }),
        at(sec(10), { lat: 13.08 }), // candidate
        at(sec(20), { lat: 13.0801 }), // confirmed → ENTER at 10 s
        at(sec(30), { lat: edgeLat }), // jitter within buffer
        at(sec(40), { lat: 13.08 }),
        at(sec(50), { lat: edgeLat }),
        at(sec(60), { lat: outsideLat }), // candidate exit
        at(sec(70), { lat: outsideLat }), // confirmed → EXIT at 60 s
      ],
      c,
    );
    expect(r.alerts.map((a) => [a.type, (a.occurredAt - T0) / 1000])).toEqual([
      ['GEOFENCE_ENTER', 10],
      ['GEOFENCE_EXIT', 60],
    ]);
    expect(r.visits).toEqual([
      { kind: 'open', id: expect.any(String), geofenceId: 'zone', enterTime: sec(10) },
      { kind: 'close', id: r.visits[0].id, exitTime: sec(60), durationSec: 50 },
    ]);
    expect(r.state.gf.zone).toBeUndefined();
  });

  it('always writes visits even when geofence alerts are disabled', () => {
    const c = ctx(settings({ GEOFENCE_ENTER: { enabled: false }, GEOFENCE_EXIT: { enabled: false } }), [zone]);
    const r = run([at(sec(0)), at(sec(10)), at(sec(20), { lat: outsideLat }), at(sec(30), { lat: outsideLat })], c);
    expect(r.alerts).toHaveLength(0);
    expect(r.visits.map((v) => v.kind)).toEqual(['open', 'close']);
  });

  it('NO_GO entry and KEEP_IN exit are critical; notify flags and time windows are respected', () => {
    const noGo = geofence('nogo', zone.geometry, { mode: 'NO_GO', notifyEnter: false });
    const r1 = run([at(sec(0)), at(sec(10))], ctx(settings(), [noGo]));
    expect(r1.alerts.map((a) => [a.type, a.severity])).toEqual([['GEOFENCE_ENTER', 'CRITICAL']]);

    const keepIn = geofence('keep', zone.geometry, { mode: 'KEEP_IN', notifyEnter: false });
    const r2 = run([at(sec(0)), at(sec(10)), at(sec(20), { lat: outsideLat }), at(sec(30), { lat: outsideLat })], ctx(settings(), [keepIn]));
    expect(r2.alerts.map((a) => [a.type, a.severity])).toEqual([['GEOFENCE_EXIT', 'CRITICAL']]);

    const silent = geofence('silent', zone.geometry, { notifyEnter: false, notifyExit: false });
    expect(run([at(sec(0)), at(sec(10))], ctx(settings(), [silent])).alerts).toHaveLength(0);

    const night = geofence('night', zone.geometry, { timeWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '22:00', to: '06:00' }] });
    const r3 = run([at(sec(0)), at(sec(10))], ctx(settings(), [night]));
    expect(r3.alerts).toHaveLength(0);
    expect(r3.visits).toHaveLength(1);
  });

  it('raises GEOFENCE_STAY once per visit and GEOFENCE_OVERSPEED per overspeed episode', () => {
    const g = geofence('yard', zone.geometry, { maxStayMin: 1, speedLimitKph: 20 });
    const c = ctx(settings(), [g]);
    const r = run(
      [
        at(sec(0), { speedKph: 10 }),
        at(sec(10), { speedKph: 10 }), // enter at 0
        at(sec(70), { speedKph: 25 }), // stay ≥ 60 s + overspeed
        at(sec(80), { speedKph: 30 }),
        at(sec(90), { speedKph: 10 }),
        at(sec(500), { speedKph: 26 }), // new overspeed episode (beyond the 5 min default cooldown)
      ],
      c,
    );
    expect(r.alerts.map((a) => a.type)).toEqual(['GEOFENCE_ENTER', 'GEOFENCE_STAY', 'GEOFENCE_OVERSPEED', 'GEOFENCE_OVERSPEED']);
  });

  it('closes open visits when a geofence disappears', () => {
    const c = ctx(settings(), [zone]);
    const r = run([at(sec(0)), at(sec(10))], c);
    const out = evaluatePosition(at(sec(100)), r.state, ctx(settings(), []));
    expect(out.visits).toEqual([{ kind: 'close', id: r.visits[0].id, exitTime: sec(100), durationSec: 100 }]);
    expect(out.alerts).toHaveLength(0);
  });
});

describe('other rules', () => {
  it('ignition on/off on change only (on by default, can be disabled)', () => {
    const c = ctx(settings({ IGNITION_ON: { enabled: true }, IGNITION_OFF: { enabled: true } }));
    const r = run([at(sec(0), { ignition: false }), at(sec(5), { ignition: false }), at(sec(10), { ignition: true }), at(sec(15), { ignition: null }), at(sec(20), { ignition: false })], c);
    expect(r.alerts.map((a) => a.type)).toEqual(['IGNITION_ON', 'IGNITION_OFF']);
    expect(run([at(sec(0), { ignition: false }), at(sec(10), { ignition: true })], ctx()).alerts.map((a) => a.type)).toEqual(['IGNITION_ON']); // on by default
    const off = ctx(settings({ IGNITION_ON: { enabled: false }, IGNITION_OFF: { enabled: false } }));
    expect(run([at(sec(0), { ignition: false }), at(sec(10), { ignition: true })], off).alerts).toHaveLength(0);
  });

  it('without a GPS fix: ignition, SOS and battery alerts still fire; overspeed and geofences do not', () => {
    const noFix = (t: number, p: Partial<RuleInput> = {}) => at(t, { locationValid: false, lat: Number.NaN, lng: Number.NaN, ...p });
    const r = run([noFix(sec(0), { ignition: false }), noFix(sec(10), { ignition: true, speedKph: 150 }), noFix(sec(20), { speedKph: 150, attributes: { alarm: 'sos' } })], ctx());
    expect(r.alerts.map((a) => a.type)).toEqual(['IGNITION_ON', 'SOS']);
    expect(r.alerts[0]).toMatchObject({ lat: null, lng: null });
  });

  it('SOS ignores snoozes; cooldown suppresses repeats; power cut alerts', () => {
    const c = ctx(settings({}, sec(3600)));
    const r = run([at(sec(0), { attributes: { alarm: 'sos' } }), at(sec(30), { attributes: { alarm: 'sos' } }), at(sec(61), { attributes: { alarm: 'sos' } })], c);
    expect(r.alerts.map((a) => [a.type, a.severity, (a.occurredAt - T0) / 1000])).toEqual([
      ['SOS', 'CRITICAL', 0],
      ['SOS', 'CRITICAL', 61], // default 1 min cooldown
    ]);
    expect(run([at(sec(0), { attributes: { alarm: 'powerCut' } })], ctx()).alerts.map((a) => a.type)).toEqual(['POWER_CUT']);
  });

  it('low battery alerts once until it recovers above threshold + 5', () => {
    const c = ctx(settings({ LOW_BATTERY: { params: { thresholdPct: 20 } } }));
    const r = run(
      [15, 10, 22, 26, 18].map((b, i) => at(sec(i * 4000), { attributes: { batteryLevel: b } })),
      c,
    );
    expect(r.alerts.map((a) => a.data.batteryPct)).toEqual([15, 18]);
  });

  it('unsupported capabilities never alert', () => {
    const noIgnition = new Map(resolveEffectiveSettings({ groups: [] }, [], [], T0).map((s) => [s.alertType, s]));
    const r = run([at(sec(0), { attributes: { alarm: 'sos' } })], ctx(noIgnition));
    expect(r.alerts).toHaveLength(0);
  });
});

describe('device health', () => {
  const min = (m: number) => sec(m * 60);
  const types = (r: { alerts: { type: string }[] }) => r.alerts.map((a) => a.type);

  it('GPS lost after the configured time without a fix, once per episode, dated by the server clock', () => {
    const bogus = Date.parse('2007-01-01T00:00:00Z');
    const noFix = (m: number) => at(bogus, { locationValid: false, lat: Number.NaN, lng: Number.NaN, receivedAt: min(m) });
    const r = run([noFix(0), noFix(20), noFix(31), noFix(45), at(min(50)), noFix(55), noFix(90)], ctx());
    expect(types(r)).toEqual(['GPS_LOST', 'GPS_LOST']);
    expect(r.alerts[0]).toMatchObject({ occurredAt: min(31), data: { durationSec: 31 * 60 } });
  });

  it('weak GSM signal sustained for the configured time', () => {
    const g = (m: number, gsmSignal: number) => at(min(m), { attributes: { gsmSignal } });
    expect(types(run([g(0, 1), g(20, 0), g(29, 3), g(40, 1), g(75, 1)], ctx()))).toEqual(['GSM_WEAK']);
    expect(types(run([g(0, 2), g(60, 2)], ctx()))).toEqual([]);
  });

  it('power source: voltage drop to 0 V is a power cut; low voltage sustained is POWER_LOW with hysteresis', () => {
    const v = (m: number, extVoltage: number) => at(min(m), { attributes: { extVoltage } });
    expect(types(run([v(0, 12.6), v(1, 0.2)], ctx()))).toEqual(['POWER_CUT']);
    const r = run([v(0, 11.2), v(5, 11.4), v(11, 11.3), v(12, 11.6), v(13, 11.0), v(30, 12.4), v(31, 11.0), v(45, 11.1)], ctx());
    expect(r.alerts.map((a) => [a.type, a.data.voltage])).toEqual([
      ['POWER_LOW', 11.3],
      ['POWER_LOW', 11.1],
    ]);
  });

  it('data delayed when live (non-buffered) points arrive late; reuploads are ignored', () => {
    expect(types(run([at(min(0), { receivedAt: min(12) })], ctx()))).toEqual(['DATA_DELAYED']);
    expect(types(run([at(min(0), { receivedAt: min(12), attributes: { reupload: true } })], ctx()))).toEqual([]);
    expect(types(run([at(min(0), { receivedAt: min(5) })], ctx()))).toEqual([]);
  });

  it('clock error for points dated ahead of the server (health-only input)', () => {
    const r = run([at(min(330), { receivedAt: min(0), healthOnly: true, speedKph: 150, ignition: false })], ctx());
    expect(types(r)).toEqual(['CLOCK_ERROR']);
    expect(r.alerts[0].occurredAt).toBe(min(0));
  });

  it('tamper and jamming alarms', () => {
    expect(types(run([at(sec(0), { attributes: { alarm: 'tamper' } }), at(sec(600), { attributes: { alarm: 'jamming' } })], ctx()))).toEqual(['DEVICE_TAMPER', 'DEVICE_TAMPER']);
  });

  it('health alerts can be disabled', () => {
    const off = ctx(settings({ GSM_WEAK: { enabled: false } }));
    expect(types(run([at(min(0), { attributes: { gsmSignal: 0 } }), at(min(40), { attributes: { gsmSignal: 0 } })], off))).toEqual([]);
  });
});

describe('dashcam (ADAS / DMS)', () => {
  const JT808 = ['ignition', 'sos', 'power_cut', 'crash', 'adas', 'dms', 'video'];
  const dashcam = (object: Partial<Record<AlertTypeCode, Partial<SettingOverride>>> = {}, caps = JT808) => {
    const chain: SettingsChain = { groups: [], object: Object.fromEntries(Object.entries(object).map(([k, v]) => [k, ov(v!)])) };
    return ctx(new Map(resolveEffectiveSettings(chain, caps, [], T0).map((s) => [s.alertType, s])));
  };
  const types = (r: { alerts: { type: string }[] }) => r.alerts.map((a) => a.type);

  it('DMS fatigue raises DRIVER_FATIGUE with the level', () => {
    const r = run([at(sec(0), { speedKph: 48, attributes: { dms: 'fatigue', dmsLevel: 2 } })], dashcam());
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ type: 'DRIVER_FATIGUE', severity: 'CRITICAL', message: 'Driver fatigue detected (level 2)', data: { event: 'fatigue', level: 2, speedKph: 48, source: 'dms' } });
  });

  it('ADAS forward collision raises FORWARD_COLLISION_WARNING with the speed', () => {
    const r = run([at(sec(0), { speedKph: 54.2, attributes: { adas: 'fcw', adasLevel: 1 } })], dashcam());
    expect(r.alerts[0]).toMatchObject({ type: 'FORWARD_COLLISION_WARNING', severity: 'CRITICAL', message: 'Forward collision warning at 54 km/h (level 1)', data: { event: 'fcw', level: 1, speedKph: 54 } });
  });

  it('maps the other events and alarm bits', () => {
    const points = [
      { dms: 'phone' }, { dms: 'smoking' }, { dms: 'distraction' }, { dms: 'driverAbsent' }, { dms: 'cameraBlocked' },
      { adas: 'ldw' }, { adas: 'hmw' }, { alarm: 'crash' }, { adas: 'roadSignOverspeed' }, { dms: 'dms_9' },
    ].map((attributes, i) => at(sec(i), { attributes }));
    expect(types(run(points, dashcam()))).toEqual([
      'DRIVER_PHONE', 'DRIVER_SMOKING', 'DRIVER_DISTRACTED', 'DRIVER_ABSENT', 'CAMERA_FAULT', 'LANE_DEPARTURE', 'TAILGATING', 'CRASH',
    ]);
  });

  it('cooldown suppresses a repeated event inside the window and allows it after', () => {
    const fcw = (s: number) => at(sec(s), { attributes: { adas: 'fcw', adasLevel: 1 } });
    expect(types(run([fcw(0), fcw(5), fcw(60), fcw(121)], dashcam()))).toEqual(['FORWARD_COLLISION_WARNING', 'FORWARD_COLLISION_WARNING']);
    expect(types(run([fcw(0), fcw(5)], dashcam({ FORWARD_COLLISION_WARNING: { cooldownMin: 0 } })))).toHaveLength(2);
  });

  it('history uploads and health-only points never raise', () => {
    const attributes = { dms: 'fatigue', dmsLevel: 2, adas: 'fcw', adasLevel: 2 };
    expect(types(run([at(sec(0), { attributes: { ...attributes, reupload: true } })], dashcam()))).toEqual([]);
    expect(types(run([at(sec(0), { attributes, healthOnly: true, receivedAt: sec(0) })], dashcam()))).toEqual([]);
  });

  it('devices without the capability, disabled types and events below the minimum level do not raise', () => {
    const p = at(sec(0), { attributes: { dms: 'phone', dmsLevel: 1 } });
    expect(types(run([p], dashcam({}, GT06)))).toEqual([]);
    expect(types(run([p], dashcam({ DRIVER_PHONE: { enabled: false } })))).toEqual([]);
    expect(types(run([p], dashcam({ DRIVER_PHONE: { params: { minLevel: 2 } } })))).toEqual([]);
  });

  it('video alarm flags alert when a fault appears, not on every point while it lasts', () => {
    const v = (s: number, videoAlarm?: string) => at(sec(s), { attributes: videoAlarm ? { videoAlarm } : {} });
    const c = dashcam({ CAMERA_FAULT: { cooldownMin: 0 } });
    const r = run([v(0, 'videoSignalLost'), v(10, 'videoSignalLost'), v(20, 'videoSignalLost,storageFault'), v(30), v(40, 'videoSignalLost')], c);
    expect(r.alerts.map((a) => a.message)).toEqual(['Camera fault: video signal lost', 'Camera fault: video storage failure', 'Camera fault: video signal lost']);
  });
});

describe('overspeed limit precedence', () => {
  it('vehicle-level setting > vehicle own limit > inherited setting > type default', () => {
    const own = { speedLimitKph: 50, ownSpeedLimitKph: 50 };
    const typeDefault = { speedLimitKph: 80, ownSpeedLimitKph: null };
    expect(overspeedLimit(40, 'OBJECT', own)).toBe(40);
    expect(overspeedLimit(80, 'COMPANY', own)).toBe(50);
    expect(overspeedLimit(80, 'GROUP', own)).toBe(50);
    expect(overspeedLimit(null, 'DEFAULT', own)).toBe(50);
    expect(overspeedLimit(70, 'BRANCH', typeDefault)).toBe(70);
    expect(overspeedLimit(null, 'DEFAULT', typeDefault)).toBe(80);
  });

  it('a vehicle set to 50 km/h alerts above 50', () => {
    const c = ctx(settings({ OVERSPEED: { params: { toleranceKph: 0, minDurationSec: 10 } } }));
    const o = { ...object, speedLimitKph: 50, ownSpeedLimitKph: 50 };
    const r = run([at(sec(0), { object: o, speedKph: 55 }), at(sec(5), { object: o, speedKph: 58 }), at(sec(12), { object: o, speedKph: 60 })], c);
    expect(r.alerts.map((a) => [a.type, a.data.limitKph])).toEqual([['OVERSPEED', 50]]);
  });
});
