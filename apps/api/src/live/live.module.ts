import { Module } from '@nestjs/common';
import { LiveStateService } from './live-state.service';
import { LiveController } from './live.controller';
import { LiveGateway } from './live.gateway';
import { LiveService } from './live.service';
import { OfflineSweeperService } from './offline-sweeper.service';

@Module({
  controllers: [LiveController],
  providers: [LiveStateService, LiveService, LiveGateway, OfflineSweeperService],
})
export class LiveModule {}
