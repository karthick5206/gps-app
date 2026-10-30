import type { LiveObject } from '@veetracer/shared';
import { chargingLive } from './position-processor';

const T = Date.parse('2026-10-30T10:00:00Z');
const prev = (charging: boolean | null, since: string | null) => ({ charging, chargingSince: since }) as LiveObject;

describe('chargingLive', () => {
  it('starts the "since" time when the state changes and keeps it while unchanged', () => {
    const first = chargingLive({ charging: true }, undefined, T);
    expect(first).toEqual({ charging: true, chargingSince: new Date(T).toISOString() });
    expect(chargingLive({ charging: true }, prev(true, first.chargingSince!), T + 60_000).chargingSince).toBe(first.chargingSince);
    expect(chargingLive({ charging: false }, prev(true, first.chargingSince!), T + 120_000)).toEqual({ charging: false, chargingSince: new Date(T + 120_000).toISOString() });
  });

  it('keeps the last known state when a point does not report it', () => {
    expect(chargingLive({ batteryLevel: 80 }, prev(true, '2026-10-30T09:00:00.000Z'), T)).toEqual({ charging: true, chargingSince: '2026-10-30T09:00:00.000Z' });
    expect(chargingLive(null, undefined, T)).toEqual({ charging: null, chargingSince: null });
  });
});
