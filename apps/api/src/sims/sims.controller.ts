import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { AssetLinksService } from './asset-links.service';
import { SIM_IMPORT_TEMPLATE_HEADER } from './sim-csv';
import {
  CreatePlanDto,
  CreateProviderDto,
  CreateSimDto,
  PlanListQuery,
  ProviderListQuery,
  RenewalQuery,
  SimAssignDto,
  SimEventListQuery,
  SimImportDto,
  SimListQuery,
  SimRenewDto,
  SimStatusDto,
  SimUnassignDto,
  SimUsageDto,
  UpdatePlanDto,
  UpdateProviderDto,
  UpdateSimDto,
} from './sims.dto';
import { SimsService } from './sims.service';

/** Platform → SIM Cards (Super Admin only: menu `sa_sim_cards` is superAdminOnly, never granted to a role). */
@Controller('sims')
export class SimsController {
  constructor(private readonly sims: SimsService) {}

  // Providers
  @Get('providers') @RequirePermission('sa_sim_cards', 'view')
  listProviders(@Query() q: ProviderListQuery) {
    return this.sims.listProviders(q);
  }
  @Get('providers/:id') @RequirePermission('sa_sim_cards', 'view')
  getProvider(@Param('id', ParseUUIDPipe) id: string) {
    return this.sims.getProvider(id);
  }
  @Post('providers') @RequirePermission('sa_sim_cards', 'create')
  createProvider(@Auth() ctx: AuthContext, @Body() dto: CreateProviderDto) {
    return this.sims.createProvider(ctx, dto);
  }
  @Patch('providers/:id') @RequirePermission('sa_sim_cards', 'edit')
  updateProvider(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProviderDto) {
    return this.sims.updateProvider(ctx, id, dto);
  }
  @Delete('providers/:id') @RequirePermission('sa_sim_cards', 'delete')
  async removeProvider(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.sims.removeProvider(ctx, id);
    return { ok: true };
  }

  // Plans
  @Get('plans') @RequirePermission('sa_sim_cards', 'view')
  listPlans(@Query() q: PlanListQuery) {
    return this.sims.listPlans(q);
  }
  @Get('plans/:id') @RequirePermission('sa_sim_cards', 'view')
  getPlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.sims.getPlan(id);
  }
  @Post('plans') @RequirePermission('sa_sim_cards', 'create')
  createPlan(@Auth() ctx: AuthContext, @Body() dto: CreatePlanDto) {
    return this.sims.createPlan(ctx, dto);
  }
  @Patch('plans/:id') @RequirePermission('sa_sim_cards', 'edit')
  updatePlan(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto) {
    return this.sims.updatePlan(ctx, id, dto);
  }
  @Delete('plans/:id') @RequirePermission('sa_sim_cards', 'delete')
  async removePlan(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.sims.removePlan(ctx, id);
    return { ok: true };
  }

  // Reports
  @Get('summary') @RequirePermission('sa_sim_cards', 'view')
  summary() {
    return this.sims.summary();
  }
  @Get('renewals') @RequirePermission('sa_sim_cards', 'view')
  renewals(@Query() q: RenewalQuery) {
    return this.sims.renewals(q);
  }
  @Get('events') @RequirePermission('sa_sim_cards', 'view')
  events(@Query() q: SimEventListQuery) {
    return this.sims.events(q);
  }

  // CSV import (dry-run by default)
  @Get('import/template') @RequirePermission('sa_sim_cards', 'view')
  importTemplate() {
    return new StreamableFile(Buffer.from(`${SIM_IMPORT_TEMPLATE_HEADER}\r\n`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="sim-import-template.csv"',
    });
  }
  @Post('import') @HttpCode(200) @RequirePermission('sa_sim_cards', 'create')
  importCsv(@Auth() ctx: AuthContext, @Body() dto: SimImportDto) {
    return this.sims.importCsv(ctx, dto);
  }

  // SIM cards (list supports ?format=csv, which also needs `export`)
  @Get() @RequirePermission('sa_sim_cards', 'view')
  list(@Query() q: SimListQuery) {
    return this.sims.list(q);
  }
  @Get(':id') @RequirePermission('sa_sim_cards', 'view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sims.get(id);
  }
  @Post() @RequirePermission('sa_sim_cards', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateSimDto) {
    return this.sims.create(ctx, dto);
  }
  @Patch(':id') @RequirePermission('sa_sim_cards', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSimDto) {
    return this.sims.update(ctx, id, dto);
  }
  @Delete(':id') @RequirePermission('sa_sim_cards', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.sims.remove(ctx, id);
    return { ok: true };
  }
  @Post(':id/status') @HttpCode(200) @RequirePermission('sa_sim_cards', 'edit')
  status(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SimStatusDto) {
    return this.sims.changeStatus(ctx, id, dto);
  }
  @Post(':id/assign') @HttpCode(200) @RequirePermission('sa_sim_cards', 'edit')
  assign(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SimAssignDto) {
    return this.sims.assign(ctx, id, dto);
  }
  @Post(':id/unassign') @HttpCode(200) @RequirePermission('sa_sim_cards', 'edit')
  unassign(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SimUnassignDto) {
    return this.sims.unassign(ctx, id, dto);
  }
  @Post(':id/renew') @HttpCode(200) @RequirePermission('sa_sim_cards', 'edit')
  renew(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SimRenewDto) {
    return this.sims.renew(ctx, id, dto);
  }
  @Get(':id/assignments') @RequirePermission('sa_sim_cards', 'view')
  assignments(@Param('id', ParseUUIDPipe) id: string) {
    return this.sims.assignments(id);
  }
  @Get(':id/usage') @RequirePermission('sa_sim_cards', 'view')
  usage(@Param('id', ParseUUIDPipe) id: string) {
    return this.sims.usage(id);
  }
  @Post(':id/usage') @RequirePermission('sa_sim_cards', 'edit')
  addUsage(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SimUsageDto) {
    return this.sims.addUsage(ctx, id, dto);
  }
}

/** Customer portal, read-only: devices fitted to an own vehicle and their SIM (tenant-scoped; QI-21 flag for SIM data). */
@Controller('asset-links')
export class AssetLinksController {
  constructor(private readonly links: AssetLinksService) {}

  @Get('objects/:objectId') @RequirePermission('objects', 'view')
  forObject(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string) {
    return this.links.forObject(ctx, objectId);
  }

  @Get('devices/:deviceId') @RequirePermission('devices', 'view')
  forDevice(@Auth() ctx: AuthContext, @Param('deviceId', ParseUUIDPipe) deviceId: string) {
    return this.links.forDevice(ctx, deviceId);
  }
}
