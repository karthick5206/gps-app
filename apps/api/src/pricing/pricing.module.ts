import { Module } from '@nestjs/common';
import { BillingAdjustmentsService } from './adjustments.service';
import { AvailabilityService } from './availability.service';
import { PricingBillingJobService } from './billing-job.service';
import { BillingRunsService } from './billing-runs.service';
import { PricingContractsService } from './contracts.service';
import { CustomerInvoicesService } from './invoices.service';
import { PRICING_CONTROLLERS } from './pricing.controller';
import { PricingReportsService } from './reports.service';
import { PricingSettingsService } from './settings.service';
import { TripPricingService } from './trip-pricing.service';

/**
 * Customer pricing & billing (doc 19). Its own module (not inside EtmsModule): it also serves corporate-managed internal
 * charge-back, and its isolation is declared in pricing-isolation.db-test.ts (route discovery + role × tenant × branch).
 * Prisma, Redis and Audit come from global modules.
 */
@Module({
  controllers: PRICING_CONTROLLERS,
  providers: [PricingSettingsService, PricingContractsService, TripPricingService, BillingRunsService, AvailabilityService, CustomerInvoicesService, BillingAdjustmentsService, PricingReportsService, PricingBillingJobService],
  exports: [TripPricingService],
})
export class PricingModule {}
