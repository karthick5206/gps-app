import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { IoSensorsBody } from './io-sensors.dto';
import { IoSensorsService } from './io-sensors.service';

/** AC / door sensors wired to a tracker (Devices → Advanced settings). */
@Controller('devices')
export class IoSensorsController {
  constructor(private readonly service: IoSensorsService) {}

  @Get(':id/io-sensors') @RequirePermission('devices', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Put(':id/io-sensors') @RequirePermission('devices', 'edit')
  put(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IoSensorsBody) {
    return this.service.put(ctx, id, dto);
  }

  /** Attribute keys and last values on the device's recent positions (to choose and calibrate an input). */
  @Get(':id/recent-attributes') @RequirePermission('devices', 'edit')
  recent(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.recent(ctx, id);
  }
}
