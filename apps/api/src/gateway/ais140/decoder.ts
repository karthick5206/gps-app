import { NormalizedPosition } from '@veetracer/shared';
import { compact, gsmFromCsq, round } from '../attributes';
import { BaseSession, DecodeContext, DecodeResult, emptyResult, ProtocolDecoder, SplitResult } from '../protocol';
import {
  AIS140_ALERT_IDS,
  AIS140_MAX_FRAME_BYTES,
  AIS140_TYPE_ALARMS,
  Ais140DecodeError,
  Ais140Location,
  Ais140Message,
  decodeAis140,
  parseFrame,
  splitAis140,
  variantFor,
} from './codec';

export const AIS140_PROTOCOL = 'ais140';

export interface Ais140Session extends BaseSession {
  variant: string | null;
  vehicleRegNo: string | null;
  /** Latest health-packet battery %, merged into positions. */
  batteryLevel: number | null;
}

/**
 * AIS-140 VLT devices (iTriangle TS101 Basic/Advanced and other ARAI-certified units).
 * Per public spec; verify with a real device capture (GATEWAY_CAPTURE=<imei>).
 * Custom commands are sent as raw text lines (the AIS-140 OTA command set differs per vendor).
 */
export class Ais140Decoder implements ProtocolDecoder<Ais140Session> {
  readonly name = AIS140_PROTOCOL;
  readonly maxFrameBytes = AIS140_MAX_FRAME_BYTES;
  readonly flushAfterMs = 1500;

  createSession(): Ais140Session {
    return { uniqueId: null, variant: null, vehicleRegNo: null, batteryLevel: null };
  }

  split(buf: Buffer): SplitResult {
    return splitAis140(buf, this.maxFrameBytes);
  }

  flush(rest: Buffer): SplitResult {
    return splitAis140(rest, this.maxFrameBytes, true);
  }

  encodeCommand(text: string): Buffer {
    const line = text.trim();
    return Buffer.from(/\r?\n$/.test(line) ? line : `${line}\r\n`, 'latin1');
  }

  decode(frame: Buffer, session: Ais140Session, ctx: DecodeContext): DecodeResult {
    const result = emptyResult();
    let message: Ais140Message;
    try {
      message = decodeAis140(parseFrame(frame).fields);
    } catch (error) {
      if (!(error instanceof Ais140DecodeError)) throw error;
      ctx.unparsed(error.message, frame, session.uniqueId);
      return result;
    }
    session.uniqueId = message.imei;
    switch (message.type) {
      case 'login': {
        if (message.vehicleRegNo) session.vehicleRegNo = message.vehicleRegNo;
        const ack = variantFor('', message.header).loginAck;
        if (ack) result.replies.push(Buffer.from(ack, 'latin1'));
        break;
      }
      case 'health':
        session.variant = variantFor(message.vendor, message.header).id;
        if (message.batteryLevel !== null) session.batteryLevel = message.batteryLevel;
        break;
      case 'emergency':
        result.positions.push({
          protocol: AIS140_PROTOCOL,
          uniqueId: message.imei,
          fixTime: message.time.toISOString(),
          receivedAt: ctx.receivedAt.toISOString(),
          lat: message.lat,
          lng: message.lng,
          speedKph: message.speedKph,
          course: 0,
          altitude: message.altitude,
          satellites: null,
          valid: message.valid,
          ignition: null,
          attributes: compact({
            ...(message.state === 'SP' ? { event: 'sosOff', emergency: false } : { alarm: 'sos', emergency: true }),
            batteryLevel: session.batteryLevel,
            vehicleRegNo: message.vehicleRegNo,
          }),
          raw: frame.toString('latin1'),
        });
        break;
      case 'location': {
        const variant = variantFor(message.vendor, message.header);
        session.variant = variant.id;
        if (message.vehicleRegNo) session.vehicleRegNo = message.vehicleRegNo;
        result.positions.push(this.position(message, session, frame, ctx));
        if (variant.ack) result.replies.push(Buffer.from(variant.ack, 'latin1'));
        break;
      }
    }
    return result;
  }

  private position(m: Ais140Location, session: Ais140Session, frame: Buffer, ctx: DecodeContext): NormalizedPosition {
    const byType = AIS140_TYPE_ALARMS[m.packetType];
    const byId = m.alertId !== null ? AIS140_ALERT_IDS[m.alertId] : undefined;
    // The packet type is decisive when it names an alert; NR packets with an alert id use the id.
    const mapped = byType && (byType.alarm || byType.event) ? byType : (byId ?? byType ?? {});
    const unknownAlert = !byType && !byId && m.packetType !== 'NR';
    return {
      protocol: AIS140_PROTOCOL,
      uniqueId: m.imei,
      fixTime: m.time.toISOString(),
      receivedAt: ctx.receivedAt.toISOString(),
      lat: m.lat,
      lng: m.lng,
      speedKph: m.speedKph,
      course: m.course,
      altitude: m.altitude,
      satellites: m.satellites,
      valid: m.valid,
      ignition: m.ignition,
      attributes: compact({
        alarm: mapped.alarm,
        event: mapped.event ?? (unknownAlert ? `ais140_${m.packetType}${m.alertId !== null ? `_${m.alertId}` : ''}` : undefined),
        reupload: m.history ? true : undefined,
        hdop: m.hdop,
        pdop: m.pdop,
        gsmSignal: m.csq === null ? null : gsmFromCsq(m.csq),
        extVoltage: m.extVoltage === null ? null : round(m.extVoltage, 2),
        batteryVoltage: m.batteryVoltage === null ? null : round(m.batteryVoltage, 2),
        batteryLevel: session.batteryLevel,
        charging: m.mainPower,
        emergency: m.emergency ? true : undefined,
        tamper: m.tamperOpen ? true : undefined,
        operator: m.operator,
        mcc: m.mcc,
        mnc: m.mnc,
        lac: m.lac,
        cellId: m.cellId,
        digitalInputs: m.digitalInputs,
        digitalOutputs: m.digitalOutputs,
        frameNo: m.frameNo,
        packetType: m.packetType,
        alertId: m.alertId,
      }),
      raw: frame.toString('latin1'),
    };
  }
}
