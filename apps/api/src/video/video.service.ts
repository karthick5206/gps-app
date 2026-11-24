import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import {
  MANUAL_CAPTURE_TYPE,
  StartLiveVideoRequest,
  StartPlaybackRequest,
  VideoCaptureDto,
  VideoCaptureRequest,
  VideoExtendDto,
  VIDEO_DEFAULT_CHANNELS,
  VideoChannelsDto,
  VideoErrorCode,
  VideoRecordingDto,
  VideoSessionDto,
  VideoSessionKind,
  VideoSessionStatusDto,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { CommandsService } from '../commands/commands.service';
import { zonedToUtc } from '../dvr-upload/dvr-upload.logic';
import { filesForPlayback, JimiRecordingFile, jimiRecordings, parseJimiFileList } from './jimi-recordings';
import { listMediaPaths, MediaPath, pickPlaybackPath, pickReadyPath, RTMP_LIVE_MINUTES, rtmpCamera, rtmpCommand } from './rtmp-live';
import { VideoGatewayReply, VideoRequestBody } from './video-messages';
import { signVideoToken } from './video-token';

/** How long to wait for an RTMP camera to start pushing after the command. */
const RTMP_START_TIMEOUT_MS = 25_000;
/** Longest an RTMP stream can run with Extend (the Jimi firmware limit, 180 min): the HLS token lasts this long. */
const RTMP_MAX_MINUTES = 185;
/** Jimi SD-card name list: ask the camera again when the cached list is older than this. */
const FILE_LIST_FRESH_MS = 60_000;
/** How long to wait for the camera to post its name list after `FILELIST`. */
const FILE_LIST_TIMEOUT_MS = 25_000;
/** Files per `REPLAYLIST` (1-min files: 5 min of video per request). */
const REPLAY_MAX_FILES = 5;

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
  /** `jt1078`: JT/T 808 + 1078 dashcam via the gateway; `rtmp`: camera pushes RTMP to MediaMTX (Jimi, GT06 port). */
  transport: 'jt1078' | 'rtmp';
}

/** What the API remembers about a session (Valkey), to authorise status / leave / stream calls. */
export interface VideoSessionRecord {
  objectId: string;
  companyId: string;
  vehicle: string;
  uniqueId: string;
  channel: number;
  kind: VideoSessionKind;
  /** RTMP sessions: MediaMTX path (`live/<n>/<imei>`) the HLS proxy reads. */
  hlsPath?: string;
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
    @Optional() private readonly commands?: CommandsService,
    @Optional() private readonly mediaPaths: () => Promise<MediaPath[]> = listMediaPaths,
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
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId }] },
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
    const protocol = d?.model.protocol.toLowerCase();
    if (!d || !d.model.capabilities.includes('video') || (protocol !== 'jt808' && protocol !== 'gt06')) {
      throw videoError('NOT_DASHCAM', 'This vehicle has no dashcam with video. Video needs a JT/T 1078 dashcam (e.g. Mettax MC202) or a Jimi JC400 / JC261.');
    }
    return { objectId: o.id, companyId: o.companyId, name: o.name, uniqueId: d.uniqueId, transport: protocol === 'gt06' ? 'rtmp' : 'jt1078' };
  }

  /**
   * RTMP live (Jimi): asks the camera over its GT06 connection to push to MediaMTX and waits until the stream is up.
   * A stream of the same camera that is already running is joined instead (Valkey remembers which camera streams).
   */
  private async rtmpLive(ctx: AuthContext, t: VideoTarget, channel: number): Promise<VideoSessionDto> {
    const camKey = `vt:video:rtmp:${t.uniqueId}`;
    const current = await this.redis.client.get(camKey);
    let path = current === rtmpCamera(channel) ? pickReadyPath(await this.mediaPaths(), t.uniqueId) : null;
    const joined = !!path;
    if (!path) {
      if (!this.commands) throw videoError('VIDEO_DISABLED', 'Live video is not available on this server');
      const sentAt = Date.now();
      if (!(await this.commands.sendInternal(ctx, t.objectId, rtmpCommand(channel)))) {
        throw videoError('DEVICE_OFFLINE', 'The dashcam is offline. Video needs the device to be connected.');
      }
      while (!path && Date.now() - sentAt < RTMP_START_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 1_000));
        path = pickReadyPath(await this.mediaPaths(), t.uniqueId, sentAt);
      }
      if (!path) {
        throw videoError('DEVICE_TIMEOUT', 'The camera did not start streaming. Check that its RTMP server (RSERVICE) points to this server and try again.');
      }
      await this.redis.client.set(camKey, rtmpCamera(channel), 'EX', RTMP_LIVE_MINUTES * 60);
    }
    const sessionId = randomUUID();
    const record: VideoSessionRecord = { objectId: t.objectId, companyId: t.companyId, vehicle: t.name, uniqueId: t.uniqueId, channel, kind: 'live', hlsPath: path };
    await this.redis.client.set(RedisKeys.videoSession(sessionId), JSON.stringify(record), 'EX', SESSION_TTL_SEC);
    // HLS fetches the playlist and segments for the whole stream, which Extend can prolong up to the camera's 180 min.
    const { token, expiresAt } = signVideoToken({ u: ctx.userId, c: t.companyId, s: sessionId }, this.env.jwtSecret, Date.now(), RTMP_MAX_MINUTES * 60);
    this.logger.log(`${ctx.userId} ${joined ? 'joined' : 'started'} rtmp live ${t.uniqueId} ${path} (${sessionId})`);
    const ttl = await this.redis.client.pttl(camKey);
    const streamEndsAt = new Date(Date.now() + (ttl > 0 ? ttl : RTMP_LIVE_MINUTES * 60_000)).toISOString();
    return { sessionId, kind: 'live', channel, url: `/api/video/hls/${sessionId}/${encodeURIComponent(token)}/index.m3u8`, codec: 'h264', expiresAt: expiresAt.toISOString(), joined, transport: 'rtmp', streamEndsAt };
  }

  /** RTMP cameras: asks the camera to keep streaming for another RTMP_LIVE_MINUTES (same command, restarts its timer). */
  async extend(ctx: AuthContext, objectId: string, channel: number): Promise<VideoExtendDto> {
    this.assertChannel(channel);
    const t = await this.target(ctx, objectId);
    if (t.transport !== 'rtmp') throw new BadRequestException('This camera streams until you stop it; nothing to extend.');
    if (!this.commands || !(await this.commands.sendInternal(ctx, t.objectId, rtmpCommand(channel)))) {
      throw videoError('DEVICE_OFFLINE', 'The dashcam is offline. Video needs the device to be connected.');
    }
    await this.redis.client.set(`vt:video:rtmp:${t.uniqueId}`, rtmpCamera(channel), 'EX', RTMP_LIVE_MINUTES * 60);
    return { streamEndsAt: new Date(Date.now() + RTMP_LIVE_MINUTES * 60_000).toISOString() };
  }

  /**
   * Photo or short clip on request (Video: Snapshot / Record). A driver event of type MANUAL_CAPTURE is created now;
   * the file the camera uploads moments later is linked to it by time (DriverEventWorker.handleMedia) and shows in
   * Video evidence. Jimi: `Picture,in|out` / `Video,in|out,<n>s` (uploaded over HTTP); JT/T 808: photo via 0x8801.
   */
  async capture(ctx: AuthContext, objectId: string, req: VideoCaptureRequest): Promise<VideoCaptureDto> {
    this.assertChannel(req.channel);
    const t = await this.target(ctx, objectId);
    const device = await this.prisma.device.findUnique({ where: { uniqueId: t.uniqueId }, select: { id: true } });
    const cam = req.channel === 2 ? 'in' : 'out';
    const seconds = Math.min(10, Math.max(3, Math.round(req.seconds ?? 10)));
    if (t.transport === 'jt1078' && req.kind === 'video') throw new BadRequestException('Short clips on request are available for Jimi cameras; take a photo or use Recordings.');
    const event = await this.prisma.driverEvent.create({
      data: { companyId: t.companyId, objectId: t.objectId, deviceId: device?.id ?? null, type: MANUAL_CAPTURE_TYPE, occurredAt: new Date() },
      select: { id: true },
    });
    let delivered: boolean;
    if (t.transport === 'rtmp') {
      if (!this.commands) throw videoError('VIDEO_DISABLED', 'Commands are not available on this server');
      delivered = await this.commands.sendInternal(ctx, t.objectId, req.kind === 'photo' ? `Picture,${cam}` : `Video,${cam},${seconds}s`);
    } else {
      const gatewayId = await this.redis.client.get(RedisKeys.connection(t.uniqueId));
      delivered = !!gatewayId && (await this.redis.client.publish(RedisKeys.snapshotChannel(gatewayId), JSON.stringify({ uniqueId: t.uniqueId, eventId: event.id, channel: req.channel }))) > 0;
    }
    if (!delivered) {
      await this.prisma.driverEvent.delete({ where: { id: event.id } }).catch(() => undefined);
      throw videoError('DEVICE_OFFLINE', 'The dashcam is offline. Video needs the device to be connected.');
    }
    this.logger.log(`${ctx.userId} asked ${t.uniqueId} for a ${req.kind} on ch${req.channel} (event ${event.id})`);
    return { eventId: event.id };
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
    // Jimi: road (OUT) and driver (IN) camera.
    if (t.transport === 'rtmp') return { channels: [1, 2], source: 'default' };
    const key = RedisKeys.videoAttributes(t.uniqueId);
    let count: number | null = null;
    const cached = await this.redis.client.get(key);
    if (cached) count = (JSON.parse(cached) as { maxVideoChannels: number }).maxVideoChannels;
    else {
      // Ask the dashcam (0x9003 → 0x1003) in the background, cached for a day; answer now with the default so the
      // drawer never waits on a slow device.
      void this.ask(t.uniqueId, { op: 'attributes' })
        .then((r) => (r.attributes ? this.redis.client.set(key, JSON.stringify(r.attributes), 'EX', ATTRIBUTES_TTL_SEC) : null))
        .catch(() => undefined);
    }
    const valid = count !== null && count >= 1 && count <= MAX_CHANNEL;
    const n = valid ? count! : VIDEO_DEFAULT_CHANNELS;
    return { channels: Array.from({ length: n }, (_, i) => i + 1), source: valid ? 'device' : 'default' };
  }

  async live(ctx: AuthContext, objectId: string, req: StartLiveVideoRequest): Promise<VideoSessionDto> {
    this.assertChannel(req.channel);
    const t = await this.target(ctx, objectId);
    if (t.transport === 'rtmp') return this.rtmpLive(ctx, t, req.channel);
    const r = await this.ask(t.uniqueId, { op: 'live', channel: req.channel, stream: req.stream ?? 'sub' });
    return this.session(ctx, t, 'live', req.channel, r);
  }

  async playback(ctx: AuthContext, objectId: string, req: StartPlaybackRequest): Promise<VideoSessionDto> {
    this.assertChannel(req.channel);
    const { from, to } = this.range(req.start, req.end, MAX_PLAYBACK_MS);
    const t = await this.target(ctx, objectId);
    if (t.transport === 'rtmp') return this.rtmpPlayback(ctx, t, req.channel, from, to);
    const r = await this.ask(t.uniqueId, { op: 'playback', channel: req.channel, start: from.toISOString(), end: to.toISOString() });
    return this.session(ctx, t, 'playback', req.channel, r);
  }

  async recordings(ctx: AuthContext, objectId: string, channel: number, fromIso: string, toIso: string): Promise<VideoRecordingDto[]> {
    if (channel !== 0) this.assertChannel(channel);
    const { from, to } = this.range(fromIso, toIso, MAX_RECORDING_RANGE_MS);
    const t = await this.target(ctx, objectId);
    if (t.transport === 'rtmp') {
      const { files, toUtc } = await this.jimiFiles(ctx, t);
      return jimiRecordings(files, channel, from, to, toUtc);
    }
    const r = await this.ask(t.uniqueId, { op: 'recordings', channel, from: from.toISOString(), to: to.toISOString() });
    return (r.recordings ?? []).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  }

  /**
   * Jimi SD-card recordings: the name list the camera posts after `FILELIST` (DvrUploadService.fileList). A list younger
   * than FILE_LIST_FRESH_MS is reused; otherwise the camera is asked and we wait for a newer one (an older list is the
   * fallback when it does not answer). Names are camera wall clock in the company time zone.
   */
  private async jimiFiles(ctx: AuthContext, t: VideoTarget, fresh = true): Promise<{ files: JimiRecordingFile[]; toUtc: (local: string) => Date }> {
    const company = await this.prisma.company.findUnique({ where: { id: t.companyId }, select: { timezone: true } });
    const tz = company?.timezone || 'Asia/Kolkata';
    const toUtc = (local: string) => zonedToUtc(local, tz);
    const key = RedisKeys.jimiFileList(t.uniqueId);
    const read = async () => {
      const raw = await this.redis.client.get(key);
      return raw ? (JSON.parse(raw) as { at: number; names: string[] }) : null;
    };
    let list = await read();
    if (fresh && (!list || Date.now() - list.at > FILE_LIST_FRESH_MS)) {
      if (!this.commands) throw videoError('VIDEO_DISABLED', 'Recorded video is not available on this server');
      const sentAt = Date.now();
      if (!(await this.commands.sendInternal(ctx, t.objectId, 'FILELIST'))) {
        if (!list) throw videoError('DEVICE_OFFLINE', 'The dashcam is offline. Recorded video needs the device to be connected.');
      } else {
        let latest = list;
        while (Date.now() - sentAt < FILE_LIST_TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, 1_000));
          latest = await read();
          if (latest && latest.at >= sentAt) break;
        }
        if (!latest || latest.at < sentAt) {
          if (!list) {
            throw videoError('DEVICE_TIMEOUT', 'The camera did not send its list of recordings. Check that its FILELIST server points to this server and try again.');
          }
        } else list = latest;
      }
    }
    return { files: parseJimiFileList(list?.names ?? []), toUtc };
  }

  /** Jimi recorded video: `REPLAYLIST,<files>` makes the camera push those SD-card files to `live/<imei>` (MediaMTX → HLS). */
  private async rtmpPlayback(ctx: AuthContext, t: VideoTarget, channel: number, from: Date, to: Date): Promise<VideoSessionDto> {
    const { files, toUtc } = await this.jimiFiles(ctx, t, false).then(async (r) => (r.files.length ? r : this.jimiFiles(ctx, t)));
    const names = filesForPlayback(files, channel, from, to, toUtc, REPLAY_MAX_FILES);
    if (!names.length) throw new BadRequestException('There is no recording of this camera at that time.');
    const first = files.find((f) => f.name === names[0])!;
    const seconds = names.reduce((s, n) => s + (files.find((f) => f.name === n)?.durationSec ?? 60), 0);
    const sentAt = Date.now();
    if (!this.commands || !(await this.commands.sendInternal(ctx, t.objectId, `REPLAYLIST,${names.join(',')}`))) {
      throw videoError('DEVICE_OFFLINE', 'The dashcam is offline. Recorded video needs the device to be connected.');
    }
    let path: string | null = null;
    while (!path && Date.now() - sentAt < RTMP_START_TIMEOUT_MS + 10_000) {
      await new Promise((r) => setTimeout(r, 1_000));
      path = pickPlaybackPath(await this.mediaPaths(), t.uniqueId, sentAt);
    }
    if (!path) throw videoError('DEVICE_TIMEOUT', 'The camera did not start playing the recording. Check that its RTMP server (RSERVICE) points to this server and try again.');
    const sessionId = randomUUID();
    const record: VideoSessionRecord = { objectId: t.objectId, companyId: t.companyId, vehicle: t.name, uniqueId: t.uniqueId, channel, kind: 'playback', hlsPath: path };
    await this.redis.client.set(RedisKeys.videoSession(sessionId), JSON.stringify(record), 'EX', SESSION_TTL_SEC);
    const { token, expiresAt } = signVideoToken({ u: ctx.userId, c: t.companyId, s: sessionId }, this.env.jwtSecret, Date.now(), seconds + 15 * 60);
    this.logger.log(`${ctx.userId} started rtmp playback ${t.uniqueId} ${names.join(',')} (${sessionId})`);
    return {
      sessionId,
      kind: 'playback',
      channel,
      url: `/api/video/hls/${sessionId}/${encodeURIComponent(token)}/index.m3u8`,
      codec: 'h264',
      expiresAt: expiresAt.toISOString(),
      joined: false,
      transport: 'rtmp',
      streamEndsAt: new Date(sentAt + seconds * 1000).toISOString(),
      startsAt: toUtc(first.localStart).toISOString(),
    };
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
      transport: 'jt1078',
      streamEndsAt: null,
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
    if (rec.hlsPath) {
      const up = (await this.mediaPaths()).some((p) => p.name === rec.hlsPath && p.ready);
      return { sessionId, state: up ? 'streaming' : 'closed', codec: 'h264', viewers: 0, frames: 0 };
    }
    const r = await this.ask(rec.uniqueId, { op: 'status', sessionId }).catch(() => null);
    const s = r?.status;
    return s ? { sessionId, ...s } : { sessionId, state: 'closed', codec: 'unknown', viewers: 0, frames: 0 };
  }

  async leave(ctx: AuthContext, sessionId: string): Promise<void> {
    const rec = await this.record(ctx, sessionId);
    // RTMP live: the camera stops by itself after RTMP_LIVE_MINUTES; other viewers may still be watching. Recorded
    // playback is one viewer's: stop the push.
    if (rec.hlsPath) {
      if (rec.kind === 'playback') await this.commands?.sendInternal(ctx, rec.objectId, 'REPLAYLIST,OFF').catch(() => false);
      return;
    }
    await this.ask(rec.uniqueId, { op: 'leave', sessionId }).catch(() => undefined);
  }
}
