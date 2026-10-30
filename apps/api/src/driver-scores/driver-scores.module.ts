import { Module } from '@nestjs/common';
import { DriverScoresController } from './driver-scores.controller';
import { DriverScoresService } from './driver-scores.service';

@Module({
  controllers: [DriverScoresController],
  providers: [DriverScoresService],
})
export class DriverScoresModule {}
