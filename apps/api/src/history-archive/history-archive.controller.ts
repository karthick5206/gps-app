import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { HISTORY_RESTORE_KEEP_DAYS_MAX } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { archiveRunDeadline } from './archive-select';
import { HistoryArchiveService } from './history-archive.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class RestoreDto {
  @IsOptional() @IsUUID() objectId?: string;
  @IsString() @Matches(DAY, { message: 'from must be YYYY-MM-DD' }) from!: string;
  @IsString() @Matches(DAY, { message: 'to must be YYYY-MM-DD' }) to!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(HISTORY_RESTORE_KEEP_DAYS_MAX) keepDays?: number;
}

export class DaysQuery {
  @IsString() @Matches(DAY) from!: string;
  @IsString() @Matches(DAY) to!: string;
}

/**
 * History archiving. Viewing archived days needs history:view; restoring needs history:command (the built-in Admin role
 * has it) or Super Admin (checked in the service).
 */
@Controller()
export class HistoryArchiveController {
  constructor(private readonly service: HistoryArchiveService) {}

  @Get('history-archive/status') @RequirePermission('history', 'view')
  status(@Auth() ctx: AuthContext) {
    return this.service.status(ctx);
  }

  @Get('history-archive/failures') @RequirePermission('history', 'command')
  failures(@Auth() ctx: AuthContext) {
    return this.service.failures(ctx);
  }

  /** Archived days of one vehicle between two local days, with restore progress. */
  @Get('objects/:id/archive') @RequirePermission('history', 'view')
  days(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: DaysQuery) {
    return this.service.days(ctx, id, q.from, q.to);
  }

  @Post('history-archive/restore') @HttpCode(200) @RequirePermission('history', 'view')
  restore(@Auth() ctx: AuthContext, @Body() body: RestoreDto) {
    return this.service.restore(ctx, body);
  }

  /** Super Admin: archive / restore job state (also on System Health). */
  @Get('admin/history-archive/health')
  health(@Auth() ctx: AuthContext) {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Super Admin only');
    return this.service.health();
  }

  /** Super Admin: start the archive pass now instead of waiting for the night (single runner; no-op while one runs). */
  @Post('admin/history-archive/run') @HttpCode(200)
  async run(@Auth() ctx: AuthContext) {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Super Admin only');
    if (!this.service.enabled) return { started: false, reason: 'HISTORY_ARCHIVE=off' };
    if (archiveRunDeadline(Date.now(), 60_000) === null) return { started: false, reason: 'backup window (21:00-22:30 UTC)' };
    void this.service.runOnce();
    return { started: true };
  }
}
