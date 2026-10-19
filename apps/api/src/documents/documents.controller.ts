import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DOCUMENT_MAX_BYTES } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { BulkActionDto } from '../common/bulk';
import { CreateDocumentDto, CreateServiceReminderDto, DocumentListQuery, ServiceDoneDto, ServiceRecordQuery, ServiceReminderListQuery, UpdateDocumentDto, UpdateServiceReminderDto } from './documents.dto';
import { DocumentsService, UploadedDocumentFile } from './documents.service';
import { ServiceRemindersService } from './service-reminders.service';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Get() @RequirePermission('documents', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: DocumentListQuery) {
    return this.service.list(ctx, query);
  }

  /** Expiring / expired documents and due services (dashboard). */
  @Get('summary') @RequirePermission('documents', 'view')
  summary(@Auth() ctx: AuthContext) {
    return this.service.summary(ctx);
  }

  @Post('bulk') @RequirePermission('documents', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Get(':id') @RequirePermission('documents', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('documents', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('documents', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateDocumentDto) {
    return this.service.create(ctx, dto);
  }

  @Patch(':id') @RequirePermission('documents', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('documents', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }

  /** Attach (or replace) the scan / photo: multipart `file`, PDF or image, at most 10 MB. */
  @Post(':id/file') @HttpCode(200) @RequirePermission('documents', 'edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }))
  attach(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: UploadedDocumentFile) {
    return this.service.attach(ctx, id, file);
  }

  @Get(':id/file') @RequirePermission('documents', 'view')
  file(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    return this.service.file(ctx, id);
  }

  @Delete(':id/file') @RequirePermission('documents', 'edit')
  detach(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.detach(ctx, id);
  }
}

@Controller('service-reminders')
export class ServiceRemindersController {
  constructor(private readonly service: ServiceRemindersService) {}

  @Get() @RequirePermission('documents', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: ServiceReminderListQuery) {
    return this.service.list(ctx, query);
  }

  /** Service history of a vehicle or a reminder. */
  @Get('records') @RequirePermission('documents', 'view')
  records(@Auth() ctx: AuthContext, @Query() query: ServiceRecordQuery) {
    return this.service.records(ctx, query);
  }

  @Get(':id') @RequirePermission('documents', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('documents', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('documents', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateServiceReminderDto) {
    return this.service.create(ctx, dto);
  }

  @Patch(':id') @RequirePermission('documents', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceReminderDto) {
    return this.service.update(ctx, id, dto);
  }

  /** Service done: history row + the reminder rolls forward. */
  @Post(':id/done') @HttpCode(200) @RequirePermission('documents', 'edit')
  done(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceDoneDto) {
    return this.service.done(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('documents', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
