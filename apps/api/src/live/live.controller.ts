import { Controller, Get } from '@nestjs/common';
import { DashboardSummary, LiveObject, VehicleDayStatsDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { LiveService } from './live.service';

@Controller()
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Get('live') @RequirePermission('live_map', 'view')
  snapshot(@Auth() ctx: AuthContext): Promise<LiveObject[]> {
    return this.live.snapshot(ctx);
  }

  /** Vehicle list / map card: today's distance, moving / idle time, stops, max speed, current trip and odometer. */
  @Get('live/day-stats') @RequirePermission('live_map', 'view')
  dayStats(@Auth() ctx: AuthContext): Promise<Record<string, VehicleDayStatsDto>> {
    return this.live.dayStats(ctx);
  }

  @Get('dashboard/summary') @RequirePermission('dashboard', 'view')
  summary(@Auth() ctx: AuthContext): Promise<DashboardSummary> {
    return this.live.summary(ctx);
  }
}
