import { Body, Controller, Delete, Get, HttpCode, Inject, Logger, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  StartLiveVideoRequest,
  StartPlaybackRequest,
  VideoCaptureDto,
  VideoCaptureRequest,
  VideoChannelsDto,
  VideoExtendDto,
  VideoRecordingDto,
  VideoSessionDto,
  VideoSessionStatusDto,
  VideoStreamType,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Request, Response } from 'express';
import { get as httpGet } from 'node:http';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { AuditService } from '../audit/audit.service';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { MEDIAMTX_HLS } from './rtmp-live';
import { verifyVideoToken } from './video-token';
import { VideoService } from './video.service';

class LiveDto implements StartLiveVideoRequest {
  @Type(() => Number) @IsInt() @Min(1) @Max(16) channel!: number;
  @IsOptional() @IsIn(['main', 'sub']) stream?: VideoStreamType;
}

class PlaybackDto implements StartPlaybackRequest {
  @Type(() => Number) @IsInt() @Min(1) @Max(16) channel!: number;
  @IsISO8601() start!: string;
  @IsISO8601() end!: string;
}

class ExtendDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(16) channel!: number;
}

class CaptureDto implements VideoCaptureRequest {
  @Type(() => Number) @IsInt() @Min(1) @Max(16) channel!: number;
  @IsIn(['photo', 'video']) kind!: 'photo' | 'video';
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(10) seconds?: number;
}

class RecordingsQuery {
  @Type(() => Number) @IsInt() @Min(0) @Max(16) channel!: number;
  @IsISO8601() from!: string;
  @IsISO8601() to!: string;
}

class StreamQuery {
  @IsString() @MaxLength(600) token!: string;
}

/** Dashcam video. All routes need `video:view`, except the stream itself, which is authorised by its signed token. */
@Controller('video')
export class VideoController {
  private readonly logger = new Logger('VideoProxy');
  /** RTMP/HLS sessions whose view is already audited (HLS makes many requests per view). */
  private readonly auditedHls = new Set<string>();

  constructor(
    private readonly video: VideoService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get(':objectId/channels') @RequirePermission('video', 'view')
  channels(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string): Promise<VideoChannelsDto> {
    return this.video.channels(ctx, objectId);
  }

  @Post(':objectId/live') @HttpCode(200) @RequirePermission('video', 'view')
  live(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Body() body: LiveDto): Promise<VideoSessionDto> {
    return this.video.live(ctx, objectId, body);
  }

  /** RTMP cameras (Jimi): keep the live stream running for another period. */
  @Post(':objectId/extend') @HttpCode(200) @RequirePermission('video', 'view')
  extend(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Body() body: ExtendDto): Promise<VideoExtendDto> {
    return this.video.extend(ctx, objectId, body.channel);
  }

  /** Photo or short clip on request; it arrives in Video evidence as a "Manual capture" event. */
  @Post(':objectId/capture') @HttpCode(200) @RequirePermission('video', 'view') @Throttle({ default: { ttl: 60_000, limit: 10 } })
  capture(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Body() body: CaptureDto): Promise<VideoCaptureDto> {
    return this.video.capture(ctx, objectId, body);
  }

  @Get(':objectId/recordings') @RequirePermission('video', 'view')
  recordings(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Query() q: RecordingsQuery): Promise<VideoRecordingDto[]> {
    return this.video.recordings(ctx, objectId, q.channel, q.from, q.to);
  }

  @Post(':objectId/playback') @HttpCode(200) @RequirePermission('video', 'view')
  playback(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Body() body: PlaybackDto): Promise<VideoSessionDto> {
    return this.video.playback(ctx, objectId, body);
  }

  @Get('sessions/:id') @RequirePermission('video', 'view')
  status(@Auth() ctx: AuthContext, @Param('id') id: string): Promise<VideoSessionStatusDto> {
    return this.video.status(ctx, id);
  }

  @Delete('sessions/:id') @HttpCode(204) @RequirePermission('video', 'view')
  async leave(@Auth() ctx: AuthContext, @Param('id') id: string): Promise<void> {
    await this.video.leave(ctx, id);
  }

  /**
   * HLS for RTMP cameras (Jimi): `GET /api/video/hls/<sessionId>/<token>/<file>`, proxied from MediaMTX on localhost.
   * The token sits in the path so the playlist's relative segment URLs carry it. The view is audited once per session
   * (first playlist request).
   */
  @Get('hls/:sessionId/:token/*file') @Public()
  async hls(@Param('sessionId') sessionId: string, @Param('token') token: string, @Param('file') file: string | string[], @Req() req: Request, @Res() res: Response): Promise<void> {
    const parts = (Array.isArray(file) ? file : String(file).split('/')).filter(Boolean);
    const claims = verifyVideoToken(decodeURIComponent(token), sessionId, this.env.jwtSecret);
    if (!claims || !parts.length || parts.some((p) => !/^[\w.-]{1,120}$/.test(p) || p.startsWith('.'))) {
      res.status(401).json({ statusCode: 401, message: 'This video link has expired. Start the video again.' });
      return;
    }
    let rec;
    try {
      rec = await this.video.record({ companyId: claims.c, isSuperAdmin: true }, sessionId);
    } catch {
      rec = null;
    }
    if (!rec?.hlsPath) {
      res.status(404).json({ statusCode: 404, message: 'This video stream has ended' });
      return;
    }
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstream = httpGet(`${MEDIAMTX_HLS}/${rec.hlsPath}/${parts.join('/')}${query}`, (up) => {
      res.status(up.statusCode ?? 502);
      const type = up.headers['content-type'];
      if (type) res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
      up.pipe(res);
    });
    upstream.on('error', (error) => {
      this.logger.warn(`MediaMTX unreachable for ${sessionId}: ${error.message}`);
      if (!res.headersSent) res.status(503).json({ statusCode: 503, message: 'The video server is not available' });
      else res.end();
    });
    res.on('close', () => upstream.destroy());
    if (parts.join('/') === 'index.m3u8' && !this.auditedHls.has(sessionId)) {
      this.auditedHls.add(sessionId);
      if (this.auditedHls.size > 5_000) this.auditedHls.clear();
      void this.audit
        .recordSystem(
          { companyId: rec.companyId, userId: claims.u, ip: req.ip ?? null },
          { action: 'CREATE', entity: 'VideoView', entityId: rec.objectId, details: { vehicle: rec.vehicle, channel: rec.channel, kind: rec.kind, sessionId, startedAt: new Date().toISOString(), transport: 'rtmp' } },
        )
        .catch((error: Error) => this.logger.error(`Video audit failed: ${error.message}`));
    }
  }

  /**
   * HTTP-FLV stream: `GET /api/video/streams/<sessionId>.flv?token=…`, piped from the gateway's localhost media server.
   * Each view is audited (vehicle, channel, duration) when the viewer disconnects.
   */
  @Get('streams/:file') @Public()
  async stream(@Param('file') file: string, @Query() q: StreamQuery, @Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = /^([A-Za-z0-9_-]{4,40})\.flv$/.exec(file)?.[1];
    const claims = sessionId ? verifyVideoToken(q.token, sessionId, this.env.jwtSecret) : null;
    if (!sessionId || !claims) {
      res.status(401).json({ statusCode: 401, message: 'This video link has expired. Start the video again.' });
      return;
    }
    let rec;
    try {
      rec = await this.video.record({ companyId: claims.c, isSuperAdmin: true }, sessionId);
    } catch {
      res.status(404).json({ statusCode: 404, message: 'This video stream has ended' });
      return;
    }
    const startedAt = new Date();
    const upstream = httpGet(`${this.video.mediaHttpBase}/live/${sessionId}.flv`, (up) => {
      if (up.statusCode !== 200) {
        res.status(up.statusCode ?? 502).setHeader('Content-Type', 'application/json');
        up.pipe(res);
        return;
      }
      // no-transform: keeps the compression middleware (and proxies) from buffering the live stream.
      res.status(200).set({ 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      up.pipe(res);
      up.on('end', () => res.end());
    });
    upstream.on('error', (error) => {
      this.logger.warn(`Media server unreachable for ${sessionId}: ${error.message}`);
      if (!res.headersSent) res.status(503).json({ statusCode: 503, message: 'The video server is not available' });
      else res.end();
    });
    res.on('close', () => {
      upstream.destroy();
      const durationSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
      void this.audit
        .recordSystem(
          { companyId: rec.companyId, userId: claims.u, ip: req.ip ?? null },
          { action: 'CREATE', entity: 'VideoView', entityId: rec.objectId, details: { vehicle: rec.vehicle, channel: rec.channel, kind: rec.kind, sessionId, startedAt: startedAt.toISOString(), durationSec } },
        )
        .catch((error: Error) => this.logger.error(`Video audit failed: ${error.message}`));
    });
  }
}
