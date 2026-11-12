import {
  TRANSPORT_AGREEMENT_STATUSES,
  TRANSPORT_DATA_PROFILES,
  TRANSPORT_GRANTS,
  type CreateTransportAgreementInput,
  type CreateTransportFleetAllocationInput,
  type TransportAgreementApproveInput,
  type TransportAgreementCommandInput,
  type TransportAgreementReasonInput,
  type TransportAgreementSide,
  type TransportAgreementStatus,
  type TransportDataProfile,
  type TransportGrant,
  type UpdateTransportAgreementInput,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';
import { ListQueryDto } from '../../common/list-query';

export class AgreementListQuery extends ListQueryDto {
  @IsOptional() @IsIn(TRANSPORT_AGREEMENT_STATUSES) agreementStatus?: TransportAgreementStatus;
  @IsOptional() @IsIn(['PROVIDER', 'CUSTOMER']) side?: TransportAgreementSide;
}

export class CreateAgreementDto implements CreateTransportAgreementInput {
  @IsUUID() providerCompanyId!: string;
  @IsUUID() customerCompanyId!: string;
  @IsISO8601() validFrom!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() validTo?: string | null;
  @IsArray() @ArrayUnique() @ArrayMaxSize(TRANSPORT_GRANTS.length) @IsIn(TRANSPORT_GRANTS, { each: true }) grants!: TransportGrant[];
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(500) @IsUUID('all', { each: true }) siteIds?: string[];
  @IsOptional() @IsIn(TRANSPORT_DATA_PROFILES) dataProfile?: TransportDataProfile;
  /** Required for VeeTrax support (checked in the service). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class UpdateAgreementDto implements UpdateTransportAgreementInput {
  @IsOptional() @IsISO8601() validFrom?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() validTo?: string | null;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(TRANSPORT_GRANTS.length) @IsIn(TRANSPORT_GRANTS, { each: true }) grants?: TransportGrant[];
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(500) @IsUUID('all', { each: true }) siteIds?: string[];
  @IsOptional() @IsIn(TRANSPORT_DATA_PROFILES) dataProfile?: TransportDataProfile;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedVersion?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AgreementCommandDto implements TransportAgreementCommandInput {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedVersion?: number;
  /** Propose by VeeTrax support: required (checked in the service). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** F6: approving needs the version the approver saw. */
export class AgreementApproveDto implements TransportAgreementApproveInput {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class AgreementReasonDto implements TransportAgreementReasonInput {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedVersion?: number;
}

export class AgreementSiteOptionsQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  /** Super Admin only: whose places to list (ignored for everyone else). */
  @IsOptional() @IsUUID() customerCompanyId?: string;
}

/** E1b: POST /transport/agreements/:id/fleet. */
export class CreateFleetAllocationDto implements CreateTransportFleetAllocationInput {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() objectId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() driverId?: string | null;
  @IsOptional() @IsISO8601() validFrom?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() validTo?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) note?: string | null;
}

export class FleetOptionsQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}
