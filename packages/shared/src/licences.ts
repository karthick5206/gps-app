/**
 * Licences & billing: licence (seat) types, Indian GST maths, invoice numbering and seat expiry rules.
 * Pure functions, shared by the api (invoices, locking) and the web / mobile apps (price previews, banners).
 */

/** Licences held by one device / fuel sensor. Users are free: an account may have any number of users. */
export const SEAT_LICENCE_TYPES = ['GPS_DEVICE', 'DASHCAM', 'FUEL_SENSOR', 'MOBILE_TRACKER'] as const;
export type SeatLicenceType = (typeof SEAT_LICENCE_TYPES)[number];

/** Every licence type sold: the per-subject seats plus the account-level Developer API licence (one per company). */
export const LICENCE_TYPES = [...SEAT_LICENCE_TYPES, 'API_ACCESS'] as const;
/** Retired types: user logins needed a licence until 2026-10-29; old seats and invoices still carry the type. */
export const RETIRED_LICENCE_TYPES = ['USER'] as const;
export type LicenceType = (typeof LICENCE_TYPES)[number] | (typeof RETIRED_LICENCE_TYPES)[number];

export const LICENCE_TYPE_LABELS: Record<LicenceType, string> = {
  USER: 'User login',
  GPS_DEVICE: 'GPS device',
  DASHCAM: 'Dashcam',
  FUEL_SENSOR: 'Fuel sensor',
  MOBILE_TRACKER: 'Mobile tracker',
  API_ACCESS: 'Developer API',
};

export const isSeatLicenceType = (t: LicenceType): t is SeatLicenceType => (SEAT_LICENCE_TYPES as readonly string[]).includes(t);

/** Device-model capabilities that make a device a dashcam (JT/T 808 video profiles). */
export const DASHCAM_CAPABILITIES = ['video', 'adas', 'dms'] as const;

/** Device-model capability of a phone running the VeeTrax Tracker app (protocol `mobile`). */
export const MOBILE_TRACKER_CAPABILITY = 'mobile';

export function deviceLicenceType(capabilities: readonly string[]): SeatLicenceType {
  if (capabilities.includes(MOBILE_TRACKER_CAPABILITY)) return 'MOBILE_TRACKER';
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

/** How a credit note's amount was refunded (Razorpay refunds are not automated yet: recorded manually). */
export const REFUND_MODES = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'RAZORPAY_REFUND_MANUAL', 'NONE'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

export const REFUND_MODE_LABELS: Record<RefundMode, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  RAZORPAY_REFUND_MANUAL: 'Razorpay refund (manual)',
  NONE: 'No refund (credit only)',
};

// ───────────── Developer API plans (API_ACCESS licence) ─────────────

export const API_PLANS = ['BASIC', 'STANDARD', 'ENTERPRISE'] as const;
export type ApiPlan = (typeof API_PLANS)[number];

export const API_PLAN_LABELS: Record<ApiPlan, string> = { BASIC: 'Basic', STANDARD: 'Standard', ENTERPRISE: 'Enterprise' };

export interface ApiPlanLimits {
  /** GST-inclusive price per account per year (paise). */
  pricePaise: number;
  /** Vehicles reachable through the API (first N by name); null = unlimited. */
  maxVehicles: number | null;
  /** Requests per minute per API key (a key's own setting can only be lower). */
  ratePerMinute: number;
  /** Requests per day for the whole company (all keys together; UTC day). */
  ratePerDay: number;
  /** Webhook endpoints the company may create. */
  maxWebhooks: number;
}

export type ApiPlans = Record<ApiPlan, ApiPlanLimits>;

/** Owner's default pricing; every value can be changed by the Super Admin (Platform Settings → Licence pricing). */
export const DEFAULT_API_PLANS: ApiPlans = {
  BASIC: { pricePaise: 600_000, maxVehicles: 25, ratePerMinute: 60, ratePerDay: 10_000, maxWebhooks: 1 },
  STANDARD: { pricePaise: 1_500_000, maxVehicles: 100, ratePerMinute: 120, ratePerDay: 50_000, maxWebhooks: 5 },
  ENTERPRISE: { pricePaise: 4_000_000, maxVehicles: null, ratePerMinute: 300, ratePerDay: 250_000, maxWebhooks: 20 },
};

const intIn = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** Plans from stored JSON: each field sanitised, anything missing taken from the defaults. */
export function readApiPlans(json: unknown): ApiPlans {
  const src = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const out = {} as ApiPlans;
  for (const plan of API_PLANS) {
    const d = DEFAULT_API_PLANS[plan];
    const p = (src[plan] && typeof src[plan] === 'object' ? src[plan] : {}) as Record<string, unknown>;
    out[plan] = {
      pricePaise: intIn(p.pricePaise, 0, 1_000_000_000, d.pricePaise),
      maxVehicles: p.maxVehicles === null ? null : 'maxVehicles' in p ? intIn(p.maxVehicles, 1, 1_000_000, d.maxVehicles ?? 1) : d.maxVehicles,
      ratePerMinute: intIn(p.ratePerMinute, 1, 6000, d.ratePerMinute),
      ratePerDay: intIn(p.ratePerDay, 1, 100_000_000, d.ratePerDay),
      maxWebhooks: intIn(p.maxWebhooks, 0, 1000, d.maxWebhooks),
    };
  }
  return out;
}

export const isApiPlan = (v: unknown): v is ApiPlan => typeof v === 'string' && (API_PLANS as readonly string[]).includes(v);

/** A key's effective limits: never above the plan (minimum of the key's own setting and the plan's). */
export function cappedKeyRates(key: { ratePerMinute: number; ratePerDay: number }, plan: Pick<ApiPlanLimits, 'ratePerMinute' | 'ratePerDay'> | null): { perMinute: number; perDay: number } {
  if (!plan) return { perMinute: key.ratePerMinute, perDay: key.ratePerDay };
  return { perMinute: Math.min(key.ratePerMinute, plan.ratePerMinute), perDay: Math.min(key.ratePerDay, plan.ratePerDay) };
}

/** Partner price-override key of an API plan in the partner's pricesPaise JSON. */
export const apiPlanPriceKey = (plan: ApiPlan) => `API_ACCESS:${plan}`;

/** Where a seat came from. */
export type SeatSource = 'PURCHASE' | 'MIGRATION' | 'OVERRIDE' | 'ALLOCATION' | 'TRIAL';

/**
 * Free trial for personal / family accounts (self-registered), so they can try VeeTrax before buying: a device added
 * without a free bought seat gets a TRIAL seat instead of being refused. Phones: TRIAL_DAYS for the first TRIAL_PHONES;
 * GPS trackers and dashcams: TRIAL_DEVICE_DAYS for the first TRIAL_DEVICES. Trial seats lock at expiry (no grace
 * period); then a licence must be bought. Business accounts are set up by the platform and don't get trials.
 */
export const TRIAL_DAYS = 100;
export const TRIAL_PHONES = 5;
export const TRIAL_DEVICE_DAYS = 30;
export const TRIAL_DEVICES = 5;

/** Trial terms for a seat type: days, how many per account, and which seat types share that count. */
export function trialPlan(type: SeatLicenceType): { days: number; max: number; countTypes: SeatLicenceType[] } | null {
  if (type === 'MOBILE_TRACKER') return { days: TRIAL_DAYS, max: TRIAL_PHONES, countTypes: ['MOBILE_TRACKER'] };
  if (type === 'GPS_DEVICE' || type === 'DASHCAM') return { days: TRIAL_DEVICE_DAYS, max: TRIAL_DEVICES, countTypes: ['GPS_DEVICE', 'DASHCAM'] };
  return null;
}

/** Grace period after expiry for a seat: none for a free trial. */
export function seatGraceDays(source: string, graceDays: number): number {
  return source === 'TRIAL' ? 0 : graceDays;
}

/** Seat status for display: ACTIVE, EXPIRING (within 30 days), GRACE (expired, still usable), EXPIRED (locked). */
export type SeatStatus = 'ACTIVE' | 'EXPIRING' | 'GRACE' | 'EXPIRED';

export const DEFAULT_GRACE_DAYS = 15;
export const DEFAULT_GST_RATE = 18;
export const DEFAULT_SAC_CODE = '998314';
/** Seats expiring within this many days count as "expiring" (banners, lists, status). */
export const LICENCE_EXPIRING_DAYS = 20;
/** Reminder thresholds (days before expiry); 0 = on the day it expires. */
export const LICENCE_REMINDER_DAYS = [20, 15, 10, 7, 5, 3, 2, 1, 0] as const;
/** Reminders during the grace period (days after expiry); the last one is sent on the day viewing locks (= grace days). */
export const LICENCE_GRACE_REMINDER_DAYS = [3, 7, 10] as const;
/** Reminders are only sent in this local (IST) window, never at night. */
export const LICENCE_REMINDER_HOURS_IST = { from: 9, to: 19 } as const;

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

/** Yearly price per seat type (the Developer API is priced per plan: ApiPlans). */
export type LicencePrices = Record<SeatLicenceType, number>;

/** Platform licence settings (Super Admin). Prices are GST-inclusive, per seat per year, in paise. */
export interface LicencePricingDto {
  pricesPaise: LicencePrices;
  /** Developer API plans: price and limits, all editable. */
  apiPlans: ApiPlans;
  gstRatePct: number;
  graceDays: number;
  /** Validity of a seat granted by a Super Admin override (days). */
  overrideDays: number;
}

/** Unit price of a licence (API_ACCESS: the plan's price; BASIC when no plan is given). */
export function unitPricePaise(prices: LicencePrices, plans: ApiPlans, type: LicenceType, plan?: ApiPlan | null): number {
  if (type === 'API_ACCESS') return plans[plan ?? 'BASIC'].pricePaise;
  return isSeatLicenceType(type) ? prices[type] : 0;
}

/** "Developer API (Standard)" / "GPS device". */
export function licenceLabel(type: LicenceType, plan?: ApiPlan | null): string {
  return type === 'API_ACCESS' && plan ? `${LICENCE_TYPE_LABELS[type]} (${API_PLAN_LABELS[plan]})` : LICENCE_TYPE_LABELS[type];
}

export interface PartnerPricingDto {
  partnerId: string;
  partnerName: string;
  /** Per-type override; null = platform price. */
  pricesPaise: Record<SeatLicenceType, number | null>;
  /** Developer API plan price overrides; null = platform price. */
  apiPlanPricesPaise: Record<ApiPlan, number | null>;
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
  /** A UPI QR image is uploaded (shown on the Buy screen and in the welcome email). */
  hasUpiQr: boolean;
  sacCode: string;
  invoicePrefix: string;
  /** Credit note series prefix, e.g. "VTX/CN" → VTX/CN/2026-27/0001. */
  creditNotePrefix: string;
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

export type SeatSubjectKind = 'USER' | 'DEVICE' | 'FUEL' | 'COMPANY';

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
  /** API_ACCESS seats: the plan. */
  apiPlan: ApiPlan | null;
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
  /** Developer API plans with this buyer's prices. */
  apiPlans: ApiPlans;
  /** Company pools: the Developer API licence (null for partner pools). */
  apiAccess: ApiAccessStatusDto | null;
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
  /** API_ACCESS only (default BASIC). */
  plan?: ApiPlan;
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
  /** API_ACCESS lines: the plan bought / renewed. */
  plan?: ApiPlan | null;
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
  /** Sum of the credit notes issued against this invoice (GST-inclusive, paise). */
  creditedPaise: number;
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

// ───────────── Credit notes ─────────────

/** One invoice line to credit: by index; quantity of seats; amount defaults to unit price × quantity. */
export interface CreditNoteLineRequest {
  lineIndex: number;
  quantity: number;
  /** GST-inclusive amount to credit for this line (paise); at most what is left on the line. */
  amountPaise?: number;
}

export interface CreditNoteRequest {
  lines: CreditNoteLineRequest[];
  reason: string;
  refundMode: RefundMode;
  refundReference?: string;
  /** Leave the credited seats running (e.g. a price correction); otherwise they expire now. */
  keepSeatsActive: boolean;
}

/** An invoice line with what has already been credited against it. */
export interface CreditableLineDto {
  lineIndex: number;
  type: LicenceType;
  plan: ApiPlan | null;
  kind: 'NEW' | 'RENEWAL';
  quantity: number;
  unitPaise: number;
  amountPaise: number;
  periodFrom: string;
  periodTo: string;
  creditedQuantity: number;
  creditedPaise: number;
  remainingQuantity: number;
  remainingPaise: number;
}

export interface CreditNoteDto {
  id: string;
  number: string;
  issuedAt: string;
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  companyId: string | null;
  partnerId: string | null;
  gstin: string | null;
  stateCode: string;
  reason: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  utgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  refundMode: RefundMode;
  refundReference: string | null;
  keepSeatsActive: boolean;
  revokedSeats: number;
  emailedAt: string | null;
}

/** Invoice detail for crediting: its lines, what is left to credit, and the credit notes so far. */
export interface InvoiceCreditsDto {
  invoice: InvoiceDto;
  lines: CreditableLineDto[];
  creditedPaise: number;
  remainingPaise: number;
  creditNotes: CreditNoteDto[];
}

// ───────────── Developer API licence status ─────────────

export interface ApiAccessSeatDto {
  id: string;
  plan: ApiPlan;
  source: SeatSource;
  activatedAt: string;
  expiresAt: string;
  status: SeatStatus;
  locked: boolean;
}

/** The company's Developer API licence: plan, limits and today's usage (Developer API page, Billing & Licences). */
export interface ApiAccessStatusDto {
  /** Platform companies: no licence needed, no plan limits. */
  exempt: boolean;
  /** Current API seat (latest expiry), or null when none was ever bought. */
  seat: ApiAccessSeatDto | null;
  /** API keys work: exempt, or the seat is active / in its grace period. */
  allowed: boolean;
  /** Limits of the current plan (null: exempt or no seat). */
  limits: ApiPlanLimits | null;
  usage: { requestsToday: number; vehicles: number; webhooks: number };
  graceDays: number;
}

/** Customer API error codes for the Developer API licence (HTTP 402). */
export type ApiLicenceErrorCode = 'LICENCE_EXPIRED' | 'LICENCE_REQUIRED' | 'API_VEHICLE_LIMIT' | 'API_WEBHOOK_LIMIT';

// ───────────── UPI payments (QR on the Buy screen; the Super Admin confirms the UTR) ─────────────

/** `upi://pay` link: scanned as a QR, or opened directly on a phone (GPay / PhonePe / Paytm / BHIM). */
export function upiPayUri(vpa: string, payeeName: string, amountPaise?: number | null, note?: string | null): string {
  const q = [`pa=${encodeURIComponent(vpa)}`, `pn=${encodeURIComponent(payeeName)}`, 'cu=INR'];
  if (amountPaise && amountPaise > 0) q.push(`am=${(amountPaise / 100).toFixed(2)}`);
  if (note) q.push(`tn=${encodeURIComponent(note.slice(0, 50))}`);
  return `upi://pay?${q.join('&')}`;
}

/** GET /licences/upi */
export interface UpiPayInfoDto {
  enabled: boolean;
  vpa: string;
  payeeName: string;
  /** An uploaded QR image (e.g. the GPay QR) exists: GET /licences/upi/qr-image. */
  hasImage: boolean;
  /** With ?amountPaise: the payment link and its QR as SVG markup. */
  uri?: string;
  svg?: string;
}

export const UPI_CLAIM_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED'] as const;
export type UpiClaimStatus = (typeof UPI_CLAIM_STATUSES)[number];

export const CUSTOMER_PAY_METHODS = ['UPI', 'CASH'] as const;
export type CustomerPayMethod = (typeof CUSTOMER_PAY_METHODS)[number];

/** A customer's "I've paid" (UPI with the UTR, or cash); licences activate when the Super Admin confirms it. */
export interface UpiClaimDto {
  id: string;
  method: CustomerPayMethod;
  ownerKind: 'COMPANY' | 'PARTNER';
  ownerId: string;
  ownerName: string;
  amountPaise: number;
  /** UPI: the UTR. Cash: receipt no., if the customer has one. */
  utr: string | null;
  paidOn: string;
  summary: string;
  status: UpiClaimStatus;
  /** Customer's note, e.g. when / where to collect cash. */
  customerNote: string | null;
  createdAt: string;
  createdByName: string | null;
  decidedAt: string | null;
  note: string | null;
}
