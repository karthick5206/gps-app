import { BadRequestException } from '@nestjs/common';
import { ioConfigDto, validateIoSensor } from './io-sensors.service';
import { recentAttributes } from './recent-attributes';

const analog = { kind: 'AC' as const, enabled: true, source: 'ANALOG' as const, attribute: 'adc1' };

describe('io sensor settings', () => {
  it('defaults: AC analog adc1 without bounds, door digital, both off', () => {
    expect(ioConfigDto('d1', 'AC', undefined)).toMatchObject({ deviceId: 'd1', kind: 'AC', enabled: false, source: 'ANALOG', attribute: 'adc1', minV: null, maxV: null, hysteresisV: 0.2, debounceSec: 10, updatedAt: null });
    expect(ioConfigDto('d1', 'DOOR', undefined)).toMatchObject({ source: 'DIGITAL', attribute: 'door' });
  });

  it('an enabled analog sensor needs a bound and min below max', () => {
    expect(() => validateIoSensor({ ...analog })).toThrow(BadRequestException);
    expect(() => validateIoSensor({ ...analog, minV: 9, maxV: 3 })).toThrow(/below the maximum/);
    expect(() => validateIoSensor({ ...analog, minV: 3, maxV: 9 })).not.toThrow();
    expect(() => validateIoSensor({ ...analog, minV: 3 })).not.toThrow();
    expect(() => validateIoSensor({ ...analog, enabled: false })).not.toThrow();
    expect(() => validateIoSensor({ kind: 'DOOR', enabled: true, source: 'DIGITAL', attribute: 'in2' })).not.toThrow();
  });

  it('recent attributes: newest value per key, counts, skips non-inputs', () => {
    const rows = [
      { fixTime: new Date('2026-10-20T06:02:00Z'), attributes: { adc1: 6.4, in2: true, mcc: 404, ac: true } },
      { fixTime: new Date('2026-10-20T06:01:00Z'), attributes: { adc1: 0.1, extVoltage: 12.6, nested: { a: 1 } } },
    ];
    expect(recentAttributes(rows)).toEqual([
      { key: 'adc1', value: 6.4, at: '2026-10-20T06:02:00.000Z', count: 2 },
      { key: 'extVoltage', value: 12.6, at: '2026-10-20T06:01:00.000Z', count: 1 },
      { key: 'in2', value: true, at: '2026-10-20T06:02:00.000Z', count: 1 },
    ]);
  });
});
