import { canTransition, deriveDeviceStatus, type DeviceAssignmentFacts, type InventoryStatus, type StockMovementKind } from '@veetracer/shared';

/*
 * Stock & sales → Stock & movements: ONE stock register for trackers.
 *
 * Stock & movements (Device Inventory: DeviceStock + StockMovement) is the register of where every tracker is. Stock &
 * sales documents (receipt, purchase return, sale, sales return, adjustment) keep their own IMEI rows for documents,
 * prices and invoices, and after every save each touched tracker is brought to the matching state in the register,
 * with one movement that names the document. These pure rules decide that state and the movement kind.
 */

/** Where a Stock & sales IMEI is now (StockSerial), or null when no document holds it any more. */
export interface SalesSerialState {
  status: 'IN_STOCK' | 'DAMAGED' | 'SOLD' | 'WITH_SUPPLIER' | 'USED' | 'SCRAPPED';
  /** Stock & movements location of the store it is in (IN_STOCK / DAMAGED). */
  locationId: string | null;
  /** The reseller owning that store (a tracker sold to a reseller sits in its store). */
  holderPartnerId: string | null;
}

/** Special places in Stock & movements for goods that left our stores. */
export interface SpecialLocations {
  supplierReturn: string;
  scrap: string;
}

export interface WantedStock {
  status: InventoryStatus;
  locationId: string | null;
  holderPartnerId: string | null;
  /** Why, in words, for the movement (reason column). */
  why: string;
}

/**
 * The register state a tracker should have. `facts` are the device's real customer / vehicle assignment (already
 * updated by the sale / return: sold to a customer company = assigned to it; back in stock = no company).
 * Returns null for "leave it alone" (the IMEI is not in Stock & sales any more and the register keeps its own state).
 */
export function wantedStock(serial: SalesSerialState | null, facts: DeviceAssignmentFacts, places: SpecialLocations): WantedStock | null {
  if (!serial) return null;
  switch (serial.status) {
    case 'IN_STOCK':
      return { status: 'IN_STOCK', locationId: serial.locationId, holderPartnerId: serial.holderPartnerId, why: 'In stock' };
    case 'DAMAGED':
      return { status: 'FAULTY', locationId: serial.locationId, holderPartnerId: serial.holderPartnerId, why: 'Damaged' };
    case 'WITH_SUPPLIER':
      return { status: 'RETURNED', locationId: places.supplierReturn, holderPartnerId: null, why: 'Returned to supplier' };
    case 'SCRAPPED':
      return { status: 'RETIRED', locationId: places.scrap, holderPartnerId: null, why: 'Written off' };
    case 'SOLD':
    case 'USED':
      // In a customer account: the register mirrors that assignment (Assigned / Active, no location).
      if (facts.companyId) return { status: deriveDeviceStatus(facts), locationId: null, holderPartnerId: null, why: serial.status === 'USED' ? 'Own use' : 'Sold' };
      // Sold to someone without a VeeTrax account (walk-in, or not yet claimed): it left our stock for good.
      return { status: 'RETIRED', locationId: null, holderPartnerId: null, why: serial.status === 'USED' ? 'Own use' : 'Sold to a customer outside VeeTrax' };
  }
}

export interface CurrentStock {
  status: InventoryStatus;
  locationId: string | null;
  holderPartnerId: string | null;
}

/**
 * The movement that takes the register from `now` to `want`, or null when nothing changes.
 * RECEIVE: first time in the register. SYNC: status follows the customer assignment. TRANSFER: same status, other
 * place. STATUS: an allowed change (Stock & movements' transition table). ADJUST: anything else (e.g. a document was
 * edited or cancelled afterwards), always with the reason.
 */
export function movementKind(now: CurrentStock | null, want: WantedStock): StockMovementKind | null {
  if (!now) return want.status === 'IN_STOCK' || want.status === 'FAULTY' ? 'RECEIVE' : 'ADJUST';
  const samePlace = now.locationId === want.locationId && now.holderPartnerId === want.holderPartnerId;
  if (now.status === want.status) return samePlace ? null : 'TRANSFER';
  if (want.status === 'ASSIGNED' || want.status === 'ACTIVE') return 'SYNC';
  if (now.status === 'ASSIGNED' || now.status === 'ACTIVE') {
    // Back from a customer (sales return): the assignment was already removed, so align it (IN_STOCK) or record it.
    return want.status === 'IN_STOCK' ? 'SYNC' : canTransition(now.status, want.status) ? 'STATUS' : 'ADJUST';
  }
  return canTransition(now.status, want.status) ? 'STATUS' : 'ADJUST';
}

/** Stock & movements location kind for a Stock & sales store kind. */
export function locationKindFor(storeKind: string): 'WAREHOUSE' | 'PARTNER' {
  return storeKind === 'PARTNER' ? 'PARTNER' : 'WAREHOUSE';
}

/** A location code from a name: upper-case letters / digits, max 20, e.g. "Main store" → "MAIN-STORE". */
export function locationCode(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'STORE'
  );
}
