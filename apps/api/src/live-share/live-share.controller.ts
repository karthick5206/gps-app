import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { LIVE_SHARE_MAX_HOURS, type LiveShareCreatedDto, type LiveShareDto, type PublicLiveShareDto } from '@veetracer/shared';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { LiveShareService } from './live-share.service';

class CreateShareBody {
  @IsUUID() objectId!: string;
  @IsInt() @Min(1) @Max(LIVE_SHARE_MAX_HOURS) hours!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class ShareListQuery {
  @IsUUID() objectId!: string;
}

/** Live location share links (signed in): create for N hours, list a vehicle's links, stop one. */
@Controller('live-shares')
export class LiveShareController {
  constructor(private readonly shares: LiveShareService) {}

  @Post() @RequirePermission('live_map', 'view')
  create(@Auth() ctx: AuthContext, @Body() body: CreateShareBody): Promise<LiveShareCreatedDto> {
    return this.shares.create(ctx, body.objectId, body.hours, body.note);
  }

  @Get() @RequirePermission('live_map', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: ShareListQuery): Promise<LiveShareDto[]> {
    return this.shares.list(ctx, q.objectId);
  }

  @Post(':id/revoke') @HttpCode(200) @RequirePermission('live_map', 'view')
  revoke(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<LiveShareDto> {
    return this.shares.revoke(ctx, id);
  }
}

/** The public page behind a share link (no sign-in). Polled every few seconds by the viewer's browser. */
@Controller('public/live-share')
@UseGuards(ThrottlerGuard)
export class PublicLiveShareController {
  constructor(private readonly shares: LiveShareService) {}

  @Public() @Get(':token') @Throttle({ default: { ttl: 60_000, limit: 40 } })
  view(@Param('token') token: string): Promise<PublicLiveShareDto> {
    return this.shares.view(token);
  }
}
