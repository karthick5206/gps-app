import { Controller, Get, Query } from '@nestjs/common';
import type { DriverScoresDto, ScoreBy, ScorePeriod } from '@veetracer/shared';
import { IsIn, IsOptional } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { DriverScoresService } from './driver-scores.service';

class ScoresQuery {
  @IsOptional() @IsIn(['week', 'lastWeek', 'month', 'lastMonth']) period?: ScorePeriod;
  @IsOptional() @IsIn(['driver', 'vehicle']) by?: ScoreBy;
}

/** Driver scorecard / leaderboard. */
@Controller('driver-scores')
export class DriverScoresController {
  constructor(private readonly scores: DriverScoresService) {}

  @Get() @RequirePermission('driver_scores', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: ScoresQuery): Promise<DriverScoresDto> {
    return this.scores.scores(ctx, q.period ?? 'week', q.by ?? 'driver');
  }
}
