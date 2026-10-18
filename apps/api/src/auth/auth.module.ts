import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailerService } from './mailer.service';
import { MeService } from './me.service';
import { TokenService } from './token.service';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }])],
  controllers: [AuthController],
  providers: [AuthService, TokenService, MeService, MailerService],
})
export class AuthModule {}
