import { Body, Controller, Get, Headers, Put, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PhotoFeaturesDto } from '@veetracer/shared';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, Public } from '../access/decorators';
import { MobileTrackerService } from '../mobile-tracker/mobile-tracker.service';
import { PhotoFeaturesService } from './photo-features.service';

class PhotoFeaturesBody {
  @IsOptional() @IsBoolean() personPhotos?: boolean;
  @IsOptional() @IsBoolean() photoNotes?: boolean;
}

/**
 * Person photos / photo notes switches of the acting company. Anyone signed in may read them (the apps hide the
 * features while off; they also come with /auth/me); changing needs an administrator (PhotoFeaturesService.set).
 */
@Controller('company/photo-features')
export class PhotoFeaturesController {
  constructor(private readonly service: PhotoFeaturesService) {}

  @Get()
  get(@Auth() ctx: AuthContext): Promise<PhotoFeaturesDto> {
    return this.service.get(ctx);
  }

  @Put()
  set(@Auth() ctx: AuthContext, @Body() body: PhotoFeaturesBody): Promise<PhotoFeaturesDto> {
    return this.service.set(ctx, body);
  }
}

/** Tracker app: the switches of the phone's account; only the owner of a personal / family account may change them. */
@Controller('tracker/v1/photo-features')
@UseGuards(ThrottlerGuard)
export class TrackerPhotoFeaturesController {
  constructor(
    private readonly service: PhotoFeaturesService,
    private readonly tracker: MobileTrackerService,
  ) {}

  @Public() @SkipThrottle() @Get()
  async get(@Headers('authorization') authorization: string | undefined): Promise<PhotoFeaturesDto> {
    const p = await this.tracker.phoneSession(authorization);
    return this.service.trackerGet(p.deviceId, p.uniqueId);
  }

  @Public() @Put() @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async set(@Headers('authorization') authorization: string | undefined, @Body() body: PhotoFeaturesBody): Promise<PhotoFeaturesDto> {
    const p = await this.tracker.phoneSession(authorization);
    return this.service.trackerSet(p.deviceId, p.uniqueId, body);
  }
}
