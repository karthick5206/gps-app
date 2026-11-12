import { sosClientStage, sosShouldRetry } from '@veetracer/shared';
import { cleanSos, incidentAccess, incidentListWhere, notifyState, safetyBackoffMs, shortName, toReceipt } from './sos-rules';

const KEY = '3f1c2a4e-9b7d-4c1e-8a2b-1234567890ab';
const NOW = Date.parse('2026-11-12T10:00:00Z');

describe('ETMS SOS rules (WP 5.4)', () => {
  it('never refuses a body: bad pieces are dropped, the SOS stays', () => {
    const c = cleanSos({ tripId: 'not-a-uuid', fix: { lat: 200, lng: 0 }, note: 42, raisedAt: 'yesterday', extra: { anything: true } }, KEY, NOW);
    expect(c).toMatchObject({ key: KEY, serverKey: false, tripId: null, tripRequested: true, fix: null, note: null });
    expect(c.raisedAt.getTime()).toBe(NOW);
    for (const body of [null, undefined, 'x', 5, [], {}]) expect(() => cleanSos(body, KEY, NOW)).not.toThrow();
  });

  it('a missing or malformed key gets a server key (replays then merge into the open SOS)', () => {
    expect(cleanSos({}, undefined, NOW).serverKey).toBe(true);
    expect(cleanSos({}, 'abc', NOW).key).toMatch(/^srv-/);
    expect(cleanSos({}, KEY.toUpperCase(), NOW)).toMatchObject({ key: KEY, serverKey: false });
  });

  it('keeps a valid fix, caps the note, and rejects device times in the future', () => {
    const c = cleanSos({ fix: { lat: 13.05, lng: 80.25, accuracyM: 12, at: '2026-11-12T09:59:00Z' }, note: 'x'.repeat(900), raisedAt: '2026-11-12T11:00:00Z' }, KEY, NOW);
    expect(c.fix).toEqual({ lat: 13.05, lng: 80.25, accuracyM: 12, at: '2026-11-12T09:59:00.000Z' });
    expect(c.note).toHaveLength(500);
    expect(c.raisedAt.getTime()).toBe(NOW);
  });

  it('the same body always hashes the same; another body does not', () => {
    const a = { tripId: KEY, note: 'help' };
    expect(cleanSos(a, KEY, NOW).hash).toBe(cleanSos({ note: 'help', tripId: KEY }, KEY, NOW).hash);
    expect(cleanSos(a, KEY, NOW).hash).not.toBe(cleanSos({ ...a, note: 'other' }, KEY, NOW).hash);
  });

  it('receipt wording is honest: received, never acknowledged without an acknowledgement', () => {
    const row = { id: 'i1', status: 'OPEN', raiserType: 'PASSENGER', providerCompanyId: 'p', customerCompanyId: 'c', receivedAt: new Date(NOW), acknowledgedAt: null, resolvedAt: null, tripId: null };
    const r = toReceipt(row, { merged: false, tripLinked: true, notify: 'QUEUED', ackByName: null });
    expect(r).toMatchObject({ status: 'RECEIVED_BY_SERVER', acknowledgement: null, incidentStatus: 'OPEN' });
    expect(sosClientStage(r)).toBe('RECEIVED');
    const acked = toReceipt({ ...row, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(NOW + 1000) }, { merged: false, tripLinked: true, notify: 'SENT_TO_DISPATCH', ackByName: 'Meena Desk Officer' });
    expect(acked.acknowledgement).toEqual({ by: 'Meena', at: new Date(NOW + 1000).toISOString() });
    expect(sosClientStage(acked)).toBe('ACKNOWLEDGED');
    expect(sosClientStage(null)).toBe('QUEUED_ON_DEVICE');
  });

  it('clients retry everything except success and a reused key', () => {
    expect([undefined, 401, 408, 429, 500, 503].map(sosShouldRetry)).toEqual([true, true, true, true, true, true]);
    expect([200, 201, 422].map(sosShouldRetry)).toEqual([false, false, false]);
  });

  it('notify state: queued until the outbox row is published; never "delivered"', () => {
    expect(notifyState(null)).toBe('SENT_TO_DISPATCH'); // N1: only published rows are trimmed
    expect(notifyState({ publishedAt: null, deadAt: null })).toBe('QUEUED');
    expect(notifyState({ publishedAt: new Date(), deadAt: null })).toBe('SENT_TO_DISPATCH');
  });

  it('safety back-off grows to 15 s and never gives up', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(safetyBackoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  describe('visibility', () => {
    const agreement = (grants: string[]) => ({ id: 'a', customerCompanyId: 'cust', grants: grants as never, siteIds: [], dataProfile: 'MINIMAL' as never, validFrom: NOW - 1000, validTo: null });
    const pax = { raiserType: 'PASSENGER', providerCompanyId: 'prov', customerCompanyId: 'cust' };
    const drv = { raiserType: 'DRIVER', providerCompanyId: 'prov', customerCompanyId: 'cust' };
    const ctx = (companyId: string, grants: string[] = [], extra = {}) => ({ companyId, homeCompanyId: companyId, isSuperAdmin: false, agreements: grants.length ? [agreement(grants)] : [], ...extra });

    it('the raiser company always manages; the other party only through an incident grant', () => {
      expect(incidentAccess(ctx('cust'), pax, NOW)).toBe('manage');
      expect(incidentAccess(ctx('prov'), drv, NOW)).toBe('manage');
      expect(incidentAccess(ctx('prov'), pax, NOW)).toBe('none');
      expect(incidentAccess(ctx('prov', ['VIEW_BOOKINGS']), pax, NOW)).toBe('none');
      expect(incidentAccess(ctx('prov', ['RECEIVE_INCIDENTS']), pax, NOW)).toBe('view');
      expect(incidentAccess(ctx('prov', ['MANAGE_INCIDENTS']), pax, NOW)).toBe('manage');
      expect(incidentAccess(ctx('other'), pax, NOW)).toBe('none');
    });

    it("M1: the Super Admin is view only: every incident on the platform, the switched-in company's own, never manage", () => {
      expect(incidentAccess({ companyId: 'platform', homeCompanyId: 'platform', isSuperAdmin: true, agreements: [] }, pax, NOW)).toBe('view');
      expect(incidentAccess({ companyId: 'platform', homeCompanyId: 'platform', isSuperAdmin: true, agreements: [] }, drv, NOW)).toBe('view');
      expect(incidentAccess({ companyId: 'cust', homeCompanyId: 'platform', isSuperAdmin: true, agreements: [] }, pax, NOW)).toBe('view');
      expect(incidentAccess({ companyId: 'prov', homeCompanyId: 'platform', isSuperAdmin: true, agreements: [] }, drv, NOW)).toBe('view');
      expect(incidentAccess({ companyId: 'other', homeCompanyId: 'platform', isSuperAdmin: true, agreements: [] }, pax, NOW)).toBe('none');
      expect(incidentListWhere({ companyId: 'platform', homeCompanyId: 'platform', isSuperAdmin: true, agreements: [] }, NOW)).toEqual({});
    });

    it('list where: own customer rows, own driver rows, and granted customers only', () => {
      const w = incidentListWhere(ctx('prov', ['RECEIVE_INCIDENTS']), NOW) as { OR: unknown[] };
      expect(w.OR).toEqual([{ customerCompanyId: 'prov' }, { providerCompanyId: 'prov', raiserType: 'DRIVER' }, { providerCompanyId: 'prov', customerCompanyId: null }, { providerCompanyId: 'prov', customerCompanyId: { in: ['cust'] } }]);
      expect((incidentListWhere(ctx('prov'), NOW) as { OR: unknown[] }).OR).toHaveLength(3);
    });
  });

  it('short names for agreement views', () => {
    expect(shortName('Priya Raman')).toBe('Priya R.');
    expect(shortName('Priya')).toBe('Priya');
    expect(shortName('')).toBe('—');
  });
});
