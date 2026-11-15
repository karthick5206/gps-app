/**
 * Customer pricing & billing API contract (doc 19 §4): every request / response of /api/pricing. The web Pricing area
 * builds against these types.
 *
 * Wire conventions:
 * - money: `…Minor` fields are INTEGER STRINGS of minor units of `currency` ("123450" = ₹1,234.50); format with
 *   formatMinor(minor, currency) / Intl.NumberFormat, never a hard-coded symbol;
 * - money typed by people (`amount`, `rate`): decimal strings in MAJOR units ("1234.50", "12.375");
 * - dates 'YYYY-MM-DD'; timestamps ISO strings; distances metres; durations seconds;
 * - writes on versioned rows send `expectedVersion` (409 VERSION_CONFLICT otherwise); generate / close send an
 *   `Idempotency-Key` header.
 */
import type { PermissionMap, DataScope } from '../permissions';
import type { AuditLogDto } from '../api';
import type {
  AvailabilityFrequency,
  CoverageKind,
  DistanceSource,
  GpsQuality,
  MissingGpsPolicy,
  PeriodFacts,
  PricingComponentKind,
  PricingComponentParams,
  PricingComponentScope,
  PricingIssue,
  PricingPolicies,
  PriceStatus,
  RidePreference,
  RoundingMode,
  TaxRegime,
  TripFacts,
} from './types';

export const PRICING_CONTRACT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'] as const;
export type PricingContractStatus = (typeof PRICING_CONTRACT_STATUSES)[number];
export const PRICING_VERSION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'REJECTED'] as const;
export type PricingVersionStatus = (typeof PRICING_VERSION_STATUSES)[number];
export const BILLING_FREQUENCIES = ['TRIP', 'DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type BillingFrequency = (typeof BILLING_FREQUENCIES)[number];
export const TRIP_PRICE_STATUSES = ['ESTIMATE', 'PRICED', 'NEEDS_REVIEW', 'COVERED', 'NO_APPLICABLE_PRICING', 'ERROR', 'VOID'] as const;
export type TripPriceStatus = (typeof TRIP_PRICE_STATUSES)[number];
export const AVAILABILITY_PERIOD_STATUSES = ['OPEN', 'CLOSED', 'NEEDS_REVIEW', 'INVOICED', 'VOID'] as const;
export type AvailabilityPeriodStatus = (typeof AVAILABILITY_PERIOD_STATUSES)[number];
export const DOWNTIME_KINDS = ['BREAKDOWN', 'MAINTENANCE', 'SUSPENSION', 'HOLIDAY', 'NON_OPERATING'] as const;
export type DowntimeKind = (typeof DOWNTIME_KINDS)[number];
export const REPLACEMENT_BILLING = ['ORIGINAL', 'SEPARATE'] as const;
export type ReplacementBilling = (typeof REPLACEMENT_BILLING)[number];
export const BILLING_RUN_KINDS = ['TRIP_PRICING', 'AVAILABILITY_CLOSE', 'INVOICE'] as const;
export type BillingRunKind = (typeof BILLING_RUN_KINDS)[number];
export const BILLING_RUN_STATUSES = ['CLAIMED', 'RUNNING', 'DONE', 'FAILED'] as const;
export type BillingRunStatus = (typeof BILLING_RUN_STATUSES)[number];
export const INVOICE_STATUSES = ['DRAFT', 'ISSUED'] as const;
export type CustomerInvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_LINE_SOURCES = ['TRIP_SNAPSHOT', 'AVAILABILITY_PERIOD', 'ADJUSTMENT', 'MANUAL'] as const;
export type InvoiceLineSource = (typeof INVOICE_LINE_SOURCES)[number];
export const PAYMENT_STATUSES = ['UNPAID', 'PART', 'PAID', 'OVERPAID'] as const;
export type InvoicePaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const BILLING_ADJUSTMENT_KINDS = ['CREDIT', 'DEBIT', 'DISTANCE_CORRECTION', 'PRICE_OVERRIDE', 'WAIVER'] as const;
export type BillingAdjustmentKind = (typeof BILLING_ADJUSTMENT_KINDS)[number];
/** Kinds a user can request on POST /adjustments (PRICE_OVERRIDE comes from a trip override that needs approval). */
export const REQUESTABLE_ADJUSTMENT_KINDS = ['CREDIT', 'DEBIT', 'WAIVER'] as const;
export const ADJUSTMENT_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED'] as const;
export type BillingAdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'OTHER'] as const;
export type BillingPaymentMethod = (typeof PAYMENT_METHODS)[number];
export const COST_CATEGORIES = ['DRIVER', 'FUEL', 'ENERGY', 'MAINTENANCE', 'TOLL', 'PARKING', 'VEHICLE', 'OTHER'] as const;
export type OperatingCostCategory = (typeof COST_CATEGORIES)[number];
export const COST_SOURCES = ['VENDOR_STATEMENT', 'EXPENSE', 'MANUAL', 'IMPORT'] as const;
export type OperatingCostSource = (typeof COST_SOURCES)[number];
export const PRICING_REPORT_TYPES = ['revenue', 'trips', 'availability', 'ageing', 'margin'] as const;
export type PricingReportType = (typeof PRICING_REPORT_TYPES)[number];
export const PRICING_REPORT_GROUPS = ['contract', 'customer', 'branch', 'vehicle', 'day', 'month'] as const;
export type PricingReportGroup = (typeof PRICING_REPORT_GROUPS)[number];

/** Coded errors of /api/pricing (body `{ code, message }`). */
export type PricingErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'CONTRACT_OVERLAP'
  | 'CONTRACT_NOT_ACTIVE'
  | 'CONTRACT_NOT_DRAFT'
  | 'CONTRACT_VERSION_IMMUTABLE'
  | 'INVALID_COMPONENTS'
  | 'NO_APPLICABLE_PRICING'
  | 'VEHICLE_OVERRIDE_NOT_PERMITTED'
  | 'TRIP_OVERRIDE_NOT_PERMITTED'
  | 'MAKER_CHECKER_SAME_USER'
  | 'ALREADY_INVOICED'
  | 'INVOICE_ISSUED_IMMUTABLE'
  | 'INVOICE_NOT_DRAFT'
  | 'NOTHING_TO_INVOICE'
  | 'CREDIT_EXCEEDS_INVOICE'
  | 'BILLING_RUN_IN_PROGRESS'
  | 'BILLING_RUN_DONE'
  | 'CURRENCY_MISMATCH'
  | 'TAX_PROFILE_MISSING'
  | 'SUPPLIER_PROFILE_MISSING'
  | 'GPS_DISTANCE_REVIEW'
  | 'BRANCH_SCOPE'
  | 'CONSOLIDATED_NEEDS_COMPANY_SCOPE'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'FORBIDDEN_GRANT'
  | 'COST_HIDDEN'
  | 'PERIOD_NOT_ENDED'
  | 'INVOICE_DATE_INVALID'
  | 'TAX_SPLIT_CHANGED'
  | 'SNAPSHOT_SUPERSEDED';

export interface PricingPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ───────────── Engine results on the wire ─────────────

export interface PriceLineDto {
  component: string;
  label: string;
  quantity: string;
  unit: string;
  rateMicro?: string;
  amountMinor: string;
  discountMinor: string;
  taxCode: string | null;
  taxMinor: string;
  basis: string;
}

export interface TaxLineDto {
  taxCode: string;
  label: string;
  ratePpm: number;
  taxableMinor: string;
  taxMinor: string;
  cgstMinor?: string;
  sgstMinor?: string;
  utgstMinor?: string;
  igstMinor?: string;
}

export interface PriceResultDto {
  status: PriceStatus;
  currency: string;
  lines: PriceLineDto[];
  subtotalMinor: string;
  discountMinor: string;
  taxLines: TaxLineDto[];
  taxMinor: string;
  totalMinor: string;
  issues: PricingIssue[];
  engineVersion: string;
}

// ───────────── Contracts ─────────────

export interface PricingComponentDto {
  id?: string;
  kind: PricingComponentKind;
  label?: string | null;
  scope?: PricingComponentScope | null;
  params: PricingComponentParams;
  covers?: CoverageKind[];
  taxCode?: string | null;
  sortOrder?: number;
}

export interface PricingContractVersionDto {
  id: string;
  contractId: string;
  versionNo: number;
  validFrom: string;
  validTo: string | null;
  status: PricingVersionStatus;
  policies: PricingPolicies;
  components: PricingComponentDto[];
  submittedById: string | null;
  submittedAt: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  supersedesId: string | null;
  createdAt: string;
}

export interface PricingContractSummaryDto {
  id: string;
  name: string;
  reference: string | null;
  customerCompanyId: string | null;
  customerName: string;
  agreementId: string | null;
  currency: string;
  billingFrequency: BillingFrequency;
  status: PricingContractStatus;
  isDefault: boolean;
  branchIds: string[];
  /** The version pricing today (ACTIVE and covering today), if any. */
  currentVersion: { id: string; versionNo: number; validFrom: string; validTo: string | null } | null;
  /** A version waiting for approval, if any. */
  pendingVersionId: string | null;
  version: number;
  updatedAt: string;
}

export interface PricingContractDto extends PricingContractSummaryDto {
  paymentTermsDays: number;
  taxProfileId: string | null;
  defaultCovers: ('INTERNAL' | 'EXTERNAL')[];
  allowVehicleOverrides: boolean;
  allowTripOverrides: boolean;
  distanceSource: DistanceSource;
  onMissingGps: MissingGpsPolicy;
  roundingMode: RoundingMode;
  approvedById: string | null;
  approvedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdById: string | null;
  createdAt: string;
  versions: PricingContractVersionDto[];
}

export interface PricingContractListQuery {
  status?: PricingContractStatus;
  customerCompanyId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface CreatePricingContractRequest {
  name: string;
  reference?: string | null;
  /** Null / absent = internal (corporate-managed) charge-back; then customerName names the internal client / branch. */
  customerCompanyId?: string | null;
  customerName?: string | null;
  agreementId?: string | null;
  currency: string;
  billingFrequency: BillingFrequency;
  paymentTermsDays?: number;
  taxProfileId?: string | null;
  branchIds?: string[];
  isDefault?: boolean;
  defaultCovers?: ('INTERNAL' | 'EXTERNAL')[];
  allowVehicleOverrides?: boolean;
  allowTripOverrides?: boolean;
  distanceSource?: DistanceSource;
  onMissingGps?: MissingGpsPolicy;
  roundingMode?: RoundingMode;
  /** Version 1. */
  validFrom: string;
  validTo?: string | null;
  policies?: PricingPolicies;
  components?: PricingComponentDto[];
}

/** Header fields; allowed while the contract is DRAFT (taxProfileId, paymentTermsDays and branchIds also later). */
export interface UpdatePricingContractRequest {
  expectedVersion: number;
  name?: string;
  reference?: string | null;
  customerName?: string | null;
  agreementId?: string | null;
  currency?: string;
  billingFrequency?: BillingFrequency;
  paymentTermsDays?: number;
  taxProfileId?: string | null;
  branchIds?: string[];
  isDefault?: boolean;
  defaultCovers?: ('INTERNAL' | 'EXTERNAL')[];
  allowVehicleOverrides?: boolean;
  allowTripOverrides?: boolean;
  distanceSource?: DistanceSource;
  onMissingGps?: MissingGpsPolicy;
  roundingMode?: RoundingMode;
}

/** New DRAFT version, by default a copy of the latest version's components and policies. */
export interface CreatePricingVersionRequest {
  validFrom: string;
  validTo?: string | null;
  copyFromVersionId?: string | null;
  policies?: PricingPolicies;
  components?: PricingComponentDto[];
}

/** PUT …/versions/:versionId/components — DRAFT versions only. */
export interface ReplacePricingComponentsRequest {
  components: PricingComponentDto[];
  policies?: PricingPolicies;
  validFrom?: string;
  validTo?: string | null;
}

export interface PricingDecisionRequest {
  note?: string | null;
}
export interface PricingRejectRequest {
  reason: string;
}
export interface PricingLifecycleRequest {
  reason: string;
  expectedVersion: number;
}

/** POST /contracts/:id/preview — sample calculation, nothing stored. */
export interface PricingPreviewRequest {
  /** Default: the DRAFT / PENDING version if any, else the current ACTIVE one. */
  versionId?: string | null;
  /** Unsaved components to try out (instead of a stored version's). */
  components?: PricingComponentDto[];
  policies?: PricingPolicies;
  kind: 'TRIP' | 'PERIOD';
  trip?: PreviewTripFacts;
  period?: PeriodFacts;
  /** Price with this vehicle's ACTIVE vehicle rate (when the contract permits overrides). */
  objectId?: string | null;
  /** Override buyer state for the GST split preview (default: the customer's billing profile). */
  buyerStateCode?: string | null;
}
export type PreviewTripFacts = Omit<TripFacts, 'tollsMinor'> & { tollsMinor?: string | null };
export type PricingPreviewResponse = PriceResultDto;

// ───────────── Vehicle rates (precedence 2) and dedicated vehicles ─────────────

export interface PricingVehicleRateDto {
  id: string;
  contractId: string;
  objectId: string;
  objectName: string;
  validFrom: string;
  validTo: string | null;
  componentOverrides: PricingComponentDto[];
  category: string | null;
  seats: number | null;
  status: PricingVersionStatus;
  reason: string | null;
  submittedById: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  version: number;
  createdAt: string;
}
export interface CreatePricingVehicleRateRequest {
  objectId: string;
  validFrom: string;
  validTo?: string | null;
  componentOverrides: PricingComponentDto[];
  reason?: string | null;
}
export interface UpdatePricingVehicleRateRequest {
  expectedVersion: number;
  validFrom?: string;
  validTo?: string | null;
  componentOverrides?: PricingComponentDto[];
  reason?: string | null;
}

export interface PricingDowntimeDto {
  id: string;
  assignmentId: string;
  fromDate: string;
  toDate: string;
  kind: DowntimeKind;
  billable: boolean;
  reason: string;
  createdAt: string;
}
export interface CreatePricingDowntimeRequest {
  fromDate: string;
  toDate: string;
  kind: DowntimeKind;
  billable?: boolean;
  reason: string;
}

export interface PricingOperatingHours {
  from?: string;
  to?: string;
  /** ISO weekdays 1 = Monday … 7 = Sunday; empty / absent = every day. */
  weekdays?: number[];
}

export interface PricingVehicleAssignmentDto {
  id: string;
  contractId: string;
  objectId: string;
  objectName: string;
  driverId: string | null;
  fleetAllocationId: string | null;
  branchId: string | null;
  validFrom: string;
  validTo: string | null;
  operatingHours: PricingOperatingHours;
  replacesAssignmentId: string | null;
  replacementBilling: ReplacementBilling;
  status: 'ACTIVE' | 'ENDED';
  version: number;
  downtimes: PricingDowntimeDto[];
}
export interface CreatePricingVehicleAssignmentRequest {
  objectId: string;
  driverId?: string | null;
  fleetAllocationId?: string | null;
  branchId?: string | null;
  validFrom: string;
  validTo?: string | null;
  operatingHours?: PricingOperatingHours;
  replacesAssignmentId?: string | null;
  replacementBilling?: ReplacementBilling;
}
export interface UpdatePricingVehicleAssignmentRequest {
  expectedVersion: number;
  validTo?: string | null;
  operatingHours?: PricingOperatingHours;
  status?: 'ACTIVE' | 'ENDED';
}

// ───────────── Trip charges ─────────────

export interface TripPriceSnapshotDto {
  id: string;
  transportTripId: string;
  bookingId: string | null;
  passengerId: string | null;
  contractId: string | null;
  contractName: string | null;
  contractVersionId: string | null;
  vehicleRateId: string | null;
  customerCompanyId: string | null;
  branchId: string | null;
  objectId: string | null;
  serviceDate: string;
  currency: string;
  pricingModel: string | null;
  ridePreference: RidePreference | null;
  distances: { plannedM: number | null; gpsM: number | null; agreedM: number | null; manualM: number | null; billableM: number | null };
  distanceSource: DistanceSource | null;
  gpsQuality: GpsQuality;
  plannedDurationS: number | null;
  actualDurationS: number | null;
  waitingS: number | null;
  extraStops: number;
  lines: PriceLineDto[];
  subtotalMinor: string;
  discountMinor: string;
  taxLines: TaxLineDto[];
  taxMinor: string;
  totalMinor: string;
  issues: PricingIssue[];
  status: TripPriceStatus;
  isCurrent: boolean;
  supersedesId: string | null;
  reason: string | null;
  override: { byId: string | null; at: string | null; reason: string | null; approvedById: string | null } | null;
  calculatedById: string | null;
  calculatedAt: string;
  engineVersion: string;
  /** Set when an invoice line references this trip (then recalculation is refused: use an adjustment). */
  invoiceId: string | null;
}

export interface TripChargeListQuery {
  from?: string;
  to?: string;
  status?: TripPriceStatus;
  branchId?: string;
  customerCompanyId?: string;
  contractId?: string;
  page?: number;
  pageSize?: number;
  format?: 'json' | 'csv';
}
export interface TripChargeListResponse extends PricingPage<TripPriceSnapshotDto> {
  /** Sum of totalMinor per currency over the whole filter (current snapshots). */
  totals: { currency: string; totalMinor: string; count: number }[];
}
export interface TripChargeDetailResponse {
  current: TripPriceSnapshotDto | null;
  history: TripPriceSnapshotDto[];
  audit: AuditLogDto[];
}
export interface RecalculateTripRequest {
  reason?: string | null;
}
export interface BillableDistanceRequest {
  /** Decimal km ("25.4"). */
  distanceKm: string;
  reason: string;
}
/** POST …/billable-distance: a new snapshot, or a DISTANCE_CORRECTION adjustment waiting for a second user (policy tripOverrideNeedsApproval). Allowed only when the contract permits trip overrides or prices on MANUAL_APPROVED distances. */
export type BillableDistanceResponse = TripOverrideResponse;
export interface TripOverrideRequest {
  /** Negotiated trip price before tax, decimal MAJOR units of the contract currency. */
  amount: string;
  reason: string;
}
export interface TripOverrideResponse {
  /** New snapshot (immediate override) … */
  snapshot: TripPriceSnapshotDto | null;
  /** … or the PRICE_OVERRIDE adjustment waiting for a second user's approval (policy tripOverrideNeedsApproval). */
  adjustment: BillingAdjustmentDto | null;
}

// ───────────── Availability ─────────────

export interface AvailabilityPeriodDto {
  id: string;
  contractId: string;
  versionId: string;
  assignmentId: string;
  objectId: string;
  objectName: string | null;
  branchId: string | null;
  periodStart: string;
  periodEnd: string;
  frequency: AvailabilityFrequency;
  currency: string;
  attachedDays: number;
  billableDays: number;
  downtimeDays: number;
  suspensionDays: number;
  usedDistanceM: number;
  usedSeconds: number;
  tripCount: number;
  lines: PriceLineDto[];
  subtotalMinor: string;
  discountMinor: string;
  taxLines: TaxLineDto[];
  taxMinor: string;
  totalMinor: string;
  issues: PricingIssue[];
  status: AvailabilityPeriodStatus;
  calculatedAt: string;
  closedAt: string | null;
}
export interface AvailabilityListQuery {
  contractId?: string;
  from?: string;
  to?: string;
  status?: AvailabilityPeriodStatus;
  page?: number;
  pageSize?: number;
}
/** POST /availability/compute (recompute OPEN periods) and /availability/close (+ Idempotency-Key). */
export interface AvailabilityPeriodRequest {
  contractId: string;
  /** Any date inside the period (the contract version's fee frequency decides the bounds). */
  periodDate: string;
}
export interface AvailabilityCloseResponse {
  run: BillingRunDto;
  periods: AvailabilityPeriodDto[];
}

export interface BillingRunDto {
  id: string;
  contractId: string;
  kind: BillingRunKind;
  periodStart: string;
  periodEnd: string;
  status: BillingRunStatus;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
}

// ───────────── Invoices, credit notes, payments ─────────────

export interface InvoicePartySnapshot {
  name: string;
  address?: string | null;
  city?: string | null;
  stateCode?: string | null;
  country?: string | null;
  taxRegistration?: string | null;
  email?: string | null;
}

export interface CustomerInvoiceLineDto {
  id: string;
  sourceType: InvoiceLineSource;
  sourceId: string | null;
  description: string;
  quantity: string;
  unit: string;
  rate: string | null;
  amountMinor: string;
  discountMinor: string;
  taxCode: string | null;
  taxMinor: string;
  totalMinor: string;
  branchId: string | null;
  serviceDate: string | null;
}

export interface CustomerInvoiceSummaryDto {
  id: string;
  number: string | null;
  fy: string | null;
  status: CustomerInvoiceStatus;
  contractId: string | null;
  contractName: string | null;
  customerCompanyId: string | null;
  customerName: string | null;
  branchId: string | null;
  consolidated: boolean;
  periodStart: string;
  periodEnd: string;
  currency: string;
  subtotalMinor: string;
  discountMinor: string;
  taxMinor: string;
  totalMinor: string;
  /** Derived from the payment ledger and credit notes (never stored as the truth). */
  paidMinor: string;
  creditedMinor: string;
  balanceMinor: string;
  paymentStatus: InvoicePaymentStatus;
  issuedAt: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  createdAt: string;
}

export interface CustomerCreditNoteDto {
  id: string;
  invoiceId: string;
  number: string;
  fy: string;
  currency: string;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  taxLines: TaxLineDto[];
  reason: string;
  issuedAt: string;
  issuedById: string;
}

export interface BillingPaymentDto {
  id: string;
  invoiceId: string;
  amountMinor: string;
  currency: string;
  receivedAt: string;
  method: BillingPaymentMethod;
  reference: string | null;
  note: string | null;
  recordedById: string;
  reversalOf: string | null;
  /** Set on a payment that has been reversed (the reversal row's id). */
  reversedBy: string | null;
  createdAt: string;
}

export interface CustomerInvoiceDto extends CustomerInvoiceSummaryDto {
  supplier: InvoicePartySnapshot;
  buyer: InvoicePartySnapshot;
  taxKind: string | null;
  taxLines: TaxLineDto[];
  lines: CustomerInvoiceLineDto[];
  creditNotes: CustomerCreditNoteDto[];
  payments: BillingPaymentDto[];
}

export interface CustomerInvoiceListQuery {
  status?: CustomerInvoiceStatus;
  contractId?: string;
  customerCompanyId?: string;
  branchId?: string;
  from?: string;
  to?: string;
  paymentStatus?: InvoicePaymentStatus;
  page?: number;
  pageSize?: number;
}

/** POST /invoices/generate (+ Idempotency-Key): one DRAFT invoice from un-invoiced snapshots, periods and adjustments. */
export interface GenerateInvoiceRequest {
  contractId: string;
  periodStart: string;
  periodEnd: string;
  /** A branch invoice; absent / null = consolidated (needs COMPANY data scope). */
  branchId?: string | null;
}
export interface GenerateInvoiceResponse {
  invoice: CustomerInvoiceDto;
  run: BillingRunDto;
  /** Snapshots left out because they still need review / have no applicable pricing. */
  skipped: { needsReview: number; noPricing: number; errors: number };
  /** True when the same Idempotency-Key + body was replayed. */
  replayed: boolean;
}
export interface IssueInvoiceRequest {
  /** Default today (company time zone). */
  invoiceDate?: string | null;
}

/**
 * POST /invoices/:id/credit-notes (pricing_adjustments:create) returns a pending CREDIT adjustment (invoiceId set); a
 * different user approves it (POST /adjustments/:id/approve, pricing_adjustments:approve), which issues the credit note
 * (its id / number are then in the adjustment data: creditNoteId, creditNoteNumber).
 * Full credit (default) or a partial amount including tax (split pro rata; the last credit takes the remaining tax).
 */
export interface CreateCreditNoteRequest {
  reason: string;
  /** Decimal MAJOR units including tax; absent = everything still creditable. */
  amount?: string | null;
}

export type CreditNoteRequestResponse = BillingAdjustmentDto;

export interface RecordPaymentRequest {
  amount: string;
  receivedAt: string;
  method: BillingPaymentMethod;
  reference?: string | null;
  note?: string | null;
}
export interface ReversePaymentRequest {
  reason: string;
}

// ───────────── Adjustments ─────────────

export interface BillingAdjustmentDto {
  id: string;
  contractId: string;
  invoiceId: string | null;
  transportTripId: string | null;
  kind: BillingAdjustmentKind;
  /** Signed minor units: credits / waivers negative, debits positive. */
  amountMinor: string;
  currency: string;
  data: Record<string, unknown>;
  reason: string;
  status: BillingAdjustmentStatus;
  requestedById: string;
  requestedAt: string;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedAt: string | null;
  version: number;
}
export interface BillingAdjustmentListQuery {
  status?: BillingAdjustmentStatus;
  contractId?: string;
  page?: number;
  pageSize?: number;
}
export interface CreateBillingAdjustmentRequest {
  contractId: string;
  kind: (typeof REQUESTABLE_ADJUSTMENT_KINDS)[number];
  /** Positive decimal MAJOR units; the sign comes from the kind. */
  amount: string;
  reason: string;
  transportTripId?: string | null;
}

// ───────────── Reports, costs, dashboard ─────────────

export interface PricingReportQuery {
  from: string;
  to: string;
  groupBy?: PricingReportGroup;
  contractId?: string;
  branchId?: string;
  format?: 'json' | 'csv';
}
export interface PricingReportColumn {
  key: string;
  label: string;
  /** 'money' columns hold minor-unit strings in the row's `currency`. */
  kind: 'text' | 'number' | 'money';
}
export interface PricingReportDto {
  type: PricingReportType;
  from: string;
  to: string;
  groupBy: PricingReportGroup | null;
  columns: PricingReportColumn[];
  rows: Record<string, string | number | null>[];
  /** False when cost / margin columns were removed (caller lacks pricing_costs:view). */
  costVisible: boolean;
}

export interface OperatingCostDto {
  id: string;
  objectId: string | null;
  driverId: string | null;
  transportTripId: string | null;
  branchId: string | null;
  date: string;
  category: OperatingCostCategory;
  amountMinor: string;
  currency: string;
  source: OperatingCostSource;
  sourceRef: string | null;
  note: string | null;
  createdAt: string;
}
export interface OperatingCostListQuery {
  from?: string;
  to?: string;
  objectId?: string;
  category?: OperatingCostCategory;
  page?: number;
  pageSize?: number;
}
export interface CreateOperatingCostRequest {
  date: string;
  category: OperatingCostCategory;
  amount: string;
  currency: string;
  objectId?: string | null;
  driverId?: string | null;
  transportTripId?: string | null;
  branchId?: string | null;
  source?: OperatingCostSource;
  sourceRef?: string | null;
  note?: string | null;
}

export interface PricingDashboardDto {
  month: string;
  revenue: { currency: string; totalMinor: string }[];
  tripsPriced: number;
  tripsNeedingReview: number;
  tripsWithoutPricing: number;
  openInvoices: number;
  overdueInvoices: number;
  outstanding: { currency: string; balanceMinor: string }[];
  contractsPendingApproval: number;
  contractsExpiringSoon: number;
  /** Only with pricing_costs:view (null otherwise). */
  margin: { currency: string; revenueMinor: string; costMinor: string; marginMinor: string }[] | null;
}

// ───────────── Settings ─────────────

export interface BillingSupplierProfileDto {
  companyId: string;
  legalName: string;
  address: string;
  city: string;
  stateCode: string | null;
  country: string;
  taxRegime: TaxRegime;
  taxRegistration: string | null;
  invoicePrefix: string;
  creditNotePrefix: string;
  fiscalYearStartMonth: number;
  email: string | null;
  phone: string | null;
  bankDetails: Record<string, string>;
  version: number;
}
export interface UpsertBillingSupplierProfileRequest {
  /** Absent on the first save. */
  expectedVersion?: number;
  legalName: string;
  address: string;
  city?: string;
  stateCode?: string | null;
  country?: string;
  taxRegime: TaxRegime;
  taxRegistration?: string | null;
  invoicePrefix?: string;
  creditNotePrefix?: string;
  fiscalYearStartMonth?: number;
  email?: string | null;
  phone?: string | null;
  bankDetails?: Record<string, string>;
}

export interface PricingTaxRateDto {
  id: string;
  taxCode: string;
  label: string;
  ratePpm: number;
  /** "18" (decimal percent, for display / editing). */
  ratePercent: string;
  sac: string | null;
  validFrom: string;
  validTo: string | null;
}
export interface PricingTaxProfileDto {
  id: string;
  name: string;
  regime: TaxRegime;
  jurisdiction: string | null;
  defaultTaxCode: string | null;
  rates: PricingTaxRateDto[];
}
export interface CreatePricingTaxRateRequest {
  taxCode: string;
  label: string;
  /** Decimal percent ("18", "7.25"). */
  ratePercent: string;
  sac?: string | null;
  validFrom: string;
  validTo?: string | null;
}
export interface CreatePricingTaxProfileRequest {
  name: string;
  regime: TaxRegime;
  jurisdiction?: string | null;
  defaultTaxCode?: string | null;
  rates?: CreatePricingTaxRateRequest[];
}

export interface PricingCalendarDto {
  id: string;
  name: string;
  holidays: string[];
  nonOperatingWeekdays: number[];
}
export interface UpsertPricingCalendarRequest {
  name: string;
  holidays: string[];
  nonOperatingWeekdays?: number[];
}

// ───────────── Role templates (seeded when the `pricing` add-on is switched on) ─────────────

export const PRICING_ROLE_TEMPLATES: { name: string; description: string; dataScope: DataScope; permissions: PermissionMap }[] = [
  {
    name: 'Billing admin',
    description: 'Customer pricing & billing: contracts, approvals, invoices, costs and margin (whole company)',
    dataScope: 'COMPANY',
    permissions: {
      pricing: ['view'],
      pricing_contracts: ['view', 'create', 'edit', 'delete', 'export', 'approve'],
      pricing_vehicle_rates: ['view', 'create', 'edit', 'approve'],
      pricing_trip_charges: ['view', 'edit', 'command', 'export'],
      pricing_availability: ['view', 'command', 'export'],
      pricing_invoices: ['view', 'create', 'edit', 'delete', 'command', 'export'],
      pricing_adjustments: ['view', 'create', 'approve'],
      pricing_reports: ['view', 'export'],
      pricing_costs: ['view', 'create'],
    },
  },
  {
    name: 'Billing clerk',
    description: 'Prepares contracts, trip charges and invoices of assigned branches; no approvals, no cost or margin',
    dataScope: 'ASSIGNED',
    permissions: {
      pricing: ['view'],
      pricing_contracts: ['view', 'create', 'edit'],
      pricing_vehicle_rates: ['view', 'create', 'edit'],
      pricing_trip_charges: ['view', 'edit', 'export'],
      pricing_availability: ['view'],
      pricing_invoices: ['view', 'create', 'export'],
      pricing_adjustments: ['view', 'create'],
      pricing_reports: ['view'],
    },
  },
];
