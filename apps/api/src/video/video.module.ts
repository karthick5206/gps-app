import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';

/** Dashcam video (JT/T 1078) — signalling via the gateway, HTTP-FLV proxy for viewers. */
@Module({
  controllers: [VideoController],
  providers: [VideoService],
  exports: [VideoService],
})
export class VideoModule {}
