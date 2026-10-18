import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CreateRoleDto, RoleListQuery, UpdateRoleDto } from './roles.dto';
import { RolesService } from './roles.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly service: RolesService) {}

  /** Also readable by user managers so the user form can offer roles to assign. */
  @Get() @RequireAnyPermission(['roles', 'view'], ['users', 'create'], ['users', 'edit'])
  list(@Auth() ctx: AuthContext, @Query() query: RoleListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('roles', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('roles', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('roles', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateRoleDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('roles', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('roles', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('roles', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
