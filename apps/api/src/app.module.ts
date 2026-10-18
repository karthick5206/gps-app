import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AccessModule } from './access/access.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { HealthController } from './health.controller';
import { LiveModule } from './live/live.module';
import { MastersModule } from './masters/masters.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    GeocodingModule,
    ScheduleModule.forRoot(),
    AccessModule,
    AuditModule,
    AuthModule,
    MastersModule,
    LiveModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
