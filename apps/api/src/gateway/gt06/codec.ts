import { crcItu } from './crc';

/**
 * Concox / Jimi GT06 family binary protocol (GT06N, GT800, V5, VL149, AT4, WeTrack…): pure frame splitting,
 * decoding and encoding.
 * Frame: 78 78 | len(1) | proto | content | serial(2) | crc(2) | 0D 0A  (79 79 uses a 2-byte len).
 * `len` covers proto..crc; the CRC (CRC-16/X-25) covers len..serial.
 * Layouts follow the Concox protocol documents; Traccar's Gt06ProtocolDecoder is the public cross-check.
 */

export const Gt06Protocol = {
  LOGIN: 0x01,
  GPS_ONLY: 0x10,
  LBS_ONLY: 0x11,
  GPS: 0x12,
  STATUS: 0x13,
  COMMAND_RESPONSE: 0x15,
  ALARM: 0x16,
  LBS_MULTIPLE: 0x17,
  COMMAND_RESPONSE_EXT: 0x21,
  GPS_LBS_STATUS: 0x22,
  HEARTBEAT: 0x23,
  ALARM_EXT: 0x26,
  ALARM_MULTI_FENCE: 0x27,
  LBS_EXTEND: 0x28,
  WIFI: 0x2c,
  SERVER_COMMAND: 0x80,
  TIME_REQUEST: 0x8a,
  /** OBD data (Concox OBD trackers, GT800-OBD / X3 / OB22 class). Per public spec; verify with a device capture. */
  OBD: 0x8c,
  INFO: 0x94,
  GPS_4G: 0xa0,
  LBS_4G: 0xa1,
  ALARM_4G: 0xa4,
} as const;

/** Alarm byte of 0x16/0x26/0x27/0xA4 packets → normalised alarm names (see gateway/attributes.ts). */
export const GT06_ALARMS: Record<number, string> = {
  0x01: 'sos',
  0x02: 'powerCut',
  0x03: 'vibration',
  0x04: 'geofenceEnter',
  0x05: 'geofenceExit',
  0x06: 'overspeed',
  0x09: 'towing',
  0x0e: 'lowBattery',
  0x0f: 'lowBattery',
  0x11: 'powerCut',
  0x13: 'tamper',
  0x19: 'lowBattery',
  0x29: 'harshAcceleration',
  0x2a: 'harshBraking',
  0x2b: 'harshCornering',
  0x2c: 'harshCornering',
  0x30: 'crash',
};

/**
 * Alarm bits 5..3 of the terminal-information byte (Concox spec: 100 SOS, 011 low battery, 010 power cut, 001 shock)
 * mapped to alarm codes. Some devices (e.g. Concox ID card trackers) leave the alarm byte 0 and only set these bits.
 */
const TERMINAL_INFO_ALARMS: Record<number, number> = { 0b100: 0x01, 0b011: 0x0e, 0b010: 0x02, 0b001: 0x03 };

/** Alarm code from the terminal-information byte, or 0 when it reports none. */
export function terminalInfoAlarm(info: number): number {
  return TERMINAL_INFO_ALARMS[(info >> 3) & 0x07] ?? 0;
}

/** 0x94 information sub-types we decode. */
export const Gt06InfoType = {
  EXTERNAL_VOLTAGE: 0x00,
  STATUS_TEXT: 0x04,
  DOOR: 0x05,
  ICCID: 0x0a,
  /** Serial fuel sensor text (`!AIOAU,…`). Per public spec (Traccar); verify with a device capture. */
  FUEL_SENSOR: 0x0d,
  /** RFID card reader (driver card). Per public spec (Traccar); verify with a device capture. */
  RFID: 0x1b,
} as const;
const KNOWN_INFO_TYPES = new Set<number>(Object.values(Gt06InfoType));

/**
 * OBD 0x8C `key=value` pairs → normalised attribute names and scale. The key's first two characters are read as hex
 * and the value is hex × scale, as Traccar's public Gt06ProtocolDecoder does. Per public spec only: verify units with
 * a real device capture (GATEWAY_CAPTURE=<imei>).
 */
export const GT06_OBD_KEYS: Record<number, { attr: string; scale: number }> = {
  40: { attr: 'obdOdometerKm', scale: 0.01 },
  43: { attr: 'fuelLevelPct', scale: 0.01 },
  45: { attr: 'coolantTemp', scale: 0.01 },
  53: { attr: 'obdSpeedKph', scale: 0.01 },
  54: { attr: 'rpm', scale: 0.01 },
  71: { attr: 'fuelUsedL', scale: 0.01 },
  73: { attr: 'engineHours', scale: 0.01 },
};

const COORD_SCALE = 1_800_000;
const FIX_LENGTH = 18;
const LBS_LENGTH = 8;
const STOP = [0x0d, 0x0a];

export class Gt06DecodeError extends Error {}

export interface Gt06Fix {
  /** Device clock read as UTC; the decoder applies the device time zone (see `timeZoneMinutes`). */
  time: Date;
  gpsInfoLength: number;
  satellites: number;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  positioned: boolean;
  /** ACC carried in the course word on some firmware (bit 14 = present, bit 15 = on), e.g. Concox V5; else null. */
  courseAcc?: boolean | null;
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
  /** 0..6 (0x13/alarms); null when the packet carries a voltage instead (0x23). */
  voltageLevel: number | null;
  /** 0..4 */
  gsmSignal: number;
}

export type Gt06Message =
  | {
      type: 'login';
      protocol: number;
      serial: number;
      imei: string;
      typeId: number | null;
      /** Raw time zone / language word (null on short logins). */
      timezone: number | null;
    }
  | {
      type: 'gps';
      protocol: number;
      serial: number;
      fix: Gt06Fix;
      lbs: Gt06Lbs | null;
      acc: boolean | null;
      uploadMode: number | null;
      reupload: boolean | null;
      mileage: number | null;
    }
  | { type: 'heartbeat'; protocol: number; serial: number; status: Gt06TerminalStatus; alarmLang: number; extVoltage?: number }
  | {
      type: 'alarm';
      protocol: number;
      serial: number;
      fix: Gt06Fix;
      lbs: Gt06Lbs | null;
      status: Gt06TerminalStatus;
      alarm: number;
      lang: number;
    }
  | { type: 'timeRequest'; protocol: number; serial: number }
  | {
      type: 'info';
      protocol: number;
      serial: number;
      infoType: number;
      /** False for sub-types we don't decode (the decoder logs them as unparsed). */
      known: boolean;
      extVoltage?: number;
      iccid?: string;
      text?: string;
      /** RFID card id as the reader reports it (hex upper case for binary cards, the text for ASCII readers). */
      rfid?: string;
      /** Serial fuel sensor: raw level (calibrate as an LLS sensor) and temperature °C. */
      fuelSensorRaw?: number;
      fuelSensorTemp?: number;
      /** 0x05 door / IO status: bit 0 door, bit 2 input 1 (per Traccar), bit 1 input 2 (unverified). */
      inputs?: { door: boolean; in1: boolean; in2: boolean };
      content: Buffer;
    }
  | {
      type: 'obd';
      protocol: number;
      serial: number;
      /** Device clock (read as UTC, like fixes); null when the date bytes are not a valid date. */
      time: Date | null;
      ignition: boolean;
      /** Normalised attributes (rpm, coolantTemp, fuelLevelPct, obdOdometerKm, …). */
      values: Record<string, number>;
      /** Pairs with keys we don't map, as `obd_<key>` → raw value text. */
      other: Record<string, string>;
    }
  | { type: 'commandResponse'; protocol: number; serial: number; serverFlag: number; text: string }
  | { type: 'lbs'; protocol: number; serial: number }
  | { type: 'unknown'; protocol: number; serial: number; content: Buffer };

export interface DecodedFrames {
  /** Complete, CRC-checked frames (including start and stop bytes). */
  frames: Buffer[];
  /** Trailing bytes of an incomplete frame; prepend them to the next chunk. */
  rest: Buffer;
  /** Number of garbage runs / corrupt frames that were skipped. */
  dropped: number;
}

/** Longest frame we accept; longer declared lengths are treated as garbage (Wi-Fi/LBS lists stay well below this). */
export const GT06_MAX_FRAME_BYTES = 1024;

function isStartAt(buf: Buffer, i: number): boolean {
  return i + 1 < buf.length && ((buf[i] === 0x78 && buf[i + 1] === 0x78) || (buf[i] === 0x79 && buf[i + 1] === 0x79));
}

function findStart(buf: Buffer, from: number): number {
  for (let i = from; i < buf.length - 1; i++) if (isStartAt(buf, i)) return i;
  return -1;
}

/** Split a byte stream into frames, keeping a partial tail and skipping garbage up to the next start marker. */
export function decodeFrames(buf: Buffer, maxFrameBytes = GT06_MAX_FRAME_BYTES): DecodedFrames {
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
    // A bogus header (garbage that happens to look like a start marker) must not stall the stream.
    if (len < 5 || total > maxFrameBytes) {
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
    courseAcc: (courseStatus & 0x4000) !== 0 ? (courseStatus & 0x8000) !== 0 : null,
  };
}

/**
 * Cell tower block. When bit 15 of the MCC word is set the MNC is 2 bytes (e.g. Jio 405-8xx); 4G packets (0xA0/0xA4)
 * use a 4-byte LAC and an 8-byte cell id. Returns the block and the bytes consumed.
 */
function readLbs(c: Buffer, at: number, fourG: boolean): { lbs: Gt06Lbs; length: number } {
  const mccWord = c.readUInt16BE(at);
  const wideMnc = (mccWord & 0x8000) !== 0;
  const mncLength = wideMnc ? 2 : 1;
  const lacLength = fourG ? 4 : 2;
  const cellLength = fourG ? 8 : 3;
  const length = 2 + mncLength + lacLength + cellLength;
  if (c.length < at + length) throw new Gt06DecodeError(`LBS block truncated (${c.length - at} of ${length} bytes)`);
  let i = at + 2;
  const mnc = wideMnc ? c.readUInt16BE(i) : c[i];
  i += mncLength;
  const lac = fourG ? c.readUInt32BE(i) : c.readUInt16BE(i);
  i += lacLength;
  // 8-byte 4G cell ids fit easily in a double (≤ 2^53) in practice; read as BigInt to be safe.
  const cellId = fourG ? Number(c.readBigUInt64BE(i)) : c.readUIntBE(i, 3);
  return { lbs: { mcc: mccWord & 0x7fff, mnc, lac, cellId }, length };
}

function readTerminalStatus(info: number, voltageLevel: number | null, gsmSignal: number): Gt06TerminalStatus {
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

function decodeGpsLbs(protocol: number, serial: number, content: Buffer, fourG: boolean): Gt06Message {
  requireLength(content, FIX_LENGTH, protocol);
  const fix = readFix(content, 0);
  if (protocol === Gt06Protocol.GPS_ONLY || content.length === FIX_LENGTH) {
    return { type: 'gps', protocol, serial, fix, lbs: null, acc: null, uploadMode: null, reupload: null, mileage: null };
  }
  const { lbs, length } = readLbs(content, FIX_LENGTH, fourG);
  const extra = FIX_LENGTH + length;
  const withStatus = protocol !== Gt06Protocol.GPS && content.length >= extra + 3;
  return {
    type: 'gps',
    protocol,
    serial,
    fix,
    lbs,
    acc: withStatus ? content[extra] === 1 : null,
    uploadMode: withStatus ? content[extra + 1] : null,
    reupload: withStatus ? content[extra + 2] === 1 : null,
    mileage: withStatus && content.length >= extra + 7 ? content.readUInt32BE(extra + 3) : null,
  };
}

function decodeAlarm(protocol: number, serial: number, content: Buffer, fourG: boolean): Gt06Message {
  // fix(18) · lbsLength(1) · lbs (2G: 8–9 bytes, 4G: 15–16) · terminal info · voltage · gsm · alarm · lang
  requireLength(content, FIX_LENGTH + 1 + 5, protocol);
  const fix = readFix(content, 0);
  const lbsLength = content[FIX_LENGTH];
  let lbs: Gt06Lbs | null = null;
  let s = FIX_LENGTH + 1;
  if (lbsLength > 0) {
    const read = readLbs(content, s, fourG);
    lbs = read.lbs;
    s += read.length;
  }
  requireLength(content, s + 5, protocol);
  return {
    type: 'alarm',
    protocol,
    serial,
    fix,
    lbs,
    status: readTerminalStatus(content[s], content[s + 1], content[s + 2]),
    // Alarm byte first; when it is 0 the alarm is carried only in the terminal-information bits.
    alarm: content[s + 3] || terminalInfoAlarm(content[s]),
    lang: content[s + 4],
  };
}

const bcd = (b: Buffer) => b.toString('hex');

function decodeInfo(protocol: number, serial: number, content: Buffer): Gt06Message {
  requireLength(content, 1, protocol);
  const infoType = content[0];
  const data = content.subarray(1);
  const base = { type: 'info' as const, protocol, serial, infoType, known: KNOWN_INFO_TYPES.has(infoType), content: Buffer.from(content) };
  switch (infoType) {
    case Gt06InfoType.EXTERNAL_VOLTAGE:
      return data.length >= 2 ? { ...base, extVoltage: data.readUInt16BE(0) / 100 } : base;
    case Gt06InfoType.ICCID:
      // IMEI(8) · IMSI(8) · ICCID(10), all BCD
      return data.length >= 26 ? { ...base, iccid: bcd(data.subarray(16, 26)).replace(/f+$/i, '') } : base;
    case Gt06InfoType.STATUS_TEXT:
      return { ...base, text: data.toString('latin1').replace(/[^\x20-\x7e]/g, '').trim() };
    case Gt06InfoType.DOOR: {
      // Newer firmware prefixes the flags with date-time(6); older sends the flags byte alone (Traccar's decoder).
      if (!data.length) return { ...base, known: false };
      const flags = data.length >= 7 ? data[6] : data[0];
      return { ...base, inputs: { door: (flags & 0x01) !== 0, in1: (flags & 0x04) !== 0, in2: (flags & 0x02) !== 0 } };
    }
    case Gt06InfoType.FUEL_SENSOR:
      return { ...base, ...readFuelSensor(data) };
    case Gt06InfoType.RFID: {
      const rfid = readRfid(data);
      return rfid ? { ...base, rfid } : { ...base, known: false };
    }
    default:
      return base;
  }
}

/** `!AIOAU,addr,addr,ctrl,len,<temperature>,<level>,…`, optionally after 6 bytes of date. Per public spec. */
const FUEL_TEXT = /!AIOAU,\d+,\d+,\d+,\d+,(-?\d+),(\d+)/;

function readFuelSensor(data: Buffer): { fuelSensorRaw?: number; fuelSensorTemp?: number; known?: boolean } {
  const at = data.indexOf('!');
  const m = at < 0 ? null : FUEL_TEXT.exec(data.subarray(at).toString('latin1'));
  if (!m) return { known: false };
  return { fuelSensorTemp: Number(m[1]), fuelSensorRaw: Number(m[2]) };
}

/**
 * RFID card from the 0x94 / 0x1B payload. ASCII readers send the card number as text (decimal or hex digits);
 * binary readers send header(1) · type(1) · card(4) · checksum(1) · footer(1) (per Traccar's public decoder).
 */
function readRfid(data: Buffer): string | null {
  const text = data.toString('latin1').replace(/[\x00\r\n]+$/g, '').trim();
  if (/^[0-9A-Fa-f]{4,20}$/.test(text)) return text.toUpperCase();
  if (data.length >= 6) {
    const card = data.subarray(2, 6);
    if (card.some((b) => b !== 0)) return card.toString('hex').toUpperCase();
  }
  return null;
}

/**
 * 0x8C OBD data: date(6) · ignition(1) · ASCII `key=value,key=value…` · trailing binary block. Per public spec
 * (Traccar's Gt06ProtocolDecoder); verify with a real device capture. Returns null when no pairs are readable.
 */
function decodeObd(protocol: number, serial: number, content: Buffer): Gt06Message {
  requireLength(content, 8, protocol);
  const [yy, mo, dd, hh, mi, ss] = content;
  const validDate = mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31 && hh < 24 && mi < 60 && ss < 60;
  const time = validDate ? new Date(Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss)) : null;
  let end = 7;
  while (end < content.length && content[end] >= 0x20 && content[end] <= 0x7e) end++;
  const values: Record<string, number> = {};
  const other: Record<string, string> = {};
  for (const pair of content.subarray(7, end).toString('latin1').split(',')) {
    const [key, value] = pair.split('=').map((s) => s.trim());
    if (!key || !value || !/^[0-9A-Fa-f]{2,}$/.test(key) || !/^[0-9A-Fa-f]{1,12}$/.test(value)) continue;
    const def = GT06_OBD_KEYS[parseInt(key.slice(0, 2), 16)];
    if (def) values[def.attr] = Math.round(parseInt(value, 16) * def.scale * 100) / 100;
    else other[`obd_${key}`] = value;
  }
  if (!Object.keys(values).length && !Object.keys(other).length) {
    throw new Gt06DecodeError('OBD 0x8c: no key=value pairs');
  }
  return { type: 'obd', protocol, serial, time, ignition: content[6] > 0, values, other };
}

function decodeCommandResponse(protocol: number, serial: number, content: Buffer): Gt06Message {
  if (protocol === Gt06Protocol.COMMAND_RESPONSE) {
    // length(1) · server flag(4) · ASCII · language(2)
    requireLength(content, 5, protocol);
    const length = content[0];
    const textEnd = Math.min(1 + length, content.length - 2);
    return { type: 'commandResponse', protocol, serial, serverFlag: content.readUInt32BE(1), text: content.subarray(5, Math.max(5, textEnd)).toString('latin1') };
  }
  // 0x21: server flag(4) · encoding(1) · content
  requireLength(content, 5, protocol);
  return { type: 'commandResponse', protocol, serial, serverFlag: content.readUInt32BE(0), text: content.subarray(5).toString('latin1') };
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
    case Gt06Protocol.GPS_ONLY:
    case Gt06Protocol.GPS:
    case Gt06Protocol.GPS_LBS_STATUS:
      return decodeGpsLbs(protocol, serial, content, false);
    case Gt06Protocol.GPS_4G:
      return decodeGpsLbs(protocol, serial, content, true);
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
    case Gt06Protocol.HEARTBEAT: {
      // terminal info(1) · external voltage(2, /100 V) · gsm(1) · language(2)
      requireLength(content, 4, protocol);
      return {
        type: 'heartbeat',
        protocol,
        serial,
        status: readTerminalStatus(content[0], null, content[3]),
        alarmLang: content.length >= 6 ? content.readUInt16BE(4) : 0,
        extVoltage: content.readUInt16BE(1) / 100,
      };
    }
    case Gt06Protocol.ALARM:
    case Gt06Protocol.ALARM_EXT:
    case Gt06Protocol.ALARM_MULTI_FENCE:
      return decodeAlarm(protocol, serial, content, false);
    case Gt06Protocol.ALARM_4G:
      return decodeAlarm(protocol, serial, content, true);
    case Gt06Protocol.TIME_REQUEST:
      return { type: 'timeRequest', protocol, serial };
    case Gt06Protocol.INFO:
      return decodeInfo(protocol, serial, content);
    case Gt06Protocol.OBD:
      return decodeObd(protocol, serial, content);
    case Gt06Protocol.COMMAND_RESPONSE:
    case Gt06Protocol.COMMAND_RESPONSE_EXT:
      return decodeCommandResponse(protocol, serial, content);
    case Gt06Protocol.LBS_ONLY:
    case Gt06Protocol.LBS_MULTIPLE:
    case Gt06Protocol.LBS_EXTEND:
    case Gt06Protocol.WIFI:
    case Gt06Protocol.LBS_4G:
      // Cell/Wi-Fi only: no GPS fix. Location lookup (OpenCelliD) is a later feature (PRO-10).
      return { type: 'lbs', protocol, serial };
    default:
      return { type: 'unknown', protocol, serial, content: Buffer.from(content) };
  }
}

/** Battery percentage from the GT06 voltage level (0..6). */
export function batteryFromVoltageLevel(level: number): number {
  return Math.round((Math.min(Math.max(level, 0), 6) * 100) / 6);
}

/**
 * Device time zone from the login word: bits 15..4 = hours×100 + minutes (e.g. 530 = +05:30), bit 3 set = west.
 * Returns minutes east of UTC, or null when absent.
 */
export function timeZoneMinutes(word: number | null): number | null {
  if (word === null) return null;
  const value = word >> 4;
  const minutes = Math.floor(value / 100) * 60 + (value % 100);
  if (minutes > 14 * 60) return null;
  return (word & 0x08) !== 0 ? -minutes : minutes;
}

/** Encode a time zone as the login word (language bits 0). */
export function timeZoneWord(minutesEast: number): number {
  const abs = Math.abs(minutesEast);
  const value = Math.floor(abs / 60) * 100 + (abs % 60);
  return ((value & 0x0fff) << 4) | (minutesEast < 0 ? 0x08 : 0);
}

// ---------------------------------------------------------------------------
// Encoders (server replies and the device simulator)
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

/** Reply to a 0x8A time request: current UTC as YY MM DD hh mm ss. */
export function encodeTimeResponse(serial: number, now: Date): Buffer {
  const b = Buffer.from([
    now.getUTCFullYear() - 2000,
    now.getUTCMonth() + 1,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  ]);
  return encodeFrame(Gt06Protocol.TIME_REQUEST, b, serial);
}

/** Which decoded messages the server must acknowledge with an empty echo (0x8A gets a time reply instead). */
export function requiresAck(message: Gt06Message): boolean {
  // OBD (0x8C) is echoed like other device-initiated Concox packets (harmless if the firmware does not expect it).
  // Unknown device packets are echoed too: Concox firmware resends a packet until it is acknowledged (seen: 0x1F every
  // 30 s from an ID card tracker), and an echo is the generic Concox acknowledgement.
  return message.type === 'login' || message.type === 'heartbeat' || message.type === 'alarm' || message.type === 'obd' || message.type === 'unknown';
}

/** Server → device text command (0x80), e.g. `RELAY,1#`. */
export function encodeCommand(text: string, serverFlag: number, serial: number): Buffer {
  const ascii = Buffer.from(text, 'latin1');
  const content = Buffer.alloc(1 + 4 + ascii.length + 2);
  content[0] = 4 + ascii.length;
  content.writeUInt32BE(serverFlag >>> 0, 1);
  ascii.copy(content, 5);
  content.writeUInt16BE(0x0002, 5 + ascii.length); // English
  return encodeFrame(Gt06Protocol.SERVER_COMMAND, content, serial);
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

/** Fix bytes; `clockOffsetMinutes` writes the device-local clock (time zone set on the device). */
function writeFix(fix: Gt06Fix, clockOffsetMinutes = 0): Buffer {
  const b = Buffer.alloc(FIX_LENGTH);
  const t = new Date(fix.time.getTime() + clockOffsetMinutes * 60_000);
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

/** LBS block; 2-byte MNC when it doesn't fit one byte (sets MCC bit 15), 4G sizes when `fourG`. */
function writeLbs(lbs: Gt06Lbs, fourG = false): Buffer {
  const wideMnc = lbs.mnc > 0xff;
  const b = Buffer.alloc(2 + (wideMnc ? 2 : 1) + (fourG ? 4 : 2) + (fourG ? 8 : 3));
  b.writeUInt16BE((lbs.mcc & 0x7fff) | (wideMnc ? 0x8000 : 0), 0);
  let i = 2;
  if (wideMnc) b.writeUInt16BE(lbs.mnc, i);
  else b[i] = lbs.mnc;
  i += wideMnc ? 2 : 1;
  if (fourG) b.writeUInt32BE(lbs.lac, i);
  else b.writeUInt16BE(lbs.lac, i);
  i += fourG ? 4 : 2;
  if (fourG) b.writeBigUInt64BE(BigInt(lbs.cellId), i);
  else b.writeUIntBE(lbs.cellId, i, 3);
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
  /** Device clock offset (device time zone) in minutes. */
  clockOffsetMinutes?: number;
}

function gpsContent(input: Gps22Input, fourG: boolean): Buffer {
  const tail = Buffer.alloc(input.mileage === undefined ? 3 : 7);
  tail[0] = input.acc ? 1 : 0;
  tail[1] = input.uploadMode ?? 0;
  tail[2] = input.reupload ? 1 : 0;
  if (input.mileage !== undefined) tail.writeUInt32BE(input.mileage, 3);
  return Buffer.concat([writeFix(input.fix, input.clockOffsetMinutes), writeLbs(input.lbs, fourG), tail]);
}

export function encodeGps22(input: Gps22Input, serial: number): Buffer {
  return encodeFrame(Gt06Protocol.GPS_LBS_STATUS, gpsContent(input, false), serial);
}

/** 4G location (0xA0): as 0x22 with a 4-byte LAC and 8-byte cell id. */
export function encodeGpsA0(input: Gps22Input, serial: number): Buffer {
  return encodeFrame(Gt06Protocol.GPS_4G, gpsContent(input, true), serial);
}

export function encodeHeartbeat(status: Gt06TerminalStatus, serial: number, alarmLang = 0x0002): Buffer {
  const b = Buffer.alloc(5);
  b[0] = terminalInfoByte(status);
  b[1] = status.voltageLevel ?? 0;
  b[2] = status.gsmSignal;
  b.writeUInt16BE(alarmLang, 3);
  return encodeFrame(Gt06Protocol.STATUS, b, serial);
}

/** 0x23 heartbeat with external voltage in volts. */
export function encodeHeartbeat23(status: Pick<Gt06TerminalStatus, 'ignition' | 'charging' | 'oilCut' | 'gsmSignal'>, extVoltage: number, serial: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = terminalInfoByte(status);
  b.writeUInt16BE(Math.round(extVoltage * 100), 1);
  b[3] = status.gsmSignal;
  b.writeUInt16BE(0x0002, 4);
  return encodeFrame(Gt06Protocol.HEARTBEAT, b, serial);
}

/** 0x94 information packet with the external voltage sub-type. */
export function encodeInfoVoltage(extVoltage: number, serial: number): Buffer {
  const b = Buffer.alloc(3);
  b[0] = Gt06InfoType.EXTERNAL_VOLTAGE;
  b.writeUInt16BE(Math.round(extVoltage * 100), 1);
  return encodeFrame(Gt06Protocol.INFO, b, serial);
}

/** 0x94 information packet with any sub-type (tests / simulator). */
export function encodeInfo(infoType: number, data: Buffer, serial: number): Buffer {
  return encodeFrame(Gt06Protocol.INFO, Buffer.concat([Buffer.from([infoType]), data]), serial);
}

/** 0x8C OBD packet: date · ignition · `pairs` text · 12-byte trailing block (zeros) as in the public spec. */
export function encodeObd(time: Date, ignition: boolean, pairs: string, serial: number): Buffer {
  const head = Buffer.from([
    time.getUTCFullYear() - 2000,
    time.getUTCMonth() + 1,
    time.getUTCDate(),
    time.getUTCHours(),
    time.getUTCMinutes(),
    time.getUTCSeconds(),
    ignition ? 1 : 0,
  ]);
  return encodeFrame(Gt06Protocol.OBD, Buffer.concat([head, Buffer.from(pairs, 'latin1'), Buffer.alloc(12)]), serial);
}

export interface AlarmInput {
  fix: Gt06Fix;
  lbs: Gt06Lbs;
  status: Gt06TerminalStatus;
  alarm: number;
  lang?: number;
  clockOffsetMinutes?: number;
}

export function encodeAlarm(input: AlarmInput, serial: number, protocol: number = Gt06Protocol.ALARM_EXT): Buffer {
  const fourG = protocol === Gt06Protocol.ALARM_4G;
  const status = Buffer.alloc(5);
  status[0] = terminalInfoByte(input.status);
  status[1] = input.status.voltageLevel ?? 0;
  status[2] = input.status.gsmSignal;
  status[3] = input.alarm;
  status[4] = input.lang ?? 0x02;
  const lbs = writeLbs(input.lbs, fourG);
  const content = Buffer.concat([writeFix(input.fix, input.clockOffsetMinutes), Buffer.from([lbs.length]), lbs, status]);
  return encodeFrame(protocol, content, serial);
}

// Re-exported for tests that build custom content.
export { LBS_LENGTH as GT06_LBS_LENGTH };
