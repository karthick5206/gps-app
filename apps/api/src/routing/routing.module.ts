import { Module } from '@nestjs/common';
import { GraphHopperProvider } from './provider/graphhopper.provider';
import { readRouterConfig } from './provider/router-config';
import { ROUTING_PROVIDER } from './provider/routing-provider';
import { RoutingController } from './routing.controller';
import { RoutingService } from './routing.service';

@Module({
  controllers: [RoutingController],
  providers: [
    RoutingService,
    // E4 RoutingProvider (GraphHopper only). No v1.8 caller uses it yet; RoutingService keeps serving them unchanged.
    { provide: GraphHopperProvider, useFactory: () => new GraphHopperProvider(readRouterConfig(process.env)) },
    { provide: ROUTING_PROVIDER, useExisting: GraphHopperProvider },
  ],
  exports: [RoutingService, GraphHopperProvider, ROUTING_PROVIDER],
})
export class RoutingModule {}
