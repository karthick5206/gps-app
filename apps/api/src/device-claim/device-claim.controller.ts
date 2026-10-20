import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { loadEnv } from '../config/env';
import { LicenceSettingsService } from '../licences/licence-settings.service';
import { ClaimDeviceBody, HelpSheetQuery, ShipDeviceBody } from './device-claim.dto';
import { DeviceClaimService } from './device-claim.service';
import { renderHelpSheet } from './help-sheet-pdf';

/** Customers add a tracker they received (claim code) or bought elsewhere (seen by our server in the last 24 h). */
@Controller('devices/claim')
export class DeviceClaimController {
  constructor(private readonly service: DeviceClaimService) {}

  @Get(':uniqueId') @RequirePermission('devices', 'create')
  lookup(@Auth() ctx: AuthContext, @Param('uniqueId') uniqueId: string) {
    return this.service.lookup(ctx, uniqueId);
  }

  @Post() @HttpCode(200) @RequirePermission('devices', 'create')
  claim(@Auth() ctx: AuthContext, @Body() body: ClaimDeviceBody) {
    return this.service.claim(ctx, body);
  }
}

/** Super Admin: reserve stock devices for a customer, print the help sheet for the box, follow up on activation. */
@Controller('admin/shipments')
export class ShipmentsController {
  constructor(
    private readonly service: DeviceClaimService,
    private readonly settings: LicenceSettingsService,
  ) {}

  @Get() @RequirePermission('sa_device_inventory', 'view')
  list() {
    return this.service.shipments();
  }

  @Post(':deviceId') @HttpCode(200) @RequirePermission('sa_device_inventory', 'edit')
  ship(@Auth() ctx: AuthContext, @Param('deviceId', ParseUUIDPipe) id: string, @Body() body: ShipDeviceBody) {
    return this.service.ship(ctx, id, body);
  }

  @Delete(':deviceId') @HttpCode(204) @RequirePermission('sa_device_inventory', 'edit')
  async unship(@Auth() ctx: AuthContext, @Param('deviceId', ParseUUIDPipe) id: string) {
    await this.service.unship(ctx, id);
  }

  @Get('help-sheet/pdf') @RequirePermission('sa_device_inventory', 'view')
  async helpSheet(@Query() q: HelpSheetQuery) {
    const ids = q.ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length || ids.length > 100) throw new BadRequestException('Choose 1–100 devices');
    const sheets = await Promise.all(ids.map((id) => this.service.shipment(id)));
    const s = await this.settings.get();
    const pdf = await renderHelpSheet(sheets, loadEnv().webUrl, { name: s.legalName || 'VeeTrax', phone: s.phone || null, email: s.email || null, website: s.website || null }, await this.settings.logo());
    const name = sheets.length === 1 ? `VeeTrax-help-${sheets[0].uniqueId}.pdf` : `VeeTrax-help-${sheets.length}-devices.pdf`;
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="${name}"` });
  }
}
