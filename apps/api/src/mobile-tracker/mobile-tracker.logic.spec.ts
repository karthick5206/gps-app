import { DEFAULT_TRACKER_CONFIG, formatMobile, normalizeMobile, parsePoint, toNormalized } from './mobile-tracker.logic';

const NOW = Date.parse('2026-10-21T06:00:00Z');

describe('mobile tracker logic', () => {
  it('normalises Indian numbers in any common format', () => {
    for (const v of ['9876543210', '+91 98765 43210', '09876543210', '919876543210', '+91-98765-43210']) expect(normalizeMobile(v)).toBe('919876543210');
    expect(normalizeMobile('12345')).toBeNull();
    expect(normalizeMobile('5876543210')).toBeNull(); // Indian mobiles start with 6-9
    expect(formatMobile('919876543210')).toBe('+91 98765 43210');
  });

  it('rejects unusable points, keeps the rest', () => {
    expect(parsePoint({ t: NOW, lat: 13.08, lng: 80.27, acc: 5 }, NOW)).toMatchObject({ lat: 13.08, acc: 5, mock: false, sos: false });
    expect(parsePoint({ t: NOW, lat: 0, lng: 0 }, NOW)).toBeNull();
    expect(parsePoint({ t: NOW, lat: 95, lng: 80 }, NOW)).toBeNull();
    expect(parsePoint({ t: NOW + 3 * 86_400_000, lat: 13, lng: 80 }, NOW)).toBeNull();
    expect(parsePoint({ lat: 13, lng: 80 }, NOW)).toBeNull();
    expect(parsePoint('x', NOW)).toBeNull();
  });

  it('converts to a pipeline position: m/s → km/h, accuracy, battery, SOS; inaccurate and mock fixes are invalid', () => {
    const base = { t: NOW, lat: 13.08, lng: 80.27, acc: 6.54, spd: 10, brg: 365, alt: 12, bat: 83.4, chg: true, mock: false, sos: false };
    const p = toNormalized(base, '919876543210', NOW, DEFAULT_TRACKER_CONFIG);
    expect(p).toMatchObject({ protocol: 'mobile', uniqueId: '919876543210', speedKph: 36, course: 5, valid: true, ignition: null, satellites: null, attributes: { accuracyM: 6.5, batteryLevel: 83, charging: true } });
    expect(toNormalized({ ...base, acc: 250 }, 'x', NOW, DEFAULT_TRACKER_CONFIG).valid).toBe(false);
    const mock = toNormalized({ ...base, mock: true }, 'x', NOW, DEFAULT_TRACKER_CONFIG);
    expect(mock.valid).toBe(false);
    expect(mock.attributes.mock).toBe(true);
    expect(toNormalized({ ...base, sos: true }, 'x', NOW, DEFAULT_TRACKER_CONFIG).attributes.alarm).toBe('sos');
    expect(toNormalized({ ...base, spd: null, brg: null }, 'x', NOW, DEFAULT_TRACKER_CONFIG)).toMatchObject({ speedKph: 0, course: 0 });
  });
});
