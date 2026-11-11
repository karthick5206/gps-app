import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ETMS_PLANNING_MENU, ROUTING_LIMITS, type RoutingJobDto } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { PlanningFeatureGuard } from '../etms/planning/planning-feature.guard';
import { TransportFeatureGuard } from '../etms/transport-feature.guard';
import { RoutingJobsService } from './routing-jobs.service';

/** Optimiser objective weights (README P6: always explicit; at least one of distance / time / routeDuration > 0). */
export class SolverWeightsDto {
  @IsNumber() @Min(0) @Max(1e7) vehicle!: number;
  @IsNumber() @Min(0) @Max(1e4) distance!: number;
  @IsNumber() @Min(0) @Max(1e4) time!: number;
  @IsNumber() @Min(0) @Max(1e4) routeDuration!: number;
}

/** The optimise options (also the body of POST /transport/route-plans/:id/optimize, where the path names the plan). */
export class OptimizeOptionsDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ROUTING_LIMITS.optimizeTimeLimitS) timeLimitS?: number;
  @IsOptional() @IsIn(['duration', 'distance']) objective?: 'duration' | 'distance';
  /** Required (P6): stored on the plan (options.weights) for compare and sent as options.weights. */
  @IsDefined() @ValidateNested() @Type(() => SolverWeightsDto) weights!: SolverWeightsDto;
}

export class OptimizeJobDto extends OptimizeOptionsDto {
  @IsUUID() planId!: string;
}

export class JobListQueryDto {
  @IsOptional() @IsUUID() planId?: string;
  /** Comma-separated states: queued,running,succeeded,failed,cancelled. */
  @IsOptional() @IsString() @MaxLength(60) state?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

type HeaderSink = { setHeader?: (name: string, value: string) => unknown; status?: (code: number) => unknown } | undefined;

/**
 * /api/routing/jobs — ETMS optimisation jobs (E4 WP 4.2). Hidden (404) unless ETMS and ETMS_ROUTING=on and the company
 * add-on `etms`. Menu etms_planning: create = start an optimisation, view = read / list, command = cancel.
 */
@Controller('routing/jobs')
@UseGuards(TransportFeatureGuard, PlanningFeatureGuard)
export class RoutingJobsController {
  constructor(private readonly jobs: RoutingJobsService) {}

  /** 202 + the job; the same Idempotency-Key and body again → 200 + the same job (header Idempotent-Replay: true). */
  @Post('optimize') @HttpCode(202) @RequirePermission(ETMS_PLANNING_MENU, 'create')
  async optimize(@Auth() ctx: AuthContext, @Body() dto: OptimizeJobDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<RoutingJobDto> {
    const r = await this.jobs.enqueueOptimize(ctx, dto, key);
    if (r.replay) {
      res?.setHeader?.('Idempotent-Replay', 'true');
      res?.status?.(200);
    }
    return r.job;
  }

  @Get() @RequirePermission(ETMS_PLANNING_MENU, 'view')
  list(@Auth() ctx: AuthContext, @Query() q: JobListQueryDto): Promise<RoutingJobDto[]> {
    return this.jobs.list(ctx, q);
  }

  @Get(':id') @RequirePermission(ETMS_PLANNING_MENU, 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RoutingJobDto> {
    return this.jobs.get(ctx, id);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermission(ETMS_PLANNING_MENU, 'command')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RoutingJobDto> {
    return this.jobs.cancel(ctx, id);
  }
}
