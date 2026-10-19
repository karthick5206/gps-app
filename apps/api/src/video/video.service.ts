import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import {
  StartLiveVideoRequest,
  StartPlaybackRequest,
  VIDEO_DEFAULT_CHANNELS,
  VideoChannelsDto,
  VideoErrorCode,
  VideoRecordingDto,
  VideoSessionDto,
  VideoSessionKind,
  VideoSessionStatusDto,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { VideoGatewayReply, VideoRequestBody } from './video-messages';
import { signVideoToken } from './video-token';

const REPLY_TIMEOUT_MS = 20_000;
const SESSION_TTL_SEC = 6 * 3600;
const ATTRIBUTES_TTL_SEC = 86_400;
/** Longest recordings query (dashcams answer slowly for big ranges). */
const MAX_RECORDING_RANGE_MS = 24 * 3600_000;
const MAX_PLAYBACK_MS = 2 * 3600_000;
const MAX_CHANNEL = 16;

const STATUS: Record<VideoErrorCode, number> = {
  DEVICE_OFFLINE: HttpStatus.CONFLICT,
  NOT_DASHCAM: HttpStatus.BAD_REQUEST,
  STREAM_LIMIT: HttpStatus.SERVICE_UNAVAILABLE,
  CODEC_UNSUPPORTED: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  DEVICE_REFUSED: HttpStatus.BAD_GATEWAY,
  DEVICE_TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  VIDEO_DISABLED: HttpStatus.SERVICE_UNAVAILABLE,
};

export const videoError = (code: VideoErrorCode, message: string) => new HttpException({ statusCode: STATUS[code], code, message }, STATUS[code]);

export interface VideoTarget {
  objectId: string;
  companyId: string;
  name: string;
  uniqueId: string;
}

/** What the API remembers about a session (Valkey), to authorise status / leave / stream calls. */
export interface VideoSessionRecord {
  objectId: string;
  companyId: string;
  vehicle: string;
  uniqueId: string;
  channel: number;
  kind: VideoSessionKind;
}

/**
 * Dashcam video (JT/T 1078). Signalling goes to the gateway holding the device's JT808 connection over Valkey
 * pub/sub (`vt:video:gw:<id>` → `vt:video:replies`); media is pulled from that gateway's localhost HTTP-FLV server
 * by VideoController and piped to the viewer.
 */
@Injectable()
export class VideoService implements OnModuleInit {
  private readonly logger = new Logger('Video');
  private readonly pending = new Map<string, { resolve: (r: VideoGatewayReply) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

  onModuleInit(): void {
    this.redis.subscribe([RedisKeys.videoReplies], (_channel, message) => {
      try {
        const reply = JSON.parse(message) as VideoGatewayReply;
        const p = this.pending.get(reply.reqId);
        if (!p) return;
        this.pending.delete(reply.reqId);
        clearTimeout(p.timer);
        p.resolve(reply);
      } catch {
        // ignore malformed
      }
    });
  }

  /** Local HTTP-FLV endpoint of the gateway (single-server deployment). */
  get mediaHttpBase(): string {
    return `http://127.0.0.1:${this.env.mediaHttpPort}`;
  }

  /** Vehicle in the caller's scope whose current device is a JT808 dashcam with the `video` capability. */
  async target(ctx: AuthContext, objectId: string): Promise<VideoTarget> {
    const o = await this.prisma.trackedObject.findFirst({
      where: { AND: [objectScopeWhere(ctx), { id: objectId }] },
      select: {
        id: true,
        companyId: true,
        name: true,
        assignments: { where: { toTime: null }, select: { device: { select: { uniqueId: true, model: { select: { protocol: true, capabilities: true } } } } } },
      },
    });
    if (!o) throw new NotFoundException('Vehicle not found');
    await this.licences?.assertViewable(ctx, o.id);
    const d = o.assignments[0]?.device;
    if (!d || d.model.protocol.toLowerCase() !== 'jt808' || !d.model.capabilities.includes('video')) {
      throw videoError('NOT_DASHCAM', 'This vehicle has no dashcam with video. Video needs a JT/T 1078 dashcam (e.g. Mettax MC202).');
    }
    return { objectId: o.id, companyId: o.companyId, name: o.name, uniqueId: d.uniqueId };
  }

  /** Sends one request to the device's gateway and waits for the answer; gateway errors become HTTP errors. */
  async ask(uniqueId: string, req: VideoRequestBody): Promise<VideoGatewayReply> {
    const gatewayId = await this.redis.client.get(RedisKeys.connection(uniqueId));
    if (!gatewayId) throw videoError('DEVICE_OFFLINE', 'The dashcam is offline. Video needs the device to be connected.');
    const reqId = randomUUID();
    const reply = new Promise<VideoGatewayReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ reqId, ok: false, error: { code: 'DEVICE_TIMEOUT', message: 'The video server did not answer in time. Try again.' } });
      }, REPLY_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, timer });
    });
    const receivers = await this.redis.client.publish(RedisKeys.videoChannel(gatewayId), JSON.stringify({ ...req, reqId, uniqueId }));
    if (!receivers) {
      clearTimeout(this.pending.get(reqId)?.timer);
      this.pending.delete(reqId);
      throw videoError('VIDEO_DISABLED', 'Video is not enabled on the device server (MEDIA_PORT).');
    }
    const r = await reply;
    if (!r.ok) throw videoError(r.error?.code ?? 'DEVICE_REFUSED', r.error?.message ?? 'Video request failed');
    return r;
  }

  private assertChannel(channel: number): void {
    if (!Number.isInteger(channel) || channel < 1 || channel > MAX_CHANNEL) throw new BadRequestException(`Channel must be 1–${MAX_CHANNEL}`);
  }

  async channels(ctx: AuthContext, objectId: string): Promise<VideoChannelsDto> {
    const t = await this.target(ctx, objectId);
    const key = RedisKeys.videoAttributes(t.uniqueId);
    let count: number | null = null;
    const cached = await this.redis.client.get(key);
    if (cached) count = (JSON.parse(cached) as { maxVideoChannels: number }).maxVideoChannels;
    else {
      // Ask the dashcam (0x9003 → 0x1003) once a day; offline or silent devices get the default.
      const attrs = await this.ask(t.uniqueId, { op: 'attributes' }).then((r) => r.attributes ?? null).catch(() => null);
      if (attrs) {
        await this.redis.client.set(key, JSON.stringify(attrs), 'EX', ATTRIBUTES_TTL_SEC);
        count = attrs.maxVideoChannels;
      }
    }
    const valid = count !== null && count >= 1 && count <= MAX_CHANNEL;
    const n = valid ? count! : VIDEO_DEFAULT_CHANNELS;
    return { channels: Array.from({ length: n }, (_, i) => i + 1), source: valid ? 'device' : 'default' };
  }

  async live(ctx: AuthContext, objectId: string, req: StartLiveVideoRequest): Promise<VideoSessionDto> {
    this.assertChannel(req.channel);
    const t = await this.target(ctx, objectId);
    const r = await this.ask(t.uniqueId, { op: 'live', channel: req.channel, stream: req.stream ?? 'sub' });
    return this.session(ctx, t, 'live', req.channel, r);
  }

  async playback(ctx: AuthContext, objectId: string, req: StartPlaybackRequest): Promise<VideoSessionDto> {
    this.assertChannel(req.channel);
    const { from, to } = this.range(req.start, req.end, MAX_PLAYBACK_MS);
    const t = await this.target(ctx, objectId);
    const r = await this.ask(t.uniqueId, { op: 'playback', channel: req.channel, start: from.toISOString(), end: to.toISOString() });
    return this.session(ctx, t, 'playback', req.channel, r);
  }

  async recordings(ctx: AuthContext, objectId: string, channel: number, fromIso: string, toIso: string): Promise<VideoRecordingDto[]> {
    if (channel !== 0) this.assertChannel(channel);
    const { from, to } = this.range(fromIso, toIso, MAX_RECORDING_RANGE_MS);
    const t = await this.target(ctx, objectId);
    const r = await this.ask(t.uniqueId, { op: 'recordings', channel, from: from.toISOString(), to: to.toISOString() });
    return (r.recordings ?? []).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  }

  private range(fromIso: string, toIso: string, maxMs: number): { from: Date; to: Date } {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new BadRequestException('Choose a valid time range');
    if (to.getTime() - from.getTime() > maxMs) throw new BadRequestException(`The time range can be at most ${Math.round(maxMs / 3600_000)} hours`);
    return { from, to };
  }

  private async session(ctx: AuthContext, t: VideoTarget, kind: VideoSessionKind, channel: number, r: VideoGatewayReply): Promise<VideoSessionDto> {
    const s = r.session!;
    const record: VideoSessionRecord = { objectId: t.objectId, companyId: t.companyId, vehicle: t.name, uniqueId: t.uniqueId, channel, kind };
    await this.redis.client.set(RedisKeys.videoSession(s.sessionId), JSON.stringify(record), 'EX', SESSION_TTL_SEC);
    if (s.codec === 'h265') throw videoError('CODEC_UNSUPPORTED', 'This camera sends H.265 video, which the web player cannot show. Set the dashcam to H.264.');
    const { token, expiresAt } = signVideoToken({ u: ctx.userId, c: t.companyId, s: s.sessionId }, this.env.jwtSecret);
    this.logger.log(`${ctx.userId} ${s.joined ? 'joined' : 'started'} ${kind} ${t.uniqueId} ch${channel} (${s.sessionId})`);
    return {
      sessionId: s.sessionId,
      kind,
      channel,
      url: `/api/video/streams/${s.sessionId}.flv?token=${encodeURIComponent(token)}`,
      codec: s.codec,
      expiresAt: expiresAt.toISOString(),
      joined: s.joined,
    };
  }

  /** Session in the caller's company (Super Admin: any); 404 otherwise. */
  async record(ctx: Pick<AuthContext, 'companyId' | 'isSuperAdmin'>, sessionId: string): Promise<VideoSessionRecord> {
    const raw = /^[A-Za-z0-9_-]{4,40}$/.test(sessionId) ? await this.redis.client.get(RedisKeys.videoSession(sessionId)) : null;
    const rec = raw ? (JSON.parse(raw) as VideoSessionRecord) : null;
    if (!rec || (!ctx.isSuperAdmin && rec.companyId !== ctx.companyId)) throw new NotFoundException('Video session not found');
    return rec;
  }

  async status(ctx: AuthContext, sessionId: string): Promise<VideoSessionStatusDto> {
    const rec = await this.record(ctx, sessionId);
    const r = await this.ask(rec.uniqueId, { op: 'status', sessionId }).catch(() => null);
    const s = r?.status;
    return s ? { sessionId, ...s } : { sessionId, state: 'closed', codec: 'unknown', viewers: 0, frames: 0 };
  }

  async leave(ctx: AuthContext, sessionId: string): Promise<void> {
    const rec = await this.record(ctx, sessionId);
    await this.ask(rec.uniqueId, { op: 'leave', sessionId }).catch(() => undefined);
  }
}
