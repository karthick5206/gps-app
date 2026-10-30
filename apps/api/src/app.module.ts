import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AccessModule } from './access/access.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { HealthController } from './health.controller';
import { HistoryModule } from './history/history.module';
import { RoutingModule } from './routing/routing.module';
import { MapsModule } from './maps/maps.module';
import { PointQualityModule } from './point-quality/point-quality.module';
import { ParkingModule } from './parking/parking.module';
import { LiveShareModule } from './live-share/live-share.module';
import { SmartSearchModule } from './smart-search/smart-search.module';
import { DriverScoresModule } from './driver-scores/driver-scores.module';
import { AttendanceModule } from './attendance/attendance.module';
import { DmsModule } from './dms/dms.module';
import { ExpensesModule } from './expenses/expenses.module';
import { TransferModule } from './transfer/transfer.module';
import { LiveModule } from './live/live.module';
import { GeofencesModule } from './masters/geofences/geofences.module';
import { MastersModule } from './masters/masters.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { PrismaModule } from './prisma/prisma.module';
import { DownloadsModule } from './downloads/downloads.module';
import { PurgeModule } from './purge/purge.module';
import { RedisModule } from './redis/redis.module';
import { ReportSchedulesModule } from './report-schedules/report-schedules.module';
import { CommandsModule } from './commands/commands.module';
import { VideoModule } from './video/video.module';
import { DriverEventsModule } from './driver-events/driver-events.module';
import { DriversModule } from './drivers/drivers.module';
import { DocumentsModule } from './documents/documents.module';
import { PoisModule } from './pois/pois.module';
import { FuelModule } from './fuel/fuel.module';
import { IoSensorsModule } from './io-sensors/io-sensors.module';
import { MobileTrackerModule } from './mobile-tracker/mobile-tracker.module';
import { SignupModule } from './signup/signup.module';
import { GuideModule } from './guide/guide.module';
import { DeviceClaimModule } from './device-claim/device-claim.module';
import { LicencesModule } from './licences/licences.module';
import { DeveloperModule } from './developer/developer.module';
import { PublicApiModule } from './public-api/public-api.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { RetentionModule } from './retention/retention.module';
import { ReportsModule } from './reports/reports.module';
import { TemplatesModule } from './templates/templates.module';
import { RelayModule } from './relay/relay.controller';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    PurgeModule,
    DownloadsModule,
    GeocodingModule,
    ScheduleModule.forRoot(),
    AccessModule,
    AuditModule,
    LicencesModule,
    AuthModule,
    // Before MastersModule: GET /objects/:id/history (?from&to = track history, else the M1 audit history) is served here.
    HistoryModule,
    RoutingModule,
    MapsModule,
    PointQualityModule,
    ParkingModule,
    LiveShareModule,
    SmartSearchModule,
    DriverScoresModule,
    AttendanceModule,
    ExpensesModule,
    DmsModule,
    TransferModule,
    MastersModule,
    LiveModule,
    AlertsModule,
    TemplatesModule,
    GeofencesModule,
    ReportsModule,
    ReportSchedulesModule,
    DashboardModule,
    RetentionModule,
    CommandsModule,
    VideoModule,
    DriverEventsModule,
    DriversModule,
    DocumentsModule,
    PoisModule,
    FuelModule,
    IoSensorsModule,
    MobileTrackerModule,
    SignupModule,
    GuideModule,
    DeviceClaimModule,
    DeveloperModule,
    RelayModule,
    PublicApiModule,
    MonitoringModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
