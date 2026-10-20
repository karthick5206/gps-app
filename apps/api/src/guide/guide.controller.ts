import { Controller, Get, HttpCode, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthContext } from '../access/auth-context';
import { Auth, Public } from '../access/decorators';
import { GUIDE_PDF_NAME, GuideService } from './guide.service';

/** Getting-started guide: public PDF (linked from /guide, emails and the apps) and "email it to me". */
@Controller('guide')
@UseGuards(ThrottlerGuard)
export class GuideController {
  constructor(private readonly guide: GuideService) {}

  @Public() @Get('pdf') @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async pdf() {
    return new StreamableFile(await this.guide.pdf(), { type: 'application/pdf', disposition: `attachment; filename="${GUIDE_PDF_NAME}"` });
  }

  @Post('email') @HttpCode(200) @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  email(@Auth() ctx: AuthContext) {
    return this.guide.emailUser(ctx.userId);
  }
}
