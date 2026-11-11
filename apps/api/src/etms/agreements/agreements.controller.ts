import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { TransportAgreementDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { AgreementCommandDto, AgreementListQuery, AgreementReasonDto, CreateAgreementDto, UpdateAgreementDto } from './agreements.dto';
import { AgreementsService } from './agreements.service';

/**
 * /api/transport/agreements (doc 05 §2.1). Menu `etms_partners` + company add-on `etms` (404 when off). Row scope:
 * the acting company must be a party (Super Admin in the platform company: all, PLAT); other ids are 404.
 */
@Controller('transport/agreements')
@UseGuards(TransportFeatureGuard)
export class AgreementsController {
  constructor(private readonly service: AgreementsService) {}

  @Get() @RequirePermission('etms_partners', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: AgreementListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('etms_partners', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportAgreementDto> {
    return this.service.get(ctx, id);
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
    return this.service.propose(ctx, id, dto.expectedVersion);
  }

  /** Approves the caller's own side; ACTIVE once both sides approved. */
  @Post(':id/approve') @RequirePermission('etms_partners', 'edit')
  approve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AgreementCommandDto): Promise<TransportAgreementDto> {
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
