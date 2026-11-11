import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import type { TransportSettingsDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { TransportSettingsService, UpdateTransportSettingsDto } from './transport-settings.service';

/** /api/transport/settings: company-level ETMS settings (menu `etms_settings`, company add-on `etms`; 404 when off). */
@Controller('transport/settings')
@UseGuards(TransportFeatureGuard)
export class TransportSettingsController {
  constructor(private readonly service: TransportSettingsService) {}

  @Get() @RequirePermission('etms_settings', 'view')
  get(@Auth() ctx: AuthContext): Promise<TransportSettingsDto> {
    return this.service.get(ctx);
  }

  @Patch() @RequirePermission('etms_settings', 'edit')
  update(@Auth() ctx: AuthContext, @Body() dto: UpdateTransportSettingsDto): Promise<TransportSettingsDto> {
    return this.service.update(ctx, dto);
  }
}
