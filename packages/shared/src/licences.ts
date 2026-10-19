/**
 * Licences & billing: licence (seat) types, Indian GST maths, invoice numbering and seat expiry rules.
 * Pure functions, shared by the api (invoices, locking) and the web / mobile apps (price previews, banners).
 */

export const LICENCE_TYPES = ['USER', 'GPS_DEVICE', 'DASHCAM', 'FUEL_SENSOR'] as const;
export type LicenceType = (typeof LICENCE_TYPES)[number];

export const LICENCE_TYPE_LABELS: Record<LicenceType, string> = {
  USER: 'User login',
  GPS_DEVICE: 'GPS device',
  DASHCAM: 'Dashcam',
  FUEL_SENSOR: 'Fuel sensor',
};

/** Device-model capabilities that make a device a dashcam (JT/T 808 video profiles). */
export const DASHCAM_CAPABILITIES = ['video', 'adas', 'dms'] as const;

export function deviceLicenceType(capabilities: readonly string[]): LicenceType {
  return capabilities.some((c) => (DASHCAM_CAPABILITIES as readonly string[]).includes(c)) ? 'DASHCAM' : 'GPS_DEVICE';
}

export const PAYMENT_MODES = ['ONLINE', 'CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const OFFLINE_PAYMENT_MODES = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;
export type OfflinePaymentMode = (typeof OFFLINE_PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  ONLINE: 'Online (Razorpay)',
  CASH: 'Cash',
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
};

/** Where a seat came from. */
export type SeatSource = 'PURCHASE' | 'MIGRATION' | 'OVERRIDE' | 'ALLOCATION';

/** Seat status for display: ACTIVE, EXPIRING (within 30 days), GRACE (expired, still usable), EXPIRED (locked). */
export type SeatStatus = 'ACTIVE' | 'EXPIRING' | 'GRACE' | 'EXPIRED';

export const DEFAULT_GRACE_DAYS = 15;
export const DEFAULT_GST_RATE = 18;
export const DEFAULT_SAC_CODE = '998314';
export const LICENCE_EXPIRING_DAYS = 30;
/** Reminder thresholds (days before expiry); 0 = on the day it expires. */
export const LICENCE_REMINDER_DAYS = [30, 15, 7, 1, 0] as const;

const DAY_MS = 86_400_000;

/** The same calendar date `years` later (29 Feb → 28 Feb), keeping the time of day (UTC). */
export function addYears(date: Date, years = 1): Date {
  const d = new Date(date.getTime());
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d;
}

/**
 * New expiry when a seat is renewed: 12 months from its current expiry while it is still running,
 * else 12 months from the payment date (an expired seat does not back-date the new year).
 */
export function renewedExpiry(currentExpiry: Date, paidAt: Date): Date {
  return addYears(currentExpiry.getTime() > paidAt.getTime() ? currentExpiry : paidAt);
}

export function seatStatus(expiresAt: Date | string, now: number, graceDays = DEFAULT_GRACE_DAYS): SeatStatus {
  const exp = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt.getTime();
  if (exp > now + LICENCE_EXPIRING_DAYS * DAY_MS) return 'ACTIVE';
  if (exp > now) return 'EXPIRING';
  if (exp + graceDays * DAY_MS > now) return 'GRACE';
  return 'EXPIRED';
}

/** True when viewing of the seat's subject is locked (expired and past the grace period). */
export function seatLocked(expiresAt: Date | string | null | undefined, now: number, graceDays = DEFAULT_GRACE_DAYS): boolean {
  if (!expiresAt) return true;
  return seatStatus(expiresAt, now, graceDays) === 'EXPIRED';
}

/** Whole days until expiry (negative once expired). */
export function daysUntil(expiresAt: Date | string, now: number): number {
  const exp = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt.getTime();
  return Math.ceil((exp - now) / DAY_MS);
}

// ───────────── Indian states / UTs (GST state codes) ─────────────

export interface IndianState {
  code: string;
  name: string;
  /** Union territory without a legislature: intra-territory supplies carry UTGST instead of SGST. */
  utWithoutLegislature?: boolean;
}

export const INDIAN_STATES: readonly IndianState[] = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh', utWithoutLegislature: true },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', utWithoutLegislature: true },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep', utWithoutLegislature: true },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands', utWithoutLegislature: true },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh', utWithoutLegislature: true },
  { code: '97', name: 'Other Territory' },
];

export function stateByCode(code: string | null | undefined): IndianState | undefined {
  return INDIAN_STATES.find((s) => s.code === code);
}

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Error message for an invalid GSTIN (format, or state code not matching the billing state), else null. */
export function gstinError(gstin: string, stateCode: string | null | undefined): string | null {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return 'GSTIN format is invalid (e.g. 33ABCDE1234F1Z5)';
  if (stateCode && g.slice(0, 2) !== stateCode) return "GSTIN state code does not match the billing state";
  return null;
}

// ───────────── GST (prices are GST-inclusive; all amounts in paise) ─────────────

export type TaxKind = 'CGST_SGST' | 'CGST_UTGST' | 'IGST';

/** Intra-state → CGST + SGST; intra-territory (UT without legislature) → CGST + UTGST; inter-state → IGST. */
export function taxKind(supplierStateCode: string, customerStateCode: string): TaxKind {
  if (supplierStateCode !== customerStateCode) return 'IGST';
  return stateByCode(customerStateCode)?.utWithoutLegislature ? 'CGST_UTGST' : 'CGST_SGST';
}

export interface GstLine {
  totalPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  /** SGST, or UTGST for a union territory without legislature. */
  sgstPaise: number;
  igstPaise: number;
}

export interface GstBreakdown extends GstLine {
  kind: TaxKind;
  ratePct: number;
  taxPaise: number;
  lines: GstLine[];
}

/** Split one inclusive amount: taxable = round(total / (1 + rate)); tax = total − taxable; CGST gets the odd paisa. */
export function gstLine(totalPaise: number, ratePct: number, kind: TaxKind): GstLine {
  const taxablePaise = Math.round((totalPaise * 100) / (100 + ratePct));
  const tax = totalPaise - taxablePaise;
  if (kind === 'IGST') return { totalPaise, taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
  const cgstPaise = Math.ceil(tax / 2);
  return { totalPaise, taxablePaise, cgstPaise, sgstPaise: tax - cgstPaise, igstPaise: 0 };
}

/** Per-line split; totals are sums of the lines, so taxable + taxes always equals the inclusive amount exactly. */
export function gstBreakdown(linePaise: number[], ratePct: number, supplierStateCode: string, customerStateCode: string): GstBreakdown {
  const kind = taxKind(supplierStateCode, customerStateCode);
  const lines = linePaise.map((p) => gstLine(p, ratePct, kind));
  const sum = (k: keyof GstLine) => lines.reduce((s, l) => s + l[k], 0);
  const totalPaise = sum('totalPaise');
  const taxablePaise = sum('taxablePaise');
  return {
    kind,
    ratePct,
    lines,
    totalPaise,
    taxablePaise,
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    taxPaise: totalPaise - taxablePaise,
  };
}

/** 123456.7 → 12345670 paise (rounded). */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** 12345670 → "1,23,456.70" (Indian digit grouping). */
export function formatInr(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100).toString();
  const p = (abs % 100).toString().padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? `${rest},${last3}` : last3}.${p}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}

/** Indian numbering (thousand, lakh, crore); crores above 99 recurse ("One Hundred Crore"). */
export function numberToIndianWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  if (crore) parts.push(`${numberToIndianWords(crore)} Crore`);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  n %= 1000;
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

/** "Rupees One Lakh Eighteen Thousand and Fifty Paise Only". */
export function amountInWords(paise: number): string {
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return `Rupees ${numberToIndianWords(rupees)}${p ? ` and ${belowHundred(p)} Paise` : ''} Only`;
}

// ───────────── Invoice numbering (Indian financial year, Apr–Mar, IST) ─────────────

const IST_OFFSET_MS = 330 * 60_000;

/** "2026-27" for any date from 1 Apr 2026 to 31 Mar 2027 (India time). */
export function financialYear(date: Date | number): string {
  const d = new Date((typeof date === 'number' ? date : date.getTime()) + IST_OFFSET_MS);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** "VTX/2026-27/0001". */
export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix ? `${prefix}/` : ''}${fy}/${String(seq).padStart(4, '0')}`;
}

// ───────────── API DTOs ─────────────

export type LicencePrices = Record<LicenceType, number>;

/** Platform licence settings (Super Admin). Prices are GST-inclusive, per seat per year, in paise. */
export interface LicencePricingDto {
  pricesPaise: LicencePrices;
  gstRatePct: number;
  graceDays: number;
  /** Validity of a seat granted by a Super Admin override (days). */
  overrideDays: number;
}

export interface PartnerPricingDto {
  partnerId: string;
  partnerName: string;
  /** Per-type override; null = platform price. */
  pricesPaise: Record<LicenceType, number | null>;
}

export interface InvoicingSettingsDto {
  legalName: string;
  addressLines: string[];
  city: string;
  stateCode: string;
  pin: string;
  gstin: string;
  pan: string;
  phone: string;
  email: string;
  website: string;
  /** Copy of every invoice e-mail goes here (optional). */
  accountsEmail: string;
  hasLogo: boolean;
  sacCode: string;
  invoicePrefix: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNo: string;
  bankIfsc: string;
  bankBranch: string;
  upiId: string;
  terms: string;
  footerNote: string;
}

export interface BillingProfileDto {
  billingName: string;
  address: string;
  city: string;
  stateCode: string;
  pin: string;
  gstin: string;
  email: string;
  /** Billing name, address, state and e-mail are filled in (required before the first purchase). */
  complete: boolean;
}

export type SeatSubjectKind = 'USER' | 'DEVICE' | 'FUEL';

export interface SeatDto {
  id: string;
  type: LicenceType;
  companyId: string | null;
  companyName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  source: SeatSource;
  activatedAt: string;
  expiresAt: string;
  status: SeatStatus;
  /** True once expired past the grace period: the subject's data can no longer be viewed. */
  locked: boolean;
  subject: { kind: SeatSubjectKind; id: string; name: string } | null;
  note: string | null;
}

export interface SeatSummaryDto {
  type: LicenceType;
  total: number;
  used: number;
  free: number;
  expiring: number;
  expired: number;
}

export interface LicenceOwnerRef {
  kind: 'COMPANY' | 'PARTNER';
  id: string;
  name: string;
}

export interface LicenceOverviewDto {
  owner: LicenceOwnerRef;
  summary: SeatSummaryDto[];
  seats: SeatDto[];
  pricesPaise: LicencePrices;
  gstRatePct: number;
  graceDays: number;
  billing: BillingProfileDto;
  onlinePayment: { enabled: boolean; keyId: string | null };
  /** Bank / UPI details shown with the pay-offline instructions. */
  payOffline: { bankName: string; bankAccountName: string; bankAccountNo: string; bankIfsc: string; bankBranch: string; upiId: string; supplierName: string };
}

export interface PurchaseItem {
  type: LicenceType;
  quantity: number;
}

export interface PurchaseRequest {
  items: PurchaseItem[];
  /** Seats to renew (each extends 12 months). */
  renewSeatIds: string[];
}

export interface QuoteLineDto {
  kind: 'NEW' | 'RENEWAL';
  type: LicenceType;
  quantity: number;
  unitPaise: number;
  amountPaise: number;
  periodFrom: string;
  periodTo: string;
  seatIds: string[];
}

export interface QuoteDto {
  lines: QuoteLineDto[];
  gst: GstBreakdown;
  customerStateCode: string;
  supplierStateCode: string;
}

export type OrderStatus = 'CREATED' | 'PAID' | 'FAILED';

export interface CheckoutDto {
  orderId: string;
  razorpayOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: 'INR';
  name: string;
  description: string;
  prefill: { name: string; email: string; contact: string };
}

export interface InvoiceDto {
  id: string;
  number: string;
  issuedAt: string;
  buyerName: string;
  companyId: string | null;
  partnerId: string | null;
  gstin: string | null;
  stateCode: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  utgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  paymentMode: PaymentMode;
  paymentReference: string | null;
  emailedAt: string | null;
}

export interface OfflinePaymentRequest extends PurchaseRequest {
  mode: OfflinePaymentMode;
  reference?: string;
  /** YYYY-MM-DD. */
  paidOn: string;
  /** Must equal the quoted total (GST-inclusive, paise). */
  amountPaise: number;
}

/** Banner data for the signed-in user's company. */
export interface LicenceBannerDto {
  /** Licensing does not apply (platform company / Super Admin home). */
  exempt: boolean;
  expiringSoon: number;
  inGrace: number;
  lockedVehicles: { id: string; name: string }[];
  canManage: boolean;
}

/** Body of a 402 response when a create needs a free seat. */
export interface LicenceRequiredError {
  code: 'LICENCE_REQUIRED';
  licenceType: LicenceType;
  message: string;
}

export const LICENCE_OVERRIDE_HEADER = 'x-licence-override';
