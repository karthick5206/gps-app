import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { API_PLANS, type ApiPlan, type ApiPlans, LICENCE_TYPES, type LicenceType, OFFLINE_PAYMENT_MODES, type OfflinePaymentMode, REFUND_MODES, type RefundMode, type SeatLicenceType } from '@veetracer/shared';

export class PurchaseItemDto {
  @IsIn(LICENCE_TYPES) type!: LicenceType;
  @Type(() => Number) @IsInt() @Min(0) @Max(1000) quantity!: number;
  @IsOptional() @IsIn(API_PLANS) plan?: ApiPlan;
}

export class PurchaseDto {
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PurchaseItemDto) items!: PurchaseItemDto[];
  @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) renewSeatIds!: string[];
}

export class OfflinePaymentDto extends PurchaseDto {
  @IsIn(OFFLINE_PAYMENT_MODES) mode!: OfflinePaymentMode;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) paidOn!: string;
  @Type(() => Number) @IsInt() @Min(1) amountPaise!: number;
}

/** "I've paid by UPI": the purchase plus the UTR from the customer's UPI app. */
export class UpiClaimBody extends PurchaseDto {
  @IsString() @Length(8, 30) utr!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) paidOn!: string;
}

export class UpiRejectBody {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class VerifyCheckoutDto {
  @IsString() @Length(1, 64) razorpayOrderId!: string;
  @IsString() @Length(1, 64) razorpayPaymentId!: string;
  @IsString() @Length(1, 256) razorpaySignature!: string;
}

export class BillingProfileBody {
  @IsString() @Length(1, 160) billingName!: string;
  @IsString() @Length(1, 500) address!: string;
  @IsString() @MaxLength(80) city!: string;
  @IsString() @Length(2, 2) stateCode!: string;
  @IsString() @MaxLength(10) pin!: string;
  @IsString() @MaxLength(15) gstin!: string;
  @IsEmail() @MaxLength(160) email!: string;
}

export class AllocateDto {
  @IsUUID() companyId!: string;
  @IsIn(LICENCE_TYPES) type!: LicenceType;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) quantity!: number;
}

export class GrantDto {
  @IsIn(LICENCE_TYPES) type!: LicenceType;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) quantity!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(3660) days!: number;
  @IsString() @Length(3, 200) reason!: string;
  /** API_ACCESS grants: the plan (default BASIC). */
  @IsOptional() @IsIn(API_PLANS) plan?: ApiPlan;
}

export class PricingDto {
  @IsObject() pricesPaise!: Record<SeatLicenceType, number>;
  /** Sanitised by readApiPlans (bounds per field). */
  @IsObject() apiPlans!: ApiPlans;
  @Type(() => Number) @IsNumber() @Min(0) @Max(40) gstRatePct!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(90) graceDays!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(365) overrideDays!: number;
}

export class InvoicingDto {
  @IsString() @MaxLength(200) legalName!: string;
  @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) @MaxLength(200, { each: true }) addressLines!: string[];
  @IsString() @MaxLength(80) city!: string;
  @IsString() @Length(2, 2) stateCode!: string;
  @IsString() @MaxLength(10) pin!: string;
  @IsString() @MaxLength(15) gstin!: string;
  @IsString() @MaxLength(10) pan!: string;
  @IsString() @MaxLength(40) phone!: string;
  @IsString() @MaxLength(160) email!: string;
  @IsString() @MaxLength(160) website!: string;
  @IsString() @MaxLength(160) accountsEmail!: string;
  @IsString() @Matches(/^\d{4,8}$/, { message: 'SAC code must be 4–8 digits' }) sacCode!: string;
  @IsString() @MaxLength(16) invoicePrefix!: string;
  @IsString() @Length(1, 20) creditNotePrefix!: string;
  @IsString() @MaxLength(120) bankName!: string;
  @IsString() @MaxLength(160) bankAccountName!: string;
  @IsString() @MaxLength(40) bankAccountNo!: string;
  @IsString() @MaxLength(20) bankIfsc!: string;
  @IsString() @MaxLength(120) bankBranch!: string;
  @IsString() @MaxLength(80) upiId!: string;
  @IsString() @MaxLength(4000) terms!: string;
  @IsString() @MaxLength(1000) footerNote!: string;
}

export class PartnerCreateDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsUUID() homeCompanyId?: string | null;
}

export class PartnerUpdateDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsUUID() homeCompanyId?: string | null;
  @IsOptional() @IsObject() pricesPaise?: Partial<Record<SeatLicenceType, number | null>>;
  @IsOptional() @IsObject() apiPlanPricesPaise?: Partial<Record<ApiPlan, number | null>>;
}

export class CompanyPartnerDto {
  @IsUUID() partnerId!: string;
}

export class InvoiceQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsUUID() companyId?: string;
  @IsOptional() @IsUUID() partnerId?: string;
}

export class MonthQuery {
  @Matches(/^\d{4}-\d{2}$/) month!: string;
}

export class CreditNoteLineDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(1000) lineIndex!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(1000) quantity!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) amountPaise?: number;
}

export class CreditNoteBody {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => CreditNoteLineDto) lines!: CreditNoteLineDto[];
  @IsString() @Length(3, 500) reason!: string;
  @IsIn(REFUND_MODES) refundMode!: RefundMode;
  @IsOptional() @IsString() @MaxLength(120) refundReference?: string;
  @IsBoolean() keepSeatsActive!: boolean;
}
