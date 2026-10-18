import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CreateLookupDto, LookupListQuery, UpdateLookupDto } from './lookups.dto';
import { LookupsService } from './lookups.service';

@Controller('lookups')
export class LookupsController {
  constructor(private readonly service: LookupsService) {}

  @Get() @RequirePermission('lookups', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: LookupListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('lookups', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('lookups', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('lookups', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateLookupDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('lookups', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('lookups', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLookupDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('lookups', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
