import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../access/decorators';
import { SignupCompleteBody, SignupRequestBody } from './signup.dto';
import { SignupService } from './signup.service';

/** Personal account self sign-up (email code). Businesses are still created by the Super Admin / partners. */
@Controller('signup')
@UseGuards(ThrottlerGuard)
export class SignupController {
  constructor(private readonly service: SignupService) {}

  @Public() @Post('request') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  request(@Body() body: SignupRequestBody, @Req() req: Request) {
    return this.service.requestCode(body.email, req.ip ?? null);
  }

  @Public() @Post('complete') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  complete(@Body() body: SignupCompleteBody) {
    return this.service.complete(body);
  }
}
