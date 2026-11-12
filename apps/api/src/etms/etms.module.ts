import { Module } from '@nestjs/common';
import { AgreementViewsService } from './agreements/agreement-views.service';
import { AgreementsController } from './agreements/agreements.controller';
import { AgreementsService } from './agreements/agreements.service';
import { FleetAllocationsService } from './agreements/fleet-allocations.service';
import { TransportProviderController } from './provider/transport-provider.controller';
import { TransportProviderService } from './provider/transport-provider.service';
import { CompanyDirectoryController } from './directory/company-directory.controller';
import { CompanyDirectoryService } from './directory/company-directory.service';
import { EtmsDispatchModule } from './dispatch/dispatch.module';
import { EtmsDriverModule } from './driver/driver.module';
import { EtmsPeopleModule } from './people/people.module';
import { EtmsPlanningModule } from './planning/planning.module';
import { EtmsSafetyModule } from './safety/safety.module';
import { EtmsSelfServiceModule } from './self-service/self-service.module';
import { TransportSettingsController } from './settings/transport-settings.controller';
import { TransportSettingsService } from './settings/transport-settings.service';

/**
 * Employee transport (ETMS). E1a: service agreements, the partner directory and the company ETMS settings; E2: people
 * (EtmsPeopleModule — passengers, consent notices, vehicle seats, driver/passenger logins); E3: schedules, bookings,
 * dispatch and transport trips (EtmsDispatchModule); E5: driver API, notifications (EtmsDriverModule); E4: route plans (EtmsPlanningModule); E5 WP 5.4: durable SOS (EtmsSafetyModule); E5 WP 5.3: passenger self-service (EtmsSelfServiceModule); E1b: fleet allocations, customer
 * context and the sensitive-access log (TransportProviderController); later phases add theirs here.
 */
@Module({
  imports: [EtmsPeopleModule, EtmsDispatchModule, EtmsDriverModule, EtmsPlanningModule, EtmsSafetyModule, EtmsSelfServiceModule],
  controllers: [AgreementsController, CompanyDirectoryController, TransportSettingsController, TransportProviderController],
  providers: [AgreementsService, AgreementViewsService, FleetAllocationsService, CompanyDirectoryService, TransportSettingsService, TransportProviderService],
  exports: [AgreementsService],
})
export class EtmsModule {}
