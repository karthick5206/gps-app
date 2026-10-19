import { Module } from '@nestjs/common';
import { MailerService } from '../auth/mailer.service';
import { AppConfigModule } from '../config/config.module';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { NotifierService } from './notifier.service';
import { WebhookWorkerService } from '../webhooks/webhook-worker.service';

@Module({
  imports: [AppConfigModule, PrismaModule, RedisModule, GeocodingModule],
  providers: [MailerService, NotifierService, WebhookWorkerService],
})
export class NotifierModule {}
