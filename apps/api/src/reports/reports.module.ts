import { Module } from '@nestjs/common';
import { AddressEnricher } from './address-enricher';
import { ReportDataService } from './report-data.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [ReportDataService, AddressEnricher],
  exports: [ReportDataService],
})
export class ReportsModule {}
