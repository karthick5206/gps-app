import { Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailerService } from '../auth/mailer.service';
import { GuideController } from './guide.controller';
import { GuideService } from './guide.service';

/** Global so sign-up can send the welcome guide. */
@Global()
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }])],
  controllers: [GuideController],
  providers: [GuideService, MailerService],
  exports: [GuideService],
})
export class GuideModule {}
