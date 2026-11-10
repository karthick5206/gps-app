import type { StockDocKind, StockSaleTo, StockSerialStatus } from '@veetracer/shared';

/*
 * Stock rules without the database: which moves a document makes, whether the goods are really there, and what a PO /
 * order still waits for. The service loads the current state, asks these functions, then writes the result.
 */

export interface PlanLine {
  itemId: string;
  serialTracked: boolean;
  qty: number;
  serials: string[];
  condition: 'OK' | 'DAMAGED';
}

export interface PlanDoc {
  kind: StockDocKind;
  /** Only DONE documents move stock. */
  status: string;
  saleTo: StockSaleTo | null;
  /** Store the goods leave from / arrive at. */
  locationId: string | null;
}

export interface PlannedMove {
  itemId: string;
  locationId: string | null;
  /** + in, − out. */
  qty: number;
  serial: string | null;
  effect: StockSerialStatus;
}

export interface PlanContext {
  damagedLocationId: string;
  /** SALE to a reseller: its store (the goods move there and stay in stock). */
  partnerLocationId: string | null;
}

/** Documents that never move stock themselves (they are plans the others follow). */
export const PLAN_ONLY: readonly StockDocKind[] = ['PO', 'ORDER'];

/** Normalised serial list: spaces removed (IMEIs / SIM numbers have none), upper-case, empty and duplicate entries dropped. */
export function cleanSerials(serials: string[]): string[] {
  return [...new Set(serials.map((s) => s.replace(/\s+/g, '').toUpperCase()).filter(Boolean))];
}

/**
 * The moves a DONE document makes, in order (the later move of a serial wins its status):
 * RECEIPT +in (damaged → damaged shelf) · PURCHASE_RETURN −out to the supplier · SALE −out (to a reseller: +into its
 * store) · SALES_RETURN +in (damaged → damaged shelf) · ADJUSTMENT ± (out = written off).
 */
export function planMoves(doc: PlanDoc, lines: PlanLine[], ctx: PlanContext): PlannedMove[] {
  if (doc.status !== 'DONE' || PLAN_ONLY.includes(doc.kind)) return [];
  const out: PlannedMove[] = [];
  const each = (l: PlanLine, sign: 1 | -1, locationId: string | null, effect: StockSerialStatus) => {
    if (l.serialTracked) for (const s of cleanSerials(l.serials)) out.push({ itemId: l.itemId, locationId, qty: sign, serial: s, effect });
    else if (l.qty) out.push({ itemId: l.itemId, locationId, qty: sign * Math.abs(l.qty), serial: null, effect });
  };
  for (const l of lines) {
    const intoShelf = l.condition === 'DAMAGED' ? ctx.damagedLocationId : doc.locationId;
    const inEffect: StockSerialStatus = l.condition === 'DAMAGED' ? 'DAMAGED' : 'IN_STOCK';
    switch (doc.kind) {
      case 'RECEIPT':
      case 'SALES_RETURN':
        each(l, 1, intoShelf, inEffect);
        break;
      case 'PURCHASE_RETURN':
        each(l, -1, doc.locationId, 'WITH_SUPPLIER');
        break;
      case 'SALE':
        each(l, -1, doc.locationId, doc.saleTo === 'OWN' ? 'USED' : 'SOLD');
        if (doc.saleTo === 'PARTNER' && ctx.partnerLocationId) each(l, 1, ctx.partnerLocationId, 'IN_STOCK');
        break;
      case 'ADJUSTMENT':
        if (l.qty >= 0) each(l, 1, doc.locationId, 'IN_STOCK');
        else each(l, -1, doc.locationId, 'SCRAPPED');
        break;
    }
  }
  return out;
}

/** Where a serial is now, from everything else (the document being saved left out). */
export interface SerialNow {
  status: StockSerialStatus;
  locationId: string | null;
}

/**
 * Problems with a document's moves against current stock (this document's own earlier moves already left out):
 * an IMEI / SIM taken from a store it isn't in, received twice, or returned without having been sold; a counted item
 * taken beyond what the store holds. Returns plain-language messages; empty = fine.
 */
export function checkMoves(
  kind: StockDocKind,
  moves: PlannedMove[],
  serialNow: (itemId: string, serial: string) => SerialNow | undefined,
  onHand: (itemId: string, locationId: string | null) => number,
  names: { item: (id: string) => string; location: (id: string | null) => string },
): string[] {
  const errors: string[] = [];
  const takenSerial = new Set<string>();
  const takenQty = new Map<string, number>();
  for (const m of moves) {
    if (m.serial) {
      const key = `${m.itemId}|${m.serial}`;
      const now = serialNow(m.itemId, m.serial);
      if (m.qty > 0 && (kind === 'RECEIPT' || kind === 'ADJUSTMENT') && now && (now.status === 'IN_STOCK' || now.status === 'DAMAGED')) {
        errors.push(`${m.serial} (${names.item(m.itemId)}) is already in stock at ${names.location(now.locationId)}.`);
      }
      if (m.qty > 0 && kind === 'SALES_RETURN' && (!now || (now.status !== 'SOLD' && now.status !== 'USED'))) {
        errors.push(`${m.serial} (${names.item(m.itemId)}) was not sold, so it can't come back as a return.`);
      }
      if (m.qty < 0) {
        if (takenSerial.has(key)) {
          errors.push(`${m.serial} is entered twice.`);
          continue;
        }
        takenSerial.add(key);
        const okStatus = now && (now.status === 'IN_STOCK' || (now.status === 'DAMAGED' && kind !== 'SALE'));
        if (!now || !okStatus || now.locationId !== m.locationId) {
          errors.push(now ? `${m.serial} (${names.item(m.itemId)}) is not available at ${names.location(m.locationId)} (it is ${now.status === 'IN_STOCK' || now.status === 'DAMAGED' ? `at ${names.location(now.locationId)}` : now.status.toLowerCase().replace(/_/g, ' ')}).` : `${m.serial} (${names.item(m.itemId)}) is not in stock.`);
        }
      }
    } else if (m.qty < 0) {
      const key = `${m.itemId}|${m.locationId}`;
      takenQty.set(key, (takenQty.get(key) ?? 0) - m.qty);
    }
  }
  for (const [key, qty] of takenQty) {
    const [itemId, loc] = key.split('|');
    const have = onHand(itemId, loc === 'null' ? null : loc);
    if (qty > have) errors.push(`Only ${have} of ${names.item(itemId)} at ${names.location(loc === 'null' ? null : loc)}; ${qty} needed.`);
  }
  return errors;
}

/** PO / order progress from the quantities received / dispatched against it. */
export function planStatus(ordered: { itemId: string; qty: number }[], done: { itemId: string; qty: number }[]): { status: 'OPEN' | 'PARTIAL' | 'DONE'; pending: { itemId: string; qty: number }[] } {
  const want = new Map<string, number>();
  for (const l of ordered) want.set(l.itemId, (want.get(l.itemId) ?? 0) + l.qty);
  const got = new Map<string, number>();
  for (const l of done) got.set(l.itemId, (got.get(l.itemId) ?? 0) + l.qty);
  const pending = [...want.entries()].map(([itemId, qty]) => ({ itemId, qty: Math.max(0, qty - (got.get(itemId) ?? 0)) })).filter((p) => p.qty > 0);
  const any = [...got.values()].some((q) => q > 0);
  return { status: pending.length === 0 && want.size > 0 ? 'DONE' : any ? 'PARTIAL' : 'OPEN', pending };
}

/** Line quantity: the number of serials for tracked items, else the entered quantity. */
export const lineQty = (l: { serialTracked: boolean; qty: number; serials: string[] }) => (l.serialTracked ? cleanSerials(l.serials).length : Math.abs(l.qty));

/** Indian financial year label of a YYYY-MM-DD date: 2026-11-09 → "26-27". */
export function fyOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

/** YYYY-MM-DD + n days. */
export function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * What is owed to a supplier for one goods received note: the supplier's invoice amount (else the receipt total), less
 * returns made from it, less payments. Due on the invoice date (else receipt date) + payment terms; overdue after that.
 */
export function supplierBill(b: { billPaise: number; returnsPaise: number; paidPaise: number; billDate: string; termsDays: number; today: string }): {
  amountPaise: number;
  returnsPaise: number;
  paidPaise: number;
  duePaise: number;
  dueDate: string;
  status: 'UNPAID' | 'PART' | 'PAID';
  overdue: boolean;
} {
  const owed = Math.max(0, b.billPaise - b.returnsPaise);
  const duePaise = Math.max(0, owed - b.paidPaise);
  const status = duePaise === 0 ? 'PAID' : b.paidPaise > 0 ? 'PART' : 'UNPAID';
  const dueDate = plusDays(b.billDate, Math.max(0, b.termsDays));
  return { amountPaise: b.billPaise, returnsPaise: b.returnsPaise, paidPaise: b.paidPaise, duePaise, dueDate, status, overdue: duePaise > 0 && b.today > dueDate };
}
