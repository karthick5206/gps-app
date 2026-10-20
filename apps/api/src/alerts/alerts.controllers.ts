import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../access/decorators';
import { AckAllDto, AckDto, AlertListQuery, ReadAllDto } from './alerts/alerts.dto';
import { AlertsService } from './alerts/alerts.service';
import { RecipientListQuery, PutRecipientListDto, ResolveRecipientsQuery, TestRecipientsDto } from './recipients/recipient-lists.dto';
import { RecipientListsService } from './recipients/recipient-lists.service';
import { BulkEnableDto, CopySettingsDto, LevelTargetQuery, ObjectQuery, OptionalLevelTargetQuery, PutAlertSettingDto } from './settings/alert-settings.dto';
import { AlertSettingsService } from './settings/alert-settings.service';
import { ApplyPackDto, CreatePackDto, CreateSnoozeDto, SnoozeQuery, UpdatePackDto } from './snoozes-packs/snoozes-packs.dto';
import { SnoozesPacksService } from './snoozes-packs/snoozes-packs.service';

@Controller('alert-types')
export class AlertTypesController {
  constructor(private readonly settings: AlertSettingsService) {}

  /** Any logged-in user. */
  @Get()
  list(@Auth() ctx: AuthContext) {
    return this.settings.alertTypes(ctx);
  }
}

@Controller('alert-settings')
export class AlertSettingsController {
  constructor(private readonly settings: AlertSettingsService) {}

  @Get() @RequirePermission('alert_settings', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: LevelTargetQuery) {
    return this.settings.list(ctx, q.level, q.targetId);
  }

  @Get('effective') @RequirePermission('alert_settings', 'view')
  effective(@Auth() ctx: AuthContext, @Query() q: ObjectQuery) {
    return this.settings.effective(ctx, q.objectId);
  }

  @Get('conflicts') @RequirePermission('alert_settings', 'view')
  conflicts(@Auth() ctx: AuthContext, @Query() q: ObjectQuery) {
    return this.settings.conflicts(ctx, q.objectId);
  }

  @Get('history') @RequirePermission('alert_settings', 'view')
  history(@Auth() ctx: AuthContext, @Query() q: OptionalLevelTargetQuery) {
    return this.settings.history(ctx, q.level, q.targetId);
  }

  @Put() @RequireAnyPermission(['alert_settings', 'edit'], ['alert_settings', 'create'])
  put(@Auth() ctx: AuthContext, @Body() dto: PutAlertSettingDto) {
    return this.settings.put(ctx, dto);
  }

  @Post('copy') @RequirePermission('alert_settings', 'edit')
  copy(@Auth() ctx: AuthContext, @Body() dto: CopySettingsDto) {
    return this.settings.copy(ctx, dto);
  }

  @Post('bulk-enable') @RequirePermission('alert_settings', 'edit')
  bulkEnable(@Auth() ctx: AuthContext, @Body() dto: BulkEnableDto) {
    return this.settings.bulkEnable(ctx, dto);
  }

  @Delete(':id') @RequireAnyPermission(['alert_settings', 'edit'], ['alert_settings', 'delete'])
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.settings.remove(ctx, id);
    return { ok: true };
  }
}

@Controller('recipient-lists')
export class RecipientListsController {
  constructor(private readonly lists: RecipientListsService) {}

  @Get() @RequirePermission('alert_settings', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: RecipientListQuery) {
    return this.lists.list(ctx, q.level, q.targetId);
  }

  @Get('resolve') @RequirePermission('alert_settings', 'view')
  resolve(@Auth() ctx: AuthContext, @Query() q: ResolveRecipientsQuery) {
    return this.lists.resolve(ctx, q.objectId, q.alertType, q.severity);
  }

  @Post('test') @RequirePermission('alert_settings', 'edit')
  test(@Auth() ctx: AuthContext, @Body() dto: TestRecipientsDto) {
    return this.lists.test(ctx, dto.objectId, dto.alertType, dto.severity);
  }

  @Put() @RequireAnyPermission(['alert_settings', 'edit'], ['alert_settings', 'create'])
  put(@Auth() ctx: AuthContext, @Body() dto: PutRecipientListDto) {
    return this.lists.put(ctx, dto);
  }

  @Delete(':id') @RequireAnyPermission(['alert_settings', 'edit'], ['alert_settings', 'delete'])
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.lists.remove(ctx, id);
    return { ok: true };
  }
}

@Controller('alert-snoozes')
export class AlertSnoozesController {
  constructor(private readonly service: SnoozesPacksService) {}

  @Get() @RequirePermission('alert_settings', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: SnoozeQuery) {
    return this.service.listSnoozes(ctx, q.level, q.targetId, q.includeExpired);
  }

  @Post() @RequireAnyPermission(['alert_settings', 'create'], ['alert_settings', 'edit'])
  create(@Auth() ctx: AuthContext, @Body() dto: CreateSnoozeDto) {
    return this.service.createSnooze(ctx, dto);
  }

  @Delete(':id') @RequireAnyPermission(['alert_settings', 'edit'], ['alert_settings', 'delete'])
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.removeSnooze(ctx, id);
    return { ok: true };
  }
}

@Controller('alert-packs')
export class AlertPacksController {
  constructor(private readonly service: SnoozesPacksService) {}

  @Get() @RequirePermission('alert_settings', 'view')
  list(@Auth() ctx: AuthContext) {
    return this.service.listPacks(ctx);
  }

  @Post() @RequirePermission('alert_settings', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreatePackDto) {
    return this.service.createPack(ctx, dto);
  }

  @Post(':id/apply') @RequirePermission('alert_settings', 'edit')
  apply(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyPackDto) {
    return this.service.applyPack(ctx, id, dto);
  }

  @Patch(':id') @RequirePermission('alert_settings', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePackDto) {
    return this.service.updatePack(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('alert_settings', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.removePack(ctx, id);
    return { ok: true };
  }
}

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get() @RequirePermission('alerts', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: AlertListQuery) {
    return this.alerts.list(ctx, q);
  }

  @Get('unread-count') @RequirePermission('alerts', 'view')
  unread(@Auth() ctx: AuthContext) {
    return this.alerts.unreadCount(ctx);
  }

  /** Marks the given alerts read for the caller, or all of them up to now (no `ids`). */
  @Post('read-all') @HttpCode(200) @RequirePermission('alerts', 'view')
  readAll(@Auth() ctx: AuthContext, @Body() dto: ReadAllDto) {
    return this.alerts.readAll(ctx, dto);
  }

  @Post('ack-all') @RequirePermission('alerts', 'edit')
  ackAll(@Auth() ctx: AuthContext, @Body() dto: AckAllDto) {
    return this.alerts.ackAll(ctx, dto);
  }

  @Get(':id') @RequirePermission('alerts', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.get(ctx, id);
  }

  @Get(':id/notifications') @RequirePermission('alerts', 'view')
  notifications(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.notifications(ctx, id);
  }

  /** Opening an alert: read for the caller only (idempotent). Acknowledging stays a separate, shared action. */
  @Post(':id/read') @HttpCode(200) @RequirePermission('alerts', 'view')
  read(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.markRead(ctx, id);
  }

  @Post(':id/ack') @RequirePermission('alerts', 'edit')
  ack(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AckDto) {
    return this.alerts.ack(ctx, id, dto.note);
  }
}
