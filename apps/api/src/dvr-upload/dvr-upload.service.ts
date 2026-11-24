import { Injectable, Logger } from '@nestjs/common';
import { DRIVER_MEDIA_MAX_PHOTO_BYTES, DRIVER_MEDIA_MAX_VIDEO_BYTES } from '@veetracer/shared';
import { DriverMediaMessage, writeIncoming } from '../driver-events/media-store';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { jimiMime, parseJimiFileName, verifyJimiSign, zonedToUtc } from './dvr-upload.logic';

/** Reply format the Jimi firmware expects (it retries on anything but code 200). */
export interface JimiUploadReply {
  code: number;
  message: string;
  data?: string;
}

export interface JimiUploadInput {
  file?: { buffer: Buffer; originalname?: string };
  filename?: string;
  timestamp?: string;
  sign?: string;
}

/**
 * Receives event photos / clips that Jimi dashcams upload over HTTP and hands them to the same pipeline as JT/T 808
 * attachments: the file goes to var/driver-media/incoming and a `vt:driver-media` message lets the notifier link it to
 * the driver event of that alarm (DriverEventWorker.handleMedia). The device comes from the IMEI in the file name; the
 * capture time from the 0x95 alarm position that listed this file (`mediaFiles`), else the name's local time in the
 * company time zone.
 */
@Injectable()
export class DvrUploadService {
  private readonly logger = new Logger('DvrUpload');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async upload(input: JimiUploadInput, key = process.env.JIMI_UPLOAD_KEY ?? ''): Promise<JimiUploadReply> {
    const filename = (input.filename || input.file?.originalname || '').trim();
    if (!key) return { code: 500, message: 'Upload is not configured' };
    if (!input.file?.buffer?.length) return { code: 400, message: 'File content is empty' };
    if (!filename || !input.timestamp || !input.sign) return { code: 400, message: 'filename, timestamp and sign are required' };
    if (!/^[\w.-]{5,160}$/.test(filename)) return { code: 400, message: 'Invalid file name' };
    if (!verifyJimiSign(filename, input.timestamp, input.sign, key)) return { code: 400, message: 'Invalid sign' };

    const mime = jimiMime(filename);
    if (!mime) return { code: 400, message: 'Unsupported file type' };
    const kind = mime.startsWith('image/') ? 'PHOTO' : 'VIDEO';
    const size = input.file.buffer.length;
    if (size > (kind === 'PHOTO' ? DRIVER_MEDIA_MAX_PHOTO_BYTES : DRIVER_MEDIA_MAX_VIDEO_BYTES)) return { code: 400, message: 'File too large' };

    const parsed = parseJimiFileName(filename);
    const device = parsed
      ? await this.prisma.device.findUnique({ where: { uniqueId: parsed.imei }, select: { id: true, uniqueId: true, company: { select: { timezone: true } } } })
      : null;
    // Unknown devices still get code 200: an error makes the camera retry the upload again and again.
    if (!parsed || !device) {
      this.logger.warn(`Upload ${filename}: no registered device for this file name, dropped`);
      return { code: 200, message: 'success', data: filename };
    }

    const alarm = await this.alarmFor(device.id, filename);
    const capturedAt = alarm?.fixTime ?? (parsed.localTime ? zonedToUtc(parsed.localTime, device.company?.timezone ?? 'Asia/Kolkata') : new Date());
    const path = await writeIncoming(input.file.buffer, mime);
    const msg: DriverMediaMessage = {
      path,
      uniqueId: device.uniqueId,
      source: 'ATTACHMENT',
      kind,
      mime,
      size,
      channel: parsed.channel,
      capturedAt: capturedAt.toISOString(),
      lat: alarm?.lat ?? null,
      lng: alarm?.lng ?? null,
      eventId: null,
      ref: filename,
    };
    await this.redis.client.xadd(RedisKeys.driverMediaStream, 'MAXLEN', '~', 20_000, '*', 'data', JSON.stringify(msg));
    this.logger.log(`Upload ${filename} from ${device.uniqueId}: ${kind.toLowerCase()} ${size} bytes${alarm ? '' : ' (no matching alarm, time from the name)'}`);
    return { code: 200, message: 'success', data: filename };
  }

  /** The 0x95 alarm position (last 2 days) whose clip list names this file. */
  private async alarmFor(deviceId: string, filename: string): Promise<{ fixTime: Date; lat: number; lng: number } | null> {
    const rows = await this.prisma.$queryRaw<{ fixTime: Date; lat: number; lng: number }[]>`
      SELECT "fixTime", lat, lng FROM "Position"
      WHERE "deviceId" = ${deviceId}::uuid AND "fixTime" > now() - interval '2 days'
        AND attributes->>'mediaFiles' LIKE ${`%${filename}%`}
      ORDER BY "fixTime" DESC LIMIT 1`;
    return rows[0] ?? null;
  }
}
