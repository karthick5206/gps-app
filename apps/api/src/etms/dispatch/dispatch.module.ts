import { Module } from '@nestjs/common';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { RoutingService } from '../../routing/routing.service';
import { TransportNotificationsService } from '../notifications/transport-notifications.service';
import { EtmsPeopleModule } from '../people/people.module';
import { BookingGeneratorService } from './booking-generator.service';
import { TripAutoStartService } from './trip-auto-start.service';
import { TransportInsightsController, TransportInsightsService } from './transport-insights';
import { SafetyWatchController, SafetyWatchService } from './safety-watch';
import { BookingsService } from './bookings.service';
import { DispatchService } from './dispatch.service';
import { BookingsController, DispatchController, MyTransportTripsController, SchedulesController, ShiftsController, TransportTripsController } from './e3.controllers';
import { MeTransportService } from './me-transport.service';
import { SchedulesService } from './schedules.service';
import { TripLiveService } from './trip-live';
import { TripsService } from './trips.service';

/**
 * ETMS E3: shifts, schedules + booking generator, bookings, dispatch (board, candidates, change sets, repeat drafts),
 * transport trips with dispatcher progression and passenger outcomes, and the passenger's own trip view. Imported by
 * EtmsModule (the isolation-matrix completeness guard follows imports). PlannedTripsService and RoutingService are
 * stateless and provided here directly (their globals Prisma / Audit / AlertTargets / Redis come from global modules)
 * instead of importing the fleet modules, so no fleet controller becomes part of the ETMS module graph.
 */
@Module({
  imports: [EtmsPeopleModule],
  controllers: [ShiftsController, SchedulesController, BookingsController, DispatchController, TransportTripsController, MyTransportTripsController, TransportInsightsController, SafetyWatchController],
  providers: [TransportNotificationsService, PlannedTripsService, RoutingService, BookingGeneratorService, SchedulesService, BookingsService, DispatchService, TripsService, MeTransportService, TripLiveService, TripAutoStartService, TransportInsightsService, SafetyWatchService],
  exports: [BookingGeneratorService, DispatchService],
})
export class EtmsDispatchModule {}
