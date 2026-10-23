import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsIn, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth } from '../access/decorators';
import { PURGE_KINDS, type PurgeKind } from './purge-plan';
import { PurgeService } from './purge.service';

class PurgeParams {
  @IsIn(PURGE_KINDS) kind!: PurgeKind;
  @IsUUID() id!: string;
}

class PurgeBody {
  @IsString() @MaxLength(200) confirm!: string;
}

/** Super Admin only (checked in the service): preview what a permanent delete removes, then do it. */
@Controller('admin/purge')
export class PurgeController {
  constructor(private readonly service: PurgeService) {}

  @Get(':kind/:id')
  preview(@Auth() ctx: AuthContext, @Param() p: PurgeParams) {
    return this.service.preview(ctx, p.kind, p.id);
  }

  @Post(':kind/:id') @HttpCode(200)
  purge(@Auth() ctx: AuthContext, @Param() p: PurgeParams, @Body() body: PurgeBody) {
    return this.service.purge(ctx, p.kind, p.id, body.confirm);
  }
}
