import { NormalizedPosition } from '@veetracer/shared';
import { correctClock, GPS_ROLLOVER_MS } from './clock-correction';

const RX = '2026-10-20T16:57:51.000Z';
const pos = (fixTime: string): NormalizedPosition => ({ protocol: 'gt06', uniqueId: '861896070025993', fixTime, receivedAt: RX, lat: 12.97, lng: 80.18, speedKph: 0, course: 0, altitude: null, satellites: 4, valid: true, ignition: null, attributes: { alarm: 'sos' } });

describe('correctClock', () => {
  it('reset clock (year 2000, seen on the Concox ID card SOS): server time, fix validity and alarm kept', () => {
    const { position, correction } = correctClock(pos('2000-01-03T14:49:55.000Z'));
    expect(correction).toBe('device-clock');
    expect(position).toMatchObject({ fixTime: RX, valid: true, attributes: { alarm: 'sos', deviceTime: '2000-01-03T14:49:55.000Z', timeCorrected: 'device-clock' } });
  });

  it('clock decades ahead → server time', () => {
    expect(correctClock(pos('2097-11-12T10:00:00.000Z')).correction).toBe('device-clock');
  });

  it('GPS week rollover (1024 weeks behind) → shifted forward, fix stays valid', () => {
    const real = Date.parse('2026-10-20T16:57:40.000Z');
    const { position, correction } = correctClock(pos(new Date(real - GPS_ROLLOVER_MS).toISOString()));
    expect(correction).toBe('gps-week-rollover');
    expect(Date.parse(position.fixTime)).toBe(real);
    expect(position.valid).toBe(true);
  });

  it('buffered history from days ago that is also 1024 weeks behind → shifted forward to its real time', () => {
    const real = Date.parse('2026-10-11T09:00:00.000Z'); // 9 days before it was received
    const { position, correction } = correctClock(pos(new Date(real - GPS_ROLLOVER_MS).toISOString()));
    expect(correction).toBe('gps-week-rollover');
    expect(Date.parse(position.fixTime)).toBe(real);
  });

  it('normal, buffered and slightly-ahead times are untouched', () => {
    for (const t of ['2026-10-20T16:57:40.000Z', '2026-10-12T08:00:00.000Z', '2026-10-20T17:30:00.000Z']) expect(correctClock(pos(t)).correction).toBeNull();
  });
});
