import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { AuditService } from '../audit/audit.service';
import { BillingService, Owner } from './billing.service';
import { InvoicesService } from './invoices.service';
import { LicenceSettingsService } from './licence-settings.service';
import { pdfFile } from './licences.controller';
import {
  AllocateDto,
  BillingProfileBody,
  CompanyPartnerDto,
  GrantDto,
  InvoiceQuery,
  InvoicingDto,
  MonthQuery,
  OfflinePaymentDto,
  PartnerCreateDto,
  PartnerUpdateDto,
  PricingDto,
  PurchaseDto,
} from './licences.dto';
import { PartnersService } from './partners.service';
import { PoolsService } from './pools.service';

/** Super Admin: every licence pool, offline payments, complimentary grants, partners, invoices and GST summaries. */
@Controller('licences/admin')
export class LicencesAdminController {
  constructor(
    private readonly billing: BillingService,
    private readonly pools: PoolsService,
    private readonly partners: PartnersService,
    private readonly invoices: InvoicesService,
  ) {}

  private owner(kind: string, id: string): Promise<Owner> {
    if (kind === 'company') return this.billing.companyOwner(id);
    if (kind === 'partner') return this.billing.partnerOwner(id);
    throw new BadRequestException('Pool kind must be company or partner');
  }

  @Get('pools') @RequirePermission('sa_licences', 'view')
  pools_() {
    return this.partners.allPools();
  }

  @Get('pools/:kind/:id') @RequirePermission('sa_licences', 'view')
  async pool(@Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string) {
    const owner = await this.owner(kind, id);
    const overview = await this.billing.overview(owner);
    return owner.kind === 'PARTNER' ? { ...overview, customers: await this.partners.customers(owner.id) } : overview;
  }

  @Put('pools/:kind/:id/billing-profile') @RequirePermission('sa_licences', 'edit')
  async profile(@Auth() ctx: AuthContext, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BillingProfileBody) {
    return this.billing.saveProfile(ctx, await this.owner(kind, id), dto);
  }

  @Post('pools/:kind/:id/quote') @HttpCode(200) @RequirePermission('sa_licences', 'view')
  async quote(@Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PurchaseDto) {
    return this.billing.quote(await this.owner(kind, id), dto);
  }

  @Post('pools/:kind/:id/payments') @RequirePermission('sa_licences', 'create')
  async payment(@Auth() ctx: AuthContext, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OfflinePaymentDto) {
    return this.billing.recordOffline(ctx, await this.owner(kind, id), dto);
  }

  @Post('pools/:kind/:id/grant') @RequirePermission('sa_licences', 'create')
  async grant(@Auth() ctx: AuthContext, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GrantDto) {
    const owner = await this.owner(kind, id);
    return { granted: await this.pools.grant(ctx, owner.kind === 'COMPANY' ? { companyId: owner.id } : { partnerId: owner.id }, dto.type, dto.quantity, dto.days, dto.reason) };
  }

  @Post('partners/:id/allocate') @HttpCode(200) @RequirePermission('sa_licences', 'edit')
  async allocate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AllocateDto) {
    return { allocated: await this.pools.allocate(ctx, id, dto.companyId, dto.type, dto.quantity) };
  }

  @Get('partners') @RequirePermission('sa_licences', 'view')
  partnersList() {
    return this.partners.partners();
  }

  @Post('partners') @RequirePermission('sa_licences', 'create')
  createPartner(@Auth() ctx: AuthContext, @Body() dto: PartnerCreateDto) {
    return this.partners.create(ctx, dto);
  }

  @Patch('partners/:id') @RequirePermission('sa_licences', 'edit')
  updatePartner(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PartnerUpdateDto) {
    return this.partners.update(ctx, id, dto);
  }

  @Patch('companies/:id/partner') @HttpCode(200) @RequirePermission('sa_licences', 'edit')
  async companyPartner(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompanyPartnerDto) {
    await this.partners.setCompanyPartner(ctx, id, dto.partnerId);
    return { ok: true };
  }

  @Get('invoices') @RequirePermission('sa_licences', 'view')
  invoicesList(@Query() q: InvoiceQuery) {
    return this.invoices.list(q, 1000);
  }

  @Get('invoices/:id/pdf') @RequirePermission('sa_licences', 'view')
  async invoicePdf(@Param('id', ParseUUIDPipe) id: string) {
    const inv = await this.invoices.find(id);
    return pdfFile(this.invoices, inv, await this.invoices.pdf(inv));
  }

  @Post('invoices/:id/resend') @HttpCode(200) @RequirePermission('sa_licences', 'edit')
  async resend(@Param('id', ParseUUIDPipe) id: string) {
    await this.invoices.find(id);
    await this.invoices.deliver(id);
    return { ok: true };
  }

  @Get('gst-summary') @RequirePermission('sa_licences', 'export')
  async gst(@Query() q: MonthQuery) {
    const { file, name } = await this.invoices.gstCsv(q.month);
    return new StreamableFile(file, { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${name}"` });
  }
}

/** Super Admin → Platform Settings: licence pricing and invoicing (supplier) details. */
@Controller('licences/settings')
export class LicenceSettingsController {
  constructor(
    private readonly settings: LicenceSettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get('pricing') @RequirePermission('sa_platform_settings', 'view')
  pricing() {
    return this.settings.pricing();
  }

  @Put('pricing') @RequirePermission('sa_platform_settings', 'edit')
  async savePricing(@Auth() ctx: AuthContext, @Body() dto: PricingDto) {
    const before = await this.settings.pricing();
    const after = await this.settings.updatePricing(dto);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'licence_pricing', before: { ...before }, after: { ...after } });
    return after;
  }

  @Get('invoicing') @RequirePermission('sa_platform_settings', 'view')
  invoicing() {
    return this.settings.invoicing();
  }

  @Put('invoicing') @RequirePermission('sa_platform_settings', 'edit')
  async saveInvoicing(@Auth() ctx: AuthContext, @Body() dto: InvoicingDto) {
    const before = await this.settings.invoicing();
    const after = await this.settings.updateInvoicing(dto);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'invoicing_settings', before: { ...before }, after: { ...after } });
    return after;
  }

  @Post('logo') @RequirePermission('sa_platform_settings', 'edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 * 1024, files: 1 } }))
  logo(@UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number }) {
    return this.settings.setLogo(file);
  }

  @Delete('logo') @RequirePermission('sa_platform_settings', 'edit')
  removeLogo() {
    return this.settings.removeLogo();
  }

  @Get('logo') @RequirePermission('sa_platform_settings', 'view')
  async logoFile() {
    const logo = await this.settings.logo();
    if (!logo) throw new BadRequestException('No logo uploaded');
    return new StreamableFile(logo.data, { type: logo.mime, disposition: 'inline; filename="logo"' });
  }
}
