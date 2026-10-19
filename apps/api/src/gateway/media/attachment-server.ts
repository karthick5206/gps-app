import { Logger } from '@nestjs/common';
import { DRIVER_MEDIA_MAX_PHOTO_BYTES, DRIVER_MEDIA_MAX_VIDEO_BYTES } from '@veetracer/shared';
import { createServer, Server, Socket } from 'node:net';
import { decodeMessage, encodeMessage, Jt808DecodeError, Jt808Header, platformResponse, unescape808 } from '../jt808/codec';
import {
  ATTACH_DATA_MAGIC,
  AttachFileType,
  AttachInfo,
  attachMime,
  encodeFileDoneResponse,
  MediaMsg,
  parseAttachData,
  parseAttachFileInfo,
  parseAttachInfo,
  parseAttachName,
} from '../jt808/media';
import { DecodedMedia } from '../protocol';

const IDLE_TIMEOUT_MS = 2 * 60_000;
/** Largest single data packet and total bytes accepted per connection. */
const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_CONNECTION_BYTES = 64 * 1024 * 1024;
const MAX_FILES_PER_CONNECTION = 16;
const DEFAULT_ZONE = 480;

interface IncomingFile {
  name: string;
  type: number;
  size: number;
  mime: string | null;
  /** offset → bytes */
  chunks: Map<number, Buffer>;
  received: number;
  done: boolean;
}

export interface AttachmentConnection {
  uniqueId: string | null;
  header: Pick<Jt808Header, 'terminalBcd' | 'version2019' | 'protocolVersion'> | null;
  serial: number;
  info: AttachInfo | null;
  files: Map<string, IncomingFile>;
  bytes: number;
}

export interface AttachmentServerOptions {
  /** Device clock zone (minutes east of UTC) from its JT808 session, for the alarm time. */
  zoneOf?: (uniqueId: string) => number | null;
  onMedia: (media: DecodedMedia) => void;
}

/** Missing [offset, length) ranges of a file from its received chunks. */
export function missingRanges(size: number, chunks: Map<number, Buffer>): { offset: number; length: number }[] {
  const sorted = [...chunks.entries()].sort((a, b) => a[0] - b[0]);
  const out: { offset: number; length: number }[] = [];
  let at = 0;
  for (const [offset, data] of sorted) {
    if (offset > at) out.push({ offset: at, length: offset - at });
    at = Math.max(at, offset + data.length);
  }
  if (at < size) out.push({ offset: at, length: size - at });
  return out;
}

/** Joins chunks into the file (overlaps resolved by offset). */
export function assemble(size: number, chunks: Map<number, Buffer>): Buffer {
  const out = Buffer.alloc(size);
  for (const [offset, data] of chunks) data.copy(out, offset, 0, Math.max(0, Math.min(data.length, size - offset)));
  return out;
}

/**
 * Su-standard alarm attachment server (ATTACH_PORT, default 7613). After a 0x9208 request the dashcam connects here
 * and sends 0x1210 (attachment list), per file 0x1211 (file info), raw "01cd" data packets and 0x1212 (done); we reply
 * 0x8001 to the signalling and 0x9212 (complete / retransmit list) to 0x1212. Finished photos / clips go to the media
 * sink as ATTACHMENT media, matched to the driver event by device and alarm time.
 */
export class AttachmentServer {
  private readonly logger = new Logger('Attachments');
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  readonly stats = { connections: 0, files: 0, errors: 0 };

  constructor(private readonly options: AttachmentServerOptions) {}

  get port(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  listen(port: number): Promise<void> {
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 2000;
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, () => resolve());
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: Socket): void {
    const conn = AttachmentServer.connection();
    let rest: Buffer = Buffer.alloc(0);
    this.sockets.add(socket);
    this.stats.connections = this.sockets.size;
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.stats.connections = this.sockets.size;
    });
    socket.on('data', (chunk) => {
      conn.bytes += chunk.length;
      if (conn.bytes > MAX_CONNECTION_BYTES) {
        this.logger.warn(`Attachment connection from ${conn.uniqueId ?? socket.remoteAddress} over ${MAX_CONNECTION_BYTES} bytes; closed`);
        socket.destroy();
        return;
      }
      try {
        const { replies, rest: left } = this.feed(conn, rest.length ? Buffer.concat([rest, chunk]) : chunk);
        rest = left;
        for (const r of replies) socket.write(r);
      } catch (error) {
        this.stats.errors++;
        this.logger.warn(`Attachment stream from ${conn.uniqueId ?? socket.remoteAddress} broken: ${(error as Error).message}`);
        socket.destroy();
      }
    });
  }

  static connection(): AttachmentConnection {
    return { uniqueId: null, header: null, serial: 0, info: null, files: new Map(), bytes: 0 };
  }

  /** Consumes signalling frames and data packets from `buf`; returns the replies and the unconsumed tail. */
  feed(conn: AttachmentConnection, buf: Buffer): { replies: Buffer[]; rest: Buffer } {
    const replies: Buffer[] = [];
    let o = 0;
    while (o < buf.length) {
      if (buf[o] === 0x7e) {
        const end = buf.indexOf(0x7e, o + 1);
        if (end < 0) {
          if (buf.length - o > 8192) throw new Jt808DecodeError('unterminated frame');
          break;
        }
        if (end === o + 1) {
          o++;
          continue;
        }
        const frame = unescape808(buf.subarray(o + 1, end));
        o = end + 1;
        this.signal(conn, frame, replies);
      } else if (buf.length - o < 4) {
        break;
      } else if (buf.readUInt32BE(o) === ATTACH_DATA_MAGIC) {
        const r = parseAttachData(buf.subarray(o), MAX_PACKET_BYTES);
        if (!r) break;
        o += r.bytes;
        this.data(conn, r.packet.name, r.packet.offset, r.packet.data);
      } else {
        o++; // garbage between messages
      }
    }
    return { replies, rest: Buffer.from(buf.subarray(o)) };
  }

  private signal(conn: AttachmentConnection, frame: Buffer, replies: Buffer[]): void {
    let msg;
    try {
      msg = decodeMessage(frame);
    } catch (error) {
      if (error instanceof Jt808DecodeError) return;
      throw error;
    }
    const h = msg.header;
    conn.uniqueId = h.terminalId;
    conn.header = { terminalBcd: h.terminalBcd, version2019: h.version2019, protocolVersion: h.protocolVersion };
    const serial = () => (conn.serial = (conn.serial + 1) & 0xffff);
    const ack = (code = 0) => replies.push(platformResponse(h, serial(), code));
    try {
      switch (h.msgId) {
        case MediaMsg.ATTACH_INFO:
          conn.info = parseAttachInfo(msg.body);
          ack();
          break;
        case MediaMsg.FILE_INFO: {
          const f = parseAttachFileInfo(msg.body);
          const mime = attachMime(parseAttachName(f.name).ext, f.type);
          const limit = mime?.startsWith('video/') ? DRIVER_MEDIA_MAX_VIDEO_BYTES : DRIVER_MEDIA_MAX_PHOTO_BYTES;
          const keep = mime && f.size > 0 && f.size <= limit && conn.files.size < MAX_FILES_PER_CONNECTION;
          conn.files.set(f.name, { name: f.name, type: f.type, size: f.size, mime: keep ? mime : null, chunks: new Map(), received: 0, done: false });
          ack();
          break;
        }
        case MediaMsg.FILE_DONE: {
          const f = parseAttachFileInfo(msg.body);
          const file = conn.files.get(f.name);
          const missing = file?.mime && !file.done ? missingRanges(file.size, file.chunks) : [];
          if (file?.mime && !file.done && !missing.length) {
            file.done = true;
            this.emit(conn, file);
            file.chunks.clear();
          }
          replies.push(encodeMessage(MediaMsg.FILE_DONE_RESPONSE, h, serial(), encodeFileDoneResponse({ name: f.name, type: f.type }, missing)));
          break;
        }
        default:
          ack();
      }
    } catch (error) {
      if (!(error instanceof Jt808DecodeError)) throw error;
      ack(2);
    }
  }

  private data(conn: AttachmentConnection, name: string, offset: number, data: Buffer): void {
    const file = conn.files.get(name);
    if (!file?.mime || file.done || offset >= file.size || file.chunks.has(offset)) return;
    const part = offset + data.length > file.size ? data.subarray(0, file.size - offset) : data;
    file.chunks.set(offset, part);
    file.received += part.length;
  }

  private emit(conn: AttachmentConnection, file: IncomingFile): void {
    const data = assemble(file.size, file.chunks);
    const mime = file.mime!;
    if (mime === 'image/jpeg' && !(data[0] === 0xff && data[1] === 0xd8)) {
      this.logger.warn(`Attachment ${file.name} from ${conn.uniqueId} is not a JPEG; dropped`);
      return;
    }
    const zone = (conn.uniqueId ? this.options.zoneOf?.(conn.uniqueId) : null) ?? DEFAULT_ZONE;
    const t = conn.info?.ident?.time;
    const { channel } = parseAttachName(file.name);
    this.stats.files++;
    this.options.onMedia({
      uniqueId: conn.uniqueId!,
      source: 'ATTACHMENT',
      kind: mime.startsWith('video/') || file.type === AttachFileType.VIDEO ? 'VIDEO' : 'PHOTO',
      mime,
      // 64 / 65 (0x64 / 0x65) name the ADAS / DMS module rather than a camera.
      channel: channel === null || [64, 65, 100, 101].includes(channel) ? null : channel,
      capturedAt: t ? new Date(t.getTime() - zone * 60_000).toISOString() : new Date().toISOString(),
      lat: null,
      lng: null,
      eventId: null,
      ref: `${conn.info?.alarmNumber ?? ''}/${file.name}`.slice(0, 200),
      data,
    });
  }
}
