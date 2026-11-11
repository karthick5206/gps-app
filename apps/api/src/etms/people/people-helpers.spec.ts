import { consentActive, currentConsents, maskEmail, maskPhone, normaliseEmail, normalisePhone, phoneCountryForTimezone, shortName, validHomePoint } from '@veetracer/shared';
import { cleanNoticeBody, noticeVersionOf, pickCurrentNotice, pickScheduledNotice } from './consent-notice.service';
import { isDiff, redactHistoryEntry } from './passenger-history';

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

describe('consent notice helpers', () => {
  const n = (purpose: string, seq: number, at: string) => ({ purpose, seq, effectiveFrom: new Date(at) });
  const now = Date.parse('2026-11-11T12:00:00Z');
  const rows = [n('TRANSPORT_PROFILE', 1, '2026-11-01T00:00:00Z'), n('TRANSPORT_PROFILE', 2, '2026-11-10T00:00:00Z'), n('TRANSPORT_PROFILE', 3, '2026-12-01T00:00:00Z'), n('SOS_LOCATION', 1, '2026-11-01T00:00:00Z')];
  it('current = highest seq already in force; scheduled = a later one; per purpose', () => {
    expect(pickCurrentNotice(rows, 'TRANSPORT_PROFILE', now)?.seq).toBe(2);
    expect(pickScheduledNotice(rows, 'TRANSPORT_PROFILE', now)?.seq).toBe(3);
    expect(pickCurrentNotice(rows, 'SOS_LOCATION', now)?.seq).toBe(1);
    expect(pickCurrentNotice(rows, 'NOTIFICATIONS_SMS', now)).toBeNull();
    expect(pickCurrentNotice(rows, 'TRANSPORT_PROFILE', Date.parse('2026-10-01T00:00:00Z'))).toBeNull();
  });
  it('versions and body cleaning', () => {
    expect(noticeVersionOf(12)).toBe('v12');
    expect(cleanNoticeBody('  A  \r\nB\r\n\r\n\r\n\r\nC  ')).toBe('A\nB\n\nC');
  });
});

describe('passenger history redaction', () => {
  const entry = (changes: unknown, over: Record<string, unknown> = {}) => ({ id: 'a1', userId: 'u1', userName: 'Admin', action: 'UPDATE', entity: 'EmployeeTransportProfile', entityId: 'p1', changes, ip: '10.0.0.9', createdAt: '2026-11-11T00:00:00.000Z', ...over });
  const diff = {
    homeAddress: { from: 'changed:abc', to: 'changed:def' },
    homeGeocodeSource: { from: 'PIN', to: 'PHOTON' },
    accessibility: { from: null, to: 'changed:123' },
    emergencyContacts: { from: 'changed:1', to: 'changed:2' },
    mobile: { from: '+919876500011', to: '+919876500012' },
    displayName: { from: 'Asha Krishnan', to: 'Asha Krishnan Iyer' },
    defaultStopPoiId: { from: null, to: 'stop-1' },
    branchId: { from: null, to: 'b1' },
  };
  const view = (projection: 'FULL' | 'STANDARD' | 'MINIMAL', contact: 'NONE' | 'MASKED' | 'CLEAR' = 'CLEAR') => ({ view: { projection, contact, agreementId: null }, routingConsent: false, profileEntity: 'EmployeeTransportProfile' });
  it('recognises AuditService diffs', () => {
    expect(isDiff(diff)).toBe(true);
    expect(isDiff({ what: 'detail' })).toBe(false);
    expect(isDiff({})).toBe(false);
  });
  it('FULL: everything, PD H values only as "changed"; diffs become { before, after }', () => {
    const r = redactHistoryEntry(entry(diff), view('FULL'))!;
    expect(r.changes).toEqual({
      before: { homeAddress: 'changed', homeGeocodeSource: 'PIN', accessibility: null, emergencyContacts: 'changed', mobile: '+919876500011', displayName: 'Asha Krishnan', defaultStopPoiId: null, branchId: null },
      after: { homeAddress: 'changed', homeGeocodeSource: 'PHOTON', accessibility: 'changed', emergencyContacts: 'changed', mobile: '+919876500012', displayName: 'Asha Krishnan Iyer', defaultStopPoiId: 'stop-1', branchId: 'b1' },
    });
    expect(r).toMatchObject({ userName: 'Admin', ip: '10.0.0.9' });
  });
  it('STANDARD: no home or emergency-contact keys, no IP, no ACCESS rows', () => {
    const r = redactHistoryEntry(entry(diff), view('STANDARD'))!;
    expect(Object.keys((r.changes as { after: object }).after).sort()).toEqual(['accessibility', 'branchId', 'defaultStopPoiId', 'displayName', 'mobile']);
    expect(r.ip).toBeNull();
    expect(redactHistoryEntry(entry({ what: 'detail' }, { action: 'ACCESS' }), view('STANDARD'))).toBeNull();
  });
  it('MINIMAL: projection fields only, short name, contacts per agreement, default stop only with routing consent, anonymous actor', () => {
    const none = redactHistoryEntry(entry(diff), view('MINIMAL', 'NONE'))!;
    expect(none.changes).toEqual({ before: { displayName: 'Asha K.' }, after: { displayName: 'Asha I.' } });
    expect(none).toMatchObject({ userId: null, userName: null, ip: null });
    const masked = redactHistoryEntry(entry(diff), { ...view('MINIMAL', 'MASKED'), routingConsent: true })!;
    expect((masked.changes as { after: Record<string, unknown> }).after).toEqual({ displayName: 'Asha I.', mobile: '+91•••••00012', defaultStopPoiId: 'stop-1' });
    expect(redactHistoryEntry(entry({ homeAddress: { from: null, to: 'changed:1' } }), view('MINIMAL'))).toBeNull();
    expect(redactHistoryEntry(entry(diff, { entity: 'EmployeeTransportConsent' }), view('MINIMAL'))).toBeNull();
  });
});
