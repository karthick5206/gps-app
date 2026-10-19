import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, StreamableFile } from '@nestjs/common';
import { Invoice } from '@prisma/client';
import { Request } from 'express';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { BillingService } from './billing.service';
import { InvoicesService } from './invoices.service';
import { AllocateDto, BillingProfileBody, OfflinePaymentDto, PurchaseDto, VerifyCheckoutDto } from './licences.dto';
import { PartnersService } from './partners.service';
import { PoolsService } from './pools.service';

export function pdfFile(invoices: InvoicesService, inv: Invoice, buffer: Buffer): StreamableFile {
  return new StreamableFile(buffer, { type: 'application/pdf', disposition: `attachment; filename="${invoices.fileName(inv)}"` });
}

/** Company admins: their own licence pool, billing details, purchases / renewals and invoices. */
@Controller('licences')
export class LicencesController {
  constructor(
    private readonly billing: BillingService,
    private readonly pools: PoolsService,
    private readonly invoices: InvoicesService,
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
}

/** Partners (resellers): their bulk pool, purchases, allocation to customers, customers' expiries, offline payments. */
@Controller('licences/partner')
export class PartnerLicencesController {
  constructor(
    private readonly billing: BillingService,
    private readonly pools: PoolsService,
    private readonly partners: PartnersService,
    private readonly invoices: InvoicesService,
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

  /** Cash / UPI / bank / cheque collected by the partner from one of its customers. */
  @Post('customers/:companyId/payments') @RequirePermission('billing', 'create')
  async customerPayment(@Auth() ctx: AuthContext, @Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: OfflinePaymentDto) {
    const partner = await this.billing.partnerOf(ctx);
    const owner = await this.billing.companyOwner(companyId);
    if (owner.partnerId !== partner.id) throw new ForbiddenException('This company is not your customer');
    return this.billing.recordOffline(ctx, owner, dto);
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
