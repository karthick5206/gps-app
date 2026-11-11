import { consentActive, currentConsents, maskEmail, maskPhone, normaliseEmail, normalisePhone, phoneCountryForTimezone, shortName, validHomePoint } from '@veetracer/shared';

/** Pure helpers of packages/shared/src/transport-people.ts (validation, masking, consent state). */
describe('transport-people helpers', () => {
  it('normalisePhone: E.164, Indian and US local formats', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalisePhone('09876543210')).toBe('+919876543210');
    expect(normalisePhone('919876543210')).toBe('+919876543210');
    expect(normalisePhone('0091 98765 43210')).toBe('+919876543210');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('5876543210')).toBeNull(); // Indian mobiles start 6-9
    expect(normalisePhone('(415) 555-0100', 'US')).toBe('+14155550100');
    expect(normalisePhone('1-415-555-0100', 'US')).toBe('+14155550100');
    expect(normalisePhone('abc')).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(phoneCountryForTimezone('America/Chicago')).toBe('US');
    expect(phoneCountryForTimezone('Asia/Kolkata')).toBe('IN');
  });

  it('normaliseEmail lower-cases and validates', () => {
    expect(normaliseEmail('  Asha@Corp.TEST ')).toBe('asha@corp.test');
    expect(normaliseEmail('nope')).toBeNull();
  });

  it('validHomePoint: finite, in range, not (0,0); no service-area bound', () => {
    expect(validHomePoint(13.06, 80.24)).toBe(true);
    expect(validHomePoint(40.71, -74.0)).toBe(true); // US is fine
    expect(validHomePoint(-33.86, 151.2)).toBe(true); // anywhere valid
    expect(validHomePoint(0, 0)).toBe(false);
    expect(validHomePoint(91, 0)).toBe(false);
    expect(validHomePoint(10, 181)).toBe(false);
    expect(validHomePoint(Number.NaN, 1)).toBe(false);
    expect(validHomePoint('13', 80)).toBe(false);
  });

  it('masking and short names', () => {
    expect(maskPhone('+919876543210')).toBe('+91•••••43210');
    expect(maskPhone('+14155550100')).toBe('+1•••••50100');
    expect(maskEmail('asha.k@corp.test')).toBe('a•••@corp.test');
    expect(shortName('Asha  Krishnan Iyer')).toBe('Asha I.');
    expect(shortName('Asha')).toBe('Asha');
  });

  it('consent state: latest row per purpose wins, regardless of input order', () => {
    const rows = [
      { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v1', channel: 'WEB', occurredAt: '2026-11-01T10:00:00Z' },
      { purpose: 'TRANSPORT_PROFILE', granted: false, noticeVersion: 'v1', channel: 'WEB', occurredAt: '2026-11-03T10:00:00Z' },
      { purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: 'v2', channel: 'ADMIN_ON_BEHALF', occurredAt: '2026-11-02T10:00:00Z' },
      { purpose: 'NOTIFICATIONS_SMS', granted: true, noticeVersion: 'v1', channel: 'WEB', occurredAt: '2026-11-02T10:00:00Z' },
    ];
    const cur = currentConsents(rows);
    expect(cur).toEqual([
      { purpose: 'NOTIFICATIONS_SMS', active: true, noticeVersion: 'v1', grantedAt: '2026-11-02T10:00:00.000Z', revokedAt: null, channel: 'WEB' },
      { purpose: 'TRANSPORT_PROFILE', active: false, noticeVersion: 'v1', grantedAt: null, revokedAt: '2026-11-03T10:00:00.000Z', channel: 'WEB' },
    ]);
    expect(consentActive(rows, 'TRANSPORT_PROFILE')).toBe(false);
    expect(consentActive(rows.slice(0, 1), 'TRANSPORT_PROFILE')).toBe(true);
    expect(consentActive([], 'TRANSPORT_PROFILE')).toBe(false);
  });
});
