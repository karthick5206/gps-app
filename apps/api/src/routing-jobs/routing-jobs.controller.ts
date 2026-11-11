import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ROUTING_LIMITS, type RoutingJobDto } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { TransportFeatureGuard } from '../etms/transport-feature.guard';
import { EtmsRoutingEnabledGuard } from './routing-flags';
import { RoutingJobsService } from './routing-jobs.service';

/**
 * Menu the job endpoints are gated by. The ETMS planner menu `etms_planning` (shared ETMS_PLANNING_MENU) is added to
 * MENUS with the planner page (WP 4.5); until then planning rides on the dispatch menu (view / edit).
 */
const MENU = 'etms_dispatch' as const;

export class OptimizeJobDto {
  @IsUUID() planId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ROUTING_LIMITS.optimizeTimeLimitS) timeLimitS?: number;
  @IsOptional() @IsIn(['duration', 'distance']) objective?: 'duration' | 'distance';
}

export class JobListQueryDto {
  @IsOptional() @IsUUID() planId?: string;
  /** Comma-separated states: queued,running,succeeded,failed,cancelled. */
  @IsOptional() @IsString() @MaxLength(60) state?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

type HeaderSink = { setHeader?: (name: string, value: string) => unknown; status?: (code: number) => unknown } | undefined;

/**
 * /api/routing/jobs — ETMS optimisation jobs (E4 WP 4.2). 404 unless ETMS_ROUTING=on (and ETMS on, company add-on
 * `etms`). The plans service's `POST /route-plans/:id/optimize` (doc 05 §2) can delegate to the same service call.
 */
@Controller('routing/jobs')
@UseGuards(EtmsRoutingEnabledGuard, TransportFeatureGuard)
export class RoutingJobsController {
  constructor(private readonly jobs: RoutingJobsService) {}

  /** 202 + the job; the same Idempotency-Key and body again → 200 + the same job (header Idempotent-Replay: true). */
  @Post('optimize') @HttpCode(202) @RequirePermission(MENU, 'edit')
  async optimize(@Auth() ctx: AuthContext, @Body() dto: OptimizeJobDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<RoutingJobDto> {
    const r = await this.jobs.enqueueOptimize(ctx, dto, key);
    if (r.replay) {
      res?.setHeader?.('Idempotent-Replay', 'true');
      res?.status?.(200);
    }
    return r.job;
  }

  @Get() @RequirePermission(MENU, 'view')
  list(@Auth() ctx: AuthContext, @Query() q: JobListQueryDto): Promise<RoutingJobDto[]> {
    return this.jobs.list(ctx, q);
  }

  @Get(':id') @RequirePermission(MENU, 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RoutingJobDto> {
    return this.jobs.get(ctx, id);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermission(MENU, 'edit')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RoutingJobDto> {
    return this.jobs.cancel(ctx, id);
  }
}
