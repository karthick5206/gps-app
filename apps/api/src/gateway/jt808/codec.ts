/**
 * JT/T 808 (2011/2013 and 2019) framing and message codec — dashcams / MDVRs (Mettax MC202, Jimi JC4xx) and many
 * Chinese trackers. Spec summary: docs/09-video-telematics-dashcam.md §2.
 *
 *   0x7E | header | body | XOR checksum | 0x7E      (0x7E ↔ 7D 02, 0x7D ↔ 7D 01 inside the frame)
 *   header 2013: msgId(2) props(2) phone BCD[6]  serial(2) [pkgTotal(2) pkgIndex(2) when bit 13]
 *   header 2019: msgId(2) props(2) version(1) phone BCD[10] serial(2) [...]   (props bit 14 = 1)
 */

export const JT808_MAX_FRAME_BYTES = 4096;

export const Jt808Msg = {
  TERMINAL_RESPONSE: 0x0001,
  HEARTBEAT: 0x0002,
  LOGOUT: 0x0003,
  REGISTER: 0x0100,
  AUTH: 0x0102,
  PARAMS_RESPONSE: 0x0104,
  ATTRIBUTES_RESPONSE: 0x0107,
  LOCATION: 0x0200,
  LOCATION_RESPONSE: 0x0201,
  BATCH: 0x0704,
  TRANSPARENT: 0x0900,
  PLATFORM_RESPONSE: 0x8001,
  REGISTER_RESPONSE: 0x8100,
  TEXT: 0x8300,
} as const;

export class Jt808DecodeError extends Error {}

export interface Jt808Header {
  msgId: number;
  bodyLength: number;
  encrypted: boolean;
  subpackage: boolean;
  version2019: boolean;
  protocolVersion: number | null;
  /** Terminal phone / ID: BCD digits with leading zeros removed. */
  terminalId: string;
  /** Raw BCD bytes (echoed in replies). */
  terminalBcd: Buffer;
  serial: number;
  packageTotal: number | null;
  packageIndex: number | null;
}

export interface Jt808Message {
  header: Jt808Header;
  body: Buffer;
}

// ───────────── framing ─────────────

export function unescape808(buf: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x7d && i + 1 < buf.length) {
      const n = buf[++i];
      if (n === 0x02) out.push(0x7e);
      else if (n === 0x01) out.push(0x7d);
      else out.push(b, n);
    } else out.push(b);
  }
  return Buffer.from(out);
}

export function escape808(buf: Buffer): Buffer {
  const out: number[] = [];
  for (const b of buf) {
    if (b === 0x7e) out.push(0x7d, 0x02);
    else if (b === 0x7d) out.push(0x7d, 0x01);
    else out.push(b);
  }
  return Buffer.from(out);
}

const xor = (buf: Buffer, from = 0, to = buf.length) => {
  let c = 0;
  for (let i = from; i < to; i++) c ^= buf[i];
  return c;
};

/** Splits the stream on 0x7E delimiters; returns un-escaped frames (header..checksum, delimiters removed). */
export function split808(buf: Buffer, maxFrameBytes = JT808_MAX_FRAME_BYTES): { frames: Buffer[]; rest: Buffer; dropped: number } {
  const frames: Buffer[] = [];
  let dropped = 0;
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf(0x7e, i);
    if (start < 0) {
      if (buf.length - i > 0) dropped++;
      i = buf.length;
      break;
    }
    if (start > i) dropped++;
    const end = buf.indexOf(0x7e, start + 1);
    if (end < 0) {
      // Incomplete: keep from the opening delimiter, unless it is already absurdly long.
      if (buf.length - start > maxFrameBytes * 2) {
        dropped++;
        i = buf.length;
      } else i = start;
      break;
    }
    if (end === start + 1) {
      // "7E 7E": the second one opens the next frame (devices sometimes send back-to-back delimiters).
      i = start + 1;
      continue;
    }
    frames.push(unescape808(buf.subarray(start + 1, end)));
    i = end + 1;
  }
  return { frames, rest: buf.subarray(i), dropped };
}

// ───────────── header / body ─────────────

const bcdDigits = (b: Buffer) => [...b].map((x) => (x >> 4).toString(16) + (x & 0x0f).toString(16)).join('');

export function decodeMessage(frame: Buffer): Jt808Message {
  if (frame.length < 13) throw new Jt808DecodeError(`frame too short (${frame.length} bytes)`);
  const check = frame[frame.length - 1];
  if (xor(frame, 0, frame.length - 1) !== check) throw new Jt808DecodeError('bad checksum');
  const msgId = frame.readUInt16BE(0);
  const props = frame.readUInt16BE(2);
  const bodyLength = props & 0x03ff;
  const encrypted = ((props >> 10) & 0x07) !== 0;
  const subpackage = (props & 0x2000) !== 0;
  const version2019 = (props & 0x4000) !== 0;
  let o = 4;
  let protocolVersion: number | null = null;
  if (version2019) protocolVersion = frame[o++];
  const idLen = version2019 ? 10 : 6;
  const terminalBcd = Buffer.from(frame.subarray(o, o + idLen));
  o += idLen;
  const serial = frame.readUInt16BE(o);
  o += 2;
  let packageTotal: number | null = null;
  let packageIndex: number | null = null;
  if (subpackage) {
    packageTotal = frame.readUInt16BE(o);
    packageIndex = frame.readUInt16BE(o + 2);
    o += 4;
  }
  const body = frame.subarray(o, frame.length - 1);
  if (body.length !== bodyLength) throw new Jt808DecodeError(`body length ${body.length} ≠ declared ${bodyLength}`);
  const terminalId = bcdDigits(terminalBcd).replace(/^0+(?=\d)/, '');
  return {
    header: { msgId, bodyLength, encrypted, subpackage, version2019, protocolVersion, terminalId, terminalBcd, serial, packageTotal, packageIndex },
    body,
  };
}

/** Builds an escaped, delimited frame from the platform to the terminal (echoes the terminal's header format). */
export function encodeMessage(msgId: number, header: Pick<Jt808Header, 'terminalBcd' | 'version2019' | 'protocolVersion'>, serial: number, body: Buffer): Buffer {
  const head = Buffer.alloc(header.version2019 ? 17 : 12);
  head.writeUInt16BE(msgId, 0);
  head.writeUInt16BE((body.length & 0x03ff) | (header.version2019 ? 0x4000 : 0), 2);
  let o = 4;
  if (header.version2019) head[o++] = header.protocolVersion ?? 1;
  header.terminalBcd.copy(head, o);
  o += header.terminalBcd.length;
  head.writeUInt16BE(serial & 0xffff, o);
  const raw = Buffer.concat([head, body]);
  return Buffer.concat([Buffer.from([0x7e]), escape808(Buffer.concat([raw, Buffer.from([xor(raw)])])), Buffer.from([0x7e])]);
}

/** 0x8001 platform general response. result: 0 ok, 1 failed, 2 wrong message, 3 not supported, 4 alarm confirmed. */
export function platformResponse(h: Jt808Header, serial: number, result = 0): Buffer {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(h.serial, 0);
  body.writeUInt16BE(h.msgId, 2);
  body[4] = result;
  return encodeMessage(Jt808Msg.PLATFORM_RESPONSE, h, serial, body);
}

/** 0x8100 registration response with an auth code the terminal sends back in 0x0102. */
export function registerResponse(h: Jt808Header, serial: number, authCode: string, result = 0): Buffer {
  const body = Buffer.concat([Buffer.from([h.serial >> 8, h.serial & 0xff, result]), result === 0 ? Buffer.from(authCode, 'ascii') : Buffer.alloc(0)]);
  return encodeMessage(Jt808Msg.REGISTER_RESPONSE, h, serial, body);
}

// ───────────── location (0x0200 / 0x0201 / 0x0704) ─────────────

export interface Jt808Adas {
  alarmId: number;
  flag: number;
  type: number;
  level: number;
  frontSpeed: number;
  frontDistance: number;
  deviation: number;
  speed: number;
  attachments: number;
  /** Alarm identification number (last 16 bytes), echoed in 0x9208 to fetch the attachments. */
  ident: Buffer;
}
export interface Jt808Dms {
  alarmId: number;
  flag: number;
  type: number;
  level: number;
  fatigue: number;
  speed: number;
  attachments: number;
  /** Alarm identification number (last 16 bytes), echoed in 0x9208 to fetch the attachments. */
  ident: Buffer;
}

export interface Jt808Location {
  alarmFlags: number;
  status: number;
  lat: number;
  lng: number;
  altitude: number;
  speedKph: number;
  course: number;
  /** Device clock as written (YYMMDDhhmmss), interpreted as UTC; the decoder applies the device zone. */
  time: Date;
  extras: Map<number, Buffer>;
  mileageKm: number | null;
  fuelL: number | null;
  gsmCsq: number | null;
  satellites: number | null;
  adas: Jt808Adas | null;
  dms: Jt808Dms | null;
}

const bcd = (b: number) => (b >> 4) * 10 + (b & 0x0f);

export function parseBcdTime(b: Buffer): Date {
  return new Date(Date.UTC(2000 + bcd(b[0]), bcd(b[1]) - 1, bcd(b[2]), bcd(b[3]), bcd(b[4]), bcd(b[5])));
}

/** ADAS (0x64) / DMS (0x65), Su-standard layout; alarm identification number (16) ends with attachment count. */
function parseAdas(v: Buffer): Jt808Adas | null {
  if (v.length < 47) return null;
  return {
    alarmId: v.readUInt32BE(0),
    flag: v[4],
    type: v[5],
    level: v[6],
    frontSpeed: v[7],
    frontDistance: v[8],
    deviation: v[9],
    speed: v[12],
    attachments: v[v.length - 2],
    ident: Buffer.from(v.subarray(v.length - 16)),
  };
}
function parseDms(v: Buffer): Jt808Dms | null {
  if (v.length < 47) return null;
  return { alarmId: v.readUInt32BE(0), flag: v[4], type: v[5], level: v[6], fatigue: v[7], speed: v[12], attachments: v[v.length - 2], ident: Buffer.from(v.subarray(v.length - 16)) };
}

export function parseLocation(b: Buffer): Jt808Location {
  if (b.length < 28) throw new Jt808DecodeError(`location body too short (${b.length})`);
  const status = b.readUInt32BE(4);
  let lat = b.readUInt32BE(8) / 1e6;
  let lng = b.readUInt32BE(12) / 1e6;
  if (status & 0x04) lat = -lat;
  if (status & 0x08) lng = -lng;
  const extras = new Map<number, Buffer>();
  let o = 28;
  while (o + 2 <= b.length) {
    const id = b[o];
    const len = b[o + 1];
    if (o + 2 + len > b.length) break;
    extras.set(id, b.subarray(o + 2, o + 2 + len));
    o += 2 + len;
  }
  const u = (id: number, size: 1 | 2 | 4) => {
    const v = extras.get(id);
    if (!v || v.length < size) return null;
    return size === 1 ? v[0] : size === 2 ? v.readUInt16BE(0) : v.readUInt32BE(0);
  };
  const mileage = u(0x01, 4);
  const fuel = u(0x02, 2);
  return {
    alarmFlags: b.readUInt32BE(0),
    status,
    lat,
    lng,
    altitude: b.readInt16BE(16),
    speedKph: b.readUInt16BE(18) / 10,
    course: b.readUInt16BE(20),
    time: parseBcdTime(b.subarray(22, 28)),
    extras,
    mileageKm: mileage === null ? null : mileage / 10,
    fuelL: fuel === null ? null : fuel / 10,
    gsmCsq: u(0x30, 1),
    satellites: u(0x31, 1),
    adas: extras.has(0x64) ? parseAdas(extras.get(0x64)!) : null,
    dms: extras.has(0x65) ? parseDms(extras.get(0x65)!) : null,
  };
}

/** 0x0704 batch upload: count(2) type(1: 0 normal, 1 blind-area/history) [len(2) location]… */
export function parseBatch(b: Buffer): { history: boolean; items: Jt808Location[] } {
  if (b.length < 3) throw new Jt808DecodeError('batch body too short');
  const count = b.readUInt16BE(0);
  const history = b[2] === 1;
  const items: Jt808Location[] = [];
  let o = 3;
  for (let k = 0; k < count && o + 2 <= b.length; k++) {
    const len = b.readUInt16BE(o);
    o += 2;
    if (o + len > b.length) break;
    items.push(parseLocation(b.subarray(o, o + len)));
    o += len;
  }
  return { history, items };
}

/** 0x0001 terminal general response to our commands: reply serial(2) reply msgId(2) result(1). */
export function parseTerminalResponse(b: Buffer): { serial: number; msgId: number; result: number } | null {
  if (b.length < 5) return null;
  return { serial: b.readUInt16BE(0), msgId: b.readUInt16BE(2), result: b[4] };
}
