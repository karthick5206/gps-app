/**
 * JT/T 1078-2016 real-time / playback media stream (table 19), sent by the terminal on its own TCP connection:
 *
 *   0  "01cd" (0x30 0x31 0x63 0x64)
 *   4  V(2) P(1) X(1) CC(4)            usually 0x81
 *   5  M(1) PT(7)                      98 H.264, 99 H.265, 6 G.711A, 7 G.711U, 8 G.726, 26 ADPCM, 19 AAC …
 *   6  packet sequence WORD
 *   8  SIM BCD[6]                      (some 2019 firmware sends BCD[10]; detected per connection)
 *   14 logical channel BYTE
 *   15 data type (high nibble: 0 I, 1 P, 2 B, 3 audio, 4 transparent) | subpackage (low: 0 atomic, 1 first, 2 last, 3 middle)
 *   16 timestamp BYTE[8] (ms)          absent for transparent data
 *   24 last I-frame interval WORD      video only
 *   26 last frame interval WORD        video only
 *   28 body length WORD (≤ 950)
 *   30 body
 */

export const JT1078_MAGIC = 0x30316364;
export const JT1078_MAX_BODY = 950;
/** Some firmware ignores the 950-byte rule; accept up to this before treating the stream as garbage. */
const BODY_HARD_LIMIT = 64 * 1024;

export const Jt1078DataType = { I: 0, P: 1, B: 2, AUDIO: 3, TRANSPARENT: 4 } as const;
export const Jt1078Subpackage = { ATOMIC: 0, FIRST: 1, LAST: 2, MIDDLE: 3 } as const;

export const Jt1078PayloadType = { G711A: 6, G711U: 7, G726: 8, ADPCM: 26, AAC: 19, H264: 98, H265: 99 } as const;

export interface Jt1078Packet {
  marker: boolean;
  payloadType: number;
  sequence: number;
  /** SIM / terminal phone, BCD digits with leading zeros removed (matches the JT808 terminal id). */
  sim: string;
  channel: number;
  dataType: number;
  subpackage: number;
  /** ms; 0 for transparent data. */
  timestamp: number;
  lastIFrameInterval: number | null;
  lastFrameInterval: number | null;
  body: Buffer;
}

export type MediaKind = 'video' | 'audio' | 'data';

export function mediaKind(dataType: number): MediaKind {
  if (dataType <= Jt1078DataType.B) return 'video';
  if (dataType === Jt1078DataType.AUDIO) return 'audio';
  return 'data';
}

const bcdDigits = (b: Buffer) => [...b].map((x) => (x >> 4).toString(16) + (x & 0x0f).toString(16)).join('');

/** Header length before the body for a data type and SIM length. */
function headerLength(dataType: number, simLength: number): number {
  const base = 8 + simLength + 2; // magic..sequence, SIM, channel, data type
  const kind = mediaKind(dataType);
  if (kind === 'data') return base + 2;
  if (kind === 'audio') return base + 8 + 2;
  return base + 8 + 4 + 2;
}

/**
 * Parses one packet at `o`. Returns `null` when more bytes are needed, `'bad'` when the bytes there are not a packet.
 */
export function parsePacketAt(buf: Buffer, o: number, simLength = 6): { packet: Jt1078Packet; next: number } | null | 'bad' {
  if (buf.length - o < 4) return null;
  if (buf.readUInt32BE(o) !== JT1078_MAGIC) return 'bad';
  const minimum = 8 + simLength + 2;
  if (buf.length - o < minimum) return null;
  const typeByte = buf[o + 8 + simLength + 1];
  const dataType = typeByte >> 4;
  const subpackage = typeByte & 0x0f;
  if (dataType > Jt1078DataType.TRANSPARENT || subpackage > Jt1078Subpackage.MIDDLE) return 'bad';
  const head = headerLength(dataType, simLength);
  if (buf.length - o < head) return null;
  const bodyLength = buf.readUInt16BE(o + head - 2);
  if (bodyLength > BODY_HARD_LIMIT) return 'bad';
  if (buf.length - o < head + bodyLength) return null;
  const kind = mediaKind(dataType);
  let p = o + 8 + simLength + 2;
  let timestamp = 0;
  if (kind !== 'data') {
    timestamp = Number(buf.readBigUInt64BE(p));
    p += 8;
  }
  let lastIFrameInterval: number | null = null;
  let lastFrameInterval: number | null = null;
  if (kind === 'video') {
    lastIFrameInterval = buf.readUInt16BE(p);
    lastFrameInterval = buf.readUInt16BE(p + 2);
  }
  const mpt = buf[o + 5];
  return {
    packet: {
      marker: (mpt & 0x80) !== 0,
      payloadType: mpt & 0x7f,
      sequence: buf.readUInt16BE(o + 6),
      sim: bcdDigits(buf.subarray(o + 8, o + 8 + simLength)).replace(/^0+(?=\d)/, ''),
      channel: buf[o + 8 + simLength],
      dataType,
      subpackage,
      timestamp,
      lastIFrameInterval,
      lastFrameInterval,
      body: Buffer.from(buf.subarray(o + head, o + head + bodyLength)),
    },
    next: o + head + bodyLength,
  };
}

/** Picks the SIM length (6 or 10 BCD bytes) whose packet ends exactly at the buffer end or at the next magic. */
function detectSimLength(buf: Buffer, o: number): 6 | 10 | null | 'bad' {
  let pending = false;
  let bad = 0;
  for (const len of [6, 10] as const) {
    const r = parsePacketAt(buf, o, len);
    if (r === null) {
      pending = true;
      continue;
    }
    if (r === 'bad') {
      bad++;
      continue;
    }
    if (r.next === buf.length) return len;
    if (buf.length - r.next >= 4 && buf.readUInt32BE(r.next) === JT1078_MAGIC) return len;
  }
  if (bad === 2) return 'bad';
  return pending ? null : 6;
}

/**
 * Stateful stream splitter for one media connection: buffers partial packets, skips garbage up to the next "01cd",
 * and detects the SIM field length on the first packet.
 */
export class Jt1078Splitter {
  private rest: Buffer = Buffer.alloc(0);
  simLength: 6 | 10 | null = null;
  /** Bytes skipped as garbage (resyncs). */
  dropped = 0;

  constructor(private readonly maxPending = 256 * 1024) {}

  push(chunk: Buffer): Jt1078Packet[] {
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const out: Jt1078Packet[] = [];
    let o = 0;
    while (o < buf.length) {
      if (this.simLength === null) {
        const magicAt = this.resync(buf, o);
        if (magicAt < 0) {
          o = Math.max(o, buf.length - 3);
          break;
        }
        o = magicAt;
        const len = detectSimLength(buf, o);
        if (len === null) break;
        if (len === 'bad') {
          this.dropped++;
          o++;
          continue;
        }
        this.simLength = len;
      }
      const r = parsePacketAt(buf, o, this.simLength);
      if (r === null) break;
      if (r === 'bad') {
        const magicAt = this.resync(buf, o + 1);
        if (magicAt < 0) {
          o = Math.max(o + 1, buf.length - 3);
          break;
        }
        o = magicAt;
        continue;
      }
      out.push(r.packet);
      o = r.next;
    }
    buf = buf.subarray(o);
    if (buf.length > this.maxPending) {
      this.dropped += buf.length;
      buf = Buffer.alloc(0);
    }
    this.rest = Buffer.from(buf);
    return out;
  }

  /** Offset of the next magic at or after `from`, counting skipped bytes; -1 if none. */
  private resync(buf: Buffer, from: number): number {
    const at = buf.indexOf('01cd', from, 'latin1');
    const end = at < 0 ? buf.length - 3 : at;
    if (end > from) this.dropped += end - from;
    return at;
  }
}

export interface Jt1078Frame {
  sim: string;
  channel: number;
  payloadType: number;
  kind: MediaKind;
  dataType: number;
  timestamp: number;
  data: Buffer;
}

/** Joins first / middle / last subpackages into whole frames, per logical channel and media kind. */
export class Jt1078Reassembler {
  private readonly partial = new Map<string, { parts: Buffer[]; size: number; first: Jt1078Packet }>();
  /** Middle / last parts without a first part, or frames over the size limit. */
  discarded = 0;

  constructor(private readonly maxFrameBytes = 2 * 1024 * 1024) {}

  push(p: Jt1078Packet): Jt1078Frame | null {
    const kind = mediaKind(p.dataType);
    const key = `${p.channel}:${kind}`;
    const frame = (first: Jt1078Packet, data: Buffer): Jt1078Frame => ({
      sim: first.sim,
      channel: first.channel,
      payloadType: first.payloadType,
      kind,
      dataType: first.dataType,
      timestamp: first.timestamp,
      data,
    });
    switch (p.subpackage) {
      case Jt1078Subpackage.ATOMIC:
        if (this.partial.delete(key)) this.discarded++;
        return frame(p, p.body);
      case Jt1078Subpackage.FIRST:
        if (this.partial.delete(key)) this.discarded++;
        this.partial.set(key, { parts: [p.body], size: p.body.length, first: p });
        return null;
      default: {
        const entry = this.partial.get(key);
        if (!entry) {
          this.discarded++;
          return null;
        }
        entry.parts.push(p.body);
        entry.size += p.body.length;
        if (entry.size > this.maxFrameBytes) {
          this.partial.delete(key);
          this.discarded++;
          return null;
        }
        if (p.subpackage === Jt1078Subpackage.MIDDLE) return null;
        this.partial.delete(key);
        return frame(entry.first, Buffer.concat(entry.parts, entry.size));
      }
    }
  }
}
