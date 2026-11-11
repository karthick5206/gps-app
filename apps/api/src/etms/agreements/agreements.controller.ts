import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  TransportAgreementDto,
  TransportAgreementHistoryEntryDto,
  TransportAgreementSitesDto,
  TransportAgreementSummaryDto,
  TransportSiteOptionDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { AgreementViewsService } from './agreement-views.service';
import { AgreementApproveDto, AgreementCommandDto, AgreementListQuery, AgreementReasonDto, AgreementSiteOptionsQuery, CreateAgreementDto, UpdateAgreementDto } from './agreements.dto';
import { AgreementsService } from './agreements.service';

/**
 * /api/transport/agreements (doc 05 §2.1). Menu `etms_partners` + company add-on `etms` (404 when off). Row scope:
 * the acting company must be a party (Super Admin in the platform company: all, PLAT); other ids are 404. Commands also
 * need whole-company data scope (403 SCOPE_REQUIRED, R-12), checked in the service.
 */
@Controller('transport/agreements')
@UseGuards(TransportFeatureGuard)
export class AgreementsController {
  constructor(
    private readonly service: AgreementsService,
    private readonly views: AgreementViewsService,
  ) {}

  @Get() @RequirePermission('etms_partners', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: AgreementListQuery) {
    return this.service.list(ctx, query);
  }

  /** Dashboard counts per status + "awaiting my approval" in one request (declared before `:id`). */
  @Get('summary') @RequirePermission('etms_partners', 'view')
  summary(@Auth() ctx: AuthContext): Promise<TransportAgreementSummaryDto> {
    return this.views.summary(ctx);
  }

  /** The acting company's own places for the agreement site picker; no `pois` permission needed. */
  @Get('site-options') @RequireAnyPermission(['etms_partners', 'edit'], ['etms_partners', 'create'])
  siteOptions(@Auth() ctx: AuthContext, @Query() query: AgreementSiteOptionsQuery): Promise<TransportSiteOptionDto[]> {
    return this.views.siteOptions(ctx, query.q, query.customerCompanyId);
  }

  @Get(':id') @RequirePermission('etms_partners', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportAgreementDto> {
    return this.service.get(ctx, id);
  }

  /** Names of the customer sites the agreement is limited to (parties only; "all sites" lists nothing). */
  @Get(':id/sites') @RequirePermission('etms_partners', 'view')
  sites(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportAgreementSitesDto> {
    return this.views.sites(ctx, id);
  }

  /** Full history from the audit log; other-party actors appear by side only. */
  @Get(':id/history') @RequirePermission('etms_partners', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportAgreementHistoryEntryDto[]> {
    return this.views.history(ctx, id);
  }

  @Post() @RequirePermission('etms_partners', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateAgreementDto): Promise<TransportAgreementDto> {
    return this.service.create(ctx, dto);
  }

  @Patch(':id') @RequirePermission('etms_partners', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAgreementDto): Promise<TransportAgreementDto> {
    return this.service.update(ctx, id, dto);
  }

  @Post(':id/propose') @RequirePermission('etms_partners', 'edit')
  propose(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AgreementCommandDto): Promise<TransportAgreementDto> {
    return this.service.propose(ctx, id, dto.expectedVersion, dto.reason);
  }

  /** Approves the caller's own side; ACTIVE once both sides approved. Never the Super Admin (P1). */
  @Post(':id/approve') @RequirePermission('etms_partners', 'edit')
  approve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AgreementApproveDto): Promise<TransportAgreementDto> {
    return this.service.approve(ctx, id, dto.expectedVersion);
  }

  @Post(':id/suspend') @RequirePermission('etms_partners', 'edit')
  suspend(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AgreementReasonDto): Promise<TransportAgreementDto> {
    return this.service.suspend(ctx, id, dto.reason, dto.expectedVersion);
  }

  @Post(':id/resume') @RequirePermission('etms_partners', 'edit')
  resume(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AgreementCommandDto): Promise<TransportAgreementDto> {
    return this.service.resume(ctx, id, dto.expectedVersion);
  }

  /** Ends the agreement for good (doc 05 "/end"; the brief's "terminate"). */
  @Post(':id/end') @RequirePermission('etms_partners', 'edit')
  end(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AgreementReasonDto): Promise<TransportAgreementDto> {
    return this.service.end(ctx, id, dto.reason, dto.expectedVersion);
  }
}
