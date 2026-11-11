import { Module } from '@nestjs/common';
import { ConsentNoticeService } from './consent-notice.service';
import { FleetLinksService } from './fleet-links.service';
import { PassengerImportService } from './passenger-import.service';
import { ConsentNoticesController, DriverLoginController, MyTransportConsentController, PassengersController, TransportVehiclesController } from './people.controller';
import { PeopleService } from './people.service';

/** ETMS E2: passengers, consent, passenger / driver logins, vehicle seat capacity. */
@Module({
  controllers: [PassengersController, MyTransportConsentController, ConsentNoticesController, TransportVehiclesController, DriverLoginController],
  providers: [PeopleService, PassengerImportService, FleetLinksService, ConsentNoticeService],
  exports: [PeopleService],
})
export class EtmsPeopleModule {}
