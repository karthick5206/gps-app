import { Module } from '@nestjs/common';
import { FleetLinksService } from './fleet-links.service';
import { PassengerImportService } from './passenger-import.service';
import { DriverLoginController, MyTransportConsentController, PassengersController, TransportVehiclesController } from './people.controller';
import { PeopleService } from './people.service';

/** ETMS E2: passengers, consent, passenger / driver logins, vehicle seat capacity. */
@Module({
  controllers: [PassengersController, MyTransportConsentController, TransportVehiclesController, DriverLoginController],
  providers: [PeopleService, PassengerImportService, FleetLinksService],
  exports: [PeopleService],
})
export class EtmsPeopleModule {}
