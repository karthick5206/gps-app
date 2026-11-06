import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { PointQualityResponse, PointQualitySettingsDto, PointRemoveResult } from '@veetracer/shared';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { HistoryQuery } from '../history/history.controller';
import { PointQualityService } from './point-quality.service';

class PointQualitySettingsBody {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() useInReports?: boolean;
}

class PointRemoveBody {
  @IsInt() @Min(0) t!: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller()
export class PointQualityController {
  constructor(private readonly quality: PointQualityService) {}

  /** History → All points: every point of the range with its quality label, and the cleaned track. */
  @Get('objects/:id/points') @RequirePermission('history', 'view')
  points(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: HistoryQuery): Promise<PointQualityResponse> {
    return this.quality.analyze(ctx, id, q.from, q.to);
  }

  /** Super Admin: remove one stored point (History, trips, distance, reports leave it out; kept for Restore). */
  @Post('objects/:id/points/remove') @HttpCode(200)
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PointRemoveBody): Promise<PointRemoveResult> {
    return this.quality.removePoint(ctx, id, body.t, body.reason ?? '');
  }

  /** Super Admin: put a removed point back. */
  @Post('objects/:id/points/restore') @HttpCode(200)
  restore(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PointRemoveBody): Promise<PointRemoveResult> {
    return this.quality.restorePoint(ctx, id, body.t);
  }

  /** Whether the feature is on (any signed-in user: the History page shows or hides the option). */
  @Get('point-quality/settings')
  settings(): Promise<PointQualitySettingsDto> {
    return this.quality.settings();
  }

  /** Super Admin: switch the analysis, and its use in trips / distance, on or off for everyone. */
  @Put('point-quality/settings')
  setSettings(@Auth() ctx: AuthContext, @Body() body: PointQualitySettingsBody): Promise<PointQualitySettingsDto> {
    return this.quality.setSettings(ctx, body);
  }
}
