import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CreateGeofenceDto, GeofenceListQuery, ImportGeofencesDto, UpdateGeofenceDto, VisitsQuery } from './geofences.dto';
import { GeofencesService } from './geofences.service';

@Controller('geofences')
export class GeofencesController {
  constructor(private readonly service: GeofencesService) {}

  @Get() @RequirePermission('geofences', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: GeofenceListQuery) {
    return this.service.list(ctx, query);
  }

  @Post('import') @RequirePermission('geofences', 'create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  import(@Auth() ctx: AuthContext, @Body() dto: ImportGeofencesDto, @UploadedFile() file?: { buffer: Buffer; originalname?: string }) {
    return this.service.import(ctx, dto, file);
  }

  @Post('bulk') @RequirePermission('geofences', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Get(':id') @RequirePermission('geofences', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('geofences', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Get(':id/visits') @RequirePermission('geofences', 'view')
  visits(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: VisitsQuery) {
    return this.service.visits(ctx, id, q.from, q.to, q.objectId);
  }

  @Post() @RequirePermission('geofences', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateGeofenceDto) {
    return this.service.create(ctx, dto);
  }

  @Patch(':id') @RequirePermission('geofences', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGeofenceDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('geofences', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
