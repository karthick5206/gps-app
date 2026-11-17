import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { RoutingModule } from '../routing/routing.module';
import { HistoryImportController } from './history-import.controller';
import { HistoryImportService } from './history-import.service';

@Module({
  imports: [HistoryModule, RoutingModule],
  controllers: [HistoryImportController],
  providers: [HistoryImportService],
})
export class HistoryImportModule {}
