import { emptyIoKindState, IO_GAP_MS, ioReading, IoSensorRuntime, IoPoint, parseIoSensors, stepIo } from './io-logic';

const AC: IoSensorRuntime = { kind: 'AC', source: 'ANALOG', attribute: 'adc1', invert: false, minV: 2, maxV: 11, hysteresisV: 0.2, debounceSec: 10 };
const DOOR: IoSensorRuntime = { kind: 'DOOR', source: 'DIGITAL', attribute: 'door', invert: false, minV: null, maxV: null, hysteresisV: 0.2, debounceSec: 0 };
const T0 = Date.parse('2026-10-20T06:00:00Z');

function ids() {
  let n = 0;
  return () => `s${++n}`;
}
const pt = (sec: number, raw: boolean | null, extra: Partial<IoPoint> = {}): IoPoint => ({ t: T0 + sec * 1000, raw, lat: 13, lng: 80, valid: true, ignition: true, ...extra });

describe('ioReading', () => {
  it('analog: ON inside min..max, OFF outside (fan off at 0 V or battery voltage)', () => {
    expect(ioReading({ adc1: 6.5 }, AC, false)).toEqual({ on: true, voltage: 6.5 });
    expect(ioReading({ adc1: 0 }, AC, false).on).toBe(false);
    expect(ioReading({ adc1: 12.6 }, AC, false).on).toBe(false);
  });

  it('analog hysteresis: once ON stays ON within 0.2 V outside the range', () => {
    expect(ioReading({ adc1: 11.1 }, AC, false).on).toBe(false);
    expect(ioReading({ adc1: 11.1 }, AC, true).on).toBe(true);
    expect(ioReading({ adc1: 11.3 }, AC, true).on).toBe(false);
    expect(ioReading({ adc1: 1.85 }, AC, true).on).toBe(true);
  });

  it('analog without bounds only reports the voltage; missing attribute = no reading', () => {
    expect(ioReading({ adc1: 5 }, { ...AC, minV: null, maxV: null }, null)).toEqual({ on: null, voltage: 5 });
    expect(ioReading({}, AC, null)).toEqual({ on: null, voltage: null });
    expect(ioReading({ adc1: 3 }, { ...AC, maxV: null }, null).on).toBe(true);
  });

  it('digital: boolean or 0/1, invert flips it', () => {
    expect(ioReading({ door: true }, DOOR, null).on).toBe(true);
    expect(ioReading({ door: 0 }, DOOR, null).on).toBe(false);
    expect(ioReading({ door: true }, { ...DOOR, invert: true }, null).on).toBe(false);
    expect(ioReading({ door: 'x' }, DOOR, null).on).toBeNull();
  });

  it('parseIoSensors drops disabled and unknown rows', () => {
    const row = { kind: 'AC', enabled: true, source: 'ANALOG', attribute: 'adc1', invert: false, minV: 1, maxV: 2, hysteresisV: 0.2, debounceSec: 10 };
    expect(parseIoSensors([row, { ...row, enabled: false }, { ...row, kind: 'X' }])).toHaveLength(1);
  });
});

describe('stepIo', () => {
  it('alerts ON when the very first reading is ON (sensor set up while the AC runs), not after a short gap while ON', () => {
    const st = emptyIoKindState();
    const id = ids();
    expect(stepIo(st, pt(0, true), AC, id).transition).toEqual({ kind: 'AC', on: true, at: T0, previousSec: null });
    expect(stepIo(st, pt(10, true), AC, id).transition).toBeNull();
    // Data stops for longer than the gap: the next ON reading starts a new period without a second alert.
    expect(stepIo(st, pt(IO_GAP_MS / 1000 + 20, true), AC, id).transition).toBeNull();
  });

  it('alerts ON after a long gap (parked for days, 351510095076652) or after a gap that followed an OFF period', () => {
    const id = ids();
    // ON before, silent 3 days, ON at start-up: the AC was switched off and on in between → AC_ON.
    const parked = emptyIoKindState();
    stepIo(parked, pt(0, true), AC, id);
    const threeDays = 3 * 24 * 3600;
    expect(stepIo(parked, pt(threeDays, true), AC, id).transition).toEqual({ kind: 'AC', on: true, at: T0 + threeDays * 1000, previousSec: null });
    // OFF before a 40 min gap, ON after it → AC_ON.
    const off = emptyIoKindState();
    stepIo(off, pt(0, false), AC, id);
    expect(stepIo(off, pt(40 * 60, true), AC, id).transition).toMatchObject({ kind: 'AC', on: true });
    // OFF after a gap never alerts on its own.
    const toOff = emptyIoKindState();
    stepIo(toOff, pt(0, true), AC, id);
    expect(stepIo(toOff, pt(threeDays, false), AC, id).transition).toBeNull();
  });

  it('opens a session on the first reading without a transition', () => {
    const st = emptyIoKindState();
    const r = stepIo(st, pt(0, false), AC, ids());
    expect(r.transition).toBeNull();
    expect(r.rows).toEqual([expect.objectContaining({ id: 's1', on: false, endTime: null })]);
  });

  it('debounces: a change must hold debounceSec, dated when it started', () => {
    const st = emptyIoKindState();
    const id = ids();
    stepIo(st, pt(0, false), AC, id);
    expect(stepIo(st, pt(5, true), AC, id).transition).toBeNull();
    expect(stepIo(st, pt(8, false), AC, id).transition).toBeNull(); // flicker back: pending cleared
    expect(stepIo(st, pt(20, true), AC, id).transition).toBeNull();
    const r = stepIo(st, pt(30, true), AC, id);
    expect(r.transition).toEqual({ kind: 'AC', on: true, at: T0 + 20_000, previousSec: 20 });
    expect(r.rows[0]).toMatchObject({ id: 's1', on: false, endTime: T0 + 20_000, durationSec: 20 });
    expect(r.rows[1]).toMatchObject({ id: 's2', on: true, startTime: T0 + 20_000, endTime: null });
  });

  it('accumulates distance and engine-off time during a session', () => {
    const st = emptyIoKindState();
    const id = ids();
    stepIo(st, pt(0, true, { lat: 13, lng: 80 }), DOOR, id);
    stepIo(st, pt(60, true, { lat: 13.01, lng: 80 }), DOOR, id);
    stepIo(st, pt(120, true, { lat: 13.01, lng: 80, ignition: false }), DOOR, id);
    stepIo(st, pt(180, true, { lat: 13.01, lng: 80, valid: false }), DOOR, id);
    const r = stepIo(st, pt(240, false, { lat: 13.02, lng: 80, ignition: false }), DOOR, id);
    expect(r.transition).toMatchObject({ on: false, previousSec: 240 });
    const closed = r.rows[0];
    expect(closed.distanceKm).toBeCloseTo(2.22, 1);
    expect(closed.engineOffSec).toBe(120);
    expect(closed).toMatchObject({ startLat: 13, endLat: 13.02 });
  });

  it('closes the session at the last point after a data gap and restarts without a transition', () => {
    const st = emptyIoKindState();
    const id = ids();
    stepIo(st, pt(0, true), DOOR, id);
    const later = (IO_GAP_MS + 60_000) / 1000;
    const r = stepIo(st, pt(later, false), DOOR, id);
    expect(r.transition).toBeNull();
    expect(r.rows[0]).toMatchObject({ id: 's1', endTime: T0, durationSec: 0 });
    expect(r.rows[1]).toMatchObject({ id: 's2', on: false, endTime: null });
  });

  it('ignores points older than the state', () => {
    const st = emptyIoKindState();
    const id = ids();
    stepIo(st, pt(100, true), DOOR, id);
    expect(stepIo(st, pt(50, false), DOOR, id)).toEqual({ rows: [], transition: null });
    expect(st.s).toBe(true);
  });

  it('refreshes the open row every 5 minutes, and keeps state on points without a reading', () => {
    const st = emptyIoKindState();
    const id = ids();
    stepIo(st, pt(0, true), DOOR, id);
    expect(stepIo(st, pt(120, null), DOOR, id).rows).toHaveLength(0);
    const r = stepIo(st, pt(301, null), DOOR, id);
    expect(r.rows).toEqual([expect.objectContaining({ id: 's1', endTime: null, durationSec: 301 })]);
    expect(st.s).toBe(true);
  });
});
