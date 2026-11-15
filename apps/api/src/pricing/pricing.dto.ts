/**
 * Doc 19 request DTOs (class-validator shapes for the global whitelist pipe). They mirror the shared request types in
 * packages/shared/src/pricing/api.ts; nested component / policy / facts objects are validated in the services
 * (sanitizeComponents, sanitizePolicies, the engine's validateComponents).
 */
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import {
  AVAILABILITY_PERIOD_STATUSES,
  BILLING_FREQUENCIES,
  COST_CATEGORIES,
  COST_SOURCES,
  DISTANCE_SOURCES,
  DOWNTIME_KINDS,
  INVOICE_STATUSES,
  MISSING_GPS_POLICIES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PRICING_CONTRACT_STATUSES,
  PRICING_REPORT_GROUPS,
  REPLACEMENT_BILLING,
  REQUESTABLE_ADJUSTMENT_KINDS,
  ROUNDING_MODES,
  TAX_REGIMES,
  TRIP_PRICE_STATUSES,
  ADJUSTMENT_STATUSES,
  type PeriodFacts,
  type PreviewTripFacts,
  type PricingComponentDto,
  type PricingOperatingHours,
  type PricingPolicies,
  type TaxRegime,
} from '@veetracer/shared';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^-?\d{1,15}(\.\d{1,6})?$/;
const nullable = (_o: unknown, v: unknown) => v !== null && v !== undefined;

class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

// ───────────── contracts ─────────────

export class ContractListQueryDto extends PageQuery {
  @IsOptional() @IsIn(PRICING_CONTRACT_STATUSES) status?: (typeof PRICING_CONTRACT_STATUSES)[number];
  @IsOptional() @IsUUID() customerCompanyId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

class ContractHeaderDto {
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(80) reference?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(160) customerName?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() agreementId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @IsOptional() @ValidateIf(nullable) @IsUUID() taxProfileId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) branchIds?: string[];
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsArray() @IsIn(['INTERNAL', 'EXTERNAL'], { each: true }) defaultCovers?: ('INTERNAL' | 'EXTERNAL')[];
  @IsOptional() @IsBoolean() allowVehicleOverrides?: boolean;
  @IsOptional() @IsBoolean() allowTripOverrides?: boolean;
  @IsOptional() @IsIn(DISTANCE_SOURCES) distanceSource?: (typeof DISTANCE_SOURCES)[number];
  @IsOptional() @IsIn(MISSING_GPS_POLICIES) onMissingGps?: (typeof MISSING_GPS_POLICIES)[number];
  @IsOptional() @IsIn(ROUNDING_MODES) roundingMode?: (typeof ROUNDING_MODES)[number];
}

export class CreateContractDto extends ContractHeaderDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() customerCompanyId?: string | null;
  @IsString() @Matches(/^[A-Za-z]{3}$/) currency!: string;
  @IsIn(BILLING_FREQUENCIES) billingFrequency!: (typeof BILLING_FREQUENCIES)[number];
  @Matches(DAY) validFrom!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
  @IsOptional() @IsObject() policies?: PricingPolicies;
  @IsOptional() @IsArray() @ArrayMaxSize(100) components?: PricingComponentDto[];
}

export class UpdateContractDto extends ContractHeaderDto {
  @IsInt() expectedVersion!: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{3}$/) currency?: string;
  @IsOptional() @IsIn(BILLING_FREQUENCIES) billingFrequency?: (typeof BILLING_FREQUENCIES)[number];
}

export class CreateVersionDto {
  @Matches(DAY) validFrom!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() copyFromVersionId?: string | null;
  @IsOptional() @IsObject() policies?: PricingPolicies;
  @IsOptional() @IsArray() @ArrayMaxSize(100) components?: PricingComponentDto[];
}

export class ReplaceComponentsDto {
  @IsArray() @ArrayMaxSize(100) components!: PricingComponentDto[];
  @IsOptional() @IsObject() policies?: PricingPolicies;
  @IsOptional() @Matches(DAY) validFrom?: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
}

export class DecisionDto {
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) note?: string | null;
}
export class RejectDto {
  @IsString() @MaxLength(500) reason!: string;
}
export class LifecycleDto {
  @IsString() @MaxLength(500) reason!: string;
  @IsInt() expectedVersion!: number;
}

export class PreviewDto {
  @IsOptional() @ValidateIf(nullable) @IsUUID() versionId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(100) components?: PricingComponentDto[];
  @IsOptional() @IsObject() policies?: PricingPolicies;
  @IsIn(['TRIP', 'PERIOD']) kind!: 'TRIP' | 'PERIOD';
  @IsOptional() @IsObject() trip?: PreviewTripFacts;
  @IsOptional() @IsObject() period?: PeriodFacts;
  @IsOptional() @ValidateIf(nullable) @IsUUID() objectId?: string | null;
  @IsOptional() @ValidateIf(nullable) @Matches(/^\d{2}$/) buyerStateCode?: string | null;
}

// ───────────── vehicle rates / dedicated vehicles ─────────────

export class CreateVehicleRateDto {
  @IsUUID() objectId!: string;
  @Matches(DAY) validFrom!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
  @IsArray() @ArrayMaxSize(50) componentOverrides!: PricingComponentDto[];
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) reason?: string | null;
}
export class UpdateVehicleRateDto {
  @IsInt() expectedVersion!: number;
  @IsOptional() @Matches(DAY) validFrom?: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) componentOverrides?: PricingComponentDto[];
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) reason?: string | null;
}

export class CreateAssignmentDto {
  @IsUUID() objectId!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() driverId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() fleetAllocationId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() branchId?: string | null;
  @Matches(DAY) validFrom!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
  @IsOptional() @IsObject() operatingHours?: PricingOperatingHours;
  @IsOptional() @ValidateIf(nullable) @IsUUID() replacesAssignmentId?: string | null;
  @IsOptional() @IsIn(REPLACEMENT_BILLING) replacementBilling?: (typeof REPLACEMENT_BILLING)[number];
}
export class UpdateAssignmentDto {
  @IsInt() expectedVersion!: number;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
  @IsOptional() @IsObject() operatingHours?: PricingOperatingHours;
  @IsOptional() @IsIn(['ACTIVE', 'ENDED']) status?: 'ACTIVE' | 'ENDED';
}
export class CreateDowntimeDto {
  @Matches(DAY) fromDate!: string;
  @Matches(DAY) toDate!: string;
  @IsIn(DOWNTIME_KINDS) kind!: (typeof DOWNTIME_KINDS)[number];
  @IsOptional() @IsBoolean() billable?: boolean;
  @IsString() @MaxLength(500) reason!: string;
}

// ───────────── trip charges ─────────────

export class TripChargeQueryDto extends PageQuery {
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  @IsOptional() @IsIn(TRIP_PRICE_STATUSES) status?: (typeof TRIP_PRICE_STATUSES)[number];
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() customerCompanyId?: string;
  @IsOptional() @IsUUID() contractId?: string;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}
export class RecalculateDto {
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) reason?: string | null;
}
export class BillableDistanceDto {
  @IsString() @Matches(/^\d{1,5}(\.\d{1,3})?$/) distanceKm!: string;
  @IsString() @MaxLength(500) reason!: string;
}
export class TripOverrideDto {
  @IsString() @Matches(MONEY) amount!: string;
  @IsString() @MaxLength(500) reason!: string;
}

// ───────────── availability ─────────────

export class AvailabilityQueryDto extends PageQuery {
  @IsOptional() @IsUUID() contractId?: string;
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  @IsOptional() @IsIn(AVAILABILITY_PERIOD_STATUSES) status?: (typeof AVAILABILITY_PERIOD_STATUSES)[number];
}
export class AvailabilityPeriodDto {
  @IsUUID() contractId!: string;
  @Matches(DAY) periodDate!: string;
}

// ───────────── invoices / payments / adjustments ─────────────

export class InvoiceQueryDto extends PageQuery {
  @IsOptional() @IsIn(INVOICE_STATUSES) status?: (typeof INVOICE_STATUSES)[number];
  @IsOptional() @IsUUID() contractId?: string;
  @IsOptional() @IsUUID() customerCompanyId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  @IsOptional() @IsIn(PAYMENT_STATUSES) paymentStatus?: (typeof PAYMENT_STATUSES)[number];
}
export class GenerateInvoiceDto {
  @IsUUID() contractId!: string;
  @Matches(DAY) periodStart!: string;
  @Matches(DAY) periodEnd!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() branchId?: string | null;
}
export class IssueInvoiceDto {
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) invoiceDate?: string | null;
}
export class CreditNoteDto {
  @IsString() @MaxLength(500) reason!: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @Matches(MONEY) amount?: string | null;
}
export class PaymentDto {
  @IsString() @Matches(MONEY) amount!: string;
  @IsString() @MaxLength(40) receivedAt!: string;
  @IsIn(PAYMENT_METHODS) method!: (typeof PAYMENT_METHODS)[number];
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(120) reference?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) note?: string | null;
}
export class ReversePaymentDto {
  @IsString() @MaxLength(500) reason!: string;
}
export class AdjustmentQueryDto extends PageQuery {
  @IsOptional() @IsIn(ADJUSTMENT_STATUSES) status?: (typeof ADJUSTMENT_STATUSES)[number];
  @IsOptional() @IsUUID() contractId?: string;
}
export class CreateAdjustmentDto {
  @IsUUID() contractId!: string;
  @IsIn(REQUESTABLE_ADJUSTMENT_KINDS) kind!: (typeof REQUESTABLE_ADJUSTMENT_KINDS)[number];
  @IsString() @Matches(MONEY) amount!: string;
  @IsString() @MaxLength(500) reason!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() transportTripId?: string | null;
}

// ───────────── reports / costs ─────────────

export class ReportQueryDto {
  @Matches(DAY) from!: string;
  @Matches(DAY) to!: string;
  @IsOptional() @IsIn(PRICING_REPORT_GROUPS) groupBy?: (typeof PRICING_REPORT_GROUPS)[number];
  @IsOptional() @IsUUID() contractId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}
export class CostQueryDto extends PageQuery {
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsIn(COST_CATEGORIES) category?: (typeof COST_CATEGORIES)[number];
}
export class CreateCostDto {
  @Matches(DAY) date!: string;
  @IsIn(COST_CATEGORIES) category!: (typeof COST_CATEGORIES)[number];
  @IsString() @Matches(MONEY) amount!: string;
  @IsString() @Matches(/^[A-Za-z]{3}$/) currency!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() objectId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() driverId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() transportTripId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsUUID() branchId?: string | null;
  @IsOptional() @IsIn(COST_SOURCES) source?: (typeof COST_SOURCES)[number];
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(120) sourceRef?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) note?: string | null;
}

// ───────────── settings ─────────────

export class SupplierProfileDto {
  @IsOptional() @IsInt() expectedVersion?: number;
  @IsString() @MinLength(1) @MaxLength(200) legalName!: string;
  @IsString() @MinLength(1) @MaxLength(500) address!: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(10) stateCode?: string | null;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/) country?: string;
  @IsIn(TAX_REGIMES) taxRegime!: TaxRegime;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(40) taxRegistration?: string | null;
  @IsOptional() @IsString() @MaxLength(16) invoicePrefix?: string;
  @IsOptional() @IsString() @MaxLength(16) creditNotePrefix?: string;
  @IsOptional() @IsInt() @Min(1) @Max(12) fiscalYearStartMonth?: number;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(200) email?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsObject() bankDetails?: Record<string, string>;
}
export class TaxRateDto {
  @IsString() @MaxLength(32) taxCode!: string;
  @IsString() @MaxLength(80) label!: string;
  @IsString() @Matches(/^\d{1,3}(\.\d{1,4})?$/) ratePercent!: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(20) sac?: string | null;
  @Matches(DAY) validFrom!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY) validTo?: string | null;
}
export class TaxProfileDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsIn(TAX_REGIMES) regime!: TaxRegime;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(80) jurisdiction?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(32) defaultTaxCode?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @Type(() => TaxRateDto) rates?: TaxRateDto[];
}
export class CalendarDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsArray() @ArrayMaxSize(400) @Matches(DAY, { each: true }) holidays!: string[];
  @IsOptional() @IsArray() @IsInt({ each: true }) nonOperatingWeekdays?: number[];
}
