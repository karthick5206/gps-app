import {
  ROUTE_PLAN_STATUSES,
  TRANSPORT_DIRECTIONS,
  type RoutePlanAssignmentUpdateRequest,
  type RoutePlanDiscardRequest,
  type RoutePlanMovePassengerRequest,
  type RoutePlanResequenceRequest,
  type RoutePlanStatus,
  type RoutePlanStopUpdateRequest,
  type TransportDirection,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MSG = { message: 'must be a date YYYY-MM-DD' };

/** GET /transport/route-plans */
export class PlanListQuery {
  @IsOptional() @Matches(DAY, DAY_MSG) planDate?: string;
  @IsOptional() @Matches(DAY, DAY_MSG) from?: string;
  @IsOptional() @Matches(DAY, DAY_MSG) to?: string;
  @IsOptional() @IsIn(ROUTE_PLAN_STATUSES) status?: RoutePlanStatus;
  @IsOptional() @IsIn(TRANSPORT_DIRECTIONS) direction?: TransportDirection;
}

/** GET /transport/route-plans/compare?ids=a,b */
export class PlanCompareQuery {
  @IsString() @MaxLength(400) ids!: string;
}

export class MovePassengerDto implements RoutePlanMovePassengerRequest {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsUUID() bookingId!: string;
  @ValidateIf((_o, v) => v !== null) @IsUUID() toAssignmentId!: string | null;
  @IsOptional() @IsInt() @Min(0) pickupIndex?: number;
  @IsOptional() @IsInt() @Min(0) dropIndex?: number;
}

class RouteOrderDto {
  @IsUUID() assignmentId!: string;
  @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) stopIds!: string[];
}

export class ResequenceDto implements RoutePlanResequenceRequest {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RouteOrderDto) assignments!: RouteOrderDto[];
}

export class AssignmentUpdateDto implements RoutePlanAssignmentUpdateRequest {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() driverId?: string | null;
  @IsOptional() @IsBoolean() locked?: boolean;
}

export class StopUpdateDto implements RoutePlanStopUpdateRequest {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsBoolean() pinned!: boolean;
}

export class DiscardDto implements RoutePlanDiscardRequest {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

/** POST /transport/route-plans/:id/publish (Idempotency-Key header or body). */
export class PublishDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @MaxLength(200) idempotencyKey?: string;
}
