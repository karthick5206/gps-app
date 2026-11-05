import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { AddressEnricher } from './address-enricher';
import { ReportDataService } from './report-data.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [AttendanceModule],
  controllers: [ReportsController],
  providers: [ReportDataService, AddressEnricher],
  exports: [ReportDataService],
})
export class ReportsModule {}
