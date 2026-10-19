import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { VideoErrorCode, VideoRecordingDto } from '@veetracer/shared';
import { RedisKeys } from '../../redis/keys';
import { VideoGatewayReply, VideoGatewayRequest } from '../../video/video-messages';
import { AvMsg, encodeLiveControl, encodeLiveRequest, encodePlaybackControl, encodePlaybackRequest, encodeResourceQuery, LiveControl, PlaybackControl } from '../jt808/av';
import { Jt808Session } from '../jt808/decoder';
import { BaseSession } from '../protocol';
import { DeviceOfflineError, TcpGatewayServer } from '../tcp-server';
import { MediaHub, StreamLimitError } from './hub';
import { MediaStream } from './stream';

/** Device clock zone when the JT808 decoder has not decided it yet (spec default GMT+8). */
const DEFAULT_ZONE = 480;
const REPLY_TIMEOUT_MS = 15_000;

export class VideoError extends Error {
  constructor(
    readonly code: VideoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const hex = (msgId: number, body: Buffer) => `#${msgId.toString(16).padStart(4, '0')}:${body.toString('hex')}`;

/** Result text of a 0x0001 general response ("OK (0x9101)", "Failed (0x9101)", …). */
const accepted = (text: string) => text.startsWith('OK');

/**
 * Gateway side of video signalling: turns API requests into JT/T 1078 messages on the dashcam's JT808 connection and
 * opens / closes the matching media streams.
 */
export class VideoControl {
  private readonly logger = new Logger('Video');

  constructor(
    private readonly jt808: TcpGatewayServer<BaseSession>,
    readonly hub: MediaHub,
    private readonly media: { host: string; port: number },
  ) {}

  private zone(uniqueId: string): number {
    return (this.jt808.sessionOf(uniqueId) as Jt808Session | null)?.clockZone ?? DEFAULT_ZONE;
  }

  private async ask(uniqueId: string, msgId: number, body: Buffer): Promise<{ text: string; data?: unknown }> {
    try {
      return await this.jt808.request(uniqueId, hex(msgId, body), REPLY_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof DeviceOfflineError) throw new VideoError('DEVICE_OFFLINE', 'The dashcam is offline. Video needs the device to be connected.');
      throw new VideoError('DEVICE_TIMEOUT', 'The dashcam did not answer. Check that it is online and supports video (JT/T 1078).');
    }
  }

  async handle(req: VideoGatewayRequest): Promise<VideoGatewayReply> {
    try {
      return { reqId: req.reqId, ok: true, ...(await this.dispatch(req)) };
    } catch (error) {
      if (error instanceof VideoError) return { reqId: req.reqId, ok: false, error: { code: error.code, message: error.message } };
      if (error instanceof StreamLimitError) return { reqId: req.reqId, ok: false, error: { code: 'STREAM_LIMIT', message: error.message } };
      this.logger.error(`Video ${req.op} for ${req.uniqueId} failed: ${(error as Error).message}`);
      return { reqId: req.reqId, ok: false, error: { code: 'DEVICE_REFUSED', message: (error as Error).message } };
    }
  }

  private async dispatch(req: VideoGatewayRequest): Promise<Omit<VideoGatewayReply, 'reqId' | 'ok'>> {
    switch (req.op) {
      case 'live': {
        if (!this.jt808.has(req.uniqueId)) throw new VideoError('DEVICE_OFFLINE', 'The dashcam is offline. Video needs the device to be connected.');
        const { stream, joined } = this.hub.open({ uniqueId: req.uniqueId, channel: req.channel, kind: 'live', streamType: req.stream });
        if (!joined) {
          const body = encodeLiveRequest({ host: this.media.host, tcpPort: this.media.port, channel: req.channel, stream: req.stream });
          const r = await this.ask(req.uniqueId, AvMsg.LIVE_REQUEST, body).catch((e: unknown) => {
            this.hub.close(stream.id, 'request failed');
            throw e;
          });
          if (!accepted(r.text)) {
            this.hub.close(stream.id, 'device refused');
            throw new VideoError('DEVICE_REFUSED', `The dashcam refused the live video request: ${r.text}`);
          }
        }
        return { session: { sessionId: stream.id, codec: stream.codec, joined } };
      }
      case 'playback': {
        if (!this.jt808.has(req.uniqueId)) throw new VideoError('DEVICE_OFFLINE', 'The dashcam is offline. Recordings can only be played while it is connected.');
        const { stream } = this.hub.open({ uniqueId: req.uniqueId, channel: req.channel, kind: 'playback', streamType: 'main' });
        const body = encodePlaybackRequest({ host: this.media.host, tcpPort: this.media.port, channel: req.channel, start: new Date(req.start), end: new Date(req.end), zone: this.zone(req.uniqueId) });
        const r = await this.ask(req.uniqueId, AvMsg.PLAYBACK_REQUEST, body).catch((e: unknown) => {
          this.hub.close(stream.id, 'request failed');
          throw e;
        });
        // Terminals answer 0x9201 with 0x1205 (the files being played) or a 0x0001 general response.
        if (r.data === undefined && !accepted(r.text)) {
          this.hub.close(stream.id, 'device refused');
          throw new VideoError('DEVICE_REFUSED', `The dashcam refused playback: ${r.text}`);
        }
        return { session: { sessionId: stream.id, codec: stream.codec, joined: false } };
      }
      case 'recordings': {
        const body = encodeResourceQuery({ channel: req.channel, start: new Date(req.from), end: new Date(req.to), zone: this.zone(req.uniqueId) });
        const r = await this.ask(req.uniqueId, AvMsg.QUERY_RESOURCES, body);
        const data = r.data as { items?: VideoRecordingDto[] } | undefined;
        if (!data?.items) throw new VideoError('DEVICE_REFUSED', `The dashcam did not return a recording list: ${r.text}`);
        return { recordings: data.items };
      }
      case 'attributes': {
        const r = await this.ask(req.uniqueId, AvMsg.QUERY_ATTRIBUTES, Buffer.alloc(0));
        const a = r.data as { maxVideoChannels: number; videoCodec: number } | undefined;
        return { attributes: a ? { maxVideoChannels: a.maxVideoChannels, videoCodec: a.videoCodec } : null };
      }
      case 'leave':
        this.hub.leave(req.sessionId);
        return {};
      case 'status': {
        const s = this.hub.get(req.sessionId);
        return { status: s ? { state: s.state, codec: s.codec, viewers: s.viewerCount, frames: s.frames } : null };
      }
    }
  }

  /** Hub onStop: tell the dashcam to stop sending (best effort; it may already be gone). */
  stopDevice(stream: MediaStream, reason: string): void {
    this.logger.log(`Stream ${stream.id} (${stream.uniqueId} ch${stream.channel} ${stream.kind}) closed: ${reason}`);
    if (!this.jt808.has(stream.uniqueId)) return;
    const [msgId, body] =
      stream.kind === 'live'
        ? [AvMsg.LIVE_CONTROL, encodeLiveControl(stream.channel, LiveControl.CLOSE)]
        : [AvMsg.PLAYBACK_CONTROL, encodePlaybackControl(stream.channel, PlaybackControl.STOP)];
    this.jt808.request(stream.uniqueId, hex(msgId, body), 10_000).catch(() => undefined);
  }

  /** Subscribes to this gateway's video channel and answers on `vt:video:replies`. */
  async subscribe(subscriber: Redis, publisher: Redis, gatewayId: string): Promise<void> {
    subscriber.on('message', (channel, message) => {
      if (channel !== RedisKeys.videoChannel(gatewayId)) return;
      let req: VideoGatewayRequest;
      try {
        req = JSON.parse(message) as VideoGatewayRequest;
      } catch {
        return;
      }
      void this.handle(req).then((reply) =>
        publisher.publish(RedisKeys.videoReplies, JSON.stringify(reply)).catch((e: Error) => this.logger.error(`Video reply failed: ${e.message}`)),
      );
    });
    await subscriber.subscribe(RedisKeys.videoChannel(gatewayId));
  }
}
