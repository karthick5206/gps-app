import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, StreamableFile } from '@nestjs/common';
import { CreditNote, Invoice } from '@prisma/client';
import { Request } from 'express';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { BillingService } from './billing.service';
import { CreditNotesService } from './credit-notes.service';
import { InvoicesService } from './invoices.service';
import { AllocateDto, BillingProfileBody, OfflinePaymentDto, PurchaseDto, UpiClaimBody, VerifyCheckoutDto } from './licences.dto';
import { LicenceSettingsService } from './licence-settings.service';
import { UpiService } from './upi.service';
import { PartnersService } from './partners.service';
import { PoolsService } from './pools.service';

export function pdfFile(invoices: InvoicesService, inv: Invoice, buffer: Buffer): StreamableFile {
  return new StreamableFile(buffer, { type: 'application/pdf', disposition: `attachment; filename="${invoices.fileName(inv)}"` });
}

export function creditNotePdfFile(notes: CreditNotesService, cn: CreditNote, buffer: Buffer): StreamableFile {
  return new StreamableFile(buffer, { type: 'application/pdf', disposition: `attachment; filename="${notes.fileName(cn)}"` });
}

/** Company admins: their own licence pool, billing details, purchases / renewals and invoices. */
@Controller('licences')
export class LicencesController {
  constructor(
    private readonly billing: BillingService,
    private readonly pools: PoolsService,
    private readonly invoices: InvoicesService,
    private readonly creditNotes: CreditNotesService,
    private readonly upiPay: UpiService,
    private readonly settings: LicenceSettingsService,
  ) {}

  /** Banner data for every signed-in user (no permission needed). */
  @Get('banner')
  banner(@Auth() ctx: AuthContext) {
    return this.pools.banner(ctx);
  }

  @Get('overview') @RequirePermission('billing', 'view')
  async overview(@Auth() ctx: AuthContext) {
    return this.billing.overview(await this.billing.companyOwner(ctx.companyId));
  }

  @Put('billing-profile') @RequirePermission('billing', 'edit')
  async profile(@Auth() ctx: AuthContext, @Body() dto: BillingProfileBody) {
    return this.billing.saveProfile(ctx, await this.billing.companyOwner(ctx.companyId), dto);
  }

  @Post('quote') @HttpCode(200) @RequirePermission('billing', 'view')
  async quote(@Auth() ctx: AuthContext, @Body() dto: PurchaseDto) {
    return this.billing.quote(await this.billing.companyOwner(ctx.companyId), dto);
  }

  @Post('checkout') @RequirePermission('billing', 'create')
  async checkout(@Auth() ctx: AuthContext, @Body() dto: PurchaseDto) {
    return this.billing.checkout(ctx, await this.billing.companyOwner(ctx.companyId), dto);
  }

  /** UPI ID / payee, and with ?amountPaise the payment link + QR (SVG) for that exact amount. */
  @Get('upi') @RequirePermission('billing', 'view')
  async upi(@Auth() ctx: AuthContext, @Query('amountPaise') amount?: string) {
    const owner = await this.billing.companyOwner(ctx.companyId);
    const paise = Number(amount);
    return this.upiPay.info(Number.isFinite(paise) && paise > 0 ? Math.round(paise) : undefined, `VeeTrax ${owner.name}`.slice(0, 50));
  }

  @Get('upi/qr-image') @RequirePermission('billing', 'view')
  async upiImage() {
    const img = await this.settings.upiQr();
    if (!img) throw new NotFoundException('No UPI QR uploaded');
    return new StreamableFile(img.data, { type: img.mime, disposition: 'inline; filename="upi-qr"' });
  }

  /** "I've paid by UPI" with the UTR; licences activate when VeeTrax confirms the payment. */
  @Post('upi-claims') @RequirePermission('billing', 'create')
  async upiClaim(@Auth() ctx: AuthContext, @Body() dto: UpiClaimBody) {
    return this.upiPay.claim(ctx, await this.billing.companyOwner(ctx.companyId), dto);
  }

  @Get('upi-claims') @RequirePermission('billing', 'view')
  async upiClaims(@Auth() ctx: AuthContext) {
    return this.upiPay.list({ ownerId: (await this.billing.companyOwner(ctx.companyId)).id });
  }

  @Post('checkout/verify') @HttpCode(200) @RequirePermission('billing', 'create')
  async verify(@Auth() ctx: AuthContext, @Body() dto: VerifyCheckoutDto) {
    return this.billing.verifyCheckout(await this.billing.companyOwner(ctx.companyId), dto);
  }

  @Get('invoices') @RequirePermission('billing', 'view')
  invoicesList(@Auth() ctx: AuthContext) {
    return this.invoices.list({ companyId: ctx.companyId });
  }

  @Get('invoices/:id/pdf') @RequirePermission('billing', 'view')
  async invoicePdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const inv = await this.invoices.find(id, { companyId: ctx.companyId });
    return pdfFile(this.invoices, inv, await this.invoices.pdf(inv));
  }

  /** Credit notes issued against one of the company's invoices. */
  @Get('invoices/:id/credit-notes') @RequirePermission('billing', 'view')
  async invoiceCreditNotes(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return (await this.creditNotes.credits(id, { companyId: ctx.companyId })).creditNotes;
  }

  @Get('credit-notes') @RequirePermission('billing', 'view')
  creditNotesList(@Auth() ctx: AuthContext) {
    return this.creditNotes.list({ companyId: ctx.companyId });
  }

  @Get('credit-notes/:id/pdf') @RequirePermission('billing', 'view')
  async creditNotePdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const cn = await this.creditNotes.find(id, { companyId: ctx.companyId });
    return creditNotePdfFile(this.creditNotes, cn, await this.creditNotes.pdf(cn));
  }
}

/** Partners (resellers): their bulk pool, purchases, allocation to customers, customers' expiries, offline payments. */
@Controller('licences/partner')
export class PartnerLicencesController {
  constructor(
    private readonly billing: BillingService,
    private readonly pools: PoolsService,
    private readonly partners: PartnersService,
    private readonly invoices: InvoicesService,
    private readonly creditNotes: CreditNotesService,
  ) {}

  @Get('overview') @RequirePermission('billing', 'view')
  async overview(@Auth() ctx: AuthContext) {
    const owner = await this.billing.partnerOf(ctx);
    return { ...(await this.billing.overview(owner)), customers: await this.partners.customers(owner.id) };
  }

  @Put('billing-profile') @RequirePermission('billing', 'edit')
  async profile(@Auth() ctx: AuthContext, @Body() dto: BillingProfileBody) {
    return this.billing.saveProfile(ctx, await this.billing.partnerOf(ctx), dto);
  }

  @Post('quote') @HttpCode(200) @RequirePermission('billing', 'view')
  async quote(@Auth() ctx: AuthContext, @Body() dto: PurchaseDto) {
    return this.billing.quote(await this.billing.partnerOf(ctx), dto);
  }

  @Post('checkout') @RequirePermission('billing', 'create')
  async checkout(@Auth() ctx: AuthContext, @Body() dto: PurchaseDto) {
    return this.billing.checkout(ctx, await this.billing.partnerOf(ctx), dto);
  }

  @Post('checkout/verify') @HttpCode(200) @RequirePermission('billing', 'create')
  async verify(@Auth() ctx: AuthContext, @Body() dto: VerifyCheckoutDto) {
    return this.billing.verifyCheckout(await this.billing.partnerOf(ctx), dto);
  }

  @Post('allocate') @HttpCode(200) @RequirePermission('billing', 'create')
  async allocate(@Auth() ctx: AuthContext, @Body() dto: AllocateDto) {
    const owner = await this.billing.partnerOf(ctx);
    return { allocated: await this.pools.allocate(ctx, owner.id, dto.companyId, dto.type, dto.quantity) };
  }

  private async customer(ctx: AuthContext, companyId: string) {
    const partner = await this.billing.partnerOf(ctx);
    const owner = await this.billing.companyOwner(companyId);
    if (owner.partnerId !== partner.id) throw new ForbiddenException('This company is not your customer');
    return owner;
  }

  @Get('customers/:companyId/overview') @RequirePermission('billing', 'view')
  async customerOverview(@Auth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.billing.overview(await this.customer(ctx, companyId));
  }

  @Put('customers/:companyId/billing-profile') @RequirePermission('billing', 'edit')
  async customerProfile(@Auth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: BillingProfileBody) {
    return this.billing.saveProfile(ctx, await this.customer(ctx, companyId), dto);
  }

  @Post('customers/:companyId/quote') @HttpCode(200) @RequirePermission('billing', 'view')
  async customerQuote(@Auth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: PurchaseDto) {
    return this.billing.quote(await this.customer(ctx, companyId), dto);
  }

  /** Cash / UPI / bank / cheque collected by the partner from one of its customers. */
  @Post('customers/:companyId/payments') @RequirePermission('billing', 'create')
  async customerPayment(@Auth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: OfflinePaymentDto) {
    return this.billing.recordOffline(ctx, await this.customer(ctx, companyId), dto);
  }

  @Get('customers/:companyId/invoices') @RequirePermission('billing', 'view')
  async customerInvoices(@Auth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.invoices.list({ companyId: (await this.customer(ctx, companyId)).id });
  }

  @Get('customers/:companyId/invoices/:id/pdf') @RequirePermission('billing', 'view')
  async customerInvoicePdf(@Auth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    const inv = await this.invoices.find(id, { companyId: (await this.customer(ctx, companyId)).id });
    return pdfFile(this.invoices, inv, await this.invoices.pdf(inv));
  }

  @Get('invoices') @RequirePermission('billing', 'view')
  async invoicesList(@Auth() ctx: AuthContext) {
    return this.invoices.list({ partnerId: (await this.billing.partnerOf(ctx)).id });
  }

  @Get('invoices/:id/pdf') @RequirePermission('billing', 'view')
  async invoicePdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const inv = await this.invoices.find(id, { partnerId: (await this.billing.partnerOf(ctx)).id });
    return pdfFile(this.invoices, inv, await this.invoices.pdf(inv));
  }

  @Get('credit-notes') @RequirePermission('billing', 'view')
  async creditNotesList(@Auth() ctx: AuthContext) {
    return this.creditNotes.list({ partnerId: (await this.billing.partnerOf(ctx)).id });
  }

  @Get('credit-notes/:id/pdf') @RequirePermission('billing', 'view')
  async creditNotePdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const cn = await this.creditNotes.find(id, { partnerId: (await this.billing.partnerOf(ctx)).id });
    return creditNotePdfFile(this.creditNotes, cn, await this.creditNotes.pdf(cn));
  }
}

/** Razorpay webhook (public; authenticated by the X-Razorpay-Signature HMAC of the raw body). */
@Controller('billing/razorpay')
export class RazorpayWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Public() @Post('webhook') @HttpCode(200)
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-razorpay-signature') signature?: string) {
    return this.billing.webhook(req.rawBody, signature);
  }
}
