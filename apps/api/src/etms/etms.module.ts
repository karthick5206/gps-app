import { Module } from '@nestjs/common';
import { AgreementViewsService } from './agreements/agreement-views.service';
import { AgreementsController } from './agreements/agreements.controller';
import { AgreementsService } from './agreements/agreements.service';
import { CompanyDirectoryController } from './directory/company-directory.controller';
import { CompanyDirectoryService } from './directory/company-directory.service';
import { EtmsDispatchModule } from './dispatch/dispatch.module';
import { EtmsDriverModule } from './driver/driver.module';
import { EtmsPeopleModule } from './people/people.module';
import { TransportSettingsController } from './settings/transport-settings.controller';
import { TransportSettingsService } from './settings/transport-settings.service';

/**
 * Employee transport (ETMS). E1a: service agreements, the partner directory and the company ETMS settings; E2: people
 * (EtmsPeopleModule — passengers, consent notices, vehicle seats, driver/passenger logins); E3: schedules, bookings,
 * dispatch and transport trips (EtmsDispatchModule); E5: driver API, notifications (EtmsDriverModule); later phases add theirs here.
 */
@Module({
  imports: [EtmsPeopleModule, EtmsDispatchModule, EtmsDriverModule],
  controllers: [AgreementsController, CompanyDirectoryController, TransportSettingsController],
  providers: [AgreementsService, AgreementViewsService, CompanyDirectoryService, TransportSettingsService],
  exports: [AgreementsService],
})
export class EtmsModule {}
