import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CompanyListQuery, CreateCompanyDto, UpdateCompanyDto } from './companies.dto';
import { CompaniesService } from './companies.service';

@Controller('admin/companies')
export class CompaniesController {
  constructor(private readonly service: CompaniesService) {}

  @Get() @RequirePermission('sa_companies', 'view')
  list(@Query() query: CompanyListQuery) {
    return this.service.list(query);
  }

  @Get(':id') @RequirePermission('sa_companies', 'view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Get(':id/history') @RequirePermission('sa_companies', 'view')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(id);
  }

  @Post() @RequirePermission('sa_companies', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateCompanyDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('sa_companies', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('sa_companies', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('sa_companies', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
