import { sanitizeTrackerHealth, trackerHealthIssues } from '@veetracer/shared';
import { codeRecipients, DEFAULT_TRACKER_CONFIG, formatMobile, maskEmail, normalizeMobile, parsePoint, toNormalized } from './mobile-tracker.logic';

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

describe('activation code e-mail', () => {
  const company = { email: 'Admin@Acme.com', scopes: ['COMPANY'], branchIds: [], objectIds: [] };
  const branch = { email: 'chennai@acme.com', scopes: ['ASSIGNED'], branchIds: ['b1'], objectIds: [] };
  const mapped = { email: 'sup@acme.com', scopes: ['ASSIGNED'], branchIds: [], objectIds: ['o1'] };
  const other = { email: 'madurai@acme.com', scopes: ['ASSIGNED'], branchIds: ['b2'], objectIds: [] };

  it('admins whose scope covers the device, plus its activation e-mail, without duplicates', () => {
    expect(codeRecipients([company, branch, mapped, other], { id: 'o1', branchId: 'b1' }, 'ravi@gmail.com')).toEqual([
      'Admin@Acme.com',
      'chennai@acme.com',
      'sup@acme.com',
      'ravi@gmail.com',
    ]);
    expect(codeRecipients([company], null, 'admin@acme.com')).toEqual(['admin@acme.com']);
  });

  it('an unassigned device reaches company-wide admins only; blanks and no-email users are skipped', () => {
    expect(codeRecipients([company, branch, mapped, { ...company, email: null }], null, '  ')).toEqual(['Admin@Acme.com']);
  });

  it('masks addresses for the app', () => {
    expect(maskEmail('ramesh@acme.com')).toBe('r****@acme.com');
    expect(maskEmail('x')).toBe('****');
  });
});

describe('phone health', () => {
  it('keeps only known keys with the right types', () => {
    const h = sanitizeTrackerHealth({ locBg: false, battOpt: 'yes', bucket: 45, dataSaver: 'on', evil: '<script>', stop: { at: 1761200000000, why: 'killed while tracking' }, mfr: 'Xiaomi' });
    expect(h).toEqual({ locBg: false, bucket: 45, dataSaver: 'on', stop: { at: 1761200000000, why: 'killed while tracking' }, mfr: 'Xiaomi' });
    expect(sanitizeTrackerHealth('x')).toBeNull();
    expect(sanitizeTrackerHealth({})).toBeNull();
  });

  it('lists problems, blocking ones first (the Redmi 9A case: while-using location + Data Saver)', () => {
    const issues = trackerHealthIssues({ locOn: true, locFine: true, locBg: false, battOpt: true, dataSaver: 'on', bucket: 40, failures: 5 });
    expect(issues.map((i) => i.code)).toEqual(['LOCATION_NOT_ALWAYS', 'DATA_SAVER', 'BATTERY_OPTIMISED', 'STANDBY_RESTRICTED', 'UPLOADS_FAILING']);
    expect(trackerHealthIssues({ locOn: true, locFine: true, locBg: true, battOpt: false, dataSaver: 'allowed', bucket: 10, notif: true })).toEqual([]);
    expect(trackerHealthIssues(null)).toEqual([]);
  });
});
