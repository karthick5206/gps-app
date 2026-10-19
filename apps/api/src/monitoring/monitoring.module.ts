import { Module } from '@nestjs/common';
import { MailerService } from '../auth/mailer.service';
import { MetricsController, SuperAdminAccess, SystemHealthController } from './system-health.controller';
import { SystemHealthService } from './system-health.service';
import { SystemMonitorService } from './system-monitor.service';

/** System Health: report endpoint, checks + e-mail alerts, API heartbeat, throughput sampler, Prometheus metrics. */
@Module({
  controllers: [SystemHealthController, MetricsController],
  providers: [SystemHealthService, SystemMonitorService, SuperAdminAccess, MailerService],
})
export class MonitoringModule {}
