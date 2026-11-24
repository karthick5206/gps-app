import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';

/** Dashcam video: JT/T 1078 via the gateway (HTTP-FLV proxy) and RTMP cameras via MediaMTX (HLS proxy). */
@Module({
  imports: [CommandsModule],
  controllers: [VideoController],
  providers: [VideoService],
  exports: [VideoService],
})
export class VideoModule {}
