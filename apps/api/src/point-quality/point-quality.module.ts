import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { PointQualityController } from './point-quality.controller';
import { PointQualityService } from './point-quality.service';

@Module({
  imports: [HistoryModule],
  controllers: [PointQualityController],
  providers: [PointQualityService],
})
export class PointQualityModule {}
