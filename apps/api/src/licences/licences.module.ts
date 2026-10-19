import { Global, Module } from '@nestjs/common';
import { MailerService } from '../auth/mailer.service';
import { BillingService } from './billing.service';
import { InvoicesService } from './invoices.service';
import { LicencePolicyService } from './licence-policy.service';
import { LicenceRemindersService } from './licence-reminders.service';
import { LicenceSettingsService } from './licence-settings.service';
import { LicencesAdminController, LicenceSettingsController } from './licences-admin.controller';
import { LicencesController, PartnerLicencesController, RazorpayWebhookController } from './licences.controller';
import { PartnersService } from './partners.service';
import { PoolsService } from './pools.service';
import { SeatsService } from './seats.service';

/**
 * Licences & billing: seat pools (company / partner), assignment hooks and viewing locks (exported, global), GST
 * invoices, Razorpay and offline payments, expiry reminders.
 */
@Global()
@Module({
  controllers: [LicencesController, PartnerLicencesController, LicencesAdminController, LicenceSettingsController, RazorpayWebhookController],
  providers: [
    LicenceSettingsService,
    LicencePolicyService,
    SeatsService,
    PoolsService,
    PartnersService,
    InvoicesService,
    BillingService,
    LicenceRemindersService,
    MailerService,
  ],
  exports: [LicenceSettingsService, LicencePolicyService, SeatsService],
})
export class LicencesModule {}
