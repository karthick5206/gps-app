import { Module } from '@nestjs/common';
import { ReportDataService } from './report-data.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [ReportDataService],
  exports: [ReportDataService],
})
export class ReportsModule {}
