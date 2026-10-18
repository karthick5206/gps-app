/**
 * Teltonika (FMB/FMC/FMM/FMT…) TCP protocol: IMEI handshake, AVL data packets with Codec 8, 8 Extended and 16, and
 * Codec 12 command responses. Pure splitting, decoding and encoding (encoders serve tests and the simulator).
 *
 * IMEI handshake : 00 0F | 15 ASCII digits                → server replies 01 (accept) / 00 (reject)
 * AVL packet     : 00000000 | data length(4) | codec | n1(1) | records | n2(1) | CRC-16/IBM(4)
 *                  → server replies with the number of accepted records as a 4-byte integer.
 */

export const TeltonikaCodec = {
  CODEC_8: 0x08,
  CODEC_8E: 0x8e,
  CODEC_12: 0x0c,
  CODEC_16: 0x10,
} as const;

/** Largest packet we accept (Teltonika's TCP packets stay well below this). */
export const TELTONIKA_MAX_FRAME_BYTES = 16 * 1024;

export class TeltonikaDecodeError extends Error {}

/** CRC-16/IBM (ARC): poly 0xA001 reflected, init 0x0000. */
export function crc16Ibm(buf: Buffer, start = 0, end = buf.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

export interface TeltonikaIo {
  id: number;
  /** Fixed-size values (1/2/4/8 bytes) as numbers (8-byte values may lose precision above 2^53); NX values as Buffer. */
  value: number | Buffer;
  /** Byte size of the value (1, 2, 4, 8, or the NX length). */
  size: number;
}

export interface TeltonikaRecord {
  timestamp: Date;
  priority: number;
  lng: number;
  lat: number;
  altitude: number;
  angle: number;
  satellites: number;
  speedKph: number;
  eventIoId: number;
  /** Codec 16 generation type (null for other codecs). */
  generationType: number | null;
  io: TeltonikaIo[];
}

export type TeltonikaFrame =
  | { type: 'imei'; imei: string }
  | { type: 'avl'; codec: number; records: TeltonikaRecord[] }
  | { type: 'response'; codec: number; text: string }
  | { type: 'unknown'; codec: number };

export interface TeltonikaSplit {
  frames: Buffer[];
  rest: Buffer;
  dropped: number;
  fatal?: string;
}

/** Split the handshake (when `identified` is false) or AVL packets from a byte stream. */
export function splitTeltonika(buf: Buffer, identified: boolean, maxFrameBytes = TELTONIKA_MAX_FRAME_BYTES): TeltonikaSplit {
  const frames: Buffer[] = [];
  let i = 0;
  let dropped = 0;
  if (!identified) {
    if (buf.length < 2) return { frames, rest: buf, dropped };
    const len = buf.readUInt16BE(0);
    if (len < 8 || len > 20) return { frames, rest: Buffer.alloc(0), dropped: 1, fatal: 'expected Teltonika IMEI handshake' };
    if (buf.length < 2 + len) return { frames, rest: buf, dropped };
    frames.push(buf.subarray(0, 2 + len));
    i = 2 + len;
  }
  while (i < buf.length) {
    if (buf.length - i < 8) break;
    if (buf.readUInt32BE(i) !== 0) {
      // Resync on the next zero preamble.
      let next = -1;
      for (let j = i + 1; j + 4 <= buf.length; j++) {
        if (buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 0 && buf[j + 3] === 0) {
          next = j;
          break;
        }
      }
      dropped++;
      if (next < 0) return { frames, rest: Buffer.alloc(0), dropped };
      i = next;
      continue;
    }
    const dataLength = buf.readUInt32BE(i + 4);
    const total = 8 + dataLength + 4;
    if (dataLength < 3 || total > maxFrameBytes) {
      dropped++;
      i += 1;
      continue;
    }
    if (buf.length - i < total) break;
    frames.push(buf.subarray(i, i + total));
    i += total;
  }
  return { frames, rest: buf.subarray(i), dropped };
}

class Reader {
  constructor(
    private readonly b: Buffer,
    public at: number,
    private readonly end: number,
  ) {}
  private need(n: number) {
    if (this.at + n > this.end) throw new TeltonikaDecodeError(`record truncated at byte ${this.at}`);
  }
  u8() {
    this.need(1);
    return this.b[this.at++];
  }
  u16() {
    this.need(2);
    const v = this.b.readUInt16BE(this.at);
    this.at += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.b.readUInt32BE(this.at);
    this.at += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.b.readInt32BE(this.at);
    this.at += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.b.readBigUInt64BE(this.at);
    this.at += 8;
    return v;
  }
  bytes(n: number) {
    this.need(n);
    const v = Buffer.from(this.b.subarray(this.at, this.at + n));
    this.at += n;
    return v;
  }
}

function readRecord(r: Reader, codec: number): TeltonikaRecord {
  const timestamp = new Date(Number(r.u64()));
  const priority = r.u8();
  const lng = r.i32() / 1e7;
  const lat = r.i32() / 1e7;
  const altitude = r.u16();
  const angle = r.u16();
  const satellites = r.u8();
  const speedKph = r.u16();
  const ext = codec === TeltonikaCodec.CODEC_8E;
  const wideIds = ext || codec === TeltonikaCodec.CODEC_16;
  const eventIoId = wideIds ? r.u16() : r.u8();
  const generationType = codec === TeltonikaCodec.CODEC_16 ? r.u8() : null;
  if (ext) r.u16();
  else r.u8(); // total IO count (redundant)
  const io: TeltonikaIo[] = [];
  for (const size of [1, 2, 4, 8]) {
    const count = ext ? r.u16() : r.u8();
    for (let k = 0; k < count; k++) {
      const id = wideIds ? r.u16() : r.u8();
      let value: number;
      if (size === 1) value = r.u8();
      else if (size === 2) value = r.u16();
      else if (size === 4) value = r.u32();
      else value = Number(r.u64());
      io.push({ id, value, size });
    }
  }
  if (ext) {
    const count = r.u16();
    for (let k = 0; k < count; k++) {
      const id = r.u16();
      const length = r.u16();
      io.push({ id, value: r.bytes(length), size: length });
    }
  }
  return { timestamp, priority, lng, lat, altitude, angle, satellites, speedKph, eventIoId, generationType, io };
}

/** Decode one frame from `splitTeltonika` (`identified` = the handshake was already received). */
export function decodeTeltonika(frame: Buffer, identified: boolean): TeltonikaFrame {
  if (!identified) {
    const imei = frame.subarray(2).toString('ascii');
    if (!/^\d{8,20}$/.test(imei)) throw new TeltonikaDecodeError(`invalid IMEI handshake "${imei}"`);
    return { type: 'imei', imei };
  }
  const dataLength = frame.readUInt32BE(4);
  const dataEnd = 8 + dataLength;
  const expectedCrc = frame.readUInt32BE(dataEnd) & 0xffff;
  const crc = crc16Ibm(frame, 8, dataEnd);
  if (crc !== expectedCrc) throw new TeltonikaDecodeError(`CRC mismatch (got ${crc.toString(16)}, packet says ${expectedCrc.toString(16)})`);
  const codec = frame[8];
  const n1 = frame[9];
  if (frame[dataEnd - 1] !== n1) throw new TeltonikaDecodeError(`record counts differ (${n1} vs ${frame[dataEnd - 1]})`);
  if (codec === TeltonikaCodec.CODEC_12) {
    // type(1) · size(4) · text
    const type = frame[10];
    const size = frame.readUInt32BE(11);
    const text = frame.subarray(15, Math.min(15 + size, dataEnd - 1)).toString('latin1');
    return type === 0x06 ? { type: 'response', codec, text } : { type: 'unknown', codec };
  }
  if (codec !== TeltonikaCodec.CODEC_8 && codec !== TeltonikaCodec.CODEC_8E && codec !== TeltonikaCodec.CODEC_16) return { type: 'unknown', codec };
  const r = new Reader(frame, 10, dataEnd - 1);
  const records: TeltonikaRecord[] = [];
  for (let k = 0; k < n1; k++) records.push(readRecord(r, codec));
  return { type: 'avl', codec, records };
}

/** Server reply accepting `count` records. */
export function encodeRecordAck(count: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(count >>> 0, 0);
  return b;
}

// ---------------------------------------------------------------------------
// Encoders (tests and the simulator)
// ---------------------------------------------------------------------------

export function encodeImei(imei: string): Buffer {
  const b = Buffer.alloc(2 + imei.length);
  b.writeUInt16BE(imei.length, 0);
  b.write(imei, 2, 'ascii');
  return b;
}

export interface TeltonikaRecordInput {
  timestamp: Date;
  priority?: number;
  lat: number;
  lng: number;
  altitude?: number;
  angle?: number;
  satellites?: number;
  speedKph?: number;
  eventIoId?: number;
  /** id → value; value byte size picked from `sizes` (default: 1 byte for ids < 2^8 values, else 2/4/8 by magnitude). */
  io?: Record<number, number>;
  sizes?: Record<number, 1 | 2 | 4 | 8>;
  /** Codec 8E variable-length values. */
  nx?: Record<number, Buffer>;
}

function sizeFor(value: number): 1 | 2 | 4 | 8 {
  if (value >= 0 && value <= 0xff) return 1;
  if (value >= 0 && value <= 0xffff) return 2;
  if (value >= 0 && value <= 0xffffffff) return 4;
  return 8;
}

function writeRecord(rec: TeltonikaRecordInput, codec: number): Buffer {
  const ext = codec === TeltonikaCodec.CODEC_8E;
  const parts: Buffer[] = [];
  const head = Buffer.alloc(24);
  head.writeBigUInt64BE(BigInt(rec.timestamp.getTime()), 0);
  head[8] = rec.priority ?? 0;
  head.writeInt32BE(Math.round(rec.lng * 1e7), 9);
  head.writeInt32BE(Math.round(rec.lat * 1e7), 13);
  head.writeUInt16BE(rec.altitude ?? 0, 17);
  head.writeUInt16BE(rec.angle ?? 0, 19);
  head[21] = rec.satellites ?? 0;
  head.writeUInt16BE(rec.speedKph ?? 0, 22);
  parts.push(head);
  const io = Object.entries(rec.io ?? {}).map(([id, value]) => ({ id: Number(id), value, size: rec.sizes?.[Number(id)] ?? sizeFor(value) }));
  const nx = Object.entries(rec.nx ?? {}).map(([id, value]) => ({ id: Number(id), value }));
  const num = (v: number, wide: boolean) => {
    const b = Buffer.alloc(wide ? 2 : 1);
    if (wide) b.writeUInt16BE(v, 0);
    else b[0] = v;
    return b;
  };
  parts.push(num(rec.eventIoId ?? 0, ext), num(io.length + nx.length, ext));
  for (const size of [1, 2, 4, 8] as const) {
    const group = io.filter((x) => x.size === size);
    parts.push(num(group.length, ext));
    for (const x of group) {
      parts.push(num(x.id, ext));
      const v = Buffer.alloc(size);
      if (size === 1) v[0] = x.value;
      else if (size === 2) v.writeUInt16BE(x.value, 0);
      else if (size === 4) v.writeUInt32BE(x.value >>> 0, 0);
      else v.writeBigUInt64BE(BigInt(x.value), 0);
      parts.push(v);
    }
  }
  if (ext) {
    parts.push(num(nx.length, true));
    for (const x of nx) parts.push(num(x.id, true), num(x.value.length, true), x.value);
  }
  return Buffer.concat(parts);
}

export function encodeAvlPacket(records: TeltonikaRecordInput[], codec: number = TeltonikaCodec.CODEC_8): Buffer {
  const data = Buffer.concat([Buffer.from([codec, records.length]), ...records.map((r) => writeRecord(r, codec)), Buffer.from([records.length])]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc16Ibm(data), 8 + data.length);
  return out;
}

/** Codec 12 frame: server → device command (type 0x05) or device → server response (type 0x06). */
export function encodeCodec12(text: string, type: 0x05 | 0x06 = 0x05): Buffer {
  const ascii = Buffer.from(text, 'latin1');
  const data = Buffer.alloc(1 + 1 + 1 + 4 + ascii.length + 1);
  data[0] = TeltonikaCodec.CODEC_12;
  data[1] = 1;
  data[2] = type;
  data.writeUInt32BE(ascii.length, 3);
  ascii.copy(data, 7);
  data[7 + ascii.length] = 1;
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc16Ibm(data), 8 + data.length);
  return out;
}
