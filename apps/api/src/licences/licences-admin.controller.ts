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
import { CreditNotesService } from './credit-notes.service';
import { InvoicesService } from './invoices.service';
import { LicenceSettingsService } from './licence-settings.service';
import { creditNotePdfFile, pdfFile } from './licences.controller';
import {
  AllocateDto,
  BillingProfileBody,
  CompanyPartnerDto,
  CreditNoteBody,
  GrantDto,
  InvoiceQuery,
  InvoicingDto,
  MonthQuery,
  OfflinePaymentDto,
  PartnerCreateDto,
  PartnerUpdateDto,
  PricingDto,
  PurchaseDto,
  UpiRejectBody,
} from './licences.dto';
import { UpiService } from './upi.service';
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
    private readonly creditNotes: CreditNotesService,
    private readonly upiPay: UpiService,
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

  /** Customers' "I've paid by UPI": check the UTR on the bank statement, then confirm (activates + invoices) or reject. */
  @Get('upi-claims') @RequirePermission('sa_licences', 'view')
  upiClaims(@Query('status') status?: string) {
    return this.upiPay.list(status ? { status } : {});
  }

  @Post('upi-claims/:id/confirm') @HttpCode(200) @RequirePermission('sa_licences', 'create')
  upiConfirm(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.upiPay.confirm(ctx, id, (kind, ownerId) => this.owner(kind.toLowerCase(), ownerId));
  }

  @Post('upi-claims/:id/reject') @HttpCode(200) @RequirePermission('sa_licences', 'edit')
  async upiReject(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpiRejectBody) {
    await this.upiPay.reject(ctx, id, body.reason ?? '');
    return { ok: true };
  }

  @Post('pools/:kind/:id/grant') @RequirePermission('sa_licences', 'create')
  async grant(@Auth() ctx: AuthContext, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GrantDto) {
    const owner = await this.owner(kind, id);
    return { granted: await this.pools.grant(ctx, owner.kind === 'COMPANY' ? { companyId: owner.id } : { partnerId: owner.id }, dto.type, dto.quantity, dto.days, dto.reason, dto.plan) };
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

  /** Invoice detail for crediting: lines with what is left, and its credit notes. */
  @Get('invoices/:id/credits') @RequirePermission('sa_licences', 'view')
  invoiceCredits(@Param('id', ParseUUIDPipe) id: string) {
    return this.creditNotes.credits(id);
  }

  @Post('invoices/:id/credit-notes') @RequirePermission('sa_licences', 'create')
  createCreditNote(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreditNoteBody) {
    return this.creditNotes.create(ctx, id, dto);
  }

  @Get('credit-notes') @RequirePermission('sa_licences', 'view')
  creditNotesList(@Query() q: InvoiceQuery) {
    return this.creditNotes.list(q);
  }

  @Get('credit-notes/:id/pdf') @RequirePermission('sa_licences', 'view')
  async creditNotePdf(@Param('id', ParseUUIDPipe) id: string) {
    const cn = await this.creditNotes.find(id);
    return creditNotePdfFile(this.creditNotes, cn, await this.creditNotes.pdf(cn));
  }

  @Post('credit-notes/:id/resend') @HttpCode(200) @RequirePermission('sa_licences', 'edit')
  async resendCreditNote(@Param('id', ParseUUIDPipe) id: string) {
    await this.creditNotes.find(id);
    await this.creditNotes.deliver(id);
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

  @Post('upi-qr') @RequirePermission('sa_platform_settings', 'edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 * 1024, files: 1 } }))
  upiQr(@UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number }) {
    return this.settings.setUpiQr(file);
  }

  @Delete('upi-qr') @RequirePermission('sa_platform_settings', 'edit')
  removeUpiQr() {
    return this.settings.removeUpiQr();
  }

  @Get('upi-qr') @RequirePermission('sa_platform_settings', 'view')
  async upiQrFile() {
    const img = await this.settings.upiQr();
    if (!img) throw new BadRequestException('No UPI QR uploaded');
    return new StreamableFile(img.data, { type: img.mime, disposition: 'inline; filename="upi-qr"' });
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
