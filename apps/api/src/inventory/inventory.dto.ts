import { PartialType } from '@nestjs/mapped-types';
import {
  DEVICE_CONDITIONS,
  DeviceCondition,
  INVENTORY_STATUSES,
  InventoryStatus,
  STOCK_LOCATION_KINDS,
  STOCK_MOVEMENT_KINDS,
  StockLocationKind,
  StockMovementKind,
} from '@veetracer/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../common/list-query';
import { UNIQUE_ID_PATTERN } from '../masters/devices/devices.dto';

/** Max devices in one receipt / import (one transaction). */
export const MAX_RECEIPT_ITEMS = 500;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ───────────── Locations ─────────────

export class LocationListQuery extends ListQueryDto {
  @IsOptional() @IsIn(STOCK_LOCATION_KINDS) kind?: StockLocationKind;
}

export class CreateLocationDto {
  @IsIn(STOCK_LOCATION_KINDS) kind!: StockLocationKind;
  @Transform(trim) @IsString() @Matches(/^[A-Za-z0-9_-]{1,20}$/, { message: 'code must be 1-20 letters, digits, "-" or "_"' }) code!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @Matches(/^\d{2}$/, { message: 'stateCode must be the 2-digit GST state code' }) stateCode?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateLocationDto extends PartialType(CreateLocationDto) {}

// ───────────── Suppliers ─────────────

export class SupplierListQuery extends ListQueryDto {}

export class CreateSupplierDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @Matches(/^[0-9A-Z]{15}$/, { message: 'gstin must be 15 capital letters / digits' }) gstin?: string | null;
  @IsOptional() @Matches(/^\d{2}$/, { message: 'stateCode must be the 2-digit GST state code' }) stateCode?: string | null;
  /** Free contact fields (person, phone, email, address); string values only. */
  @IsOptional() @IsObject() contact?: Record<string, string>;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

// ───────────── Receipts ─────────────

export class ReceiptItemDto {
  /** An existing stock device (no DeviceStock yet)… */
  @IsOptional() @IsUUID() deviceId?: string;
  /** …or an IMEI: existing device (by IMEI) or a new one registered through the Device Inventory create path. */
  @IsOptional() @Matches(UNIQUE_ID_PATTERN, { message: 'uniqueId must be 4-32 letters, digits, "-" or "_"' }) uniqueId?: string;
  /** Required when the IMEI is new. */
  @IsOptional() @IsUUID() modelId?: string;
  @IsOptional() @IsString() @MaxLength(20) simNumber?: string;
  @IsOptional() @IsString() @MaxLength(40) simOperator?: string;
  @IsOptional() @IsString() @MaxLength(40) firmware?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) serialNumber?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) unitCostPaise?: number;
  @IsOptional() @Matches(DATE_ONLY, { message: 'warrantyUntil must be YYYY-MM-DD' }) warrantyUntil?: string;
  @IsOptional() @IsIn(DEVICE_CONDITIONS) condition?: DeviceCondition;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class CreateReceiptDto {
  @IsUUID() locationId!: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsString() @MaxLength(60) supplierInvoiceNo?: string;
  @IsOptional() @Matches(DATE_ONLY, { message: 'supplierInvoiceAt must be YYYY-MM-DD' }) supplierInvoiceAt?: string;
  @IsOptional() @IsISO8601() receivedAt?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_RECEIPT_ITEMS) @ValidateNested({ each: true }) @Type(() => ReceiptItemDto) items!: ReceiptItemDto[];
}

export class ReceiptListQuery extends ListQueryDto {
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() locationId?: string;
}

// ───────────── Stock ─────────────

export class StockListQuery extends ListQueryDto {
  @IsOptional() @IsIn(INVENTORY_STATUSES) stockStatus?: InventoryStatus;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsUUID() holderPartnerId?: string;
  @IsOptional() @IsUUID() modelId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() receiptId?: string;
  @IsOptional() @IsUUID() companyId?: string;
  @IsOptional() @IsIn(['true']) mismatch?: 'true';
}

export class ChangeStatusDto {
  @IsIn(INVENTORY_STATUSES) status!: InventoryStatus;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Where the unit now is (statuses that hold a location); omitted = unchanged. */
  @IsOptional() @IsUUID() toLocationId?: string;
}

export class TransferDto {
  /** New location; omitted = unchanged. */
  @IsOptional() @IsUUID() toLocationId?: string;
  /** Partner now holding the unit (null = platform). Omitted = unchanged. Never changes Device.companyId. */
  @IsOptional() @IsUUID() holderPartnerId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class AdjustDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @IsOptional() @IsIn(INVENTORY_STATUSES) status?: InventoryStatus;
  @IsOptional() @IsUUID() locationId?: string | null;
  @IsOptional() @IsUUID() holderPartnerId?: string | null;
  @IsOptional() @IsString() @MaxLength(60) serialNumber?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) unitCostPaise?: number | null;
  @IsOptional() @Matches(DATE_ONLY, { message: 'warrantyUntil must be YYYY-MM-DD' }) warrantyUntil?: string | null;
  @IsOptional() @IsIn(DEVICE_CONDITIONS) condition?: DeviceCondition | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

export class SyncDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class MovementListQuery extends ListQueryDto {
  @IsOptional() @IsIn(STOCK_MOVEMENT_KINDS) kind?: StockMovementKind;
  @IsOptional() @IsUUID() deviceId?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsUUID() receiptId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

// ───────────── CSV import ─────────────

export class ImportDto {
  /** CSV text (UTF-8). Columns by header: imei, model, serial, unit_cost, warranty_until, condition, sim, operator, note. */
  @IsString() @MinLength(1) @MaxLength(100_000) csv!: string;
  @IsUUID() locationId!: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsString() @MaxLength(60) supplierInvoiceNo?: string;
  @IsOptional() @Matches(DATE_ONLY, { message: 'supplierInvoiceAt must be YYYY-MM-DD' }) supplierInvoiceAt?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Default true: validate and report only. Send false to apply (refused while any row has an error). */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}
