import { Prisma } from '@prisma/client';
import {
  DeviceAssignmentFacts,
  DeviceCondition,
  deriveDeviceStatus,
  DeviceStockDto,
  InventoryStatus,
  StockLicenceStatus,
  StockLocationDto,
  StockLocationKind,
  StockMovementDto,
  StockMovementKind,
  StockReceiptDto,
  SupplierDto,
} from '@veetracer/shared';
import { iso, isoOrNull } from '../common/dto';
import { CsvSpec } from '../common/list-query';

const LOC_REF = { select: { id: true, code: true, name: true } } as const;

/** Device facts read for consistency checks (never written by inventory). */
export const DEVICE_FACTS_SELECT = {
  id: true,
  uniqueId: true,
  companyId: true,
  shippedAt: true,
  claimedAt: true,
  assignments: { where: { toTime: null }, select: { id: true, objectId: true }, take: 1 },
} satisfies Prisma.DeviceSelect;
export type DeviceFactsRow = Prisma.DeviceGetPayload<{ select: typeof DEVICE_FACTS_SELECT }>;

export function factsOf(d: DeviceFactsRow): DeviceAssignmentFacts {
  return { companyId: d.companyId, hasOpenAssignment: d.assignments.length > 0, shippedAt: d.shippedAt, claimedAt: d.claimedAt };
}

export const STOCK_INCLUDE = {
  location: LOC_REF,
  holderPartner: { select: { id: true, name: true } },
  receipt: { select: { id: true, supplier: { select: { name: true } } } },
  device: {
    select: {
      id: true,
      uniqueId: true,
      companyId: true,
      isActive: true,
      shippedAt: true,
      claimedAt: true,
      company: { select: { id: true, name: true } },
      model: { select: { brand: true, model: true } },
      assignments: { where: { toTime: null }, select: { id: true, objectId: true, object: { select: { id: true, name: true } } }, take: 1 },
      licenceSeat: { select: { type: true, expiresAt: true } },
    },
  },
} satisfies Prisma.DeviceStockInclude;
export type StockRow = Prisma.DeviceStockGetPayload<{ include: typeof STOCK_INCLUDE }>;

export function licenceStatusOf(companyId: string | null, seat: { type: string; expiresAt: Date } | null, now = new Date()): DeviceStockDto['licence'] {
  if (!companyId) return { status: 'NOT_IN_ACCOUNT', type: seat?.type ?? null, expiresAt: isoOrNull(seat?.expiresAt) };
  if (!seat) return { status: 'NO_SEAT', type: null, expiresAt: null };
  const status: StockLicenceStatus = seat.expiresAt > now ? 'ACTIVE' : 'EXPIRED';
  return { status, type: seat.type, expiresAt: iso(seat.expiresAt) };
}

export function toStockDto(s: StockRow): DeviceStockDto {
  const d = s.device;
  const assignment = d.assignments[0];
  const derived = deriveDeviceStatus({ companyId: d.companyId, hasOpenAssignment: !!assignment, shippedAt: d.shippedAt, claimedAt: d.claimedAt });
  const status = s.status as InventoryStatus;
  return {
    deviceId: s.deviceId,
    uniqueId: d.uniqueId,
    modelName: `${d.model.brand} ${d.model.model}`,
    status,
    derivedStatus: derived,
    mismatch: isMismatch(status, derived),
    location: s.location,
    holderPartner: s.holderPartner,
    receiptId: s.receiptId,
    supplierName: s.receipt?.supplier?.name ?? null,
    serialNumber: s.serialNumber,
    unitCostPaise: s.unitCostPaise,
    warrantyUntil: s.warrantyUntil ? s.warrantyUntil.toISOString().slice(0, 10) : null,
    condition: (s.condition as DeviceCondition | null) ?? null,
    note: s.note,
    statusChangedAt: iso(s.statusChangedAt),
    company: d.company,
    object: assignment?.object ?? null,
    deviceActive: d.isActive,
    licence: licenceStatusOf(d.companyId, d.licenceSeat),
    updatedAt: iso(s.updatedAt),
  };
}

/**
 * A stored status disagrees with the assignment when it claims ASSIGNED / ACTIVE / IN_STOCK / RESERVED but the
 * device's company / vehicle says otherwise. RESERVED is inventory's own reservation, so it only conflicts with a
 * customer account. FAULTY / UNDER_REPAIR / RETURNED / RETIRED are facts and never mismatch.
 */
export function isMismatch(status: InventoryStatus, derived: InventoryStatus): boolean {
  switch (status) {
    case 'ASSIGNED':
    case 'ACTIVE':
      return status !== derived;
    case 'IN_STOCK':
    case 'RESERVED':
      return derived === 'ASSIGNED' || derived === 'ACTIVE';
    default:
      return false;
  }
}

export const STOCK_CSV: CsvSpec<DeviceStockDto> = {
  name: 'inventory-stock',
  columns: [
    { header: 'IMEI / Unique ID', value: (r) => r.uniqueId },
    { header: 'Model', value: (r) => r.modelName },
    { header: 'Stock status', value: (r) => r.status },
    { header: 'Status from assignment', value: (r) => r.derivedStatus },
    { header: 'Mismatch', value: (r) => (r.mismatch ? 'Yes' : 'No') },
    { header: 'Location code', value: (r) => r.location?.code },
    { header: 'Location', value: (r) => r.location?.name },
    { header: 'Held by partner', value: (r) => r.holderPartner?.name },
    { header: 'Customer', value: (r) => r.company?.name },
    { header: 'Vehicle', value: (r) => r.object?.name },
    { header: 'Licence', value: (r) => r.licence.status },
    { header: 'Licence expires', value: (r) => r.licence.expiresAt },
    { header: 'Serial number', value: (r) => r.serialNumber },
    { header: 'Supplier', value: (r) => r.supplierName },
    { header: 'Unit cost (INR)', value: (r) => (r.unitCostPaise === null ? null : (r.unitCostPaise / 100).toFixed(2)) },
    { header: 'Warranty until', value: (r) => r.warrantyUntil },
    { header: 'Condition', value: (r) => r.condition },
    { header: 'Status since', value: (r) => r.statusChangedAt },
    { header: 'Note', value: (r) => r.note },
  ],
};

export const MOVEMENT_INCLUDE = {
  fromLocation: LOC_REF,
  toLocation: LOC_REF,
  company: { select: { name: true } },
  object: { select: { name: true } },
} satisfies Prisma.StockMovementInclude;
export type MovementRow = Prisma.StockMovementGetPayload<{ include: typeof MOVEMENT_INCLUDE }>;

export function toMovementDto(m: MovementRow, userNames: Map<string, string>): StockMovementDto {
  return {
    id: m.id,
    deviceId: m.deviceId,
    itemRef: m.itemRef,
    kind: m.kind as StockMovementKind,
    fromStatus: (m.fromStatus as InventoryStatus | null) ?? null,
    toStatus: m.toStatus as InventoryStatus,
    fromLocation: m.fromLocation,
    toLocation: m.toLocation,
    fromHolderPartnerId: m.fromHolderPartnerId,
    toHolderPartnerId: m.toHolderPartnerId,
    companyId: m.companyId,
    companyName: m.company?.name ?? null,
    objectId: m.objectId,
    objectName: m.object?.name ?? null,
    receiptId: m.receiptId,
    reason: m.reason,
    reference: m.reference,
    note: m.note,
    changes: (m.changes as StockMovementDto['changes']) ?? null,
    at: iso(m.at),
    createdById: m.createdById,
    createdByName: m.createdById ? (userNames.get(m.createdById) ?? null) : null,
  };
}

export const MOVEMENT_CSV: CsvSpec<StockMovementDto> = {
  name: 'inventory-movements',
  columns: [
    { header: 'When', value: (m) => m.at },
    { header: 'IMEI / Unique ID', value: (m) => m.itemRef },
    { header: 'Kind', value: (m) => m.kind },
    { header: 'From status', value: (m) => m.fromStatus },
    { header: 'To status', value: (m) => m.toStatus },
    { header: 'From location', value: (m) => m.fromLocation?.code },
    { header: 'To location', value: (m) => m.toLocation?.code },
    { header: 'Customer', value: (m) => m.companyName },
    { header: 'Vehicle', value: (m) => m.objectName },
    { header: 'Reason', value: (m) => m.reason },
    { header: 'Reference', value: (m) => m.reference },
    { header: 'Note', value: (m) => m.note },
    { header: 'By', value: (m) => m.createdByName },
  ],
};

export const LOCATION_INCLUDE = { _count: { select: { stock: true } } } satisfies Prisma.StockLocationInclude;
export type LocationRow = Prisma.StockLocationGetPayload<{ include: typeof LOCATION_INCLUDE }>;

export function toLocationDto(l: LocationRow): StockLocationDto {
  return {
    id: l.id,
    kind: l.kind as StockLocationKind,
    code: l.code,
    name: l.name,
    ownerPartnerId: l.ownerPartnerId,
    address: l.address,
    stateCode: l.stateCode,
    isActive: l.isActive,
    deviceCount: l._count.stock,
    createdAt: iso(l.createdAt),
    updatedAt: iso(l.updatedAt),
  };
}

export function toSupplierDto(s: Prisma.SupplierGetPayload<object>): SupplierDto {
  const contact = typeof s.contact === 'object' && s.contact && !Array.isArray(s.contact) ? (s.contact as Record<string, string>) : {};
  return {
    id: s.id,
    name: s.name,
    gstin: s.gstin,
    stateCode: s.stateCode,
    contact,
    isActive: s.isActive,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

export const RECEIPT_INCLUDE = { supplier: { select: { id: true, name: true } }, location: LOC_REF } satisfies Prisma.StockReceiptInclude;
export type ReceiptRow = Prisma.StockReceiptGetPayload<{ include: typeof RECEIPT_INCLUDE }>;

export function toReceiptDto(r: ReceiptRow): StockReceiptDto {
  return {
    id: r.id,
    supplier: r.supplier,
    location: r.location,
    supplierInvoiceNo: r.supplierInvoiceNo,
    supplierInvoiceAt: r.supplierInvoiceAt ? r.supplierInvoiceAt.toISOString().slice(0, 10) : null,
    receivedAt: iso(r.receivedAt),
    source: r.source as StockReceiptDto['source'],
    itemCount: r.itemCount,
    note: r.note,
    createdAt: iso(r.createdAt),
  };
}

/** Date-only column value from YYYY-MM-DD (stored as UTC midnight, Postgres DATE). */
export const dateOnly = (s: string | null | undefined): Date | null | undefined =>
  s === undefined ? undefined : s === null ? null : new Date(`${s}T00:00:00Z`);
