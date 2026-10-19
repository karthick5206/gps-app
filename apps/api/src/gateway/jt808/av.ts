/**
 * JT/T 1078-2016 audio/video signalling carried over the JT/T 808 connection (bodies only; framing in codec.ts).
 *   0x9101 real-time AV request        → 0x0001        0x9102 real-time AV control → 0x0001
 *   0x9205 query resource list         → 0x1205        0x9201 remote playback       → 0x1205
 *   0x9202 playback control            → 0x0001        0x9003 query AV attributes   → 0x1003
 */

export const AvMsg = {
  QUERY_ATTRIBUTES: 0x9003,
  ATTRIBUTES: 0x1003,
  LIVE_REQUEST: 0x9101,
  LIVE_CONTROL: 0x9102,
  PLAYBACK_REQUEST: 0x9201,
  PLAYBACK_CONTROL: 0x9202,
  QUERY_RESOURCES: 0x9205,
  RESOURCE_LIST: 0x1205,
} as const;

export const LiveControl = { CLOSE: 0, SWITCH_STREAM: 1, PAUSE: 2, RESUME: 3, CLOSE_TALK: 4 } as const;
export const PlaybackControl = { START: 0, PAUSE: 1, STOP: 2, FAST_FORWARD: 3, REWIND: 4, SEEK: 5, KEYFRAME_PLAY: 6 } as const;

const toBcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | n % 10;

/** Device-local BCD[6] YYMMDDhhmmss for a UTC instant and the device clock zone (minutes east of UTC); null → zeros. */
export function bcdTime(at: Date | null, zoneMinutes: number): Buffer {
  if (!at) return Buffer.alloc(6);
  const d = new Date(at.getTime() + zoneMinutes * 60_000);
  return Buffer.from([d.getUTCFullYear() % 100, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(toBcd));
}

const fromBcd = (b: number) => (b >> 4) * 10 + (b & 0x0f);

/** Device-local BCD[6] → UTC instant (null for all-zero times). */
export function parseBcd(b: Buffer, zoneMinutes: number): Date | null {
  if (b.every((x) => x === 0)) return null;
  const local = Date.UTC(2000 + fromBcd(b[0]), fromBcd(b[1]) - 1, fromBcd(b[2]), fromBcd(b[3]), fromBcd(b[4]), fromBcd(b[5]));
  return new Date(local - zoneMinutes * 60_000);
}

function serverAddress(host: string, tcpPort: number, udpPort: number): Buffer {
  const ip = Buffer.from(host, 'ascii');
  const b = Buffer.alloc(1 + ip.length + 4);
  b[0] = ip.length;
  ip.copy(b, 1);
  b.writeUInt16BE(tcpPort, 1 + ip.length);
  b.writeUInt16BE(udpPort, 3 + ip.length);
  return b;
}

export interface LiveRequest {
  host: string;
  tcpPort: number;
  channel: number;
  /** 0 audio+video, 1 video, 2 two-way talk, 3 listen, 4 broadcast, 5 transparent. */
  dataType?: number;
  stream: 'main' | 'sub';
}

/** 0x9101: IP len, IP, TCP port, UDP port (0), channel, data type, stream type (0 main, 1 sub). */
export function encodeLiveRequest(r: LiveRequest): Buffer {
  return Buffer.concat([serverAddress(r.host, r.tcpPort, 0), Buffer.from([r.channel, r.dataType ?? 1, r.stream === 'main' ? 0 : 1])]);
}

/** 0x9102: channel, control command, close type (0 all, 1 audio, 2 video), switch stream type (0 main, 1 sub). */
export function encodeLiveControl(channel: number, command: number, closeType = 0, stream: 'main' | 'sub' = 'sub'): Buffer {
  return Buffer.from([channel, command, closeType, stream === 'main' ? 0 : 1]);
}

export interface ResourceQuery {
  /** 0 = all channels. */
  channel: number;
  start: Date | null;
  end: Date | null;
  /** Device clock zone, minutes east of UTC. */
  zone: number;
  /** 0 AV, 1 audio, 2 video, 3 audio or video. */
  avType?: number;
  /** 0 all, 1 main, 2 sub. */
  streamType?: number;
  /** 0 all, 1 main storage, 2 disaster backup. */
  storageType?: number;
}

/** 0x9205: channel, start BCD[6], end BCD[6], alarm flags (8, 0 = any), AV type, stream type, storage type. */
export function encodeResourceQuery(q: ResourceQuery): Buffer {
  return Buffer.concat([
    Buffer.from([q.channel]),
    bcdTime(q.start, q.zone),
    bcdTime(q.end, q.zone),
    Buffer.alloc(8),
    Buffer.from([q.avType ?? 3, q.streamType ?? 0, q.storageType ?? 0]),
  ]);
}

export interface PlaybackRequest {
  host: string;
  tcpPort: number;
  channel: number;
  start: Date;
  end: Date | null;
  zone: number;
  /** 0 AV, 1 audio, 2 video, 3 video or AV. */
  avType?: number;
  /** 0 main or sub, 1 main, 2 sub. */
  streamType?: number;
  /** 0 all, 1 main, 2 backup. */
  storageType?: number;
  /** 0 normal, 1 fast forward, 2 keyframe rewind, 3 keyframe play, 4 single frame. */
  mode?: number;
  /** 0 n/a, 1..5 = 1x, 2x, 4x, 8x, 16x. */
  speed?: number;
}

/** 0x9201: IP len, IP, TCP, UDP, channel, AV type, stream type, storage, playback mode, speed, start, end. */
export function encodePlaybackRequest(r: PlaybackRequest): Buffer {
  return Buffer.concat([
    serverAddress(r.host, r.tcpPort, 0),
    Buffer.from([r.channel, r.avType ?? 2, r.streamType ?? 0, r.storageType ?? 0, r.mode ?? 0, r.speed ?? 0]),
    bcdTime(r.start, r.zone),
    bcdTime(r.end, r.zone),
  ]);
}

/** 0x9202: channel, control, speed, seek position BCD[6]. */
export function encodePlaybackControl(channel: number, control: number, speed = 0, seek: Date | null = null, zone = 0): Buffer {
  return Buffer.concat([Buffer.from([channel, control, speed]), bcdTime(seek, zone)]);
}

export interface ResourceItem {
  channel: number;
  start: Date | null;
  end: Date | null;
  /** 64-bit alarm flags as hex (bits 0–31 = JT808 alarms, 32–63 = video alarms). */
  alarmFlags: string;
  /** 0 AV, 1 audio, 2 video. */
  avType: number;
  /** 1 main, 2 sub. */
  streamType: number;
  /** 1 main storage, 2 disaster backup. */
  storageType: number;
  sizeBytes: number;
}

export const RESOURCE_ITEM_BYTES = 28;

/** 0x1205: reply serial WORD, total DWORD, then 28-byte items. Truncated trailing items are ignored. */
export function parseResourceList(b: Buffer, zone: number): { serial: number; total: number; items: ResourceItem[] } | null {
  if (b.length < 6) return null;
  const serial = b.readUInt16BE(0);
  const total = b.readUInt32BE(2);
  const items: ResourceItem[] = [];
  for (let o = 6; o + RESOURCE_ITEM_BYTES <= b.length && items.length < total; o += RESOURCE_ITEM_BYTES) {
    items.push({
      channel: b[o],
      start: parseBcd(b.subarray(o + 1, o + 7), zone),
      end: parseBcd(b.subarray(o + 7, o + 13), zone),
      alarmFlags: b.subarray(o + 13, o + 21).toString('hex'),
      avType: b[o + 21],
      streamType: b[o + 22],
      storageType: b[o + 23],
      sizeBytes: b.readUInt32BE(o + 24),
    });
  }
  return { serial, total, items };
}

export interface AvAttributes {
  audioCodec: number;
  audioChannels: number;
  audioSampleRate: number;
  audioSampleBits: number;
  audioFrameLength: number;
  audioOutput: boolean;
  /** JT/T 1078 table 12: 98 H.264, 99 H.265. */
  videoCodec: number;
  maxAudioChannels: number;
  maxVideoChannels: number;
}

/** 0x1003 terminal AV attributes (10 bytes). */
export function parseAvAttributes(b: Buffer): AvAttributes | null {
  if (b.length < 10) return null;
  return {
    audioCodec: b[0],
    audioChannels: b[1],
    audioSampleRate: b[2],
    audioSampleBits: b[3],
    audioFrameLength: b.readUInt16BE(4),
    audioOutput: b[6] === 1,
    videoCodec: b[7],
    maxAudioChannels: b[8],
    maxVideoChannels: b[9],
  };
}
