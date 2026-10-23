import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailerService } from '../auth/mailer.service';
import { MobileTrackerAdminController, MobileTrackerController } from './mobile-tracker.controller';
import { MobileTrackerService } from './mobile-tracker.service';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
  controllers: [MobileTrackerController, MobileTrackerAdminController],
  providers: [MobileTrackerService, MailerService],
})
export class MobileTrackerModule {}
