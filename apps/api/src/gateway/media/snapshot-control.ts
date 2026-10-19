import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { SnapshotRequest } from '../../driver-events/media-store';
import { RedisKeys } from '../../redis/keys';
import { Jt808Session } from '../jt808/decoder';
import { CameraShoot, encodeCameraShoot, MediaMsg } from '../jt808/media';
import { BaseSession } from '../protocol';
import { TcpGatewayServer } from '../tcp-server';

const REPLY_TIMEOUT_MS = 20_000;

/** Snapshot defaults: one photo, upload now, 640×480, quality 5, neutral picture settings. */
export const SNAPSHOT_DEFAULTS: Omit<CameraShoot, 'channel'> = { command: 1, interval: 0, save: 0, resolution: 0x02, quality: 5 };

/**
 * Takes driver event snapshots: `vt:snap:gw:<id>` requests become JT/T 808 0x8801 (camera shoot immediately) on the
 * dashcam's connection. The 0x0805 reply lists multimedia ids; the 0x0801 uploads are matched to the event by id
 * (or channel) in the decoder session and stored by the media sink.
 */
export class SnapshotControl {
  private readonly logger = new Logger('Snapshot');

  constructor(private readonly jt808: TcpGatewayServer<BaseSession>) {}

  async take(req: SnapshotRequest): Promise<boolean> {
    const session = this.jt808.sessionOf(req.uniqueId) as Jt808Session | null;
    if (!session) return false;
    const pending = { eventId: req.eventId, channel: req.channel, at: Date.now(), ids: [] as number[] };
    session.snapshots.push(pending);
    if (session.snapshots.length > 20) session.snapshots.shift();
    const body = encodeCameraShoot({ ...SNAPSHOT_DEFAULTS, channel: req.channel });
    try {
      const r = await this.jt808.request(req.uniqueId, `#${MediaMsg.CAMERA_SHOOT.toString(16)}:${body.toString('hex')}`, REPLY_TIMEOUT_MS);
      const data = r.data as { result?: number; ids?: number[] } | undefined;
      if (data?.ids?.length) pending.ids = data.ids;
      this.logger.log(`Snapshot ${req.uniqueId} ch${req.channel} for event ${req.eventId}: ${r.text}`);
      return data?.result === undefined ? r.text.startsWith('OK') : data.result === 0;
    } catch (error) {
      this.logger.warn(`Snapshot ${req.uniqueId} ch${req.channel} failed: ${(error as Error).message}`);
      return false;
    }
  }

  async subscribe(subscriber: Redis, gatewayId: string): Promise<void> {
    const channel = RedisKeys.snapshotChannel(gatewayId);
    subscriber.on('message', (ch, message) => {
      if (ch !== channel) return;
      try {
        const req = JSON.parse(message) as SnapshotRequest;
        if (typeof req.uniqueId === 'string' && typeof req.eventId === 'string' && Number.isInteger(req.channel)) void this.take(req);
      } catch {
        // malformed
      }
    });
    await subscriber.subscribe(channel);
  }
}
