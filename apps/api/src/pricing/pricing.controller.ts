import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { AuthContext } from '../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../access/decorators';
import { idempotencyKey } from '../etms/dispatch/e3-common';
import { BillingAdjustmentsService } from './adjustments.service';
import { AvailabilityService } from './availability.service';
import { BillingRunsService } from './billing-runs.service';
import { PricingContractsService } from './contracts.service';
import { CustomerInvoicesService } from './invoices.service';
import {
  AdjustmentQueryDto,
  AvailabilityPeriodDto,
  AvailabilityQueryDto,
  BillableDistanceDto,
  CalendarDto,
  ContractListQueryDto,
  CostQueryDto,
  CreateAdjustmentDto,
  CreateAssignmentDto,
  CreateContractDto,
  CreateCostDto,
  CreateDowntimeDto,
  CreateVehicleRateDto,
  CreateVersionDto,
  CreditNoteDto,
  DecisionDto,
  GenerateInvoiceDto,
  InvoiceQueryDto,
  IssueInvoiceDto,
  LifecycleDto,
  PaymentDto,
  PreviewDto,
  RecalculateDto,
  RejectDto,
  ReplaceComponentsDto,
  ReportQueryDto,
  ReversePaymentDto,
  SupplierProfileDto,
  TaxProfileDto,
  TaxRateDto,
  TripChargeQueryDto,
  TripOverrideDto,
  UpdateAssignmentDto,
  UpdateContractDto,
  UpdateVehicleRateDto,
} from './pricing.dto';
import { PricingReportsService } from './reports.service';
import { PricingSettingsService } from './settings.service';
import { TripPricingService } from './trip-pricing.service';

/**
 * Doc 19 §4: every route is under /api/pricing and requires a pricing_* menu grant. The menus require the `pricing`
 * company add-on, so with the add-on off PermissionGuard answers a plain 404 for every route here (the route cannot even
 * be detected). Rows are always scoped to the acting company (other tenants' ids are 404) and to the caller's branches
 * for ASSIGNED roles (§9.3).
 */
const ID = new ParseUUIDPipe();

@Controller('pricing/contracts')
export class PricingContractsController {
  constructor(private readonly contracts: PricingContractsService) {}

  @Get() @RequirePermission('pricing_contracts', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: ContractListQueryDto) {
    return this.contracts.list(ctx, q);
  }
  @Get(':id') @RequirePermission('pricing_contracts', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.contracts.get(ctx, id);
  }
  @Get(':id/history') @RequirePermission('pricing_contracts', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.contracts.history(ctx, id);
  }
  @Post() @RequirePermission('pricing_contracts', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateContractDto) {
    return this.contracts.create(ctx, dto);
  }
  @Patch(':id') @RequirePermission('pricing_contracts', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: UpdateContractDto) {
    return this.contracts.update(ctx, id, dto);
  }
  @Delete(':id') @RequirePermission('pricing_contracts', 'delete')
  remove(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.contracts.remove(ctx, id);
  }
  @Post(':id/versions') @RequirePermission('pricing_contracts', 'edit')
  createVersion(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: CreateVersionDto) {
    return this.contracts.createVersion(ctx, id, dto);
  }
  @Put(':id/versions/:versionId/components') @RequirePermission('pricing_contracts', 'edit')
  replaceComponents(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('versionId', ID) versionId: string, @Body() dto: ReplaceComponentsDto) {
    return this.contracts.replaceComponents(ctx, id, versionId, dto);
  }
  @Post(':id/versions/:versionId/submit') @RequirePermission('pricing_contracts', 'edit')
  submit(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('versionId', ID) versionId: string) {
    return this.contracts.submit(ctx, id, versionId);
  }
  @Post(':id/versions/:versionId/approve') @RequirePermission('pricing_contracts', 'approve')
  approve(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('versionId', ID) versionId: string, @Body() dto: DecisionDto) {
    return this.contracts.approve(ctx, id, versionId, dto.note);
  }
  @Post(':id/versions/:versionId/reject') @RequirePermission('pricing_contracts', 'approve')
  reject(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('versionId', ID) versionId: string, @Body() dto: RejectDto) {
    return this.contracts.reject(ctx, id, versionId, dto.reason);
  }
  @Post(':id/suspend') @RequirePermission('pricing_contracts', 'approve')
  suspend(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: LifecycleDto) {
    return this.contracts.lifecycle(ctx, id, 'suspend', dto);
  }
  @Post(':id/resume') @RequirePermission('pricing_contracts', 'approve')
  resume(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: LifecycleDto) {
    return this.contracts.lifecycle(ctx, id, 'resume', dto);
  }
  @Post(':id/expire') @RequirePermission('pricing_contracts', 'approve')
  expire(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: LifecycleDto) {
    return this.contracts.lifecycle(ctx, id, 'expire', dto);
  }
  @Post(':id/preview') @RequirePermission('pricing_contracts', 'view')
  preview(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: PreviewDto) {
    return this.contracts.preview(ctx, id, dto);
  }

  // Vehicle rates (precedence 2): refused with 409 when the contract does not permit overrides.
  @Get(':id/vehicle-rates') @RequirePermission('pricing_vehicle_rates', 'view')
  listRates(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.contracts.listVehicleRates(ctx, id);
  }
  @Post(':id/vehicle-rates') @RequirePermission('pricing_vehicle_rates', 'create')
  createRate(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: CreateVehicleRateDto) {
    return this.contracts.createVehicleRate(ctx, id, dto);
  }
  @Patch(':id/vehicle-rates/:rateId') @RequirePermission('pricing_vehicle_rates', 'edit')
  updateRate(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('rateId', ID) rateId: string, @Body() dto: UpdateVehicleRateDto) {
    return this.contracts.updateVehicleRate(ctx, id, rateId, dto);
  }
  @Post(':id/vehicle-rates/:rateId/submit') @RequirePermission('pricing_vehicle_rates', 'edit')
  submitRate(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('rateId', ID) rateId: string) {
    return this.contracts.decideVehicleRate(ctx, id, rateId, 'submit');
  }
  @Post(':id/vehicle-rates/:rateId/approve') @RequirePermission('pricing_vehicle_rates', 'approve')
  approveRate(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('rateId', ID) rateId: string) {
    return this.contracts.decideVehicleRate(ctx, id, rateId, 'approve');
  }
  @Post(':id/vehicle-rates/:rateId/reject') @RequirePermission('pricing_vehicle_rates', 'approve')
  rejectRate(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('rateId', ID) rateId: string, @Body() dto: RejectDto) {
    return this.contracts.decideVehicleRate(ctx, id, rateId, 'reject', dto.reason);
  }

  // Dedicated vehicles (availability billing), replacement, downtime.
  @Get(':id/vehicles') @RequirePermission('pricing_contracts', 'view')
  listVehicles(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.contracts.listAssignments(ctx, id);
  }
  @Post(':id/vehicles') @RequirePermission('pricing_contracts', 'edit')
  createVehicle(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: CreateAssignmentDto) {
    return this.contracts.createAssignment(ctx, id, dto);
  }
  @Patch(':id/vehicles/:assignmentId') @RequirePermission('pricing_contracts', 'edit')
  updateVehicle(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('assignmentId', ID) assignmentId: string, @Body() dto: UpdateAssignmentDto) {
    return this.contracts.updateAssignment(ctx, id, assignmentId, dto);
  }
  @Post(':id/vehicles/:assignmentId/downtime') @RequirePermission('pricing_contracts', 'edit')
  addDowntime(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Param('assignmentId', ID) assignmentId: string, @Body() dto: CreateDowntimeDto) {
    return this.contracts.addDowntime(ctx, id, assignmentId, dto);
  }
}

@Controller('pricing/trip-charges')
export class PricingTripChargesController {
  constructor(private readonly trips: TripPricingService) {}

  @Get() @RequirePermission('pricing_trip_charges', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: TripChargeQueryDto) {
    return this.trips.list(ctx, q);
  }
  @Get(':tripId') @RequirePermission('pricing_trip_charges', 'view')
  detail(@Auth() ctx: AuthContext, @Param('tripId', ID) tripId: string) {
    return this.trips.detail(ctx, tripId);
  }
  @Post(':tripId/recalculate') @RequirePermission('pricing_trip_charges', 'edit')
  recalculate(@Auth() ctx: AuthContext, @Param('tripId', ID) tripId: string, @Body() dto: RecalculateDto) {
    return this.trips.recalculate(ctx, tripId, dto.reason);
  }
  @Post(':tripId/billable-distance') @RequirePermission('pricing_trip_charges', 'edit')
  distance(@Auth() ctx: AuthContext, @Param('tripId', ID) tripId: string, @Body() dto: BillableDistanceDto) {
    return this.trips.setBillableDistance(ctx, tripId, dto.distanceKm, dto.reason);
  }
  @Post(':tripId/override') @RequirePermission('pricing_trip_charges', 'command')
  override(@Auth() ctx: AuthContext, @Param('tripId', ID) tripId: string, @Body() dto: TripOverrideDto) {
    return this.trips.override(ctx, tripId, dto.amount, dto.reason);
  }
}

@Controller('pricing/availability')
export class PricingAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get() @RequirePermission('pricing_availability', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: AvailabilityQueryDto) {
    return this.availability.list(ctx, q);
  }
  @Post('compute') @RequirePermission('pricing_availability', 'view')
  compute(@Auth() ctx: AuthContext, @Body() dto: AvailabilityPeriodDto) {
    return this.availability.compute(ctx, dto.contractId, dto.periodDate);
  }
  @Post('close') @RequirePermission('pricing_availability', 'command')
  close(@Auth() ctx: AuthContext, @Body() dto: AvailabilityPeriodDto, @Headers('idempotency-key') key?: string) {
    return this.availability.close(ctx, dto.contractId, dto.periodDate, idempotencyKey(key));
  }
}

@Controller('pricing')
export class PricingInvoicesController {
  constructor(
    private readonly invoices: CustomerInvoicesService,
    private readonly runs: BillingRunsService,
  ) {}

  @Get('invoices') @RequirePermission('pricing_invoices', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: InvoiceQueryDto) {
    return this.invoices.list(ctx, q);
  }
  @Get('invoices/:id') @RequirePermission('pricing_invoices', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.invoices.get(ctx, id);
  }
  @Get('invoices/:id/pdf') @RequirePermission('pricing_invoices', 'view')
  pdf(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.invoices.pdf(ctx, id);
  }
  @Post('invoices/generate') @RequirePermission('pricing_invoices', 'create')
  generate(@Auth() ctx: AuthContext, @Body() dto: GenerateInvoiceDto, @Headers('idempotency-key') key?: string) {
    return this.invoices.generate(ctx, dto, idempotencyKey(key));
  }
  @Post('invoices/:id/issue') @RequirePermission('pricing_invoices', 'command')
  issue(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: IssueInvoiceDto) {
    return this.invoices.issue(ctx, id, dto.invoiceDate);
  }
  @Delete('invoices/:id') @RequirePermission('pricing_invoices', 'delete')
  remove(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.invoices.remove(ctx, id);
  }
  @Post('invoices/:id/credit-notes') @RequirePermission('pricing_adjustments', 'approve')
  creditNote(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: CreditNoteDto) {
    return this.invoices.createCreditNote(ctx, id, dto);
  }
  @Get('invoices/:id/payments') @RequirePermission('pricing_invoices', 'view')
  payments(@Auth() ctx: AuthContext, @Param('id', ID) id: string) {
    return this.invoices.payments(ctx, id);
  }
  @Post('invoices/:id/payments') @RequirePermission('pricing_invoices', 'edit')
  recordPayment(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: PaymentDto) {
    return this.invoices.recordPayment(ctx, id, dto);
  }
  @Post('payments/:id/reverse') @RequirePermission('pricing_invoices', 'edit')
  reversePayment(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: ReversePaymentDto) {
    return this.invoices.reversePayment(ctx, id, dto.reason);
  }
  @Get('billing-runs') @RequirePermission('pricing_invoices', 'view')
  billingRuns(@Auth() ctx: AuthContext, @Query('contractId') contractId?: string) {
    return this.runs.list(ctx, contractId && /^[0-9a-f-]{36}$/i.test(contractId) ? contractId : undefined);
  }
}

@Controller('pricing/adjustments')
export class PricingAdjustmentsController {
  constructor(private readonly adjustments: BillingAdjustmentsService) {}

  @Get() @RequirePermission('pricing_adjustments', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: AdjustmentQueryDto) {
    return this.adjustments.list(ctx, q);
  }
  @Post() @RequirePermission('pricing_adjustments', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateAdjustmentDto) {
    return this.adjustments.create(ctx, dto);
  }
  @Post(':id/approve') @RequirePermission('pricing_adjustments', 'approve')
  approve(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: DecisionDto) {
    return this.adjustments.decide(ctx, id, true, dto.note);
  }
  @Post(':id/reject') @RequirePermission('pricing_adjustments', 'approve')
  reject(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: DecisionDto) {
    return this.adjustments.decide(ctx, id, false, dto.note);
  }
}

@Controller('pricing')
export class PricingReportsController {
  constructor(private readonly reports: PricingReportsService) {}

  @Get('dashboard') @RequirePermission('pricing', 'view')
  dashboard(@Auth() ctx: AuthContext) {
    return this.reports.dashboard(ctx);
  }
  // Cost / margin columns need pricing_costs:view in addition (projected out otherwise; the margin report is refused).
  @Get('reports/:type') @RequirePermission('pricing_reports', 'view')
  report(@Auth() ctx: AuthContext, @Param('type') type: string, @Query() q: ReportQueryDto) {
    return this.reports.report(ctx, type, q);
  }
  @Get('costs') @RequirePermission('pricing_costs', 'view')
  costs(@Auth() ctx: AuthContext, @Query() q: CostQueryDto) {
    return this.reports.listCosts(ctx, q);
  }
  @Post('costs') @RequirePermission('pricing_costs', 'create')
  createCost(@Auth() ctx: AuthContext, @Body() dto: CreateCostDto) {
    return this.reports.createCost(ctx, dto);
  }
}

@Controller('pricing/settings')
export class PricingSettingsController {
  constructor(private readonly settings: PricingSettingsService) {}

  @Get('supplier') @RequireAnyPermission(['pricing_contracts', 'view'], ['pricing_invoices', 'view'])
  supplier(@Auth() ctx: AuthContext) {
    return this.settings.getSupplier(ctx);
  }
  @Put('supplier') @RequirePermission('pricing_contracts', 'approve')
  putSupplier(@Auth() ctx: AuthContext, @Body() dto: SupplierProfileDto) {
    return this.settings.putSupplier(ctx, dto);
  }
  @Get('tax-profiles') @RequireAnyPermission(['pricing_contracts', 'view'], ['pricing_invoices', 'view'])
  taxProfiles(@Auth() ctx: AuthContext) {
    return this.settings.listTaxProfiles(ctx);
  }
  @Post('tax-profiles') @RequirePermission('pricing_contracts', 'approve')
  createTaxProfile(@Auth() ctx: AuthContext, @Body() dto: TaxProfileDto) {
    return this.settings.createTaxProfile(ctx, dto);
  }
  @Post('tax-profiles/:id/rates') @RequirePermission('pricing_contracts', 'approve')
  addTaxRate(@Auth() ctx: AuthContext, @Param('id', ID) id: string, @Body() dto: TaxRateDto) {
    return this.settings.addTaxRate(ctx, id, dto);
  }
  @Get('calendars') @RequirePermission('pricing_contracts', 'view')
  calendars(@Auth() ctx: AuthContext) {
    return this.settings.listCalendars(ctx);
  }
  @Put('calendars') @RequirePermission('pricing_contracts', 'approve')
  upsertCalendar(@Auth() ctx: AuthContext, @Body() dto: CalendarDto) {
    return this.settings.upsertCalendar(ctx, dto);
  }
}

export const PRICING_CONTROLLERS = [PricingContractsController, PricingTripChargesController, PricingAvailabilityController, PricingInvoicesController, PricingAdjustmentsController, PricingReportsController, PricingSettingsController];
