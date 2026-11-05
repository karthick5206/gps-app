import { sanitizeTrackerEvents, sanitizeTrackerHealth, trackerHealthIssues } from '@veetracer/shared';
import { trackerOnOffChanges, codeRecipients, DEFAULT_TRACKER_CONFIG, formatMobile, maskEmail, normalizeMobile, parsePoint, phoneReturn, phoneReturnMessage, toNormalized } from './mobile-tracker.logic';

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
  it('reads the event history, dropping unknown kinds and bad entries', () => {
    const at = 1761200000000;
    expect(sanitizeTrackerEvents({ events: [{ k: 'stop', at, why: 'user tapped Stop' }, { k: 'evil', at, why: 'x' }, { k: 'boot', at: -1 }, { k: 'exit', at: 1.5 }, 'x', { k: 'boot', at }] })).toEqual([
      { kind: 'stop', at, why: 'user tapped Stop' },
      { kind: 'boot', at, why: '' },
    ]);
    expect(sanitizeTrackerEvents({})).toEqual([]);
    expect(sanitizeTrackerEvents(null)).toEqual([]);
    expect(sanitizeTrackerEvents({ events: 'x' })).toEqual([]);
    expect(sanitizeTrackerEvents({ events: Array.from({ length: 60 }, (_, i) => ({ k: 'stop', at: at + i, why: 'x'.repeat(200) })) })).toHaveLength(50);
    expect(sanitizeTrackerEvents({ events: [{ k: 'stop', at, why: 'x'.repeat(200) }] })[0].why).toHaveLength(80);
  });

  it('does not keep the event history in the stored health report', () => {
    expect(sanitizeTrackerHealth({ locBg: true, events: [{ k: 'stop', at: 1761200000000, why: 'x' }] })).toEqual({ locBg: true });
  });

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

describe('app 1.3.2 extra fields', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const base = { t: now - 5000, lat: 13.08, lng: 80.27, acc: 8, spd: 10 };

  it('keeps the phone verdict, provider, speed accuracy, satellites and mode; drops unknown values', () => {
    const p = parsePoint({ ...base, flt: 'jump', prov: 'fused', sacc: 0.8, sat: 9, mode: 'moving' }, now)!;
    expect(p).toMatchObject({ flt: 'jump', prov: 'fused', sacc: 0.8, sat: 9, mode: 'moving' });
    const bad = parsePoint({ ...base, flt: 'nonsense', prov: 'Fused Provider!', sat: 500, mode: 'flying' }, now)!;
    expect(bad).toMatchObject({ flt: null, prov: null, sat: null, mode: null });
  });

  it('marks a point the phone found inaccurate as invalid, but keeps jump / still points for the server filter', () => {
    const cfg = DEFAULT_TRACKER_CONFIG;
    expect(toNormalized(parsePoint({ ...base, flt: 'inaccurate' }, now)!, '919000000001', now, cfg).valid).toBe(false);
    expect(toNormalized(parsePoint({ ...base, flt: 'jump' }, now)!, '919000000001', now, cfg).valid).toBe(true);
    expect(toNormalized(parsePoint({ ...base, flt: 'still' }, now)!, '919000000001', now, cfg).attributes).toMatchObject({ phoneFilter: 'still' });
  });

  it('keeps the whole point as raw text for analysis', () => {
    const n = toNormalized(parsePoint({ ...base, prov: 'gps', sat: 7 }, now)!, '919000000001', now, DEFAULT_TRACKER_CONFIG);
    expect(JSON.parse(n.raw!)).toMatchObject({ lat: 13.08, prov: 'gps', sat: 7 });
    expect(n.satellites).toBe(7);
  });
});

describe('trackerOnOffChanges', () => {
  const ev = (kind: string, why: string) => ({ kind, why });
  const kinds = (r: { kind: string; why: string }[]) => r.map((e) => `${e.kind}:${e.why}`);

  it('the person tapped Stop, then started again: both', () => {
    expect(kinds(trackerOnOffChanges(ev('start', 'app'), [ev('stop', 'user tapped Stop'), ev('start', 'app')]))).toEqual(['stop:user tapped Stop', 'start:app']);
  });

  it('the very first start from the app counts; a background one does not', () => {
    expect(trackerOnOffChanges(null, [ev('start', 'app')])).toHaveLength(1);
    expect(trackerOnOffChanges(null, [ev('start', 'boot')])).toHaveLength(0);
  });

  it('the phone killing the app and the restart raise nothing', () => {
    expect(trackerOnOffChanges(ev('start', 'app'), [ev('stop', 'killed while tracking'), ev('start', 'watchdog')])).toEqual([]);
    expect(trackerOnOffChanges(ev('stop', 'killed while tracking'), [ev('start', 'app')])).toEqual([]);
  });

  it('a start while tracking was already on raises nothing (a kill that left no stop event)', () => {
    expect(trackerOnOffChanges(ev('start', 'app'), [ev('start', 'boot')])).toEqual([]);
  });

  it('a server stop is no alert, but coming back on after it is', () => {
    expect(trackerOnOffChanges(ev('start', 'app'), [ev('stop', 'server answered INACTIVE')])).toEqual([]);
    expect(trackerOnOffChanges(ev('stop', 'server answered INACTIVE'), [ev('start', 'app')])).toHaveLength(1);
  });

  it('after a sign-out, the next activation is switched on', () => {
    expect(trackerOnOffChanges(ev('stop', 'signed out'), [ev('start', 'app')])).toHaveLength(1);
    expect(trackerOnOffChanges(ev('start', 'app'), [ev('stop', 'signed out')])).toEqual([]);
  });

  it('other event kinds do not count', () => {
    expect(trackerOnOffChanges(ev('stop', 'user tapped Stop'), [ev('upload', 'queue'), ev('start', 'app')])).toHaveLength(1);
  });
});

describe('phoneReturn', () => {
  const NOW = Date.parse('2026-11-05T12:00:00Z');
  const ago = (min: number) => new Date(NOW - min * 60_000);
  const phone = { installIdHash: 'a', deviceName: 'Pixel 8' };

  it('first activation and another phone are not a return', () => {
    expect(phoneReturn(null, phone, false, NOW)).toBeNull();
    expect(phoneReturn({ ...phone, installIdHash: 'b', revokedAt: null, lastUsedAt: ago(1) }, phone, false, NOW)).toBeNull();
    expect(phoneReturn({ installIdHash: null, deviceName: null, revokedAt: null, lastUsedAt: null }, phone, false, NOW)).toBeNull();
  });

  it('a session still open means the app lost its token: reinstalled, away since last contact', () => {
    expect(phoneReturn({ ...phone, revokedAt: null, lastUsedAt: ago(90) }, phone, false, NOW)).toEqual({ how: 'REINSTALLED', awayMs: 90 * 60_000 });
  });

  it('a closed session: signed out by the phone or stopped by an administrator, away since it closed', () => {
    const closed = { ...phone, revokedAt: ago(30), lastUsedAt: ago(40) };
    expect(phoneReturn(closed, phone, true, NOW)).toEqual({ how: 'SIGNED_OUT', awayMs: 30 * 60_000 });
    expect(phoneReturn(closed, phone, false, NOW)).toEqual({ how: 'STOPPED', awayMs: 30 * 60_000 });
  });

  it('sessions from before install ids go by the phone name', () => {
    expect(phoneReturn({ installIdHash: null, deviceName: 'Pixel 8', revokedAt: null, lastUsedAt: null }, phone, false, NOW)).toEqual({ how: 'REINSTALLED', awayMs: null });
  });
});

describe('phoneReturnMessage', () => {
  const M = '+91 90000 00000';
  it('says what happened and how long the phone was away', () => {
    expect(phoneReturnMessage(M, 'Pixel 8', 'REINSTALLED', 90 * 60_000)).toMatch(/^Tracker app reinstalled on \+91 90000 00000 \(Pixel 8\): it was removed or its data was cleared, then set up again on the same phone\. No contact for .+ before this\.$/);
    expect(phoneReturnMessage(M, 'Pixel 8', 'SIGNED_OUT', 30 * 60_000)).toMatch(/^Tracker app activated again on \+91 90000 00000 \(Pixel 8\), .+ after it was signed out\.$/);
    expect(phoneReturnMessage(M, null, 'STOPPED', 30 * 60_000)).toMatch(/^Tracker app activated again on \+91 90000 00000, .+ after an administrator stopped it\.$/);
  });
  it('leaves out short or unknown gaps', () => {
    expect(phoneReturnMessage(M, null, 'REINSTALLED', 60_000)).toBe('Tracker app reinstalled on +91 90000 00000: it was removed or its data was cleared, then set up again on the same phone.');
    expect(phoneReturnMessage(M, null, 'SIGNED_OUT', null)).toBe('Tracker app activated again on +91 90000 00000 after it was signed out.');
  });
});
