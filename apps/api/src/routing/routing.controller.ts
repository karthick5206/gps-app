import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { GapEstimateResponse, MAX_GAP_ESTIMATES } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsNumber, Max, Min, ValidateNested } from 'class-validator';
import { RequirePermission } from '../access/decorators';
import { RoutingService } from './routing.service';

class GapSegmentBody {
  @IsNumber() @Min(-90) @Max(90) fromLat!: number;
  @IsNumber() @Min(-180) @Max(180) fromLng!: number;
  @IsNumber() @Min(-90) @Max(90) toLat!: number;
  @IsNumber() @Min(-180) @Max(180) toLng!: number;
  @IsNumber() @Min(0) @Max(31 * 86_400) seconds!: number;
}

export class GapEstimateBody {
  @IsArray() @ArrayMaxSize(MAX_GAP_ESTIMATES) @ValidateNested({ each: true }) @Type(() => GapSegmentBody) segments!: GapSegmentBody[];
}

@Controller('routing')
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  /** Likely roads through History's data gaps (drawn dashed as "estimated"); `enabled: false` without an engine. */
  @Post('estimate-gaps') @HttpCode(200) @RequirePermission('history', 'view')
  estimateGaps(@Body() body: GapEstimateBody): Promise<GapEstimateResponse> {
    return this.routing.estimateGaps(body.segments);
  }
}
