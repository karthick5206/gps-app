import {
  canTransition,
  checkStatusConsistency,
  DeviceAssignmentFacts,
  deriveDeviceStatus,
  INVENTORY_STATUSES,
  INVENTORY_TRANSITIONS,
  InventoryStatus,
  MENUS,
  reasonRequired,
  statusHoldsLocation,
  SYSTEM_ROLES,
  validateStatusChange,
} from '@veetracer/shared';
import { resolvePermissions, validateRolePermissions } from '../access/access-rules';

const STOCK: DeviceAssignmentFacts = { companyId: null, hasOpenAssignment: false };
const SHIPPED: DeviceAssignmentFacts = { companyId: null, hasOpenAssignment: false, shippedAt: '2026-11-01T00:00:00Z', claimedAt: null };
const CUSTOMER: DeviceAssignmentFacts = { companyId: 'c1', hasOpenAssignment: false };
const FITTED: DeviceAssignmentFacts = { companyId: 'c1', hasOpenAssignment: true };

describe('inventory status machine', () => {
  it('has a transition row for every status and only known targets', () => {
    expect(Object.keys(INVENTORY_TRANSITIONS).sort()).toEqual([...INVENTORY_STATUSES].sort());
    for (const targets of Object.values(INVENTORY_TRANSITIONS)) {
      for (const t of targets) expect(INVENTORY_STATUSES).toContain(t);
    }
  });

  it('never allows a self transition and keeps RETIRED terminal', () => {
    for (const s of INVENTORY_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(INVENTORY_TRANSITIONS.RETIRED).toEqual([]);
  });

  it.each<[InventoryStatus, InventoryStatus, boolean]>([
    ['IN_STOCK', 'RESERVED', true],
    ['IN_STOCK', 'ACTIVE', false],
    ['RESERVED', 'IN_STOCK', true],
    ['ASSIGNED', 'ACTIVE', true],
    ['ACTIVE', 'IN_STOCK', false],
    ['FAULTY', 'UNDER_REPAIR', true],
    ['UNDER_REPAIR', 'IN_STOCK', true],
    ['RETURNED', 'IN_STOCK', true],
    ['RETIRED', 'IN_STOCK', false],
  ])('%s → %s allowed=%s', (from, to, ok) => expect(canTransition(from, to)).toBe(ok));

  it('derives the status from the existing assignment', () => {
    expect(deriveDeviceStatus(STOCK)).toBe('IN_STOCK');
    expect(deriveDeviceStatus(SHIPPED)).toBe('RESERVED');
    expect(deriveDeviceStatus({ ...SHIPPED, claimedAt: '2026-11-02T00:00:00Z' })).toBe('IN_STOCK');
    expect(deriveDeviceStatus(CUSTOMER)).toBe('ASSIGNED');
    expect(deriveDeviceStatus(FITTED)).toBe('ACTIVE');
  });

  it('keeps ASSIGNED / ACTIVE consistent with the real company / vehicle assignment', () => {
    expect(checkStatusConsistency('ACTIVE', STOCK)).toMatch(/Assign the device to a customer/);
    expect(checkStatusConsistency('ACTIVE', CUSTOMER)).toMatch(/not fitted/);
    expect(checkStatusConsistency('ACTIVE', FITTED)).toBeNull();
    expect(checkStatusConsistency('ASSIGNED', STOCK)).toMatch(/Assign the device/);
    expect(checkStatusConsistency('ASSIGNED', FITTED)).toMatch(/Active/);
    expect(checkStatusConsistency('ASSIGNED', CUSTOMER)).toBeNull();
    expect(checkStatusConsistency('IN_STOCK', CUSTOMER)).toMatch(/customer account/);
    expect(checkStatusConsistency('RESERVED', CUSTOMER)).toMatch(/customer account/);
    for (const s of ['FAULTY', 'UNDER_REPAIR', 'RETURNED', 'RETIRED'] as const) {
      expect(checkStatusConsistency(s, FITTED)).toBeNull();
      expect(checkStatusConsistency(s, STOCK)).toBeNull();
    }
  });

  it('requires a reason for faulty / returned / retired and every adjustment', () => {
    expect(reasonRequired('STATUS', 'FAULTY')).toBe(true);
    expect(reasonRequired('STATUS', 'RETIRED')).toBe(true);
    expect(reasonRequired('STATUS', 'RETURNED')).toBe(true);
    expect(reasonRequired('STATUS', 'RESERVED')).toBe(false);
    expect(reasonRequired('ADJUST', 'IN_STOCK')).toBe(true);
    expect(validateStatusChange({ kind: 'STATUS', from: 'IN_STOCK', to: 'FAULTY', facts: STOCK })).toMatch(/reason is required/);
    expect(validateStatusChange({ kind: 'STATUS', from: 'IN_STOCK', to: 'FAULTY', facts: STOCK, reason: '  ' })).toMatch(/reason/);
    expect(validateStatusChange({ kind: 'STATUS', from: 'IN_STOCK', to: 'FAULTY', facts: STOCK, reason: 'No GPS fix' })).toBeNull();
  });

  it('STATUS follows the table; ADJUST may skip it but not the assignment rules', () => {
    expect(validateStatusChange({ kind: 'STATUS', from: 'RETIRED', to: 'IN_STOCK', facts: STOCK, reason: 'x' })).toMatch(/Cannot change/);
    expect(validateStatusChange({ kind: 'ADJUST', from: 'RETIRED', to: 'IN_STOCK', facts: STOCK, reason: 'Retired by mistake' })).toBeNull();
    expect(validateStatusChange({ kind: 'ADJUST', from: 'RETIRED', to: 'IN_STOCK', facts: STOCK })).toMatch(/adjustment needs a reason/);
    // Inventory can never make a stock device Active.
    expect(validateStatusChange({ kind: 'ADJUST', from: 'IN_STOCK', to: 'ACTIVE', facts: STOCK, reason: 'force' })).toMatch(/Assign the device/);
    expect(validateStatusChange({ kind: 'STATUS', from: 'ASSIGNED', to: 'ACTIVE', facts: CUSTOMER })).toMatch(/not fitted/);
    expect(validateStatusChange({ kind: 'STATUS', from: 'ASSIGNED', to: 'ACTIVE', facts: FITTED })).toBeNull();
    expect(validateStatusChange({ kind: 'STATUS', from: 'IN_STOCK', to: 'IN_STOCK', facts: STOCK })).toMatch(/already/);
    expect(validateStatusChange({ kind: 'STATUS', from: 'IN_STOCK', to: 'BOGUS' as InventoryStatus, facts: STOCK })).toMatch(/Unknown status/);
  });

  it('SYNC only moves to the derived status', () => {
    expect(validateStatusChange({ kind: 'SYNC', from: 'IN_STOCK', to: 'ACTIVE', facts: FITTED })).toBeNull();
    expect(validateStatusChange({ kind: 'SYNC', from: 'IN_STOCK', to: 'ASSIGNED', facts: FITTED })).toMatch(/implied/);
    expect(validateStatusChange({ kind: 'SYNC', from: 'ACTIVE', to: 'ACTIVE', facts: FITTED })).toMatch(/already matches/);
  });

  it('assignment statuses hold no stock location', () => {
    expect(statusHoldsLocation('ASSIGNED')).toBe(false);
    expect(statusHoldsLocation('ACTIVE')).toBe(false);
    expect(statusHoldsLocation('IN_STOCK')).toBe(true);
    expect(statusHoldsLocation('UNDER_REPAIR')).toBe(true);
  });
});

describe('sa_inventory menu', () => {
  const menu = MENUS.find((m) => m.key === 'sa_inventory');

  it('is a Super Admin–only platform menu', () => {
    expect(menu).toMatchObject({ group: 'platform', superAdminOnly: true });
  });

  it('is never granted to tenant roles', () => {
    for (const role of SYSTEM_ROLES) expect(role.permissions.sa_inventory).toBeUndefined();
    expect(validateRolePermissions([{ menu: 'sa_inventory', actions: ['view'] }])).toMatch(/reserved for the Super Admin/);
    const tenant = resolvePermissions([{ dataScope: 'COMPANY', permissions: [{ menu: 'sa_inventory', actions: ['view', 'edit'] }] }], false);
    expect(tenant.permissions.sa_inventory).toBeUndefined();
    expect(resolvePermissions([], true).permissions.sa_inventory).toEqual(['view', 'create', 'edit', 'delete', 'export']);
  });
});
