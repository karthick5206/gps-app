import { Module } from '@nestjs/common';
import { BookingsService } from '../dispatch/bookings.service';
import { MeTransportService } from '../dispatch/me-transport.service';
import { TransportNotificationsService } from '../notifications/transport-notifications.service';
import { EtmsPeopleModule } from '../people/people.module';
import { MySelfServiceController } from './self-service.controller';
import { SelfServiceService } from './self-service.service';

/**
 * ETMS E5 WP 5.3: passenger self-service (book, commute, saved places, confirm, report). Imported by EtmsModule (the
 * isolation-matrix completeness guard follows imports). BookingsService / MeTransportService are stateless and provided
 * here directly, as EtmsDriverModule does for MeTransportService.
 */
@Module({
  imports: [EtmsPeopleModule],
  controllers: [MySelfServiceController],
  providers: [TransportNotificationsService, BookingsService, MeTransportService, SelfServiceService],
})
export class EtmsSelfServiceModule {}
