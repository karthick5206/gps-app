import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { DashboardCompare, DashboardHealth, DashboardOverview, VehicleRemarkDto } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { normalizeScope, ReportScopeDto } from '../reports/reports.dto';
import { DashboardService } from './dashboard.service';

class OverviewQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) top?: number;
}

class HealthQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(43_200) inactiveAfterMin?: number;
}

class CompareBody {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to!: string;
  @IsOptional() @ValidateNested() @Type(() => ReportScopeDto) scope: ReportScopeDto = new ReportScopeDto();
}

class RemarksQuery {
  @IsUUID() objectId!: string;
}

class RemarkBody {
  @IsUUID() objectId!: string;
  @IsString() @Length(1, 500) note!: string;
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview') @RequirePermission('dashboard', 'view')
  overview(@Auth() ctx: AuthContext, @Query() q: OverviewQuery): Promise<DashboardOverview> {
    return this.dashboard.overview(ctx, q.top ?? 5);
  }

  @Get('health') @RequirePermission('dashboard', 'view')
  health(@Auth() ctx: AuthContext, @Query() q: HealthQuery): Promise<DashboardHealth> {
    return this.dashboard.health(ctx, q.inactiveAfterMin ?? 1440);
  }

  /** Consolidated figures for a date range and scope (empty scope = every vehicle the user can see). */
  @Post('compare') @HttpCode(200) @RequirePermission('dashboard', 'view')
  compare(@Auth() ctx: AuthContext, @Body() body: CompareBody): Promise<DashboardCompare> {
    return this.dashboard.compare(ctx, body.from, body.to, normalizeScope(body.scope));
  }

  @Get('remarks') @RequirePermission('dashboard', 'view')
  remarks(@Auth() ctx: AuthContext, @Query() q: RemarksQuery): Promise<VehicleRemarkDto[]> {
    return this.dashboard.remarks(ctx, q.objectId);
  }

  /** Adding a support note requires the right to edit vehicles. */
  @Post('remarks') @RequirePermission('objects', 'edit')
  addRemark(@Auth() ctx: AuthContext, @Body() body: RemarkBody): Promise<VehicleRemarkDto> {
    return this.dashboard.addRemark(ctx, body.objectId, body.note);
  }
}
