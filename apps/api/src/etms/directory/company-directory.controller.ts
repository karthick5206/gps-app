import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TransportCompanyLookupDto } from '@veetracer/shared';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { CompanyDirectoryService } from './company-directory.service';

export class CompanyLookupQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/**
 * /api/transport/companies (E1a gap 1): partner lookup for users who draft agreements (`etms_partners:create`, company
 * add-on `etms`). Returns only id, name and city of ETMS companies; see CompanyDirectoryService for the privacy rules.
 */
@Controller('transport/companies')
@UseGuards(TransportFeatureGuard)
export class CompanyDirectoryController {
  constructor(private readonly service: CompanyDirectoryService) {}

  @Get('lookup') @RequirePermission('etms_partners', 'create')
  lookup(@Auth() ctx: AuthContext, @Query() query: CompanyLookupQuery): Promise<TransportCompanyLookupDto[]> {
    return this.service.lookup(ctx, query.q);
  }
}
