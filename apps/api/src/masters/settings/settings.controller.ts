import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { UpdateSettingsDto } from './settings.dto';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get() @RequirePermission('settings', 'view')
  get(@Auth() ctx: AuthContext) {
    return this.service.get(ctx);
  }

  @Patch() @RequirePermission('settings', 'edit')
  update(@Auth() ctx: AuthContext, @Body() dto: UpdateSettingsDto) {
    return this.service.update(ctx, dto);
  }
}
