import { DEFAULT_THRESHOLDS } from '@veetracer/shared';
import { nextStatus, StatusState } from './movement-status';

const T0 = Date.UTC(2026, 9, 18, 6, 0, 0);
const limit = 80;
const step = (prev: StatusState | null, secs: number, speedKph: number, ignition: boolean | null) =>
  nextStatus(prev, { fixTime: T0 + secs * 1000, speedKph, ignition }, DEFAULT_THRESHOLDS, limit);

describe('nextStatus', () => {
  it('RUNNING above the running threshold', () => {
    expect(step(null, 0, 40, true)).toEqual({ status: 'RUNNING', statusSince: T0, stoppedSince: null });
  });

  it('OVERSPEED above the speed limit, statusSince moves on change only', () => {
    const running = step(null, 0, 40, true);
    const over = step(running, 10, 95, true);
    expect(over.status).toBe('OVERSPEED');
    expect(over.statusSince).toBe(T0 + 10_000);
    expect(step(over, 20, 99, true).statusSince).toBe(T0 + 10_000);
  });

  it('keeps RUNNING while briefly stopped with ignition on, then IDLE after idleAfterSec', () => {
    const running = step(null, 0, 40, true);
    const stopped = step(running, 10, 0, true);
    expect(stopped.status).toBe('RUNNING');
    expect(stopped.stoppedSince).toBe(T0 + 10_000);
    const stillShort = step(stopped, 10 + DEFAULT_THRESHOLDS.idleAfterSec - 1, 0, true);
    expect(stillShort.status).toBe('RUNNING');
    const idle = step(stillShort, 10 + DEFAULT_THRESHOLDS.idleAfterSec, 0, true);
    expect(idle).toEqual({ status: 'IDLE', statusSince: T0 + (10 + DEFAULT_THRESHOLDS.idleAfterSec) * 1000, stoppedSince: T0 + 10_000 });
  });

  it('keeps OVERSPEED (not RUNNING) during the idle grace period', () => {
    const over = step(null, 0, 95, true);
    expect(step(over, 5, 0, true).status).toBe('OVERSPEED');
  });

  it('IDLE immediately when ignition is on and the object was not moving before', () => {
    expect(step(null, 0, 0, true).status).toBe('IDLE');
    const off = step(null, 0, 0, false);
    expect(step(off, 30, 0, true).status).toBe('IDLE');
  });

  it.each([false, null])('OFF when not moving and ignition is %s', (ignition) => {
    const running = step(null, 0, 40, true);
    expect(step(running, 10, 0, ignition).status).toBe('OFF');
  });

  it('comes back from OFFLINE to RUNNING with a new statusSince', () => {
    const offline: StatusState = { status: 'OFFLINE', statusSince: T0, stoppedSince: null };
    expect(step(offline, 900, 30, true)).toEqual({ status: 'RUNNING', statusSince: T0 + 900_000, stoppedSince: null });
  });

  it('resets stoppedSince when moving again', () => {
    const idle = step(null, 0, 0, true);
    const moving = step(idle, 10, 30, true);
    expect(moving.stoppedSince).toBeNull();
    const stopped = step(moving, 20, 0, true);
    expect(stopped.stoppedSince).toBe(T0 + 20_000);
  });
});
