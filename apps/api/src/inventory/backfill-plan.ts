/**
 * B4 backfill design (pure): the DeviceStock row and SYNC movement each legacy device WOULD get, derived from the
 * existing assignment. Report only — nothing here writes; applying a backfill needs owner approval and a separate,
 * reviewed change.
 */
import { deriveDeviceStatus, InventoryStatus, INVENTORY_STATUSES, statusHoldsLocation } from '@veetracer/shared';

export interface BackfillDevice {
  id: string;
  uniqueId: string;
  companyId: string | null;
  companyName: string | null;
  isActive: boolean;
  shippedAt: Date | null;
  claimedAt: Date | null;
  openObjectId: string | null;
  openObjectName: string | null;
  hasStock: boolean;
  createdAt: Date;
}

export interface BackfillRow {
  deviceId: string;
  uniqueId: string;
  status: InventoryStatus;
  /** Proposed stock location code (only for statuses that hold one). */
  locationCode: string | null;
  companyName: string | null;
  objectName: string | null;
  notes: string[];
}

export interface BackfillPlan {
  /** Devices that already have a DeviceStock row (left untouched). */
  skipped: number;
  rows: BackfillRow[];
  byStatus: Record<InventoryStatus, number>;
  /** What applying would insert (DeviceStock rows + one SYNC movement each). */
  wouldInsert: { deviceStock: number; stockMovement: number };
  warnings: string[];
}

export function planBackfill(devices: BackfillDevice[], opts: { stockLocationCode: string | null }): BackfillPlan {
  const byStatus = Object.fromEntries(INVENTORY_STATUSES.map((s) => [s, 0])) as Record<InventoryStatus, number>;
  const rows: BackfillRow[] = [];
  let skipped = 0;
  for (const d of devices) {
    if (d.hasStock) {
      skipped++;
      continue;
    }
    const status = deriveDeviceStatus({ companyId: d.companyId, hasOpenAssignment: !!d.openObjectId, shippedAt: d.shippedAt, claimedAt: d.claimedAt });
    const notes: string[] = [];
    if (!d.isActive) notes.push('Device is deactivated (flag kept; not a stock status)');
    if (status === 'RESERVED') notes.push('Shipped, not yet claimed');
    if (statusHoldsLocation(status) && !opts.stockLocationCode) notes.push('No stock location given: would be left without a location');
    byStatus[status]++;
    rows.push({
      deviceId: d.id,
      uniqueId: d.uniqueId,
      status,
      locationCode: statusHoldsLocation(status) ? opts.stockLocationCode : null,
      companyName: d.companyName,
      objectName: d.openObjectName,
      notes,
    });
  }
  const warnings: string[] = [];
  if (!opts.stockLocationCode && (byStatus.IN_STOCK || byStatus.RESERVED)) warnings.push('Pass --location=<CODE> to place platform stock in a location');
  warnings.push('Dry run only: this plan has no apply mode. Applying needs owner approval (see docs/inventory-modules/phase-b/PHASE_B.md §B4).');
  return { skipped, rows, byStatus, wouldInsert: { deviceStock: rows.length, stockMovement: rows.length }, warnings };
}
