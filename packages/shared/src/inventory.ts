/**
 * Device inventory (Phase B): statuses, the allowed-transition table, assignment consistency rules and DTOs.
 *
 * Inventory never changes who owns a device: the customer (Device.companyId) and the vehicle (open DeviceAssignment)
 * stay on the existing admin assign / transfer / claim flows, which also drive licence seats. ASSIGNED and ACTIVE are
 * therefore only accepted when they agree with those facts (checkStatusConsistency).
 */

export const INVENTORY_STATUSES = [
  'IN_STOCK',
  'RESERVED',
  'ASSIGNED',
  'ACTIVE',
  'FAULTY',
  'UNDER_REPAIR',
  'RETURNED',
  'RETIRED',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  IN_STOCK: 'In stock',
  RESERVED: 'Reserved',
  ASSIGNED: 'Assigned',
  ACTIVE: 'Active',
  FAULTY: 'Faulty',
  UNDER_REPAIR: 'Under repair',
  RETURNED: 'Returned',
  RETIRED: 'Retired',
};

/** Statuses that mirror the existing customer assignment; inventory cannot create them, only record them. */
export const ASSIGNMENT_STATUSES: readonly InventoryStatus[] = ['ASSIGNED', 'ACTIVE'];

/**
 * Allowed status changes (from → to). RETIRED is terminal: only an ADJUST (with a reason) can correct it.
 * ASSIGNED / ACTIVE targets are additionally checked against the device's real assignment.
 */
export const INVENTORY_TRANSITIONS: Record<InventoryStatus, readonly InventoryStatus[]> = {
  IN_STOCK: ['RESERVED', 'ASSIGNED', 'FAULTY', 'UNDER_REPAIR', 'RETIRED'],
  RESERVED: ['IN_STOCK', 'ASSIGNED', 'FAULTY'],
  ASSIGNED: ['ACTIVE', 'IN_STOCK', 'RETURNED', 'FAULTY'],
  ACTIVE: ['ASSIGNED', 'RETURNED', 'FAULTY'],
  FAULTY: ['UNDER_REPAIR', 'RETURNED', 'IN_STOCK', 'RETIRED'],
  UNDER_REPAIR: ['IN_STOCK', 'FAULTY', 'RETIRED'],
  RETURNED: ['IN_STOCK', 'FAULTY', 'UNDER_REPAIR', 'RETIRED'],
  RETIRED: [],
};

/** A status change into one of these needs a written reason (adjustments always need one). */
export const REASON_REQUIRED_STATUSES: readonly InventoryStatus[] = ['FAULTY', 'RETURNED', 'RETIRED'];

export const STOCK_MOVEMENT_KINDS = [
  /** Received into a location (manual receipt or CSV import). */
  'RECEIVE',
  /** Status change through the transition table. */
  'STATUS',
  /** Location and / or holder partner change. */
  'TRANSFER',
  /** Correction with a mandatory reason (may override the transition table, never the assignment rules). */
  'ADJUST',
  /** Status aligned with the existing assignment (company / vehicle) after an admin assign / transfer / claim. */
  'SYNC',
  /**
   * Faulty unit swapped on a vehicle. The vehicle fitting itself is done by the existing vehicle assignment flow
   * (ObjectsService.update → assignDevice); inventory records one REPLACE movement per device, linked by reference.
   * No licence seat moves (QI-13).
   */
  'REPLACE',
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

export const STOCK_LOCATION_KINDS = ['WAREHOUSE', 'PARTNER', 'TECHNICIAN', 'IN_TRANSIT', 'SUPPLIER_RMA', 'SCRAP'] as const;
export type StockLocationKind = (typeof STOCK_LOCATION_KINDS)[number];

export const DEVICE_CONDITIONS = ['NEW', 'REFURBISHED', 'USED'] as const;
export type DeviceCondition = (typeof DEVICE_CONDITIONS)[number];

export function isInventoryStatus(value: unknown): value is InventoryStatus {
  return typeof value === 'string' && (INVENTORY_STATUSES as readonly string[]).includes(value);
}

/** Facts read from the existing Device / DeviceAssignment rows (never written by inventory). */
export interface DeviceAssignmentFacts {
  companyId: string | null;
  /** The device is fitted to a vehicle / object now (open DeviceAssignment). */
  hasOpenAssignment: boolean;
  shippedAt?: Date | string | null;
  claimedAt?: Date | string | null;
}

/**
 * Status implied by the existing fields (legacy devices without a DeviceStock row, sync, backfill):
 * no company → RESERVED when shipped and not yet claimed, else IN_STOCK; company → ACTIVE when fitted, else ASSIGNED.
 */
export function deriveDeviceStatus(f: DeviceAssignmentFacts): InventoryStatus {
  if (!f.companyId) return f.shippedAt && !f.claimedAt ? 'RESERVED' : 'IN_STOCK';
  return f.hasOpenAssignment ? 'ACTIVE' : 'ASSIGNED';
}

/**
 * Whether a stored status agrees with the real assignment. Returns an error message, or null when consistent.
 * IN_STOCK / RESERVED: not in a customer account. ASSIGNED: in a customer account, not fitted. ACTIVE: in a customer
 * account and fitted to a vehicle. FAULTY / UNDER_REPAIR / RETURNED / RETIRED record facts and carry no rule.
 */
export function checkStatusConsistency(status: InventoryStatus, f: DeviceAssignmentFacts): string | null {
  switch (status) {
    case 'IN_STOCK':
    case 'RESERVED':
      return f.companyId
        ? `A device in a customer account cannot be ${INVENTORY_STATUS_LABELS[status].toLowerCase()}; move it back to stock in Device Inventory first`
        : null;
    case 'ASSIGNED':
      if (!f.companyId) return 'Assign the device to a customer in Device Inventory first (inventory does not change the owner)';
      return f.hasOpenAssignment ? 'The device is fitted to a vehicle: its status is Active' : null;
    case 'ACTIVE':
      if (!f.companyId) return 'Assign the device to a customer in Device Inventory first (inventory does not change the owner)';
      return f.hasOpenAssignment ? null : 'The device is not fitted to a vehicle: fit it on the vehicle form first';
    default:
      return null;
  }
}

/** ASSIGNED / ACTIVE devices are at the customer: they have no stock location. */
export function statusHoldsLocation(status: InventoryStatus): boolean {
  return !ASSIGNMENT_STATUSES.includes(status);
}

export function canTransition(from: InventoryStatus, to: InventoryStatus): boolean {
  return INVENTORY_TRANSITIONS[from].includes(to);
}

export function reasonRequired(kind: StockMovementKind, to: InventoryStatus): boolean {
  return kind === 'ADJUST' || REASON_REQUIRED_STATUSES.includes(to);
}

export interface StatusChangeInput {
  kind: Extract<StockMovementKind, 'STATUS' | 'ADJUST' | 'SYNC'>;
  from: InventoryStatus;
  to: InventoryStatus;
  facts: DeviceAssignmentFacts;
  reason?: string | null;
}

/**
 * The single rule set every status change goes through. STATUS follows the transition table; ADJUST may skip it
 * (reason mandatory); SYNC only moves to the derived status. All three must agree with the real assignment.
 */
export function validateStatusChange(input: StatusChangeInput): string | null {
  const { kind, from, to, facts } = input;
  if (!isInventoryStatus(to)) return `Unknown status "${String(to)}"`;
  if (kind === 'SYNC') {
    const derived = deriveDeviceStatus(facts);
    if (to !== derived) return `Sync can only set the status implied by the assignment (${INVENTORY_STATUS_LABELS[derived]})`;
    if (from === to) return 'Status already matches the assignment';
    return null;
  }
  if (from === to && kind === 'STATUS') return `The device is already ${INVENTORY_STATUS_LABELS[to].toLowerCase()}`;
  if (kind === 'STATUS' && !canTransition(from, to)) {
    return `Cannot change status from ${INVENTORY_STATUS_LABELS[from]} to ${INVENTORY_STATUS_LABELS[to]}`;
  }
  if (reasonRequired(kind, to) && !input.reason?.trim()) {
    return kind === 'ADJUST' ? 'An adjustment needs a reason' : `A reason is required to mark a device ${INVENTORY_STATUS_LABELS[to].toLowerCase()}`;
  }
  return checkStatusConsistency(to, facts);
}

// ───────────── DTOs ─────────────

export interface StockLocationDto {
  id: string;
  kind: StockLocationKind;
  code: string;
  name: string;
  ownerPartnerId: string | null;
  address: string | null;
  stateCode: string | null;
  isActive: boolean;
  deviceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierDto {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  contact: Record<string, string>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Licence status shown read-only next to the stock row (from LicenceSeat; never changed by inventory). */
export type StockLicenceStatus = 'NOT_IN_ACCOUNT' | 'NO_SEAT' | 'ACTIVE' | 'EXPIRED';

export interface DeviceStockDto {
  deviceId: string;
  uniqueId: string;
  modelName: string;
  status: InventoryStatus;
  /** Status implied by the existing assignment; differs from `status` until the next sync. */
  derivedStatus: InventoryStatus;
  /** Stored status disagrees with the real assignment (an admin flow changed the owner / vehicle since). */
  mismatch: boolean;
  location: { id: string; code: string; name: string } | null;
  holderPartner: { id: string; name: string } | null;
  receiptId: string | null;
  supplierName: string | null;
  serialNumber: string | null;
  unitCostPaise: number | null;
  warrantyUntil: string | null;
  condition: DeviceCondition | null;
  note: string | null;
  statusChangedAt: string;
  /** Read-only: existing assignment and licence. */
  company: { id: string; name: string } | null;
  object: { id: string; name: string } | null;
  deviceActive: boolean;
  licence: { status: StockLicenceStatus; type: string | null; expiresAt: string | null };
  updatedAt: string;
}

export interface StockMovementDto {
  id: string;
  deviceId: string | null;
  itemRef: string;
  kind: StockMovementKind;
  fromStatus: InventoryStatus | null;
  toStatus: InventoryStatus;
  fromLocation: { id: string; code: string; name: string } | null;
  toLocation: { id: string; code: string; name: string } | null;
  fromHolderPartnerId: string | null;
  toHolderPartnerId: string | null;
  companyId: string | null;
  companyName: string | null;
  objectId: string | null;
  objectName: string | null;
  receiptId: string | null;
  reason: string | null;
  reference: string | null;
  note: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  at: string;
  createdById: string | null;
  createdByName: string | null;
}

export interface StockReceiptDto {
  id: string;
  supplier: { id: string; name: string } | null;
  location: { id: string; code: string; name: string };
  supplierInvoiceNo: string | null;
  supplierInvoiceAt: string | null;
  receivedAt: string;
  source: 'MANUAL' | 'CSV_IMPORT';
  itemCount: number;
  note: string | null;
  createdAt: string;
}

export type StockImportAction = 'CREATE_DEVICE' | 'ADD_STOCK' | 'ERROR';

export interface StockImportRowResult {
  /** 1-based line number in the uploaded file (header = line 1). */
  line: number;
  uniqueId: string | null;
  action: StockImportAction;
  errors: string[];
}

export interface StockImportReport {
  dryRun: boolean;
  applied: boolean;
  receiptId: string | null;
  summary: { rows: number; createDevice: number; addStock: number; errors: number };
  rows: StockImportRowResult[];
}

/** Statuses a replaced (removed) unit may take. */
export const REPLACED_UNIT_STATUSES = ['FAULTY', 'RETURNED', 'UNDER_REPAIR'] as const;
export type ReplacedUnitStatus = (typeof REPLACED_UNIT_STATUSES)[number];

export interface ReplaceDeviceResult {
  objectId: string;
  objectName: string;
  companyId: string;
  oldDevice: { id: string; uniqueId: string; status: InventoryStatus | null };
  newDevice: { id: string; uniqueId: string; status: InventoryStatus | null };
  /** Licence seats are not moved by a replacement (QI-13); both devices keep whatever seat the existing rules gave them. */
  seatsChanged: false;
}

export interface InventoryDashboardDto {
  totals: { tracked: number; untracked: number; mismatches: number; atCustomer: number; inStock: number; needsAttention: number };
  byStatus: Record<InventoryStatus, number>;
  byLocation: { locationId: string | null; code: string | null; name: string | null; count: number; valuePaise: number }[];
  byModel: { modelId: string; name: string; total: number; inStock: number; atCustomer: number; faulty: number }[];
  /** One entry per day of the window (oldest first), movements counted by kind. */
  movements: { day: string; total: number; byKind: Partial<Record<StockMovementKind, number>> }[];
  valuation: {
    /** Sum of recorded purchase cost of devices still held (not RETIRED). */
    heldValuePaise: number;
    costedUnits: number;
    uncostedUnits: number;
    byStatus: Partial<Record<InventoryStatus, number>>;
  };
  windowDays: number;
}

export interface StockSummaryDto {
  byStatus: Record<InventoryStatus, number>;
  byLocation: { locationId: string | null; code: string | null; name: string | null; count: number }[];
  mismatches: number;
  /** Devices without a DeviceStock row (legacy; status derived). */
  untracked: number;
}
