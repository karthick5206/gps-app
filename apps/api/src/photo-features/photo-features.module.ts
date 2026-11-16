import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { MobileTrackerModule } from '../mobile-tracker/mobile-tracker.module';
import { PhotoFeaturesController, TrackerPhotoFeaturesController } from './photo-features.controller';
import { PhotoFeaturesService } from './photo-features.service';

@Module({
  imports: [MobileTrackerModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
  controllers: [PhotoFeaturesController, TrackerPhotoFeaturesController],
  providers: [PhotoFeaturesService],
  exports: [PhotoFeaturesService],
})
export class PhotoFeaturesModule {}
