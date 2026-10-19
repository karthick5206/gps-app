import { Module } from '@nestjs/common';
import { AddressEnricher } from '../reports/address-enricher';
import { DriverEventsController } from './driver-events.controller';
import { DriverEventsService } from './driver-events.service';

/** Driver behaviour events API. Capture runs in the gateway (snapshots / attachments) and the notifier (linking). */
@Module({
  controllers: [DriverEventsController],
  providers: [DriverEventsService, AddressEnricher],
  exports: [DriverEventsService],
})
export class DriverEventsModule {}
