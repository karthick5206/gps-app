import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CreateObjectDto, ObjectListQuery, UpdateObjectDto } from './objects.dto';
import { ObjectsService } from './objects.service';

@Controller('objects')
export class ObjectsController {
  constructor(private readonly service: ObjectsService) {}

  @Get() @RequirePermission('objects', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: ObjectListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('objects', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('objects', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('objects', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateObjectDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('objects', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('objects', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateObjectDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('objects', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
