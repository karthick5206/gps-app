/**
 * Customer pricing engine types (doc 19 §5). Pure data: no I/O. Money is always integer:
 * - amounts are `bigint` MINOR units of the contract currency (paise, cents, fils …);
 * - rates are `bigint` MICRO units of the MAJOR unit (₹12.375 = 12_375_000n), carried over the wire as decimal strings;
 * - distances are integer metres, durations integer seconds.
 * There is no float anywhere in the money path.
 */

export const PRICING_ENGINE_VERSION = 'pricing-engine/1';

export const ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const PRICING_COMPONENT_KINDS = [
  'BASE_FARE',
  'PER_KM',
  'SLAB_KM',
  'MIN_TRIP_CHARGE',
  'MIN_BILLABLE_KM',
  'WAITING',
  'EXTRA_STOP',
  'TOLL_PARKING_PASSTHROUGH',
  'NIGHT_SURCHARGE',
  'PEAK_SURCHARGE',
  'FIXED_TRIP',
  'HOURLY',
  'MIN_HOURS',
  'AVAILABILITY_FEE',
  'INCLUDED_KM',
  'INCLUDED_HOURS',
  'EXCESS_KM',
  'EXCESS_HOUR',
  'OVERTIME',
  'HOLIDAY',
  'CANCELLATION',
  'SEAT',
  'MIN_GUARANTEE',
  'DISCOUNT',
] as const;
export type PricingComponentKind = (typeof PRICING_COMPONENT_KINDS)[number];

/** What an availability component pays for (§5.5 coverage matrix). */
export const COVERAGE_KINDS = ['VEHICLE_TIME', 'KM_INCLUDED', 'HOURS_INCLUDED', 'TRIPS'] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

export const RIDE_PREFERENCES = ['PRIVATE', 'SHARED', 'FLEXIBLE'] as const;
export type RidePreference = (typeof RIDE_PREFERENCES)[number];

export const AVAILABILITY_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type AvailabilityFrequency = (typeof AVAILABILITY_FREQUENCIES)[number];

/** Optional narrowing of a component; a component applies when every set field matches the facts. */
export interface PricingComponentScope {
  vehicleCategory?: string | null;
  minSeats?: number | null;
  maxSeats?: number | null;
  branchIds?: string[] | null;
  journey?: string | null;
  ridePreference?: RidePreference | null;
  serviceType?: string | null;
}

/**
 * Parameters per kind. Decimal strings are major units ("12.375" = ₹12.375) or plain decimals (km, hours, percent).
 * - BASE_FARE, MIN_TRIP_CHARGE, FIXED_TRIP, MIN_GUARANTEE: { amount }
 * - FIXED_TRIP may also carry { agreedKm } (the route's agreed distance; used by distanceSource AGREED)
 * - PER_KM, EXCESS_KM: { rate } per km;  HOURLY, EXCESS_HOUR, OVERTIME: { rate } per hour
 * - SLAB_KM: { slabs: [{ uptoKm: "10" | null, rate }] } marginal tiers, the last open-ended
 * - MIN_BILLABLE_KM, INCLUDED_KM: { km };  MIN_HOURS, INCLUDED_HOURS: { hours }
 * - HOURLY: { rate, incrementMinutes?: number (default 60), basis?: 'ACTUAL' | 'RESERVED' (default ACTUAL) }
 * - WAITING: { freeMinutes: number, incrementMinutes: number, rate } (rate per increment)
 * - EXTRA_STOP: { includedStops: number, rate } (rate per extra stop)
 * - NIGHT_SURCHARGE / PEAK_SURCHARGE: { from: 'HH:MM', to: 'HH:MM', percent?: "10" | amount?: "50" } on the trip start time
 * - TOLL_PARKING_PASSTHROUGH: {} (actual amounts from the facts; taxed per the component taxCode, 'EXEMPT' = no tax)
 * - AVAILABILITY_FEE: { amount, frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY', prorate?: boolean (default true) }
 * - HOLIDAY: { amount } per holiday day worked
 * - CANCELLATION: { amount, freeBeforeMinutes: number }
 * - SEAT: { rate } per passenger
 * - DISCOUNT: { percent?: "5" | amount?: "100" }
 */
export type PricingComponentParams = Record<string, unknown>;

export interface PricingComponentInput {
  kind: PricingComponentKind;
  label?: string | null;
  scope?: PricingComponentScope | null;
  params: PricingComponentParams;
  /** AVAILABILITY_FEE only: what the fee pays for. */
  covers?: CoverageKind[];
  /** Tax code (TaxRateInput.taxCode); null = the tax config's default code. 'EXEMPT' = never taxed. */
  taxCode?: string | null;
  sortOrder?: number;
}

/** Version-level policies (PricingContractVersion.policies). */
export interface PricingPolicies {
  /** Explicit hybrid: trips on a dedicated vehicle are ALSO priced per trip (only when no availability fee covers TRIPS). */
  alsoChargeTrips?: boolean;
  /** Availability: charge the fee even in a period without any trip (default true). */
  chargeWithoutTrips?: boolean;
  /** GPS quality thresholds: GPS km below minPct % or above maxPct % of planned = LOW_COVERAGE (defaults 50 / 200). */
  gpsMinPctOfPlanned?: number;
  gpsMaxPctOfPlanned?: number;
  /** Fare allocation for shared rides (§5.9). */
  sharedFareMethod?: SharedFareMethod;
  /** Shared rate discount for OWN_FARE, percent decimal string ("20" = 20 % below the private per-km price). */
  sharedDiscountPercent?: string;
  /** FIXED_PER_PASSENGER amount (major, decimal string). */
  sharedFixedAmount?: string;
  /** EQUAL_SPLIT must be explicitly allowed. */
  allowEqualSplit?: boolean;
  /** Trip overrides need a second user's approval (maker-checker). */
  tripOverrideNeedsApproval?: boolean;
  /** Holiday calendar id (PricingCalendar) used by availability periods. */
  calendarId?: string | null;
}

// ───────────── Tax ─────────────

export const TAX_REGIMES = ['IN_GST', 'SIMPLE', 'NONE'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

export interface TaxRateInput {
  taxCode: string;
  label: string;
  /** Parts per million (18 % = 180_000). */
  ratePpm: number;
}

export interface TaxConfig {
  regime: TaxRegime;
  rates: TaxRateInput[];
  /** Code for lines without their own taxCode. */
  defaultTaxCode?: string | null;
  /** IN_GST: GST state codes of supplier and buyer (CGST+SGST / CGST+UTGST / IGST). */
  supplierStateCode?: string | null;
  buyerStateCode?: string | null;
}

export interface TaxLine {
  taxCode: string;
  label: string;
  ratePpm: number;
  taxableMinor: bigint;
  taxMinor: bigint;
  /** IN_GST split; the odd minor unit goes to CGST. */
  cgstMinor?: bigint;
  sgstMinor?: bigint;
  utgstMinor?: bigint;
  igstMinor?: bigint;
}

// ───────────── Results ─────────────

export type PriceStatus = 'PRICED' | 'ESTIMATE' | 'COVERED' | 'NEEDS_REVIEW' | 'NO_APPLICABLE_PRICING' | 'ERROR';

export type PricingIssueCode =
  | 'NO_APPLICABLE_PRICING'
  | 'CURRENCY_MISMATCH'
  | 'TAX_PROFILE_MISSING'
  | 'GPS_DISTANCE_REVIEW'
  | 'VEHICLE_OVERRIDE_NOT_PERMITTED'
  | 'SHARED_FARE_NOT_ALLOWED'
  | 'EQUAL_SPLIT_NOT_ALLOWED'
  | 'INVALID_COMPONENT'
  | 'AMBIGUOUS_BASE_MODEL'
  | 'DOUBLE_CHARGE'
  | 'MISSING_FACT';

export interface PricingIssue {
  code: PricingIssueCode;
  message: string;
}

export interface PriceLine {
  /** Component kind, or a synthetic line: 'COVERED' | 'MIN_TRIP_TOP_UP' | 'MIN_GUARANTEE_TOP_UP' | 'OVERRIDE' | 'ALLOCATION'. */
  component: string;
  label: string;
  /** Decimal string ("25.000" km, "3" stops). */
  quantity: string;
  unit: string;
  /** Rate in micro major units (decimal string of a bigint), when the line is rate × quantity. */
  rateMicro?: string;
  amountMinor: bigint;
  /** Share of the discount allocated to this line (>= 0). */
  discountMinor: bigint;
  taxCode: string | null;
  taxMinor: bigint;
  /** Human explanation, e.g. "25.000 km × 12.375000/km". */
  basis: string;
}

/**
 * Invariants (tested): subtotalMinor = Σ lines.amountMinor; discountMinor = Σ lines.discountMinor;
 * taxMinor = Σ lines.taxMinor = Σ taxLines.taxMinor; totalMinor = subtotalMinor − discountMinor + taxMinor.
 */
export interface PriceResult {
  status: PriceStatus;
  currency: string;
  lines: PriceLine[];
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxLines: TaxLine[];
  taxMinor: bigint;
  totalMinor: bigint;
  issues: PricingIssue[];
  engineVersion: string;
}

// ───────────── Trip pricing input ─────────────

export interface TripFacts {
  serviceDate: string;
  /** Local minute of day of the trip start (0–1439), for night / peak bands. */
  startMinuteOfDay?: number | null;
  /** Billable distance (already resolved by resolveBillableDistance); null = unknown (→ NEEDS_REVIEW for distance models). */
  billableDistanceM: number | null;
  /** Actual duration (s) and reserved duration (s), for hourly models. */
  actualDurationS?: number | null;
  reservedDurationS?: number | null;
  waitingS?: number | null;
  /** Stops actually served (pickups + drops). */
  stops?: number | null;
  passengers?: number | null;
  /** Toll / parking amounts actually paid, minor units of the contract currency. */
  tollsMinor?: bigint | null;
  /** Cancelled trip: minutes before the planned start it was cancelled. */
  cancelledMinutesBefore?: number | null;
  ridePreference?: RidePreference | null;
  /** Trip on a dedicated (availability) vehicle within its operating hours. */
  onDedicatedVehicle?: boolean;
  vehicleCategory?: string | null;
  seats?: number | null;
  branchId?: string | null;
  journey?: string | null;
  serviceType?: string | null;
}

export interface TripPriceInput {
  currency: string;
  roundingMode: RoundingMode;
  components: PricingComponentInput[];
  policies?: PricingPolicies | null;
  facts: TripFacts;
  tax: TaxConfig;
  /** ESTIMATE when priced from planned values. */
  estimate?: boolean;
  /** Negotiated trip price (precedence 3): replaces the computed base + add-ons with one line. Minor units. */
  overrideMinor?: bigint | null;
  overrideReason?: string | null;
}

// ───────────── Availability period input ─────────────

export interface PeriodFacts {
  frequency: AvailabilityFrequency;
  /** Inclusive dates 'YYYY-MM-DD'. */
  periodStart: string;
  periodEnd: string;
  /** Days of the period the vehicle was attached (assignment validity ∩ period). */
  attachedDays: number;
  /** Non-billable downtime days (breakdown / maintenance not billable). */
  downtimeDays: number;
  /** Suspension days (contract or vehicle suspended). */
  suspensionDays: number;
  /** Days a replacement vehicle (replacementBilling ORIGINAL) covered a downtime: billed as if the original ran. */
  replacementCoveredDays?: number;
  /** Holiday days worked (HOLIDAY component). */
  holidayDaysWorked?: number;
  usedDistanceM: number;
  usedDurationS?: number;
  overtimeS?: number;
  tripCount?: number;
  /** This assignment is a replacement billed under the original: no own fee. */
  billedUnderOriginal?: boolean;
  vehicleCategory?: string | null;
  seats?: number | null;
  branchId?: string | null;
}

export interface PeriodPriceInput {
  currency: string;
  roundingMode: RoundingMode;
  components: PricingComponentInput[];
  policies?: PricingPolicies | null;
  facts: PeriodFacts;
  tax: TaxConfig;
}

// ───────────── Distance resolution (§5.4) ─────────────

export const DISTANCE_SOURCES = ['GPS', 'PLANNED', 'AGREED', 'MANUAL_APPROVED'] as const;
export type DistanceSource = (typeof DISTANCE_SOURCES)[number];
export const MISSING_GPS_POLICIES = ['REVIEW', 'USE_PLANNED', 'USE_AGREED'] as const;
export type MissingGpsPolicy = (typeof MISSING_GPS_POLICIES)[number];
export type GpsQuality = 'OK' | 'MISSING' | 'LOW_COVERAGE' | 'UNAVAILABLE';

export interface DistanceInput {
  source: DistanceSource;
  onMissingGps: MissingGpsPolicy;
  plannedM?: number | null;
  gpsM?: number | null;
  agreedM?: number | null;
  manualM?: number | null;
  /** Longest GPS offline gap during the trip (s) and the threshold above which coverage is low. */
  offlineGapS?: number | null;
  maxOfflineGapS?: number | null;
  gpsMinPctOfPlanned?: number;
  gpsMaxPctOfPlanned?: number;
}

export interface DistanceResolution {
  billableM: number | null;
  /** The value actually used (may differ from the contract source when a fallback policy applied). */
  usedSource: DistanceSource | null;
  gpsQuality: GpsQuality;
  needsReview: boolean;
  basis: string;
}

// ───────────── Shared rides (§5.9) ─────────────

export const SHARED_FARE_METHODS = ['OWN_FARE', 'DISTANCE_SHARE', 'FIXED_PER_PASSENGER', 'CONTRACT_RULE', 'EQUAL_SPLIT'] as const;
export type SharedFareMethod = (typeof SHARED_FARE_METHODS)[number];

export interface FarePassenger {
  passengerId: string;
  /** Direct (solo) distance from pickup to drop. */
  directDistanceM: number;
  /** Distance travelled on board. */
  onboardDistanceM: number;
}

export interface FareAllocationInput {
  currency: string;
  roundingMode: RoundingMode;
  preference: RidePreference;
  method: SharedFareMethod;
  passengers: FarePassenger[];
  /** Whether co-riders were actually on board (FLEXIBLE resolves to shared only then). */
  coRidersOnBoard: boolean;
  /** The vehicle trip price (DISTANCE_SHARE / EQUAL_SPLIT / PRIVATE), minor. */
  vehicleTripMinor?: bigint;
  /** OWN_FARE: per-km rate micro and shared discount ppm (200_000 = 20 %). */
  perKmRateMicro?: bigint;
  baseFareMinor?: bigint;
  sharedDiscountPpm?: number;
  /** FIXED_PER_PASSENGER, minor. */
  fixedPerPassengerMinor?: bigint;
  allowEqualSplit?: boolean;
}

export interface FareAllocation {
  /** 'SHARED' when a shared method was applied, else 'PRIVATE'. */
  appliedAs: 'SHARED' | 'PRIVATE';
  method: SharedFareMethod | 'PRIVATE';
  shares: { passengerId: string; amountMinor: bigint; basis: string }[];
  totalMinor: bigint;
  issues: PricingIssue[];
}

// ───────────── Precedence (§5.7) ─────────────

export interface ContractCandidate {
  id: string;
  customerCompanyId: string | null;
  isDefault: boolean;
  /** Empty = every branch. */
  branchIds: string[];
  /** Vehicle category the contract is limited to (from its components' scopes), null = any. */
  vehicleCategory?: string | null;
  status: string;
  validFrom: string;
  validTo: string | null;
  /** Default contract only: customer types it explicitly covers ('INTERNAL' | 'EXTERNAL'). */
  defaultCovers?: ('INTERNAL' | 'EXTERNAL')[];
}

export interface ContractSelectionQuery {
  customerCompanyId: string | null;
  branchId: string | null;
  vehicleCategory: string | null;
  serviceDate: string;
}

export type ContractSelection =
  | { ok: true; contractId: string; viaDefault: boolean; basis: string }
  | { ok: false; code: 'NO_APPLICABLE_PRICING'; reason: string };
