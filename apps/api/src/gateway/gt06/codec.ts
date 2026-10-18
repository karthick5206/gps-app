import { crcItu } from './crc';

/**
 * Concox GT06 binary protocol: pure frame splitting, decoding and encoding.
 * Frame: 78 78 | len(1) | proto | content | serial(2) | crc(2) | 0D 0A  (79 79 uses a 2-byte len).
 * `len` covers proto..crc; the CRC covers len..serial.
 */

export const Gt06Protocol = {
  LOGIN: 0x01,
  GPS: 0x12,
  STATUS: 0x13,
  ALARM: 0x16,
  GPS_LBS_STATUS: 0x22,
  ALARM_EXT: 0x26,
} as const;

export const GT06_ALARMS: Record<number, string> = {
  0x01: 'sos',
  0x02: 'powerCut',
  0x03: 'vibration',
  0x06: 'overspeed',
};

const COORD_SCALE = 1_800_000;
const FIX_LENGTH = 18;
const LBS_LENGTH = 8;
const STOP = [0x0d, 0x0a];

export class Gt06DecodeError extends Error {}

export interface Gt06Fix {
  time: Date;
  gpsInfoLength: number;
  satellites: number;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  positioned: boolean;
}

export interface Gt06Lbs {
  mcc: number;
  mnc: number;
  lac: number;
  cellId: number;
}

export interface Gt06TerminalStatus {
  ignition: boolean;
  charging: boolean;
  oilCut: boolean;
  /** 0..6 */
  voltageLevel: number;
  /** 0..4 */
  gsmSignal: number;
}

export type Gt06Message =
  | { type: 'login'; protocol: number; serial: number; imei: string; typeId: number | null; timezone: number | null }
  | {
      type: 'gps';
      protocol: number;
      serial: number;
      fix: Gt06Fix;
      lbs: Gt06Lbs;
      acc: boolean | null;
      uploadMode: number | null;
      reupload: boolean | null;
      mileage: number | null;
    }
  | { type: 'heartbeat'; protocol: number; serial: number; status: Gt06TerminalStatus; alarmLang: number }
  | {
      type: 'alarm';
      protocol: number;
      serial: number;
      fix: Gt06Fix;
      lbs: Gt06Lbs;
      status: Gt06TerminalStatus;
      alarm: number;
      lang: number;
    }
  | { type: 'unknown'; protocol: number; serial: number; content: Buffer };

export interface DecodedFrames {
  /** Complete, CRC-checked frames (including start and stop bytes). */
  frames: Buffer[];
  /** Trailing bytes of an incomplete frame; prepend them to the next chunk. */
  rest: Buffer;
  /** Number of garbage runs / corrupt frames that were skipped. */
  dropped: number;
}

function isStartAt(buf: Buffer, i: number): boolean {
  return i + 1 < buf.length && ((buf[i] === 0x78 && buf[i + 1] === 0x78) || (buf[i] === 0x79 && buf[i + 1] === 0x79));
}

function findStart(buf: Buffer, from: number): number {
  for (let i = from; i < buf.length - 1; i++) if (isStartAt(buf, i)) return i;
  return -1;
}

/** Split a byte stream into frames, keeping a partial tail and skipping garbage up to the next start marker. */
export function decodeFrames(buf: Buffer): DecodedFrames {
  const frames: Buffer[] = [];
  let dropped = 0;
  let i = 0;
  while (i < buf.length) {
    if (!isStartAt(buf, i)) {
      const next = findStart(buf, i);
      if (next < 0) {
        // Keep a lone trailing marker byte: it may be the first half of the next start marker.
        const last = buf[buf.length - 1];
        const keepLast = last === 0x78 || last === 0x79;
        if (buf.length - i > (keepLast ? 1 : 0)) dropped++;
        return { frames, rest: keepLast ? buf.subarray(buf.length - 1) : Buffer.alloc(0), dropped };
      }
      dropped++;
      i = next;
    }
    const long = buf[i] === 0x79;
    const headerLength = long ? 4 : 3;
    if (buf.length - i < headerLength) break;
    const len = long ? buf.readUInt16BE(i + 2) : buf[i + 2];
    const total = headerLength + len + 2;
    if (len < 5) {
      dropped++;
      i += 1;
      continue;
    }
    if (buf.length - i < total) break;
    const end = i + total;
    const crcAt = end - 4;
    const ok =
      buf[end - 2] === STOP[0] && buf[end - 1] === STOP[1] && crcItu(buf, i + 2, crcAt) === buf.readUInt16BE(crcAt);
    if (!ok) {
      dropped++;
      i += 1;
      continue;
    }
    frames.push(buf.subarray(i, end));
    i = end;
  }
  return { frames, rest: buf.subarray(i), dropped };
}

function readFix(c: Buffer, at: number): Gt06Fix {
  const time = new Date(Date.UTC(2000 + c[at], c[at + 1] - 1, c[at + 2], c[at + 3], c[at + 4], c[at + 5]));
  const courseStatus = c.readUInt16BE(at + 16);
  const north = (courseStatus & 0x0400) !== 0;
  const west = (courseStatus & 0x0800) !== 0;
  return {
    time,
    gpsInfoLength: c[at + 6] >> 4,
    satellites: c[at + 6] & 0x0f,
    lat: (c.readUInt32BE(at + 7) / COORD_SCALE) * (north ? 1 : -1),
    lng: (c.readUInt32BE(at + 11) / COORD_SCALE) * (west ? -1 : 1),
    speedKph: c[at + 15],
    course: courseStatus & 0x03ff,
    positioned: (courseStatus & 0x1000) !== 0,
  };
}

function readLbs(c: Buffer, at: number): Gt06Lbs {
  return { mcc: c.readUInt16BE(at), mnc: c[at + 2], lac: c.readUInt16BE(at + 3), cellId: c.readUIntBE(at + 5, 3) };
}

function readTerminalStatus(info: number, voltageLevel: number, gsmSignal: number): Gt06TerminalStatus {
  return {
    ignition: (info & 0x02) !== 0,
    charging: (info & 0x04) !== 0,
    oilCut: (info & 0x80) !== 0,
    voltageLevel,
    gsmSignal,
  };
}

function requireLength(content: Buffer, min: number, protocol: number): void {
  if (content.length < min) {
    throw new Gt06DecodeError(`Protocol 0x${protocol.toString(16)}: content ${content.length} bytes, need ${min}`);
  }
}

/** Protocol number of a complete frame without decoding its content (e.g. server ACKs, which have none). */
export function frameProtocol(frame: Buffer): number {
  return frame[frame[0] === 0x79 ? 4 : 3];
}

/** Decode one complete frame produced by `decodeFrames`. */
export function decodeMessage(frame: Buffer): Gt06Message {
  const long = frame[0] === 0x79;
  const lenAt = 2;
  const len = long ? frame.readUInt16BE(lenAt) : frame[lenAt];
  const protoAt = long ? 4 : 3;
  const protocol = frameProtocol(frame);
  const content = frame.subarray(protoAt + 1, protoAt + 1 + len - 5);
  const serial = frame.readUInt16BE(protoAt + 1 + content.length);

  switch (protocol) {
    case Gt06Protocol.LOGIN: {
      requireLength(content, 8, protocol);
      const imei = content.subarray(0, 8).toString('hex').replace(/^0/, '');
      return {
        type: 'login',
        protocol,
        serial,
        imei,
        typeId: content.length >= 10 ? content.readUInt16BE(8) : null,
        timezone: content.length >= 12 ? content.readUInt16BE(10) : null,
      };
    }
    case Gt06Protocol.GPS:
    case Gt06Protocol.GPS_LBS_STATUS: {
      requireLength(content, FIX_LENGTH + LBS_LENGTH, protocol);
      const extended = protocol === Gt06Protocol.GPS_LBS_STATUS && content.length >= FIX_LENGTH + LBS_LENGTH + 3;
      const extra = FIX_LENGTH + LBS_LENGTH;
      return {
        type: 'gps',
        protocol,
        serial,
        fix: readFix(content, 0),
        lbs: readLbs(content, FIX_LENGTH),
        acc: extended ? content[extra] === 1 : null,
        uploadMode: extended ? content[extra + 1] : null,
        reupload: extended ? content[extra + 2] === 1 : null,
        mileage: extended && content.length >= extra + 7 ? content.readUInt32BE(extra + 3) : null,
      };
    }
    case Gt06Protocol.STATUS: {
      requireLength(content, 5, protocol);
      return {
        type: 'heartbeat',
        protocol,
        serial,
        status: readTerminalStatus(content[0], content[1], content[2]),
        alarmLang: content.readUInt16BE(3),
      };
    }
    case Gt06Protocol.ALARM:
    case Gt06Protocol.ALARM_EXT: {
      // fix(18) · lbsLength(1) · lbs(8) · terminal info · voltage · gsm · alarm · lang
      requireLength(content, FIX_LENGTH + 1 + LBS_LENGTH + 5, protocol);
      const s = FIX_LENGTH + 1 + LBS_LENGTH;
      return {
        type: 'alarm',
        protocol,
        serial,
        fix: readFix(content, 0),
        lbs: readLbs(content, FIX_LENGTH + 1),
        status: readTerminalStatus(content[s], content[s + 1], content[s + 2]),
        alarm: content[s + 3],
        lang: content[s + 4],
      };
    }
    default:
      return { type: 'unknown', protocol, serial, content: Buffer.from(content) };
  }
}

/** Battery percentage from the GT06 voltage level (0..6). */
export function batteryFromVoltageLevel(level: number): number {
  return Math.round((Math.min(Math.max(level, 0), 6) * 100) / 6);
}

// ---------------------------------------------------------------------------
// Encoders (server ACKs and the device simulator)
// ---------------------------------------------------------------------------

export function encodeFrame(protocol: number, content: Buffer, serial: number): Buffer {
  const len = 1 + content.length + 2 + 2;
  const long = len > 0xff;
  const headerLength = long ? 4 : 3;
  const out = Buffer.alloc(headerLength + len + 2);
  out[0] = out[1] = long ? 0x79 : 0x78;
  if (long) out.writeUInt16BE(len, 2);
  else out[2] = len;
  out[headerLength] = protocol;
  content.copy(out, headerLength + 1);
  const serialAt = headerLength + 1 + content.length;
  out.writeUInt16BE(serial & 0xffff, serialAt);
  out.writeUInt16BE(crcItu(out, 2, serialAt + 2), serialAt + 2);
  out[serialAt + 4] = STOP[0];
  out[serialAt + 5] = STOP[1];
  return out;
}

export function encodeAck(protocol: number, serial: number): Buffer {
  return encodeFrame(protocol, Buffer.alloc(0), serial);
}

/** Which decoded messages the server must acknowledge. */
export function requiresAck(message: Gt06Message): boolean {
  return message.type === 'login' || message.type === 'heartbeat' || message.type === 'alarm';
}

export function encodeLogin(imei: string, serial: number, typeId?: number, timezone?: number): Buffer {
  if (!/^\d{1,16}$/.test(imei)) throw new Error(`Invalid IMEI ${imei}`);
  const parts = [Buffer.from(imei.padStart(16, '0'), 'hex')];
  if (typeId !== undefined) {
    const extra = Buffer.alloc(4);
    extra.writeUInt16BE(typeId, 0);
    extra.writeUInt16BE(timezone ?? 0, 2);
    parts.push(extra);
  }
  return encodeFrame(Gt06Protocol.LOGIN, Buffer.concat(parts), serial);
}

function writeFix(fix: Gt06Fix): Buffer {
  const b = Buffer.alloc(FIX_LENGTH);
  const t = fix.time;
  b[0] = t.getUTCFullYear() - 2000;
  b[1] = t.getUTCMonth() + 1;
  b[2] = t.getUTCDate();
  b[3] = t.getUTCHours();
  b[4] = t.getUTCMinutes();
  b[5] = t.getUTCSeconds();
  b[6] = ((fix.gpsInfoLength & 0x0f) << 4) | Math.min(fix.satellites, 15);
  b.writeUInt32BE(Math.round(Math.abs(fix.lat) * COORD_SCALE), 7);
  b.writeUInt32BE(Math.round(Math.abs(fix.lng) * COORD_SCALE), 11);
  b[15] = Math.min(Math.max(Math.round(fix.speedKph), 0), 255);
  const courseStatus =
    (Math.round(fix.course) % 360 & 0x03ff) |
    (fix.lat >= 0 ? 0x0400 : 0) |
    (fix.lng < 0 ? 0x0800 : 0) |
    (fix.positioned ? 0x1000 : 0);
  b.writeUInt16BE(courseStatus, 16);
  return b;
}

function writeLbs(lbs: Gt06Lbs): Buffer {
  const b = Buffer.alloc(LBS_LENGTH);
  b.writeUInt16BE(lbs.mcc, 0);
  b[2] = lbs.mnc;
  b.writeUInt16BE(lbs.lac, 3);
  b.writeUIntBE(lbs.cellId, 5, 3);
  return b;
}

function terminalInfoByte(status: Pick<Gt06TerminalStatus, 'ignition' | 'charging' | 'oilCut'>): number {
  return (status.ignition ? 0x02 : 0) | (status.charging ? 0x04 : 0) | (status.oilCut ? 0x80 : 0);
}

export interface Gps22Input {
  fix: Gt06Fix;
  lbs: Gt06Lbs;
  acc: boolean;
  uploadMode?: number;
  reupload?: boolean;
  mileage?: number;
}

export function encodeGps22(input: Gps22Input, serial: number): Buffer {
  const tail = Buffer.alloc(input.mileage === undefined ? 3 : 7);
  tail[0] = input.acc ? 1 : 0;
  tail[1] = input.uploadMode ?? 0;
  tail[2] = input.reupload ? 1 : 0;
  if (input.mileage !== undefined) tail.writeUInt32BE(input.mileage, 3);
  return encodeFrame(Gt06Protocol.GPS_LBS_STATUS, Buffer.concat([writeFix(input.fix), writeLbs(input.lbs), tail]), serial);
}

export function encodeHeartbeat(status: Gt06TerminalStatus, serial: number, alarmLang = 0x0002): Buffer {
  const b = Buffer.alloc(5);
  b[0] = terminalInfoByte(status);
  b[1] = status.voltageLevel;
  b[2] = status.gsmSignal;
  b.writeUInt16BE(alarmLang, 3);
  return encodeFrame(Gt06Protocol.STATUS, b, serial);
}

export interface AlarmInput {
  fix: Gt06Fix;
  lbs: Gt06Lbs;
  status: Gt06TerminalStatus;
  alarm: number;
  lang?: number;
}

export function encodeAlarm(input: AlarmInput, serial: number, protocol: number = Gt06Protocol.ALARM_EXT): Buffer {
  const status = Buffer.alloc(5);
  status[0] = terminalInfoByte(input.status);
  status[1] = input.status.voltageLevel;
  status[2] = input.status.gsmSignal;
  status[3] = input.alarm;
  status[4] = input.lang ?? 0x02;
  const content = Buffer.concat([writeFix(input.fix), Buffer.from([LBS_LENGTH]), writeLbs(input.lbs), status]);
  return encodeFrame(protocol, content, serial);
}
