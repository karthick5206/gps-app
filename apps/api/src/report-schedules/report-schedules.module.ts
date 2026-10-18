import { Module } from '@nestjs/common';
import { MailerService } from '../auth/mailer.service';
import { ReportsModule } from '../reports/reports.module';
import { ReportSchedulerService } from './report-scheduler.service';
import { ReportRunsController, ReportSchedulesController } from './report-schedules.controller';
import { ReportSchedulesService } from './report-schedules.service';

@Module({
  imports: [ReportsModule],
  controllers: [ReportSchedulesController, ReportRunsController],
  providers: [ReportSchedulesService, ReportSchedulerService, MailerService],
})
export class ReportSchedulesModule {}
