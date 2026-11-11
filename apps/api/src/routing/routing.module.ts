import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OptimizerClient, readOptimizerConfig } from './optimizer/optimizer.client';
import { RedisService } from '../redis/redis.service';
import { MatrixBuilder } from './matrix/matrix-builder';
import { createMatrixBuilder } from './matrix/matrix.factory';
import { GraphHopperProvider } from './provider/graphhopper.provider';
import { readRouterConfig } from './provider/router-config';
import { ROUTING_PROVIDER } from './provider/routing-provider';
import { RoutingController } from './routing.controller';
import { RoutingService } from './routing.service';
import { RoutingUsageService } from './usage/routing-usage.service';

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
    // E4 salvage (doc 17 §5.1). Both stay inert unless ETMS_ROUTING=on: no call reaches the optimiser or the
    // RoutingUsage table while the switch is off.
    { provide: OptimizerClient, useFactory: () => new OptimizerClient(readOptimizerConfig(process.env)) },
    { provide: RoutingUsageService, useFactory: (prisma: PrismaService) => new RoutingUsageService(prisma), inject: [PrismaService] },
  ],
  exports: [RoutingService, GraphHopperProvider, ROUTING_PROVIDER, MatrixBuilder, OptimizerClient, RoutingUsageService],
})
export class RoutingModule {}
