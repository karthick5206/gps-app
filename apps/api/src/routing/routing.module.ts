import { Module } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { MatrixBuilder } from './matrix/matrix-builder';
import { createMatrixBuilder } from './matrix/matrix.factory';
import { GraphHopperProvider } from './provider/graphhopper.provider';
import { readRouterConfig } from './provider/router-config';
import { ROUTING_PROVIDER } from './provider/routing-provider';
import { RoutingController } from './routing.controller';
import { RoutingService } from './routing.service';

@Module({
  controllers: [RoutingController],
  providers: [
    RoutingService,
    // E4 WP 4.1b M1 matrix (off unless ETMS_ROUTING=on): Valkey cache + stats for System Health.
    { provide: MatrixBuilder, inject: [RedisService], useFactory: (redis: RedisService) => createMatrixBuilder(redis.client) },
    // E4 RoutingProvider (GraphHopper only). No v1.8 caller uses it yet; RoutingService keeps serving them unchanged.
    {
      provide: GraphHopperProvider,
      inject: [MatrixBuilder],
      useFactory: (matrix: MatrixBuilder) => new GraphHopperProvider(readRouterConfig(process.env)).attachMatrix(matrix),
    },
    { provide: ROUTING_PROVIDER, useExisting: GraphHopperProvider },
  ],
  exports: [RoutingService, GraphHopperProvider, ROUTING_PROVIDER, MatrixBuilder],
})
export class RoutingModule {}
