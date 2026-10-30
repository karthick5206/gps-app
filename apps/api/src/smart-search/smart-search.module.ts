import { Module } from '@nestjs/common';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { LiveModule } from '../live/live.module';
import { SmartSearchController } from './smart-search.controller';
import { SmartSearchService } from './smart-search.service';

@Module({
  imports: [LiveModule, GeocodingModule],
  controllers: [SmartSearchController],
  providers: [SmartSearchService],
})
export class SmartSearchModule {}
