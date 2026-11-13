import { Global, Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { RoutingSwitchController } from './routing-switch.controller';
import { RoutingSwitchService } from './routing-switch.service';

/**
 * v1.16 automatic route planning switch (API process only; the routing worker reads the switch with its own cache).
 * Global so System Health, capabilities and retention can read the decision without import chains.
 */
@Global()
@Module({
  imports: [RoutingModule],
  controllers: [RoutingSwitchController],
  providers: [RoutingSwitchService],
  exports: [RoutingSwitchService],
})
export class RoutingSwitchModule {}
