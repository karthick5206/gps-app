import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { DriverScoresModule } from '../driver-scores/driver-scores.module';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { LiveModule } from '../live/live.module';
import { SmartSearchController } from './smart-search.controller';
import { SmartSearchService } from './smart-search.service';

@Module({
  imports: [LiveModule, GeocodingModule, AttendanceModule, DriverScoresModule],
  controllers: [SmartSearchController],
  providers: [SmartSearchService],
})
export class SmartSearchModule {}
