/*
 * Stock (inventory): what the platform and its resellers buy and sell — trackers (by IMEI), SIMs (by number) and
 * accessories (counted). One document type covers the whole flow; saving a document updates stock.
 */

export const STOCK_ITEM_KINDS = ['DEVICE', 'SIM', 'ACCESSORY'] as const;
export type StockItemKind = (typeof STOCK_ITEM_KINDS)[number];

/** Purchase order → receipt (→ purchase return); customer order → sale (→ sales return); adjustment. */
export const STOCK_DOC_KINDS = ['PO', 'RECEIPT', 'PURCHASE_RETURN', 'ORDER', 'SALE', 'SALES_RETURN', 'ADJUSTMENT'] as const;
export type StockDocKind = (typeof STOCK_DOC_KINDS)[number];

/** DRAFT: saved, no stock change. DONE: stock updated. PO / ORDER: OPEN → PARTIAL → DONE as goods arrive / leave. */
export const STOCK_DOC_STATUSES = ['DRAFT', 'OPEN', 'PARTIAL', 'DONE', 'CANCELLED'] as const;
export type StockDocStatus = (typeof STOCK_DOC_STATUSES)[number];

/** Who a sale is for: a customer company / person, a reseller (stock moves into its store), or our own use. */
export const STOCK_SALE_TO = ['CUSTOMER', 'PARTNER', 'OWN'] as const;
export type StockSaleTo = (typeof STOCK_SALE_TO)[number];

/** How a customer order came in. */
export const STOCK_ORDER_CHANNELS = ['CALL', 'WHATSAPP', 'EMAIL', 'VISIT', 'PORTAL'] as const;
export type StockOrderChannel = (typeof STOCK_ORDER_CHANNELS)[number];

export const STOCK_SERIAL_STATUSES = ['IN_STOCK', 'DAMAGED', 'SOLD', 'WITH_SUPPLIER', 'USED', 'SCRAPPED'] as const;
export type StockSerialStatus = (typeof STOCK_SERIAL_STATUSES)[number];

export const STOCK_LOCATION_KINDS = ['STORE', 'DAMAGED', 'PARTNER'] as const;
export type StockLocationKind = (typeof STOCK_LOCATION_KINDS)[number];

/** Document number prefix per kind: PO/26-27/0001, GRN/…, PRN/…, ORD/…, SAL/…, SRN/…, ADJ/…. */
export const STOCK_DOC_PREFIX: Record<StockDocKind, string> = { PO: 'PO', RECEIPT: 'GRN', PURCHASE_RETURN: 'PRN', ORDER: 'ORD', SALE: 'SAL', SALES_RETURN: 'SRN', ADJUSTMENT: 'ADJ' };

/** Plain-language names (translation keys). */
export const STOCK_DOC_LABEL: Record<StockDocKind, string> = {
  PO: 'Purchase order',
  RECEIPT: 'Goods received',
  PURCHASE_RETURN: 'Return to supplier',
  ORDER: 'Customer order',
  SALE: 'Sale / dispatch',
  SALES_RETURN: 'Customer return',
  ADJUSTMENT: 'Stock adjustment',
};
export const STOCK_SERIAL_LABEL: Record<StockSerialStatus, string> = { IN_STOCK: 'In stock', DAMAGED: 'Damaged', SOLD: 'Sold', WITH_SUPPLIER: 'Returned to supplier', USED: 'Own use', SCRAPPED: 'Written off' };

export interface StockItemDto {
  id: string;
  name: string;
  kind: StockItemKind;
  deviceModelId: string | null;
  deviceModelName: string | null;
  sku: string | null;
  hsnCode: string;
  gstRatePct: number;
  unit: string;
  serialTracked: boolean;
  salePricePaise: number;
  purchasePricePaise: number;
  /** Reorder level: low stock at or below this (main store; a reseller's own store for resellers). */
  lowStockAt: number | null;
  /** Usual quantity to order when low. */
  reorderQty: number | null;
  isActive: boolean;
  /** On hand in all stores (damaged shelf not included). */
  onHand: number;
}

export interface StockPriceDto {
  id: string;
  itemId: string;
  partnerId: string | null;
  companyId: string | null;
  /** Reseller or customer name. */
  forName: string;
  pricePaise: number;
}

export interface SupplierDto {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string;
  address: string;
  city: string;
  pin: string;
  contactName: string;
  phone: string;
  email: string;
  notes: string;
  /** Days from order to delivery. */
  leadTimeDays: number;
  isActive: boolean;
}

export interface StockLocationDto {
  id: string;
  name: string;
  kind: StockLocationKind;
  partnerId: string | null;
  isActive: boolean;
}

export interface StockDocLineDto {
  id?: string;
  itemId: string;
  itemName?: string;
  serialTracked?: boolean;
  unit?: string;
  hsnCode?: string;
  qty: number;
  ratePaise: number;
  gstRatePct: number;
  serials: string[];
  condition: 'OK' | 'DAMAGED';
  note: string;
}

export interface StockFileDto {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  createdAt: string;
}

export interface StockDocDto {
  id: string;
  kind: StockDocKind;
  number: string;
  status: StockDocStatus;
  docDate: string;
  partnerId: string | null;
  partnerName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  toPlatform: boolean;
  saleTo: StockSaleTo | null;
  customerCompanyId: string | null;
  customerPartnerId: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerGstin: string | null;
  customerStateCode: string;
  customerAddress: string;
  locationId: string | null;
  locationName: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
  channel: StockOrderChannel | null;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string | null;
  supplierInvoiceAmountPaise: number | null;
  reason: string;
  notes: string;
  totalPaise: number;
  lines: StockDocLineDto[];
  files: StockFileDto[];
  /** Documents that follow this one (receipts of a PO, sales of an order, returns). */
  followUps: { id: string; kind: StockDocKind; number: string; status: StockDocStatus; docDate: string }[];
  invoice: { id: string; kind: 'INVOICE' | 'CREDIT_NOTE'; number: string; totalPaise: number; paymentStatus: string } | null;
  /** PO / ORDER: quantity still to receive / dispatch per item. */
  pending: { itemId: string; itemName: string; qty: number }[];
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body of POST / PUT /stock/docs. */
export interface StockDocInput {
  kind: StockDocKind;
  status: 'DRAFT' | 'DONE' | 'OPEN' | 'CANCELLED';
  docDate: string;
  supplierId?: string | null;
  toPlatform?: boolean;
  saleTo?: StockSaleTo | null;
  customerCompanyId?: string | null;
  customerPartnerId?: string | null;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerGstin?: string | null;
  customerStateCode?: string;
  customerAddress?: string;
  locationId?: string | null;
  sourceId?: string | null;
  channel?: StockOrderChannel | null;
  supplierInvoiceNo?: string;
  supplierInvoiceDate?: string | null;
  supplierInvoiceAmountPaise?: number | null;
  reason?: string;
  notes?: string;
  lines: StockDocLineDto[];
}

export interface StockOnHandRow {
  itemId: string;
  itemName: string;
  kind: StockItemKind;
  unit: string;
  locationId: string;
  locationName: string;
  locationKind: StockLocationKind;
  qty: number;
  lowStockAt: number | null;
}

/** One IMEI / SIM number: where it is now and everything that happened to it. */
export interface StockSerialDto {
  serial: string;
  itemId: string;
  itemName: string;
  status: StockSerialStatus;
  locationName: string | null;
  customerName: string | null;
  history: { docId: string; kind: StockDocKind; number: string; docDate: string; party: string; effect: StockSerialStatus; locationName: string | null }[];
}

/** Whole rupees / paise helpers for the stock screens. */
export const rupeesToPaise = (r: number) => Math.round(r * 100);

/** GET /stock/dashboard: the inventory dashboard (platform: main store; reseller: its own store). */
export interface StockDashboardDto {
  generatedAt: string;
  /** Units in stores (damaged shelf not included). */
  unitsInStock: number;
  /** At default buying price, paise. */
  stockValuePaise: number;
  /** Units on the damaged shelf waiting to go back to the supplier or be written off. */
  damagedUnits: number;
  /** This calendar month. */
  soldUnitsMonth: number;
  salesMonthPaise: number;
  receivedUnitsMonth: number;
  /** Platform: open POs resellers raised to VeeTrax. */
  resellerOrdersOpen: number;
  unpaidInvoices: { count: number; amountPaise: number };
  /** At or below the reorder level, most urgent first. */
  lowStock: {
    itemId: string;
    itemName: string;
    unit: string;
    onHand: number;
    reorderLevel: number;
    /** Already ordered, not yet received. */
    onOrder: number;
    suggestedQty: number;
    supplierId: string | null;
    supplierName: string | null;
    leadTimeDays: number | null;
    /** If ordered today. */
    expectedBy: string | null;
    /** On hand + on order still at or below the level: order now. */
    orderNow: boolean;
  }[];
  /** Open / part-received purchase orders with their expected arrival. */
  openPurchaseOrders: { id: string; number: string; supplierName: string; docDate: string; expectedBy: string | null; overdueDays: number; pendingQty: number }[];
  /** Units sold per day, last 30 days (oldest first). */
  salesByDay: { day: string; units: number; amountPaise: number }[];
  /** Latest documents. */
  recent: { id: string; kind: StockDocKind; number: string; status: StockDocStatus; docDate: string; party: string; totalPaise: number }[];
}
