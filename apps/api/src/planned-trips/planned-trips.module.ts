import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { PlannedTripJobService } from './planned-trip-job.service';
import { PlannedTripsController } from './planned-trips.controller';
import { PlannedTripsService } from './planned-trips.service';
import { RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';

/** Routes & planned trips (module RTE, docs/routes-trips/SPEC.md): routes + schedules, planned trips, generator / sweeper. */
@Module({
  imports: [RoutingModule],
  controllers: [RoutesController, PlannedTripsController],
  providers: [RoutesService, PlannedTripsService, PlannedTripJobService],
  exports: [PlannedTripsService, PlannedTripJobService],
})
export class PlannedTripsModule {}
