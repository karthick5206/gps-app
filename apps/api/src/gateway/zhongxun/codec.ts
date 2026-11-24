/**
 * Zhongxun locator protocol (blue ID card trackers, e.g. OEM "AC10" sold with the 365GPS platform), V1.1–V1.3.
 *
 * Frames look like Concox (`78 78 … 0D 0A`) but carry NO serial number and NO checksum, and the third byte is often not
 * a length (0x17 / 0x18 / 0x69: number of Wi-Fi hotspots; replies use 00). `0D 0A` may also occur inside the data
 * (e.g. in a date), so each packet's length comes from its documented structure, not from a terminator search.
 */

export const ZX_STOP = [0x0d, 0x0a] as const;

export const ZhongxunProtocol = {
  LOGIN: 0x01,
  HEARTBEAT: 0x08,
  GPS: 0x10,
  GPS_OFFLINE: 0x11,
  STATUS: 0x13,
  SLEEP: 0x14,
  FACTORY_RESET: 0x15,
  WIFI_LBS_OFFLINE: 0x17,
  WIFI_LBS_4G: 0x18,
  WIFI_LBS_4G_OFFLINE: 0x19,
  WIFI_LBS_4G_SPECIAL: 0x1a,
  WIFI_LBS_4G_SPECIAL_OFFLINE: 0x1b,
  TIME: 0x30,
  CALL_SOS: 0x41,
  CALL_DAD: 0x42,
  CALL_MOM: 0x43,
  STEPS: 0x54,
  WEAR: 0x56,
  SYNC_SETTINGS: 0x57,
  SYNC_WHITELIST: 0x58,
  RECORDING: 0x64,
  RECOVER_PASSWORD: 0x67,
  WIFI_LBS: 0x69,
  ATTENDANCE: 0x72,
  LOCATE: 0x80,
  CHARGE_DONE: 0x81,
  CHARGE_ON: 0x82,
  CHARGE_OFF: 0x83,
  OVERSPEED: 0x86,
  VIBRATION: 0x94,
  INTERVAL_SET: 0x97,
  INTERVAL_SYNC: 0x98,
  SOS: 0x99,
  ICCID: 0xb3,
} as const;

/** Wi-Fi / cell packets: Wi-Fi count in byte 2, date, n × 7-byte hotspots, cells (5-byte 2G or 9-byte 4G), optional alarm. */
const WIFI_LBS: Record<number, number> = { 0x17: 5, 0x69: 5, 0x18: 9, 0x19: 9, 0x1a: 9, 0x1b: 9 };

/** Content length (bytes after the protocol number, before 0D 0A) of fixed-layout device packets; null = variable. */
function fixedContentLength(proto: number, b2: number): number | null {
  switch (proto) {
    case ZhongxunProtocol.LOGIN:
      return 9; // IMEI(8, BCD) · software version(1)
    case ZhongxunProtocol.GPS:
    case ZhongxunProtocol.GPS_OFFLINE:
      return b2 >= 0x15 ? 21 : 18; // date(6) gps(1) lat(4) lng(4) speed(1) course(2) [altitude(2) alarm(1), V1.2]
    case ZhongxunProtocol.HEARTBEAT:
    case ZhongxunProtocol.SLEEP:
    case ZhongxunProtocol.FACTORY_RESET:
    case ZhongxunProtocol.TIME:
    case ZhongxunProtocol.SYNC_SETTINGS:
    case ZhongxunProtocol.SYNC_WHITELIST:
    case ZhongxunProtocol.CHARGE_ON:
    case ZhongxunProtocol.CHARGE_OFF:
    case ZhongxunProtocol.VIBRATION:
    case ZhongxunProtocol.SOS:
      return 0;
    case ZhongxunProtocol.CHARGE_DONE:
      return 0; // 7878 02 81 0D0A = low battery (byte 2 only), still no content
    case ZhongxunProtocol.CALL_SOS:
    case ZhongxunProtocol.CALL_DAD:
    case ZhongxunProtocol.CALL_MOM:
    case ZhongxunProtocol.WEAR:
    case ZhongxunProtocol.RECOVER_PASSWORD:
    case ZhongxunProtocol.ATTENDANCE:
    case ZhongxunProtocol.LOCATE:
    case ZhongxunProtocol.OVERSPEED:
      return 1;
    case ZhongxunProtocol.INTERVAL_SYNC:
      return 2;
    case ZhongxunProtocol.STEPS:
      return 7;
    case ZhongxunProtocol.ICCID:
      return 20;
    default:
      return null;
  }
}

/** Length of a Wi-Fi / cell packet's content from its counts, or null when the buffer is still too short to tell. */
function wifiLbsLength(buf: Buffer, at: number, cellLen: number): number | null {
  const wifi = buf[at + 2];
  let i = at + 4 + 6 + wifi * 7; // header(4) · date(6) · hotspots
  if (buf.length < i + 1) return null;
  const cells = buf[i];
  i += 1 + 3 + cells * cellLen; // count · MCC(2) MNC(1) · cells
  return i - (at + 4);
}

const isStop = (buf: Buffer, i: number) => buf[i] === ZX_STOP[0] && buf[i + 1] === ZX_STOP[1];
const isStart = (buf: Buffer, i: number) => buf[i] === 0x78 && buf[i + 1] === 0x78;

export interface ZxFrames {
  frames: Buffer[];
  rest: Buffer;
  dropped: number;
}

export const ZX_MAX_FRAME_BYTES = 1024;

/** Splits the byte stream into frames (start, byte 2, protocol, content, 0D 0A), keeping a partial tail. */
export function splitZhongxun(buf: Buffer, maxFrameBytes = ZX_MAX_FRAME_BYTES): ZxFrames {
  const frames: Buffer[] = [];
  let dropped = 0;
  let i = 0;
  while (i < buf.length) {
    if (!isStart(buf, i)) {
      let next = -1;
      for (let j = i + 1; j < buf.length - 1; j++) if (isStart(buf, j)) { next = j; break; }
      if (next < 0) {
        const keep = buf[buf.length - 1] === 0x78 ? 1 : 0;
        if (buf.length - i > keep) dropped++;
        return { frames, rest: buf.subarray(buf.length - keep), dropped };
      }
      dropped++;
      i = next;
    }
    if (buf.length - i < 4) break;
    const b2 = buf[i + 2];
    const proto = buf[i + 3];
    let len: number | null = fixedContentLength(proto, b2);
    if (len === null && WIFI_LBS[proto]) {
      len = wifiLbsLength(buf, i, WIFI_LBS[proto]);
      if (len === null) break; // need more bytes
      // V1.2 adds one alarm byte before 0D 0A.
      if (buf.length >= i + 4 + len + 2 && !isStop(buf, i + 4 + len) && isStop(buf, i + 4 + len + 1)) len += 1;
    }
    if (len === null && proto === ZhongxunProtocol.STATUS) {
      // Status: byte 2 is content+1 on newer firmware (0x09 → 8 bytes) and content+2 on the first (0x06 → 4 bytes).
      for (const guess of [b2 - 1, b2 - 2]) {
        if (guess >= 4 && buf.length >= i + 4 + guess + 2 && isStop(buf, i + 4 + guess)) { len = guess; break; }
      }
      if (len === null && buf.length < i + 4 + b2 + 1) break; // wait for more bytes
    }
    if (len === null) {
      // Unknown / variable packet: the first 0D 0A that ends the buffer or is followed by a new frame.
      let end = -1;
      for (let j = i + 4; j < Math.min(buf.length - 1, i + maxFrameBytes); j++) {
        if (isStop(buf, j) && (j + 2 === buf.length || isStart(buf, j + 2))) { end = j; break; }
      }
      if (end < 0) {
        if (buf.length - i >= maxFrameBytes) { dropped++; i += 2; continue; }
        break;
      }
      len = end - (i + 4);
    }
    const total = 4 + len + 2;
    if (total > maxFrameBytes) { dropped++; i += 2; continue; }
    if (buf.length - i < total) break;
    if (!isStop(buf, i + 4 + len)) {
      // Layout did not match (firmware variant): resync on the next start marker.
      dropped++;
      i += 2;
      continue;
    }
    frames.push(buf.subarray(i, i + total));
    i += total;
  }
  return { frames, rest: buf.subarray(i), dropped };
}

export interface ZxFix {
  time: Date;
  /** `time` as ISO text, built from the packet bytes without a Date round trip (hot path). */
  iso: string;
  satellites: number;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  positioned: boolean;
}

const COORD_SCALE = 1_800_000;

/** date(6, hex, UTC) · gps length/satellites(1) · lat(4) · lng(4) · speed(1) · status/course(2), as in GT06. */
export function readZxFix(c: Buffer, at = 0): ZxFix {
  const time = new Date(Date.UTC(2000 + c[at], c[at + 1] - 1, c[at + 2], c[at + 3], c[at + 4], c[at + 5]));
  const iso = zxIso(c, at) ?? (Number.isNaN(time.getTime()) ? new Date(0).toISOString() : time.toISOString());
  const status = c.readUInt16BE(at + 16);
  const north = (status & 0x0400) !== 0;
  const west = (status & 0x0800) !== 0;
  return {
    time,
    iso,
    satellites: c[at + 6] & 0x0f,
    lat: (c.readUInt32BE(at + 7) / COORD_SCALE) * (north ? 1 : -1),
    lng: (c.readUInt32BE(at + 11) / COORD_SCALE) * (west ? -1 : 1),
    speedKph: c[at + 15],
    course: status & 0x03ff,
    positioned: (status & 0x1000) !== 0,
  };
}

const two = (n: number) => (n < 10 ? '0' + n : String(n));
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** ISO text of a packet date (YY MM DD hh mm ss, UTC) when every field is in range; null → let Date normalise it. */
export function zxIso(c: Buffer, at = 0): string | null {
  const y = c[at], mo = c[at + 1], d = c[at + 2], h = c[at + 3], mi = c[at + 4], s = c[at + 5];
  if (y > 99 || mo < 1 || mo > 12 || d < 1 || d > DAYS[mo - 1] || h > 23 || mi > 59 || s > 59) return null;
  if (mo === 2 && d === 29 && y % 4 !== 0) return null;
  return `20${two(y)}-${two(mo)}-${two(d)}T${two(h)}:${two(mi)}:${two(s)}.000Z`;
}

/** Alarm byte of V1.2 GPS / Wi-Fi packets → normalised alarm (first set bit that is an alarm). */
export function zxAlarm(flags: number): { alarm: string | null; event: string | null } {
  if (flags & 0x02) return { alarm: 'overspeed', event: null };
  if (flags & 0x10) return { alarm: 'lowBattery', event: null };
  if (flags & 0x01) return { alarm: 'vibration', event: null };
  if (flags & 0x04) return { alarm: null, event: 'wifiAttendanceIn' };
  if (flags & 0x08) return { alarm: null, event: 'wifiAttendanceOut' };
  return { alarm: null, event: null };
}

/** `78 78 <b2> <proto> <content> 0D 0A`. */
export function zxFrame(proto: number, content: Buffer = Buffer.alloc(0), b2 = content.length + 1): Buffer {
  return Buffer.concat([Buffer.from([0x78, 0x78, b2 & 0xff, proto]), content, Buffer.from(ZX_STOP)]);
}

/** Reply to GPS / Wi-Fi packets: `78 78 00 <proto> <date(6) as sent> 0D 0A` (one allocation, sent for every fix). */
export function zxDateReply(proto: number, date: Buffer): Buffer {
  const n = Math.min(6, date.length);
  const out = Buffer.allocUnsafe(6 + n);
  out[0] = 0x78;
  out[1] = 0x78;
  out[2] = 0x00;
  out[3] = proto;
  date.copy(out, 4, 0, n);
  out[4 + n] = 0x0d;
  out[5 + n] = 0x0a;
  return out;
}

/** Time sync reply (0x30): year(2) month day hour minute second, hex, UTC. */
export function zxTimeReply(now: Date): Buffer {
  const c = Buffer.alloc(7);
  c.writeUInt16BE(now.getUTCFullYear(), 0);
  c[2] = now.getUTCMonth() + 1;
  c[3] = now.getUTCDate();
  c[4] = now.getUTCHours();
  c[5] = now.getUTCMinutes();
  c[6] = now.getUTCSeconds();
  return zxFrame(ZhongxunProtocol.TIME, c, 0x07);
}

/**
 * Server commands (text → frame): LOCATE (0x80 instant GPS / Wi-Fi / cell update), RESTART / SHUTDOWN (0x48),
 * INTERVAL,<seconds 10–7200> (0x97), FIND,ON|OFF (0x49 buzzer), SOSNUM,<number> (0x41); `#<hex>` sends raw bytes.
 */
export function zxCommand(text: string): Buffer | null {
  const t = text.trim();
  if (/^#[0-9a-f]+$/i.test(t) && t.length % 2 === 1) return Buffer.from(t.slice(1), 'hex');
  const [name, arg] = t.toUpperCase().split(',').map((s) => s.trim());
  switch (name) {
    case 'LOCATE':
      return zxFrame(ZhongxunProtocol.LOCATE, Buffer.alloc(0), 0x01);
    case 'RESTART':
      return zxFrame(0x48, Buffer.from([0x01]));
    case 'SHUTDOWN':
      return zxFrame(0x48, Buffer.from([0x02]));
    case 'FIND':
      return zxFrame(0x49, Buffer.from([arg === 'OFF' ? 0x00 : 0x01]));
    case 'INTERVAL': {
      const s = Number(arg);
      if (!Number.isInteger(s) || s < 10 || s > 7200) return null;
      const c = Buffer.alloc(2);
      c.writeUInt16BE(s, 0);
      return zxFrame(ZhongxunProtocol.INTERVAL_SET, c);
    }
    case 'SOSNUM': {
      const num = text.split(',')[1]?.trim() ?? '';
      if (!/^\+?\d{5,15}$/.test(num)) return null;
      return zxFrame(ZhongxunProtocol.CALL_SOS, Buffer.from(num, 'ascii'));
    }
    default:
      return null;
  }
}
