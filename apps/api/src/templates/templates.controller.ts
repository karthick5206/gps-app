import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../access/decorators';
import { DuplicateTemplateDto, PlaceholdersQuery, PreviewTemplateDto, TemplateListQuery, TestTemplateDto, UpdateTemplateDto } from './templates.dto';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly service: TemplatesService) {}

  @Get() @RequirePermission('message_templates', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: TemplateListQuery) {
    return this.service.list(ctx, q);
  }

  @Get('placeholders') @RequirePermission('message_templates', 'view')
  placeholders(@Query() q: PlaceholdersQuery) {
    return this.service.placeholders(q.purpose);
  }

  @Post('preview') @RequirePermission('message_templates', 'view')
  preview(@Auth() ctx: AuthContext, @Body() dto: PreviewTemplateDto) {
    return this.service.preview(ctx, dto);
  }

  @Get(':id') @RequirePermission('message_templates', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/versions') @RequirePermission('message_templates', 'view')
  versions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.versions(ctx, id);
  }

  @Get(':id/history') @RequirePermission('message_templates', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Patch(':id') @RequirePermission('message_templates', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto) {
    return this.service.update(ctx, id, dto);
  }

  @Post(':id/duplicate') @RequirePermission('message_templates', 'create')
  duplicate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DuplicateTemplateDto) {
    return this.service.duplicate(ctx, id, dto);
  }

  @Post(':id/restore/:version') @RequirePermission('message_templates', 'edit')
  restore(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number) {
    return this.service.restore(ctx, id, version);
  }

  @Post(':id/reset') @RequireAnyPermission(['message_templates', 'edit'], ['message_templates', 'delete'])
  reset(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.reset(ctx, id);
  }

  @Post(':id/test') @RequirePermission('message_templates', 'view')
  test(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TestTemplateDto) {
    return this.service.test(ctx, id, dto.to);
  }

  @Delete(':id') @RequirePermission('message_templates', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
