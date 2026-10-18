import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { BranchListQuery, CreateBranchDto, UpdateBranchDto } from './branches.dto';
import { BranchesService } from './branches.service';

@Controller('branches')
export class BranchesController {
  constructor(private readonly service: BranchesService) {}

  @Get() @RequirePermission('branches', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: BranchListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('branches', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('branches', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('branches', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateBranchDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('branches', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('branches', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('branches', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
