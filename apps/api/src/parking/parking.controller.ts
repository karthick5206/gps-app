import { Body, Controller, Get, Put } from '@nestjs/common';
import type { ParkingRowDto } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { ParkingService } from './parking.service';

class ParkingWindowBody {
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
  @IsInt() @Min(0) @Max(1439) startMin!: number;
  @IsInt() @Min(0) @Max(1439) endMin!: number;
}

class ParkingSaveBody {
  /** One vehicle, or several at once (the same schedule on each). */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) objectIds!: string[];
  @IsBoolean() enabled!: boolean;
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ParkingWindowBody) windows!: ParkingWindowBody[];
  @IsBoolean() alarmAllAlerts!: boolean;
}

/** Parking mode (spy mode): weekly armed windows per vehicle; alerts while armed ring as an alarm. */
@Controller('parking-mode')
export class ParkingController {
  constructor(private readonly parking: ParkingService) {}

  @Get() @RequirePermission('parking_mode', 'view')
  list(@Auth() ctx: AuthContext): Promise<ParkingRowDto[]> {
    return this.parking.list(ctx);
  }

  @Put() @RequirePermission('parking_mode', 'edit')
  save(@Auth() ctx: AuthContext, @Body() body: ParkingSaveBody): Promise<ParkingRowDto[]> {
    return this.parking.save(ctx, body.objectIds, { enabled: body.enabled, windows: body.windows, alarmAllAlerts: body.alarmAllAlerts });
  }
}
