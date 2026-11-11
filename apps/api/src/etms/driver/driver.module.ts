import { Module } from '@nestjs/common';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { TripLiveService } from '../dispatch/trip-live';
import { TransportNotificationsService } from '../notifications/transport-notifications.service';
import { TransportNotifyRelayService } from '../notifications/transport-notify-relay.service';
import { EtmsPeopleModule } from '../people/people.module';
import { DriverApiService } from './driver-api.service';
import { DriverController, MyTransportBookingsController, MyTransportNotificationsController } from './driver.controller';
import { MeBookingCancelService } from './me-booking-cancel.service';
import { MeTransportService } from '../dispatch/me-transport.service';

/**
 * ETMS E5: the driver API (/api/driver/v1), the passenger's notification inbox and booking self-cancel, and the
 * durable notification relay.
 * Imported by EtmsModule (the isolation-matrix completeness guard follows imports). PlannedTripsService /
 * TripLiveService are stateless and provided here directly, as in EtmsDispatchModule.
 */
@Module({
  imports: [EtmsPeopleModule],
  controllers: [DriverController, MyTransportNotificationsController, MyTransportBookingsController],
  providers: [PlannedTripsService, TripLiveService, TransportNotificationsService, TransportNotifyRelayService, DriverApiService, MeTransportService, MeBookingCancelService],
})
export class EtmsDriverModule {}
