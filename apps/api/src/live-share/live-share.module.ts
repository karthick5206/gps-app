import { Module } from '@nestjs/common';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { LiveModule } from '../live/live.module';
import { LiveShareController, PublicLiveShareController } from './live-share.controller';
import { LiveShareService } from './live-share.service';

@Module({
  imports: [LiveModule, GeocodingModule],
  controllers: [LiveShareController, PublicLiveShareController],
  providers: [LiveShareService],
})
export class LiveShareModule {}
