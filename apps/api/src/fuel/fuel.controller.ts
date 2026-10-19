import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { FuelConfigBody, FuelEventsQuery } from './fuel.dto';
import { FuelService } from './fuel.service';

@Controller()
export class FuelController {
  constructor(private readonly service: FuelService) {}

  /** Fuel sensor settings of a vehicle (defaults when never configured). */
  @Get('objects/:id/fuel') @RequirePermission('objects', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Put('objects/:id/fuel') @RequirePermission('objects', 'edit')
  put(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FuelConfigBody) {
    return this.service.put(ctx, id, dto);
  }

  /** Detected refills and drains (newest first, at most 2000). */
  @Get('fuel-events') @RequirePermission('reports', 'view')
  events(@Auth() ctx: AuthContext, @Query() q: FuelEventsQuery) {
    return this.service.events(ctx, q);
  }
}
