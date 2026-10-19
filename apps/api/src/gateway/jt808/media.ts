/**
 * JT/T 808 multimedia (snapshots) and the Su-standard (JT/T 1078 extension, "苏标") alarm attachment protocol.
 *   0x8801 camera shoot immediately  → 0x0805 shoot response (multimedia ids) → 0x0800 event info + 0x0801 data
 *   0x0801 multimedia data upload    → 0x8800 multimedia upload response (id + retransmit list)
 *   0x9208 alarm attachment request  → terminal connects to the attachment server:
 *          0x1210 attachment list, 0x1211 file info, raw "01cd" data packets, 0x1212 file done → 0x9212
 */
import { Jt808DecodeError, Jt808Location, parseLocation } from './codec';

export const MediaMsg = {
  MEDIA_EVENT: 0x0800,
  MEDIA_UPLOAD: 0x0801,
  SHOOT_RESPONSE: 0x0805,
  MEDIA_UPLOAD_RESPONSE: 0x8800,
  CAMERA_SHOOT: 0x8801,
  ALARM_ATTACH_REQUEST: 0x9208,
  ATTACH_INFO: 0x1210,
  FILE_INFO: 0x1211,
  FILE_DONE: 0x1212,
  FILE_DONE_RESPONSE: 0x9212,
} as const;

/** Multimedia type (0x0800 / 0x0801). */
export const MediaType = { IMAGE: 0, AUDIO: 1, VIDEO: 2 } as const;
/** Multimedia format: 0 JPEG, 1 TIF, 2 MP3, 3 WAV, 4 WMV. */
export const MEDIA_FORMAT_MIME: Record<number, string> = { 0: 'image/jpeg', 1: 'image/tiff', 2: 'audio/mpeg', 3: 'audio/wav', 4: 'video/x-ms-wmv' };

export interface CameraShoot {
  channel: number;
  /** 0 stop, 0xFFFF record video, n = take n photos. */
  command?: number;
  /** Seconds between photos / video length. */
  interval?: number;
  /** 1 save on the terminal, 0 upload in real time. */
  save?: number;
  /** 0x01 320×240, 0x02 640×480, 0x03 800×600, 0x04 1024×768, 0x05 176×144, 0x06 352×288, 0x07 704×288, 0x08 704×576. */
  resolution?: number;
  /** 1 (best) … 10 (smallest). */
  quality?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  chroma?: number;
}

/** 0x8801 body (12 bytes): channel, command WORD, interval WORD, save flag, resolution, quality, brightness, contrast, saturation, chroma. */
export function encodeCameraShoot(s: CameraShoot): Buffer {
  const b = Buffer.alloc(12);
  b[0] = s.channel & 0xff;
  b.writeUInt16BE((s.command ?? 1) & 0xffff, 1);
  b.writeUInt16BE((s.interval ?? 0) & 0xffff, 3);
  b[5] = s.save ?? 0;
  b[6] = s.resolution ?? 0x02;
  b[7] = s.quality ?? 5;
  b[8] = s.brightness ?? 127;
  b[9] = s.contrast ?? 64;
  b[10] = s.saturation ?? 64;
  b[11] = s.chroma ?? 127;
  return b;
}

/** 0x0805: reply serial WORD, result (0 ok, 1 failed, 2 channel not supported), [count WORD, ids DWORD…]. */
export function parseShootResponse(b: Buffer): { serial: number; result: number; ids: number[] } | null {
  if (b.length < 3) return null;
  const serial = b.readUInt16BE(0);
  const result = b[2];
  const ids: number[] = [];
  if (result === 0 && b.length >= 5) {
    const count = b.readUInt16BE(3);
    for (let k = 0, o = 5; k < count && o + 4 <= b.length; k++, o += 4) ids.push(b.readUInt32BE(o));
  }
  return { serial, result, ids };
}

export interface MediaEventInfo {
  mediaId: number;
  type: number;
  format: number;
  /** 0 platform command, 1 timed, 2 robbery alarm, 3 collision / rollover, 4 door open, 5 door close, 6 door…, 7 distance. */
  eventCode: number;
  channel: number;
}

/** 0x0800: multimedia id DWORD, type, format, event code, channel. */
export function parseMediaEvent(b: Buffer): MediaEventInfo {
  if (b.length < 8) throw new Jt808DecodeError(`multimedia event too short (${b.length})`);
  return { mediaId: b.readUInt32BE(0), type: b[4], format: b[5], eventCode: b[6], channel: b[7] };
}

export interface MediaUpload extends MediaEventInfo {
  location: Jt808Location | null;
  data: Buffer;
}

/** 0x0801: id DWORD, type, format, event, channel, location basic info (28 bytes), then the file bytes. */
export function parseMediaUpload(b: Buffer): MediaUpload {
  if (b.length < 36) throw new Jt808DecodeError(`multimedia upload too short (${b.length})`);
  let location: Jt808Location | null = null;
  try {
    location = parseLocation(b.subarray(8, 36));
  } catch {
    location = null;
  }
  return { ...parseMediaEvent(b), location, data: Buffer.from(b.subarray(36)) };
}

/** 0x8800: multimedia id DWORD, retransmit count BYTE, package ids WORD… (count 0 = all received). */
export function encodeMediaUploadResponse(mediaId: number, retransmit: number[] = []): Buffer {
  const list = retransmit.slice(0, 125);
  const b = Buffer.alloc(5 + list.length * 2);
  b.writeUInt32BE(mediaId >>> 0, 0);
  b[4] = list.length;
  list.forEach((id, i) => b.writeUInt16BE(id & 0xffff, 5 + i * 2));
  return b;
}

// ───────────── Su-standard alarm attachments ─────────────

export const ALARM_IDENT_BYTES = 16;
export const ALARM_NUMBER_BYTES = 32;

export interface AlarmIdent {
  /** Manufacturer terminal id (7 ASCII bytes, trailing zeros removed). */
  terminalId: string;
  /** Alarm time as written (device clock, YYMMDDhhmmss read as UTC); apply the device zone. */
  time: Date | null;
  seq: number;
  attachments: number;
}

const fromBcd = (x: number) => (x >> 4) * 10 + (x & 0x0f);

/** Alarm identification number: terminal id BYTE[7], time BCD[6], sequence, attachment count, reserved. */
export function parseAlarmIdent(b: Buffer): AlarmIdent | null {
  if (b.length < ALARM_IDENT_BYTES) return null;
  const t = b.subarray(7, 13);
  const time = t.every((x) => x === 0)
    ? null
    : new Date(Date.UTC(2000 + fromBcd(t[0]), fromBcd(t[1]) - 1, fromBcd(t[2]), fromBcd(t[3]), fromBcd(t[4]), fromBcd(t[5])));
  return { terminalId: asciiz(b.subarray(0, 7)), time, seq: b[13], attachments: b[14] };
}

const asciiz = (b: Buffer) => b.toString('latin1').replace(/\0+$/, '').trim();

export interface AlarmAttachRequest {
  host: string;
  tcpPort: number;
  udpPort?: number;
  ident: Buffer;
  /** 32 ASCII characters, unique per alarm (the platform's alarm number). */
  alarmNumber: string;
}

/** 0x9208: IP length, IP, TCP port WORD, UDP port WORD, alarm identification [16], alarm number [32], reserved [16]. */
export function encodeAlarmAttachRequest(r: AlarmAttachRequest): Buffer {
  const ip = Buffer.from(r.host, 'ascii');
  const head = Buffer.alloc(1 + ip.length + 4);
  head[0] = ip.length;
  ip.copy(head, 1);
  head.writeUInt16BE(r.tcpPort, 1 + ip.length);
  head.writeUInt16BE(r.udpPort ?? 0, 3 + ip.length);
  const ident = Buffer.alloc(ALARM_IDENT_BYTES);
  r.ident.copy(ident, 0, 0, ALARM_IDENT_BYTES);
  const number = Buffer.alloc(ALARM_NUMBER_BYTES);
  number.write(r.alarmNumber.slice(0, ALARM_NUMBER_BYTES), 'ascii');
  return Buffer.concat([head, ident, number, Buffer.alloc(16)]);
}

/** Attachment file type in 0x1210 / 0x1211 / 0x1212: 0 picture, 1 audio, 2 video, 3 text, 4 other. */
export const AttachFileType = { PICTURE: 0, AUDIO: 1, VIDEO: 2, TEXT: 3, OTHER: 4 } as const;

export interface AttachInfo {
  terminalId: string;
  ident: AlarmIdent | null;
  identRaw: Buffer;
  alarmNumber: string;
  /** 0 normal, 1 supplementary upload. */
  infoType: number;
  files: { name: string; size: number }[];
}

/** 0x1210: terminal id [7], alarm identification [16], alarm number [32], info type, count, [name length, name, size DWORD]…. */
export function parseAttachInfo(b: Buffer): AttachInfo {
  if (b.length < 57) throw new Jt808DecodeError(`attachment info too short (${b.length})`);
  const identRaw = Buffer.from(b.subarray(7, 23));
  const count = b[56];
  const files: { name: string; size: number }[] = [];
  let o = 57;
  for (let k = 0; k < count && o < b.length; k++) {
    const len = b[o];
    if (o + 1 + len + 4 > b.length) break;
    files.push({ name: asciiz(b.subarray(o + 1, o + 1 + len)), size: b.readUInt32BE(o + 1 + len) });
    o += 1 + len + 4;
  }
  return { terminalId: asciiz(b.subarray(0, 7)), ident: parseAlarmIdent(identRaw), identRaw, alarmNumber: asciiz(b.subarray(23, 55)), infoType: b[55], files };
}

export interface AttachFileInfo {
  name: string;
  type: number;
  size: number;
}

/** 0x1211 file info / 0x1212 file upload complete: name length, name, file type, size DWORD. */
export function parseAttachFileInfo(b: Buffer): AttachFileInfo {
  if (b.length < 1 || b.length < 1 + b[0] + 5) throw new Jt808DecodeError(`attachment file info too short (${b.length})`);
  const len = b[0];
  return { name: asciiz(b.subarray(1, 1 + len)), type: b[1 + len], size: b.readUInt32BE(2 + len) };
}

/** 0x9212: name length, name, file type, result (0 complete, 1 retransmit), count, [offset DWORD, length DWORD]…. */
export function encodeFileDoneResponse(file: { name: string; type: number }, missing: { offset: number; length: number }[] = []): Buffer {
  const name = Buffer.from(file.name, 'ascii');
  const list = missing.slice(0, 255);
  const b = Buffer.alloc(1 + name.length + 3 + list.length * 8);
  b[0] = name.length;
  name.copy(b, 1);
  let o = 1 + name.length;
  b[o++] = file.type;
  b[o++] = list.length ? 1 : 0;
  b[o++] = list.length;
  for (const m of list) {
    b.writeUInt32BE(m.offset >>> 0, o);
    b.writeUInt32BE(m.length >>> 0, o + 4);
    o += 8;
  }
  return b;
}

/** Raw file data packet on the attachment connection (not 0x7E-framed). */
export const ATTACH_DATA_MAGIC = 0x30316364; // "01cd"
export const ATTACH_DATA_HEADER_BYTES = 62;

export interface AttachDataPacket {
  name: string;
  offset: number;
  data: Buffer;
}

/**
 * Data packet: magic DWORD 0x30316364, file name [50], offset DWORD, length DWORD, data. Returns null while the buffer
 * holds less than one whole packet; `bytes` = bytes consumed.
 */
export function parseAttachData(b: Buffer, maxLength: number): { packet: AttachDataPacket; bytes: number } | null {
  if (b.length < ATTACH_DATA_HEADER_BYTES) return null;
  if (b.readUInt32BE(0) !== ATTACH_DATA_MAGIC) throw new Jt808DecodeError('not a file data packet');
  const length = b.readUInt32BE(58);
  if (length > maxLength) throw new Jt808DecodeError(`file data packet too large (${length})`);
  if (b.length < ATTACH_DATA_HEADER_BYTES + length) return null;
  return {
    packet: { name: asciiz(b.subarray(4, 54)), offset: b.readUInt32BE(54), data: Buffer.from(b.subarray(62, 62 + length)) },
    bytes: ATTACH_DATA_HEADER_BYTES + length,
  };
}

/** Encodes a data packet (tests / simulators). */
export function encodeAttachData(name: string, offset: number, data: Buffer): Buffer {
  const h = Buffer.alloc(ATTACH_DATA_HEADER_BYTES);
  h.writeUInt32BE(ATTACH_DATA_MAGIC, 0);
  h.write(name.slice(0, 50), 4, 'ascii');
  h.writeUInt32BE(offset >>> 0, 54);
  h.writeUInt32BE(data.length, 58);
  return Buffer.concat([h, data]);
}

/**
 * Su-standard attachment name `<type>_<channel>_<alarm type>_<serial>_<alarm number>.<ext>`, e.g.
 * `00_65_6501_0_ab12….jpg` (type 00 picture, 01 audio, 02 video; channel 0x65 = DMS, 0x64 = ADAS, else camera no.).
 */
export function parseAttachName(name: string): { fileType: number | null; channel: number | null; ext: string } {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const parts = name.split('_');
  const fileType = parts.length >= 2 && /^\d{1,2}$/.test(parts[0]) ? Number(parts[0]) : null;
  const channel = parts.length >= 2 && /^\d{1,3}$/.test(parts[1]) ? Number(parts[1]) : null;
  return { fileType, channel, ext };
}

/** MIME type of a stored attachment from its extension / declared type; null = not kept. */
export function attachMime(ext: string, type: number): string | null {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'avi') return 'video/x-msvideo';
  if (ext === 'h264' || ext === '264') return 'video/h264';
  if (type === AttachFileType.PICTURE) return 'image/jpeg';
  if (type === AttachFileType.VIDEO) return 'video/h264';
  return null;
}
