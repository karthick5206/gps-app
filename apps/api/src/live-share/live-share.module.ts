import { Module } from '@nestjs/common';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { LiveModule } from '../live/live.module';
import { RoutingModule } from '../routing/routing.module';
import { LiveShareController, PublicLiveShareController } from './live-share.controller';
import { LiveShareService } from './live-share.service';

@Module({
  imports: [LiveModule, GeocodingModule, RoutingModule],
  controllers: [LiveShareController, PublicLiveShareController],
  providers: [LiveShareService],
})
export class LiveShareModule {}
