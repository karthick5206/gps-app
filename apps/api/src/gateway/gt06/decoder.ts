import { NormalizedPosition } from '@veetracer/shared';
import { compact, round } from '../attributes';
import { BaseSession, DecodeContext, DecodeResult, emptyResult, ProtocolDecoder, SplitResult } from '../protocol';
import {
  batteryFromVoltageLevel,
  decodeFrames,
  decodeMessage,
  encodeAck,
  encodeCommand,
  encodeTimeResponse,
  Gt06DecodeError,
  Gt06Fix,
  Gt06Lbs,
  Gt06Message,
  GT06_ALARMS,
  GT06_MAX_FRAME_BYTES,
  Gt06TerminalStatus,
  requiresAck,
  timeZoneMinutes,
} from './codec';

export const GT06_PROTOCOL = 'gt06';

/** A real-time fix within this window of server time decides whether the device clock is UTC or local. */
const CLOCK_DECISION_WINDOW_MS = 30 * 60_000;
/** Before a decision, a device time this far ahead of server time means the clock is local (east of UTC). */
const CLOCK_FUTURE_EVIDENCE_MS = 10 * 60_000;

/** Latest terminal status seen on a connection (heartbeats, alarms, 0x94 info) used to enrich positions. */
export interface Gt06Status {
  ignition: boolean | null;
  charging: boolean | null;
  oilCut: boolean | null;
  batteryLevel: number | null;
  gsmSignal: number | null;
  extVoltage: number | null;
}

export interface Gt06Session extends BaseSession {
  /** Device time zone from the login packet, minutes east of UTC. */
  timeZoneMinutes: number | null;
  /** 'local' = device clock is in `timeZoneMinutes`, 'utc' = clock is UTC despite a reported zone, null = undecided. */
  clock: 'local' | 'utc' | null;
  typeId: number | null;
  status: Gt06Status;
  iccid: string | null;
  /** Serial number for frames the server initiates (commands). */
  serverSerial: number;
}

export const alarmName = (code: number): string => GT06_ALARMS[code] ?? `alarm_${code}`;

function mergeStatus(prev: Gt06Status, s: Gt06TerminalStatus): Gt06Status {
  return {
    ...prev,
    ignition: s.ignition,
    charging: s.charging,
    oilCut: s.oilCut,
    batteryLevel: s.voltageLevel === null ? prev.batteryLevel : batteryFromVoltageLevel(s.voltageLevel),
    gsmSignal: s.gsmSignal,
  };
}

/** Concox / Jimi GT06 family (GT06N, GT800, V5, VL149 and other Concox/Jimi trackers) on one TCP port. */
export class Gt06Decoder implements ProtocolDecoder<Gt06Session> {
  readonly name = GT06_PROTOCOL;
  readonly maxFrameBytes = GT06_MAX_FRAME_BYTES;

  createSession(): Gt06Session {
    return {
      uniqueId: null,
      timeZoneMinutes: null,
      clock: null,
      typeId: null,
      status: { ignition: null, charging: null, oilCut: null, batteryLevel: null, gsmSignal: null, extVoltage: null },
      iccid: null,
      serverSerial: 0,
    };
  }

  encodeCommand(text: string, session: Gt06Session, ref: number): Buffer {
    session.serverSerial = (session.serverSerial + 1) & 0xffff;
    return encodeCommand(text, ref, session.serverSerial);
  }

  split(buf: Buffer): SplitResult {
    return decodeFrames(buf, this.maxFrameBytes);
  }

  decode(frame: Buffer, session: Gt06Session, ctx: DecodeContext): DecodeResult {
    let message: Gt06Message;
    try {
      message = decodeMessage(frame);
    } catch (error) {
      if (!(error instanceof Gt06DecodeError)) throw error;
      ctx.unparsed(error.message, frame, session.uniqueId);
      return emptyResult();
    }
    const result = emptyResult();
    if (requiresAck(message)) result.replies.push(encodeAck(message.protocol, message.serial));

    switch (message.type) {
      case 'login':
        session.uniqueId = message.imei;
        session.typeId = message.typeId;
        session.timeZoneMinutes = timeZoneMinutes(message.timezone);
        session.clock = session.timeZoneMinutes ? null : 'utc';
        break;
      case 'heartbeat':
        session.status = mergeStatus(session.status, message.status);
        if (message.extVoltage !== undefined) session.status.extVoltage = message.extVoltage;
        break;
      case 'timeRequest':
        result.replies.push(encodeTimeResponse(message.serial, ctx.receivedAt));
        break;
      case 'info':
        if (message.extVoltage !== undefined) session.status.extVoltage = message.extVoltage;
        if (message.iccid) session.iccid = message.iccid;
        break;
      case 'commandResponse':
        result.commandResponses = [{ ref: message.serverFlag, text: message.text }];
        break;
      case 'gps': {
        if (!session.uniqueId) break;
        const fixTime = this.fixTime(session, message.fix, message.reupload === true, ctx);
        result.positions.push(
          this.position(session, message.fix, fixTime, message.lbs, message.acc, frame, ctx, {
            ...(message.mileage !== null ? { mileage: message.mileage } : {}),
            ...(message.reupload ? { reupload: true } : {}),
          }),
        );
        break;
      }
      case 'alarm': {
        session.status = mergeStatus(session.status, message.status);
        if (!session.uniqueId) break;
        const fixTime = this.fixTime(session, message.fix, false, ctx);
        result.positions.push(this.position(session, message.fix, fixTime, message.lbs, null, frame, ctx, { alarm: alarmName(message.alarm) }));
        break;
      }
      case 'lbs':
        break;
      case 'unknown':
        ctx.unparsed(`unknown protocol 0x${message.protocol.toString(16).padStart(2, '0')}`, frame, session.uniqueId);
        break;
    }
    return result;
  }

  /**
   * Device clock → UTC. Concox devices report their configured zone in the login packet; some stamp fixes in that zone
   * (as Traccar assumes) but others stamp UTC regardless (seen on a customer unit reporting +05:30). The first
   * real-time fix close to server time decides which, once per connection. Until then a time clearly in the future
   * proves a local clock; otherwise the time is taken as UTC.
   */
  private fixTime(session: Gt06Session, fix: Gt06Fix, reupload: boolean, ctx: DecodeContext): Date {
    const raw = fix.time.getTime();
    const offset = (session.timeZoneMinutes ?? 0) * 60_000;
    if (!offset || session.clock === 'utc') return fix.time;
    if (session.clock === 'local') return new Date(raw - offset);
    const now = ctx.receivedAt.getTime();
    if (!reupload && fix.positioned) {
      const asLocal = Math.abs(raw - offset - now);
      const asUtc = Math.abs(raw - now);
      if (Math.min(asLocal, asUtc) <= CLOCK_DECISION_WINDOW_MS) {
        this.decideClock(session, asUtc < asLocal ? 'utc' : 'local', ctx);
        return session.clock === 'utc' ? fix.time : new Date(raw - offset);
      }
    }
    // Undecided (history or no fix yet): a raw time clearly in the future can only be a local clock east of UTC.
    if (offset > 0 && raw - now > CLOCK_FUTURE_EVIDENCE_MS) {
      this.decideClock(session, 'local', ctx);
      return new Date(raw - offset);
    }
    return fix.time;
  }

  private decideClock(session: Gt06Session, clock: 'utc' | 'local', ctx: DecodeContext): void {
    session.clock = clock;
    const zone = `UTC${session.timeZoneMinutes! >= 0 ? '+' : ''}${session.timeZoneMinutes} min`;
    ctx.warn(`gt06:clock:${session.uniqueId}`, `Device ${session.uniqueId} reports ${zone}; clock is ${clock === 'utc' ? 'UTC (zone ignored)' : 'local (zone applied)'}`);
  }

  private position(
    session: Gt06Session,
    fix: Gt06Fix,
    fixTime: Date,
    lbs: Gt06Lbs | null,
    acc: boolean | null,
    frame: Buffer,
    ctx: DecodeContext,
    extra: Record<string, unknown>,
  ): NormalizedPosition {
    const s = session.status;
    return {
      protocol: GT06_PROTOCOL,
      uniqueId: session.uniqueId!,
      fixTime: fixTime.toISOString(),
      receivedAt: ctx.receivedAt.toISOString(),
      lat: fix.lat,
      lng: fix.lng,
      speedKph: fix.speedKph,
      course: fix.course,
      altitude: null,
      satellites: fix.satellites,
      valid: fix.positioned,
      ignition: acc ?? fix.courseAcc ?? s.ignition,
      attributes: compact({
        batteryLevel: s.batteryLevel,
        gsmSignal: s.gsmSignal,
        charging: s.charging,
        extVoltage: s.extVoltage === null ? null : round(s.extVoltage, 2),
        oilCut: s.oilCut ? true : null,
        mcc: lbs?.mcc,
        mnc: lbs?.mnc,
        lac: lbs?.lac,
        cellId: lbs?.cellId,
        ...extra,
      }),
      raw: frame.toString('hex'),
    };
  }
}
