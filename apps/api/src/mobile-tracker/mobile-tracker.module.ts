import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailerService } from '../auth/mailer.service';
import { MobileTrackerAdminController, MobileTrackerController } from './mobile-tracker.controller';
import { MobileTrackerService } from './mobile-tracker.service';
import { TrackerSelfService } from './self-service';
import { FamilyController } from './family.controller';
import { FamilyService } from './family.service';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
  controllers: [MobileTrackerController, MobileTrackerAdminController, FamilyController],
  providers: [MobileTrackerService, TrackerSelfService, FamilyService, MailerService],
})
export class MobileTrackerModule {}
