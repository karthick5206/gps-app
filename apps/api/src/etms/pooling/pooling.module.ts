import { Module } from '@nestjs/common';
import { OptimizerClient, readOptimizerConfig } from '../../routing/optimizer/optimizer.client';
import { EtmsDispatchModule } from '../dispatch/dispatch.module';
import { EtmsPeopleModule } from '../people/people.module';
import { LiveDispatchService } from './live-dispatch.service';
import { LiveDispatchWorker } from './live-dispatch.worker';
import { DriverRouteAckController, LiveDispatchController, MySharingPolicyController, PoolingController } from './pooling.controller';
import { PoolingService } from './pooling.service';

/**
 * ETMS on-demand pooling and live dispatch (doc 20, phases B–D backend): hold, sharing policy, pooling settings,
 * driver hours, vehicle availability, live dispatch (decide endpoint, worker, driver acknowledgement). Imported by
 * EtmsModule (the isolation-matrix completeness guard follows imports). The optimiser client is provided here directly
 * (contract v3 insertOnly; optional — without it, or before the solver offers pdp, the in-process insertion is used).
 */
@Module({
  imports: [EtmsDispatchModule, EtmsPeopleModule],
  controllers: [PoolingController, LiveDispatchController, MySharingPolicyController, DriverRouteAckController],
  providers: [PoolingService, LiveDispatchService, LiveDispatchWorker, { provide: OptimizerClient, useFactory: () => new OptimizerClient(readOptimizerConfig(process.env)) }],
  exports: [LiveDispatchService],
})
export class EtmsPoolingModule {}
