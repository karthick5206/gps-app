import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { HistoryImportController } from './history-import.controller';
import { HistoryImportService } from './history-import.service';

@Module({
  imports: [HistoryModule],
  controllers: [HistoryImportController],
  providers: [HistoryImportService],
})
export class HistoryImportModule {}
