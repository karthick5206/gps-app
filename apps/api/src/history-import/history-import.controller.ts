import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { HistoryImportPointsDto, HistoryImportPreviewDto, HistoryImportStartDto, MAX_POINTS } from './history-import.dto';
import { HistoryImportService } from './history-import.service';

/** Super Admin "Import old history" (Device Inventory). */
@Controller('admin/history-import')
export class HistoryImportController {
  constructor(private readonly imports: HistoryImportService) {}

  @Post('preview') @HttpCode(200) @RequirePermission('sa_device_inventory', 'create')
  preview(@Auth() ctx: AuthContext, @Body() dto: HistoryImportPreviewDto) {
    return this.imports.preview(ctx, dto);
  }

  @Get() @RequirePermission('sa_device_inventory', 'view')
  list(@Auth() ctx: AuthContext, @Query('objectId') objectId?: string) {
    return this.imports.list(ctx, objectId || undefined);
  }

  @Post() @RequirePermission('sa_device_inventory', 'create')
  start(@Auth() ctx: AuthContext, @Body() dto: HistoryImportStartDto) {
    if (dto.points > MAX_POINTS) throw new BadRequestException(`At most ${MAX_POINTS} points per file`);
    return this.imports.start(ctx, dto);
  }

  @Post(':id/points') @HttpCode(200) @RequirePermission('sa_device_inventory', 'create')
  points(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HistoryImportPointsDto) {
    return this.imports.addPoints(ctx, id, dto.rows);
  }

  @Post(':id/finish') @HttpCode(200) @RequirePermission('sa_device_inventory', 'create')
  finish(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.finish(ctx, id);
  }

  @Post(':id/road-snap') @HttpCode(200) @RequirePermission('sa_device_inventory', 'create')
  roadSnap(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.roadSnap(ctx, id);
  }

  @Post(':id/remove') @HttpCode(200) @RequirePermission('sa_device_inventory', 'delete')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.remove(ctx, id);
  }
}
