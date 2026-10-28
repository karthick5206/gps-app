import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import type { PointQualityResponse, PointQualitySettingsDto } from '@veetracer/shared';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { HistoryQuery } from '../history/history.controller';
import { PointQualityService } from './point-quality.service';

class PointQualitySettingsBody {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() useInReports?: boolean;
}

@Controller()
export class PointQualityController {
  constructor(private readonly quality: PointQualityService) {}

  /** History → All points: every point of the range with its quality label, and the cleaned track. */
  @Get('objects/:id/points') @RequirePermission('history', 'view')
  points(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: HistoryQuery): Promise<PointQualityResponse> {
    return this.quality.analyze(ctx, id, q.from, q.to);
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
