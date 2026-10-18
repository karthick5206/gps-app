import { NormalizedPosition } from '@veetracer/shared';
import { compact, gsmFromCsq, round } from '../attributes';
import { BaseSession, DecodeContext, DecodeResult, emptyResult, ProtocolDecoder, SplitResult } from '../protocol';
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
  parts: Map<string, { total: number; got: Map<number, Buffer>; header: Jt808Header }>;
}

const bit = (v: number, n: number) => ((v >>> n) & 1) === 1;

/**
 * JT/T 808-2013/2019 terminals (Mettax / Jimi dashcams and MDVRs, many Chinese trackers). Identification is the
 * terminal phone number from the header (leading zeros removed), so register devices with that number.
 */
export class Jt808Decoder implements ProtocolDecoder<Jt808Session> {
  readonly name = JT808_PROTOCOL;
  readonly maxFrameBytes = JT808_MAX_FRAME_BYTES;

  createSession(): Jt808Session {
    return { uniqueId: null, serial: 0, clockZone: null, alarmFlags: 0, commandRefs: new Map(), header: null, parts: new Map() };
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
      const whole = this.reassemble(session, h, body);
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
        // Any terminal may register; the platform only accepts data for devices added in VeeTracer.
        result.replies.push(registerResponse(h, this.nextSerial(session), h.terminalId));
        break;
      case Jt808Msg.LOCATION:
        result.positions.push(this.position(session, parseLocation(body), false, ctx, frame));
        ack();
        break;
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

  private commandReply(session: Jt808Session, serial: number, text: string, result: DecodeResult): void {
    const ref = session.commandRefs.get(serial);
    if (ref === undefined) return;
    session.commandRefs.delete(serial);
    (result.commandResponses ??= []).push({ ref, text });
  }

  private reassemble(session: Jt808Session, h: Jt808Header, body: Buffer): Buffer | null {
    const total = h.packageTotal ?? 1;
    const index = h.packageIndex ?? 1;
    // Parts carry consecutive serials, so the first part's serial identifies the message.
    const key = `${h.msgId}:${(h.serial - index + 1) & 0xffff}`;
    const entry = session.parts.get(key) ?? { total, got: new Map<number, Buffer>(), header: h };
    entry.got.set(index, Buffer.from(body));
    session.parts.set(key, entry);
    if (session.parts.size > 8) session.parts.delete(session.parts.keys().next().value as string);
    if (entry.got.size < entry.total) return null;
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
        fuel: loc.fuelL,
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
