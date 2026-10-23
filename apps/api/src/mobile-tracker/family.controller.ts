import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { FamilyService } from './family.service';

class FamilyRequestBody {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsString() @MaxLength(24) mobile!: string;
}

class FamilyVerifyBody {
  @IsString() @MaxLength(24) mobile!: string;
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/, { message: 'The code has 6 digits' }) code!: string;
}

/** Personal accounts: add a family member's phone with their OTP consent (see FamilyService). */
@Controller('family/members')
export class FamilyController {
  constructor(private readonly service: FamilyService) {}

  @Get() @RequirePermission('devices', 'view')
  list(@Auth() ctx: AuthContext) {
    return this.service.list(ctx);
  }

  @Post('request') @HttpCode(200) @RequirePermission('devices', 'create')
  request(@Auth() ctx: AuthContext, @Body() body: FamilyRequestBody) {
    return this.service.request(ctx, body);
  }

  @Post('verify') @HttpCode(200) @RequirePermission('devices', 'create')
  verify(@Auth() ctx: AuthContext, @Body() body: FamilyVerifyBody) {
    return this.service.verify(ctx, body);
  }
}
