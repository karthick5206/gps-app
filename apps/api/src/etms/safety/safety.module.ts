import { Module } from '@nestjs/common';
import { IncidentsService } from './incidents.service';
import { SafetyOutboxRelayService } from './safety-outbox-relay.service';
import { DriverSosController, IncidentsController, MySosController } from './safety.controller';
import { SosDirectSender } from './sos-direct-sender';
import { SosService } from './sos.service';

/**
 * ETMS E5 WP 5.4: durable SOS — passenger / driver raise, the dispatcher SOS lane, and the SAFETY outbox relay with its
 * direct-send fallback. Imported by EtmsModule (the isolation-matrix completeness guard follows imports).
 */
@Module({
  controllers: [MySosController, DriverSosController, IncidentsController],
  providers: [SosService, IncidentsService, SafetyOutboxRelayService, SosDirectSender],
  exports: [SafetyOutboxRelayService],
})
export class EtmsSafetyModule {}
