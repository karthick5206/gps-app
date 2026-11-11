import { Module } from '@nestjs/common';
import { GraphHopperProvider } from '../../routing/provider/graphhopper.provider';
import { readRouterConfig } from '../../routing/provider/router-config';
import { ROUTING_PROVIDER } from '../../routing/provider/routing-provider';
import { EtmsDispatchModule } from '../dispatch/dispatch.module';
import { RoutingJobsModule } from '../../routing-jobs/routing-jobs.module';
import { RoutePlanCreateController, RoutePlanCreateService } from './plan-create';
import { RoutePlansController } from './plans.controller';
import { RoutePlansService } from './plans.service';

/**
 * ETMS E4 route plans (doc 17 §7 P9): plans API and publish into E3 trips through DispatchService. The RoutingProvider
 * (GraphHopper) is provided here directly instead of importing RoutingModule, so no fleet controller joins the ETMS
 * module graph (the isolation-matrix completeness guard follows imports).
 */
@Module({
  // E4 WP 4.2: optimisation jobs + capabilities (routing/jobs, routing/capabilities) join the ETMS module graph, so the
  // isolation-matrix completeness guard covers them.
  imports: [EtmsDispatchModule, RoutingJobsModule],
  controllers: [RoutePlansController, RoutePlanCreateController],
  providers: [RoutePlansService, RoutePlanCreateService, { provide: ROUTING_PROVIDER, useFactory: () => new GraphHopperProvider(readRouterConfig(process.env)) }],
})
export class EtmsPlanningModule {}
