import { randomUUID } from 'node:crypto';
import { DRIVER_MEDIA_MAX_PHOTO_BYTES, NormalizedPosition } from '@veetracer/shared';
import { compact, gsmFromCsq, round } from '../attributes';
import { BaseSession, DecodeContext, DecodedMedia, DecodeResult, emptyResult, ProtocolDecoder, SplitResult } from '../protocol';
import {
  decodeMessage,
  encodeMessage,
  Jt808DecodeError,
  Jt808Header,
  Jt808Location,
  Jt808Message,
  Jt808Msg,
  JT808_MAX_FRAME_BYTES,
  parseBatch,
  parseLocation,
  parseTerminalResponse,
  platformResponse,
  registerResponse,
  split808,
} from './codec';
import { AvMsg, parseAvAttributes, parseResourceList } from './av';
import { encodeAlarmAttachRequest, encodeMediaUploadResponse, MEDIA_FORMAT_MIME, MediaMsg, MediaType, parseMediaEvent, parseMediaUpload, parseShootResponse } from './media';

export const JT808_PROTOCOL = 'jt808';

/** Device clock candidates, minutes east of UTC: China (spec default), India, UTC. */
const CLOCK_ZONES = [480, 330, 0];
/** A real-time fix within this window of server time decides the device clock zone. */
const CLOCK_DECISION_WINDOW_MS = 20 * 60_000;

/** Alarm DWORD bits (JT/T 808 table 24) → normalised alarm names; earlier entries win when several bits rise at once. */
const ALARM_BITS: [bit: number, name: string][] = [
  [0, 'sos'],
  [29, 'crash'],
  [30, 'rollover'],
  [8, 'powerCut'],
  [26, 'tamper'], // vehicle stolen (anti-theft)
  [28, 'towing'], // illegal displacement
  [27, 'illegalIgnition'],
  [31, 'doorOpen'],
  [1, 'overspeed'],
  [2, 'fatigue'],
  [7, 'lowBattery'], // main power under-voltage
  [5, 'gpsAntennaCut'],
  [6, 'gpsAntennaShort'],
  [4, 'gnssFault'],
  [11, 'cameraFault'],
];

/** Video alarm TLV 0x14 bits (JT/T 1078 table 14). */
const VIDEO_ALARM_BITS: [number, string][] = [
  [0, 'videoSignalLost'],
  [1, 'videoSignalBlocked'],
  [2, 'storageFault'],
  [5, 'abnormalDriving'],
];

const ADAS_TYPES: Record<number, string> = {
  1: 'fcw', // forward collision
  2: 'ldw', // lane departure
  3: 'hmw', // headway (too close)
  4: 'pcw', // pedestrian collision
  5: 'laneChange',
  6: 'roadSignOverspeed',
  7: 'obstacle',
};
const DMS_TYPES: Record<number, string> = {
  1: 'fatigue',
  2: 'phone',
  3: 'smoking',
  4: 'distraction',
  5: 'driverAbsent',
  8: 'cameraBlocked',
};

export interface Jt808Session extends BaseSession {
  /** Platform → terminal serial (replies and commands). */
  serial: number;
  /** Minutes east of UTC for the device clock; null until decided. */
  clockZone: number | null;
  /** Last alarm DWORD, so a persistent alarm bit is reported once when it rises. */
  alarmFlags: number;
  /** Platform serial of a command → gateway ref, matched by the 0x0001 reply. */
  commandRefs: Map<number, number>;
  /** Header of the latest frame, echoed in commands (2013 vs 2019 format, BCD terminal id). */
  header: Pick<Jt808Header, 'terminalBcd' | 'version2019' | 'protocolVersion'> | null;
  /** Sub-packaged message parts by `msgId:firstSerial`. */
  parts: Map<string, { total: number; got: Map<number, Buffer>; header: Jt808Header; bytes: number; at: number }>;
  /** Gateway ref of the latest 0x9003 query (its 0x1003 answer carries no reply serial). */
  avAttributesRef: number | null;
  /** Snapshots the platform asked for (0x8801), matched to 0x0801 uploads by multimedia id or channel. */
  snapshots: PendingSnapshot[];
}

export interface PendingSnapshot {
  eventId: string;
  channel: number;
  at: number;
  ids: number[];
}

export interface Jt808DecoderOptions {
  /** Su-standard attachment server the dashcam is told (0x9208) to upload ADAS / DMS alarm photos and clips to. */
  attachServer?: { host: string; port: number } | null;
}

/** Sub-packaged messages: at most this many parts / bytes per message and pending bytes per connection. */
export const JT808_MAX_PACKAGES = 4096;
export const JT808_MAX_REASSEMBLED_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES_PER_SESSION = 4 * 1024 * 1024;
/** Incomplete sub-packaged messages are dropped after this. */
const PARTS_TTL_MS = 3 * 60_000;
/** A 0x0801 upload without a known multimedia id matches a pending snapshot on the same channel within this window. */
const SNAPSHOT_MATCH_MS = 2 * 60_000;

const bit = (v: number, n: number) => ((v >>> n) & 1) === 1;

/**
 * JT/T 808-2013/2019 terminals (Mettax / Jimi dashcams and MDVRs, many Chinese trackers). Identification is the
 * terminal phone number from the header (leading zeros removed), so register devices with that number.
 */
export class Jt808Decoder implements ProtocolDecoder<Jt808Session> {
  readonly name = JT808_PROTOCOL;
  readonly maxFrameBytes = JT808_MAX_FRAME_BYTES;

  constructor(private readonly options: Jt808DecoderOptions = {}) {}

  createSession(): Jt808Session {
    return { uniqueId: null, serial: 0, clockZone: null, alarmFlags: 0, commandRefs: new Map(), header: null, parts: new Map(), avAttributesRef: null, snapshots: [] };
  }

  split(buf: Buffer): SplitResult {
    return split808(buf, this.maxFrameBytes);
  }

  private nextSerial(session: Jt808Session): number {
    session.serial = (session.serial + 1) & 0xffff;
    return session.serial;
  }

  /**
   * '#8201' → location query, '#8105:<cmd>' → terminal control (4 reset, 5 factory reset), '#<msgId>:<hex body>' → raw
   * message; any other text is sent as a 0x8300 text / TTS message.
   */
  encodeCommand(text: string, session: Jt808Session, ref: number): Buffer {
    const header = session.header ?? { terminalBcd: Buffer.alloc(6), version2019: false, protocolVersion: null };
    const serial = this.nextSerial(session);
    session.commandRefs.set(serial, ref);
    if (session.commandRefs.size > 50) session.commandRefs.delete(session.commandRefs.keys().next().value as number);
    const raw = /^#([0-9a-f]{4})(?::(.*))?$/i.exec(text.trim());
    if (raw) {
      const msgId = parseInt(raw[1], 16);
      const arg = raw[2] ?? '';
      if (msgId === AvMsg.QUERY_ATTRIBUTES) session.avAttributesRef = ref;
      const body = msgId === 0x8105 ? Buffer.from([Number(arg || 4) & 0xff]) : Buffer.from(arg.replace(/\s+/g, ''), 'hex');
      return encodeMessage(msgId, header, serial, body);
    }
    // Flags: 0x08 TTS read-out + 0x04 terminal display. 2013 text is GBK; ASCII is a common subset.
    return encodeMessage(Jt808Msg.TEXT, header, serial, Buffer.concat([Buffer.from([0x0c]), Buffer.from(text, 'ascii')]));
  }

  decode(frame: Buffer, session: Jt808Session, ctx: DecodeContext): DecodeResult {
    let message: Jt808Message;
    try {
      message = decodeMessage(frame);
    } catch (error) {
      if (!(error instanceof Jt808DecodeError)) throw error;
      ctx.unparsed(error.message, frame, session.uniqueId);
      return emptyResult();
    }
    const result = emptyResult();
    const h = message.header;
    if (h.encrypted) {
      ctx.unparsed('RSA-encrypted body (not supported)', frame, session.uniqueId);
      return result;
    }
    session.uniqueId = h.terminalId;
    session.header = { terminalBcd: h.terminalBcd, version2019: h.version2019, protocolVersion: h.protocolVersion };

    let body = message.body;
    if (h.subpackage) {
      result.replies.push(platformResponse(h, this.nextSerial(session)));
      const whole = this.reassemble(session, h, body, ctx, result);
      if (!whole) return result;
      body = whole;
    }

    try {
      this.handle(h, body, session, ctx, frame, result);
    } catch (error) {
      if (!(error instanceof Jt808DecodeError)) throw error;
      ctx.unparsed(error.message, frame, session.uniqueId);
      if (!h.subpackage) result.replies.push(platformResponse(h, this.nextSerial(session), 2));
    }
    return result;
  }

  private handle(h: Jt808Header, body: Buffer, session: Jt808Session, ctx: DecodeContext, frame: Buffer, result: DecodeResult): void {
    const ack = (code = 0) => {
      if (!h.subpackage) result.replies.push(platformResponse(h, this.nextSerial(session), code));
    };
    switch (h.msgId) {
      case Jt808Msg.REGISTER:
        // Any terminal may register; the platform only accepts data for devices added in VeeTrax.
        result.replies.push(registerResponse(h, this.nextSerial(session), h.terminalId));
        break;
      case Jt808Msg.LOCATION: {
        const loc = parseLocation(body);
        result.positions.push(this.position(session, loc, false, ctx, frame));
        ack();
        this.requestAttachments(session, h, loc, result);
        break;
      }
      case Jt808Msg.LOCATION_RESPONSE: {
        // Reply to our 0x8201 query: reply serial(2) + location.
        if (body.length < 30) throw new Jt808DecodeError('location response too short');
        const replySerial = body.readUInt16BE(0);
        result.positions.push(this.position(session, parseLocation(body.subarray(2)), false, ctx, frame));
        this.commandReply(session, replySerial, 'Location reported', result);
        ack();
        break;
      }
      case Jt808Msg.BATCH: {
        const batch = parseBatch(body);
        for (const loc of batch.items) result.positions.push(this.position(session, loc, true, ctx, frame));
        ack();
        break;
      }
      case Jt808Msg.TERMINAL_RESPONSE: {
        const r = parseTerminalResponse(body);
        if (r) {
          const outcome = ['OK', 'Failed', 'Wrong message', 'Not supported'][r.result] ?? `Result ${r.result}`;
          this.commandReply(session, r.serial, `${outcome} (0x${r.msgId.toString(16).padStart(4, '0')})`, result);
        }
        break;
      }
      case AvMsg.RESOURCE_LIST: {
        // Answer to 0x9205 (resource query) or 0x9201 (playback request); times are device-local.
        const list = parseResourceList(body, session.clockZone ?? CLOCK_ZONES[0]);
        if (!list) throw new Jt808DecodeError('resource list too short');
        const items = list.items.map((i) => ({ ...i, start: i.start?.toISOString() ?? null, end: i.end?.toISOString() ?? null }));
        this.commandReply(session, list.serial, `${items.length} recording(s)`, result, { total: list.total, items });
        ack();
        break;
      }
      case AvMsg.ATTRIBUTES: {
        const attrs = parseAvAttributes(body);
        if (attrs && session.avAttributesRef !== null) {
          (result.commandResponses ??= []).push({ ref: session.avAttributesRef, text: `${attrs.maxVideoChannels} video channel(s)`, data: attrs });
          session.avAttributesRef = null;
        }
        ack();
        break;
      }
      case MediaMsg.SHOOT_RESPONSE: {
        const r = parseShootResponse(body);
        if (!r) throw new Jt808DecodeError('shoot response too short');
        const text = r.result === 0 ? `OK: ${r.ids.length} photo(s)` : r.result === 2 ? 'Channel not supported' : 'Failed';
        this.commandReply(session, r.serial, text, result, r);
        ack();
        break;
      }
      case MediaMsg.MEDIA_EVENT:
        parseMediaEvent(body);
        ack();
        break;
      case MediaMsg.MEDIA_UPLOAD: {
        const m = parseMediaUpload(body);
        result.replies.push(encodeMessage(MediaMsg.MEDIA_UPLOAD_RESPONSE, h, this.nextSerial(session), encodeMediaUploadResponse(m.mediaId)));
        const media = this.snapshotMedia(session, m, ctx);
        if (media) (result.media ??= []).push(media);
        break;
      }
      case Jt808Msg.AUTH:
      case Jt808Msg.HEARTBEAT:
      case Jt808Msg.LOGOUT:
        ack();
        if (h.msgId === Jt808Msg.LOGOUT) result.close = true;
        break;
      default:
        // Unknown uplink: acknowledge so the terminal does not resend it forever.
        ack();
        ctx.unparsed(`unhandled message 0x${h.msgId.toString(16).padStart(4, '0')}`, frame, session.uniqueId);
    }
  }

  /** 0x0801 → stored media (JPEG photos; other types are acknowledged and dropped). */
  private snapshotMedia(session: Jt808Session, m: ReturnType<typeof parseMediaUpload>, ctx: DecodeContext): DecodedMedia | null {
    const now = ctx.receivedAt.getTime();
    session.snapshots = session.snapshots.filter((s) => now - s.at < SNAPSHOT_MATCH_MS);
    const isJpeg = m.data.length > 3 && m.data[0] === 0xff && m.data[1] === 0xd8;
    if (m.type !== MediaType.IMAGE || !isJpeg) {
      ctx.warn(`jt808:media:${session.uniqueId}`, `Device ${session.uniqueId} uploaded multimedia type ${m.type} format ${m.format}; only JPEG photos are kept`);
      return null;
    }
    if (m.data.length > DRIVER_MEDIA_MAX_PHOTO_BYTES) return null;
    let match = session.snapshots.find((s) => s.ids.includes(m.mediaId));
    if (match) {
      match.ids = match.ids.filter((id) => id !== m.mediaId);
      if (!match.ids.length) session.snapshots = session.snapshots.filter((s) => s !== match);
    } else {
      match = session.snapshots.find((s) => s.channel === m.channel && !s.ids.length);
      if (match) session.snapshots = session.snapshots.filter((s) => s !== match);
    }
    // Embedded location time is device-local; trust it only near the receive time.
    const zone = session.clockZone ?? CLOCK_ZONES[0];
    const t = m.location ? m.location.time.getTime() - zone * 60_000 : NaN;
    const capturedAt = Number.isFinite(t) && Math.abs(t - now) < 86_400_000 ? new Date(t) : ctx.receivedAt;
    const valid = m.location && (m.location.lat !== 0 || m.location.lng !== 0);
    return {
      uniqueId: session.uniqueId!,
      source: 'SNAPSHOT',
      kind: 'PHOTO',
      mime: MEDIA_FORMAT_MIME[m.format] === 'image/jpeg' || isJpeg ? 'image/jpeg' : MEDIA_FORMAT_MIME[m.format],
      channel: m.channel,
      capturedAt: capturedAt.toISOString(),
      lat: valid ? m.location!.lat : null,
      lng: valid ? m.location!.lng : null,
      eventId: match?.eventId ?? null,
      ref: String(m.mediaId),
      data: m.data,
    };
  }

  /** ADAS / DMS alarm with attachments: ask the dashcam (0x9208) to upload them to the attachment server. */
  private requestAttachments(session: Jt808Session, h: Jt808Header, loc: Jt808Location, result: DecodeResult): void {
    const server = this.options.attachServer;
    if (!server) return;
    for (const a of [loc.adas, loc.dms]) {
      if (!a || a.flag === 2 || a.attachments <= 0) continue;
      const body = encodeAlarmAttachRequest({ host: server.host, tcpPort: server.port, ident: a.ident, alarmNumber: randomUUID().replace(/-/g, '') });
      result.replies.push(encodeMessage(MediaMsg.ALARM_ATTACH_REQUEST, h, this.nextSerial(session), body));
    }
  }

  private commandReply(session: Jt808Session, serial: number, text: string, result: DecodeResult, data?: unknown): void {
    const ref = session.commandRefs.get(serial);
    if (ref === undefined) return;
    session.commandRefs.delete(serial);
    (result.commandResponses ??= []).push(data === undefined ? { ref, text } : { ref, text, data });
  }

  private reassemble(session: Jt808Session, h: Jt808Header, body: Buffer, ctx: DecodeContext, result: DecodeResult): Buffer | null {
    const total = h.packageTotal ?? 1;
    const index = h.packageIndex ?? 1;
    const now = ctx.receivedAt.getTime();
    if (total < 1 || total > JT808_MAX_PACKAGES || index < 1 || index > total) {
      ctx.warn(`jt808:parts:${session.uniqueId}`, `Device ${session.uniqueId} sent package ${index}/${total}; ignored`);
      return null;
    }
    for (const [k, e] of session.parts) if (now - e.at > PARTS_TTL_MS) session.parts.delete(k);
    // Parts carry consecutive serials, so the first part's serial identifies the message.
    const key = `${h.msgId}:${(h.serial - index + 1) & 0xffff}`;
    const entry = session.parts.get(key) ?? { total, got: new Map<number, Buffer>(), header: h, bytes: 0, at: now };
    if (!entry.got.has(index)) {
      entry.got.set(index, Buffer.from(body));
      entry.bytes += body.length;
    }
    entry.at = now;
    if (entry.bytes > JT808_MAX_REASSEMBLED_BYTES) {
      session.parts.delete(key);
      ctx.warn(`jt808:parts:${session.uniqueId}`, `Device ${session.uniqueId}: message 0x${h.msgId.toString(16)} over ${JT808_MAX_REASSEMBLED_BYTES} bytes; dropped`);
      return null;
    }
    session.parts.set(key, entry);
    let pending = 0;
    for (const e of session.parts.values()) pending += e.bytes;
    while ((session.parts.size > 8 || pending > MAX_PENDING_BYTES_PER_SESSION) && session.parts.size > 1) {
      const oldest = session.parts.keys().next().value as string;
      if (oldest === key) break;
      pending -= session.parts.get(oldest)!.bytes;
      session.parts.delete(oldest);
    }
    if (entry.got.size < entry.total) {
      // Last part arrived but some are missing: ask for the missing ones (0x8800 retransmit list) for multimedia.
      if (index === total && h.msgId === MediaMsg.MEDIA_UPLOAD && entry.got.has(1) && entry.got.get(1)!.length >= 4) {
        const missing = Array.from({ length: total }, (_, i) => i + 1).filter((i) => !entry.got.has(i));
        result.replies.push(encodeMessage(MediaMsg.MEDIA_UPLOAD_RESPONSE, h, this.nextSerial(session), encodeMediaUploadResponse(entry.got.get(1)!.readUInt32BE(0), missing)));
      }
      return null;
    }
    session.parts.delete(key);
    return Buffer.concat([...entry.got.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
  }

  /**
   * Device time → UTC. The spec says GMT+8 but terminals sold in India are often set to IST or UTC: the first real-time
   * fix near server time picks the zone, once per connection; until then GMT+8 is assumed unless it lands in the future.
   */
  private fixTime(session: Jt808Session, loc: Jt808Location, history: boolean, ctx: DecodeContext): Date {
    const raw = loc.time.getTime();
    const at = (zone: number) => new Date(raw - zone * 60_000);
    if (session.clockZone !== null) return at(session.clockZone);
    const now = ctx.receivedAt.getTime();
    if (!history && bit(loc.status, 1)) {
      const best = CLOCK_ZONES.map((z) => ({ z, d: Math.abs(raw - z * 60_000 - now) })).sort((a, b) => a.d - b.d)[0];
      if (best.d <= CLOCK_DECISION_WINDOW_MS) {
        session.clockZone = best.z;
        ctx.warn(`jt808:clock:${session.uniqueId}`, `Device ${session.uniqueId} clock is UTC${best.z >= 0 ? '+' : ''}${best.z} min`);
        return at(best.z);
      }
    }
    for (const z of CLOCK_ZONES) if (raw - z * 60_000 <= now + 5 * 60_000) return at(z);
    return at(0);
  }

  private position(session: Jt808Session, loc: Jt808Location, history: boolean, ctx: DecodeContext, frame: Buffer): NormalizedPosition {
    // Alarms: report a bit once when it rises (terminals keep it set until the condition clears / is confirmed).
    const risen = (loc.alarmFlags & ~session.alarmFlags) >>> 0;
    if (!history) session.alarmFlags = loc.alarmFlags;
    const alarm = history ? null : (ALARM_BITS.find(([b]) => bit(risen, b))?.[1] ?? null);

    const videoAlarm = loc.extras.get(0x14);
    const videoFlags = videoAlarm && videoAlarm.length >= 4 ? videoAlarm.readUInt32BE(0) : 0;
    // ADAS / DMS: flag 1 = event started, 0 = instantaneous; 2 (ended) is not a new event.
    const adas = loc.adas && loc.adas.flag !== 2 ? (ADAS_TYPES[loc.adas.type] ?? `adas_${loc.adas.type}`) : null;
    const dms = loc.dms && loc.dms.flag !== 2 ? (DMS_TYPES[loc.dms.type] ?? `dms_${loc.dms.type}`) : null;

    return {
      protocol: JT808_PROTOCOL,
      uniqueId: session.uniqueId!,
      fixTime: this.fixTime(session, loc, history, ctx).toISOString(),
      receivedAt: ctx.receivedAt.toISOString(),
      lat: loc.lat,
      lng: loc.lng,
      speedKph: round(loc.speedKph, 1),
      course: loc.course,
      altitude: loc.altitude,
      satellites: loc.satellites,
      valid: bit(loc.status, 1),
      ignition: bit(loc.status, 0),
      attributes: compact({
        alarm,
        gsmSignal: loc.gsmCsq === null ? null : gsmFromCsq(loc.gsmCsq),
        odometerM: loc.mileageKm === null ? null : Math.round(loc.mileageKm * 1000),
        fuelLevelL: loc.fuelL,
        oilCut: bit(loc.status, 10) ? true : null,
        doorLocked: bit(loc.status, 12) ? true : null,
        videoAlarm: VIDEO_ALARM_BITS.filter(([b]) => bit(videoFlags, b)).map(([, n]) => n).join(',') || null,
        adas,
        adasLevel: adas ? loc.adas!.level : null,
        dms,
        dmsLevel: dms ? loc.dms!.level : null,
        event: adas ?? dms ?? null,
        ...(history ? { reupload: true } : {}),
      }),
      raw: frame.toString('hex'),
    };
  }
}
