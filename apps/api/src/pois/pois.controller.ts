import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { POI_IMPORT_MAX_BYTES } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { BulkActionDto } from '../common/bulk';
import { CreatePoiDto, ExportQuery, ImportCommitDto, PoiListQuery, UpdatePoiDto } from './pois.dto';
import { PoisService } from './pois.service';

@Controller('pois')
export class PoisController {
  constructor(private readonly service: PoisService) {}

  @Get() @RequirePermission('pois', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: PoiListQuery) {
    return this.service.list(ctx, query);
  }

  /** POIs (and geofences, with geofences:view) as a KML or GeoJSON download. */
  @Get('export') @RequirePermission('pois', 'export')
  export(@Auth() ctx: AuthContext, @Query() query: ExportQuery): Promise<StreamableFile> {
    return this.service.export(ctx, query);
  }

  /** Step 1: parse a KML / KMZ / GPX / GeoJSON / CSV upload (multipart `file`, ≤ 5 MB) without saving anything. */
  @Post('import/preview') @HttpCode(200) @RequirePermission('pois', 'create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: POI_IMPORT_MAX_BYTES, files: 1 } }))
  preview(@UploadedFile() file?: { buffer: Buffer; originalname?: string }) {
    return this.service.preview(file);
  }

  /** Step 2: save the selected items of the preview. */
  @Post('import/commit') @RequirePermission('pois', 'create')
  commit(@Auth() ctx: AuthContext, @Body() dto: ImportCommitDto) {
    return this.service.commit(ctx, dto);
  }

  @Post('bulk') @RequirePermission('pois', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Get(':id') @RequirePermission('pois', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('pois', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('pois', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreatePoiDto) {
    return this.service.create(ctx, dto);
  }

  @Patch(':id') @RequirePermission('pois', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePoiDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('pois', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
