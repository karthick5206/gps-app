import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import type { RoutingPlatformSwitchDto } from '@veetracer/shared';
import { IsBoolean } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { RoutingSwitchService } from './routing-switch.service';

class RoutingSwitchBody {
  @IsBoolean() enabled!: boolean;
}

/**
 * /api/admin/routing — v1.16 platform switch "Automatic route planning" (Super Admin only: menu sa_platform_settings and
 * an explicit Super Admin check). GET shows the switch, the env kill switch and the readiness checklist (`?refresh=1`
 * re-probes now); PUT { enabled } switches it, ON only when every readiness item passes (409 ROUTING_NOT_READY).
 */
@Controller('admin/routing')
export class RoutingSwitchController {
  constructor(private readonly switches: RoutingSwitchService) {}

  @Get() @RequirePermission('sa_platform_settings', 'view')
  get(@Auth() ctx: AuthContext, @Query('refresh') refresh?: string): Promise<RoutingPlatformSwitchDto> {
    return this.switches.get(ctx, refresh === '1' || refresh === 'true');
  }

  @Put() @RequirePermission('sa_platform_settings', 'edit')
  set(@Auth() ctx: AuthContext, @Body() body: RoutingSwitchBody): Promise<RoutingPlatformSwitchDto> {
    return this.switches.set(ctx, body.enabled);
  }
}
