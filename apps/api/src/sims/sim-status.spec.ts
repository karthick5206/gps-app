import {
  canSimTransition,
  MENUS,
  normalizeIccid,
  normalizeMsisdn,
  renewalState,
  SIM_STATUSES,
  SIM_TRANSITIONS,
  SimStatus,
  simDaysUntil,
  SYSTEM_ROLES,
  validateSimStatusChange,
} from '@veetracer/shared';
import { resolvePermissions, validateRolePermissions } from '../access/access-rules';
import { reconcileFlags } from './sims.mapper';
import { tenantSimViewEnabled } from './asset-links.service';

describe('SIM transition table', () => {
  // The full matrix, written out so any change to the table is a visible test change.
  const EXPECTED: Record<SimStatus, SimStatus[]> = {
    AVAILABLE: ['RESERVED', 'ACTIVE', 'DAMAGED', 'DEACTIVATED'],
    RESERVED: ['AVAILABLE', 'ACTIVE', 'DAMAGED', 'DEACTIVATED'],
    ACTIVE: ['SUSPENDED', 'EXPIRED', 'DEACTIVATED', 'DAMAGED'],
    SUSPENDED: ['ACTIVE', 'EXPIRED', 'DEACTIVATED', 'DAMAGED'],
    EXPIRED: ['ACTIVE', 'DEACTIVATED'],
    DEACTIVATED: [],
    DAMAGED: ['DEACTIVATED'],
  };

  it('has exactly the seven shared statuses', () => {
    expect([...SIM_STATUSES]).toEqual(['AVAILABLE', 'RESERVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'DEACTIVATED', 'DAMAGED']);
  });

  it.each(SIM_STATUSES.flatMap((from) => SIM_STATUSES.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    expect(canSimTransition(from, to)).toBe(EXPECTED[from].includes(to));
  });

  it('table and expectation agree', () => expect(SIM_TRANSITIONS).toEqual(EXPECTED));

  it('DEACTIVATED is terminal', () => expect(SIM_TRANSITIONS.DEACTIVATED).toEqual([]));
});

describe('validateSimStatusChange', () => {
  it('accepts allowed changes', () => {
    expect(validateSimStatusChange({ from: 'AVAILABLE', to: 'ACTIVE', assigned: false })).toBeNull();
    expect(validateSimStatusChange({ from: 'EXPIRED', to: 'ACTIVE', assigned: true })).toBeNull();
  });
  it('refuses same status, disallowed transitions and unknown statuses', () => {
    expect(validateSimStatusChange({ from: 'ACTIVE', to: 'ACTIVE', assigned: false })).toMatch(/already active/);
    expect(validateSimStatusChange({ from: 'DEACTIVATED', to: 'ACTIVE', assigned: false })).toMatch(/Cannot change/);
    expect(validateSimStatusChange({ from: 'EXPIRED', to: 'SUSPENDED', assigned: false })).toMatch(/Cannot change/);
    expect(validateSimStatusChange({ from: 'ACTIVE', to: 'LOST' as SimStatus, assigned: false })).toMatch(/Unknown/);
  });
  it('needs a reason for suspended / deactivated / damaged', () => {
    for (const to of ['SUSPENDED', 'DEACTIVATED', 'DAMAGED'] as const) {
      expect(validateSimStatusChange({ from: 'ACTIVE', to, assigned: false })).toMatch(/reason is required/);
      expect(validateSimStatusChange({ from: 'ACTIVE', to, assigned: false, reason: '  ' })).toMatch(/reason is required/);
      expect(validateSimStatusChange({ from: 'ACTIVE', to, assigned: false, reason: 'Operator notice' })).toBeNull();
    }
  });
  it('requires the SIM out of its device before deactivating / damaging', () => {
    expect(validateSimStatusChange({ from: 'ACTIVE', to: 'DEACTIVATED', assigned: true, reason: 'x' })).toMatch(/out of its device/);
    expect(validateSimStatusChange({ from: 'ACTIVE', to: 'DAMAGED', assigned: true, reason: 'x' })).toMatch(/out of its device/);
    expect(validateSimStatusChange({ from: 'ACTIVE', to: 'SUSPENDED', assigned: true, reason: 'x' })).toBeNull();
  });
});

describe('ICCID / MSISDN normalisation', () => {
  it('normalises ICCIDs', () => {
    expect(normalizeIccid('8991 1012 3456 7890 123F')).toBe('8991101234567890123');
    expect(normalizeIccid('89-91-10-12345678901234')).toBe('89911012345678901234');
    expect(normalizeIccid('89911012345678901')).toBeNull(); // 17 digits
    expect(normalizeIccid('8991101234567890123456789')).toBeNull();
    expect(normalizeIccid('ABCD')).toBeNull();
    expect(normalizeIccid(null)).toBeNull();
  });
  it('normalises MSISDNs', () => {
    expect(normalizeMsisdn('+91 98450 12345')).toBe('919845012345');
    expect(normalizeMsisdn('(080) 1234-5678')).toBe('08012345678');
    expect(normalizeMsisdn('1234')).toBeNull();
    expect(normalizeMsisdn('')).toBeNull();
  });
});

describe('renewal reminders', () => {
  const now = new Date('2026-11-09T10:00:00Z');
  it('buckets by days left', () => {
    expect(simDaysUntil('2026-11-19', now)).toBe(10);
    expect(renewalState(null, 30, now)).toBe('NONE');
    expect(renewalState('2026-11-08', 30, now)).toBe('OVERDUE');
    expect(renewalState('2026-11-09', 30, now)).toBe('DUE_SOON');
    expect(renewalState('2026-12-09', 30, now)).toBe('DUE_SOON');
    expect(renewalState('2026-12-10', 30, now)).toBe('OK');
  });
});

describe('reconciliation (report only)', () => {
  const sim = { iccid: '8991101234567890123', msisdn: '919845012345' };
  it('flags differences between the managed SIM and the device row', () => {
    expect(reconcileFlags(sim, null)).toEqual([]);
    expect(reconcileFlags(sim, { iccid: '8991101234567890123F', simNumber: '9845012345' })).toEqual([]);
    expect(reconcileFlags(sim, { iccid: '8991101234567890999', simNumber: null })).toEqual(['ICCID_DIFFERS']);
    expect(reconcileFlags(sim, { iccid: null, simNumber: '+91 99999 00000' })).toEqual(['MSISDN_DIFFERS']);
  });
});

describe('sa_sim_cards menu and tenant flag', () => {
  it('is a Super Admin-only platform menu, never granted to tenant roles', () => {
    const menu = MENUS.find((m) => m.key === 'sa_sim_cards');
    expect(menu).toMatchObject({ group: 'platform', superAdminOnly: true });
    for (const role of SYSTEM_ROLES) expect(role.permissions.sa_sim_cards).toBeUndefined();
    expect(validateRolePermissions([{ menu: 'sa_sim_cards', actions: ['view'] }])).toMatch(/reserved for the Super Admin/);
    expect(resolvePermissions([{ dataScope: 'COMPANY', permissions: [{ menu: 'sa_sim_cards', actions: ['view'] }] }], false).permissions.sa_sim_cards).toBeUndefined();
  });
  it('tenant SIM view is off unless the platform enables it (QI-21)', () => {
    expect(tenantSimViewEnabled({})).toBe(false);
    expect(tenantSimViewEnabled({ INVENTORY_TENANT_SIM_VIEW: '1' })).toBe(false);
    expect(tenantSimViewEnabled({ INVENTORY_TENANT_SIM_VIEW: 'true' })).toBe(true);
  });
});
