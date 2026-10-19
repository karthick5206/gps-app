/**
 * AIS-140 (ARAI, India) text protocol over TCP, as sent by iTriangle TS101 Basic/Advanced and other VLT units:
 *   $<header>,<vendor>,<firmware>,<packetType>,<alertId>,<L|H>,<IMEI>,<vehicleRegNo>,<fix>,<ddmmyyyy>,<hhmmss>,
 *    <lat>,<N|S>,<lng>,<E|W>,<speed>,<heading>,<sats>,<altitude>,<pdop>,<hdop>,<operator>,<ignition>,<mainPower>,
 *    <mainVoltage>,<batteryVoltage>,<emergency>,<tamper C|O>,<gsm>,<mcc>,<mnc>,<lac>,<cellId>,<neighbour cells…>,
 *    <digitalInputs 4 bits>,<digitalOutputs 2 bits>,<frameNo>,…*<checksum>
 * plus login ($LGN…), health ($…HP / HMP) and emergency ($EPB,EMR,…) messages.
 *
 * Implemented from the public AIS-140 specification (and Traccar's public ItsProtocolDecoder as a cross-check), NOT a
 * vendor document: field layouts must be verified with a real device capture (GATEWAY_CAPTURE=<imei>). Parsing is
 * anchored on the `L|H` flag followed by the 15-digit IMEI, so vendor variations in the header part (missing alert id,
 * extra header fields) and in the neighbour-cell block still decode; anything else is reported as unparsed.
 */

import { SplitResult } from '../protocol';

export const AIS140_MAX_FRAME_BYTES = 2048;

/** Known vendor variants. `loginAck` / `ack` are written back when set (most AIS-140 units need no reply). */
export interface Ais140Variant {
  id: string;
  match: (vendor: string, header: string) => boolean;
  loginAck: string | null;
  ack: string | null;
}

export const AIS140_VARIANTS: Ais140Variant[] = [
  // iTriangle TS101: same field order as the ARAI table; no ACK required (per public material, verify on a device).
  { id: 'itriangle', match: (vendor) => /itriangle|^itl/i.test(vendor), loginAck: null, ack: null },
  { id: 'ais140', match: () => true, loginAck: null, ack: null },
];

export function variantFor(vendor: string, header: string): Ais140Variant {
  return AIS140_VARIANTS.find((v) => v.match(vendor, header))!;
}

/** Packet-type codes (AIS-140 alert packets) → normalised alarm, or an event name for non-alarm state changes. */
export const AIS140_TYPE_ALARMS: Record<string, { alarm?: string; event?: string }> = {
  NR: {},
  EA: { alarm: 'sos' },
  TA: { alarm: 'tamper' },
  BD: { alarm: 'powerCut' },
  BR: { event: 'powerRestored' },
  BL: { alarm: 'lowBattery' },
  HB: { alarm: 'harshBraking' },
  HA: { alarm: 'harshAcceleration' },
  RT: { alarm: 'harshCornering' },
  OS: { alarm: 'overspeed' },
  IN: { event: 'ignitionOn' },
  IF: { event: 'ignitionOff' },
  WD: { alarm: 'tamper', event: 'emergencyWireDisconnect' },
};

/** Numeric alert IDs (AIS-140 alert table) → normalised alarm / event; used when the packet type is not decisive. */
export const AIS140_ALERT_IDS: Record<number, { alarm?: string; event?: string }> = {
  1: {},
  2: {},
  3: { alarm: 'powerCut' },
  4: { alarm: 'lowBattery' },
  5: { event: 'lowBatteryRemoved' },
  6: { event: 'powerRestored' },
  7: { event: 'ignitionOn' },
  8: { event: 'ignitionOff' },
  9: { alarm: 'tamper' },
  10: { alarm: 'sos' },
  11: { event: 'sosOff' },
  12: { event: 'otaParameterChange' },
  13: { alarm: 'harshBraking' },
  14: { alarm: 'harshAcceleration' },
  15: { alarm: 'harshCornering' },
  16: { alarm: 'tamper', event: 'emergencyWireDisconnect' },
  // 17 = overspeed on most VLT firmware (less certain than 1–16).
  17: { alarm: 'overspeed' },
};

/** XOR of the bytes between `$` (exclusive) and `*` (exclusive), as two upper-case hex digits. */
export function xorChecksum(body: string): string {
  let x = 0;
  for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
  return x.toString(16).toUpperCase().padStart(2, '0');
}

const DOLLAR = 0x24;
const STAR = 0x2a;
const isHex = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
const isEol = (b: number) => b === 0x0d || b === 0x0a;

/**
 * Split `$…*[checksum]` packets out of the stream. Bytes before a `$` are dropped. A packet whose `*` is the last
 * byte(s) of the chunk may still be followed by checksum digits, so it stays pending until a terminator (CR/LF, the
 * next `$`, or a 4th hex digit) arrives or `flush` runs after a short silence.
 */
export function splitAis140(buf: Buffer, maxFrameBytes = AIS140_MAX_FRAME_BYTES, final = false): SplitResult {
  const frames: Buffer[] = [];
  let dropped = 0;
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf(DOLLAR, i);
    if (start < 0) {
      if (buf.subarray(i).some((b) => !isEol(b))) dropped++;
      return { frames, rest: Buffer.alloc(0), dropped };
    }
    if (buf.subarray(i, start).some((b) => !isEol(b))) dropped++;
    i = start;
    let star = -1;
    for (let j = start + 1; j < buf.length; j++) {
      if (buf[j] === STAR) {
        star = j;
        break;
      }
      if (buf[j] === DOLLAR) break; // a new packet started: the previous one had no terminator
    }
    if (star < 0) {
      const next = buf.indexOf(DOLLAR, start + 1);
      if (next > 0) {
        dropped++;
        i = next;
        continue;
      }
      if (buf.length - start > maxFrameBytes) return { frames, rest: Buffer.alloc(0), dropped: dropped + 1 };
      break;
    }
    let end = star + 1;
    while (end < buf.length && end - star <= 4 && isHex(buf[end])) end++;
    const terminated = end < buf.length || final || end - star > 4;
    if (!terminated) break;
    frames.push(buf.subarray(start, end));
    while (end < buf.length && isEol(buf[end])) end++;
    i = end;
  }
  return { frames, rest: buf.subarray(i), dropped };
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

export class Ais140DecodeError extends Error {}

export interface Ais140Location {
  type: 'location';
  header: string;
  vendor: string;
  firmware: string;
  packetType: string;
  alertId: number | null;
  history: boolean;
  imei: string;
  vehicleRegNo: string | null;
  valid: boolean;
  time: Date;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  satellites: number | null;
  altitude: number | null;
  pdop: number | null;
  hdop: number | null;
  operator: string | null;
  ignition: boolean | null;
  mainPower: boolean | null;
  extVoltage: number | null;
  batteryVoltage: number | null;
  emergency: boolean | null;
  tamperOpen: boolean | null;
  csq: number | null;
  mcc: number | null;
  mnc: number | null;
  lac: number | null;
  cellId: number | null;
  digitalInputs: string | null;
  digitalOutputs: string | null;
  frameNo: number | null;
}

export type Ais140Message =
  | Ais140Location
  | { type: 'login'; header: string; imei: string; vehicleRegNo: string | null; firmware: string | null; protocolVersion: string | null }
  | {
      type: 'health';
      header: string;
      vendor: string;
      firmware: string;
      imei: string;
      batteryLevel: number | null;
      lowBatteryThreshold: number | null;
      memoryPct: number | null;
      intervalIgnOn: number | null;
      intervalIgnOff: number | null;
      digitalInputs: string | null;
      analogInput: number | null;
    }
  | {
      type: 'emergency';
      imei: string;
      /** NM = emergency active, SP = stopped (per spec). */
      state: string;
      time: Date;
      valid: boolean;
      lat: number;
      lng: number;
      altitude: number | null;
      speedKph: number;
      vehicleRegNo: string | null;
      replyNumber: string | null;
    };

export interface ParsedFrame {
  /** Text between `$` and `*`. */
  body: string;
  /** Checksum digits after `*` ('' when absent). */
  checksum: string;
  fields: string[];
}

/** Split a frame into fields; validates a 2-digit XOR checksum when present (other lengths are vendor-specific). */
export function parseFrame(frame: Buffer): ParsedFrame {
  const text = frame.toString('latin1');
  const star = text.lastIndexOf('*');
  if (text[0] !== '$' || star < 0) throw new Ais140DecodeError('not a $…* packet');
  const body = text.slice(1, star);
  const checksum = text.slice(star + 1).trim();
  // Vendors differ on whether the `$` is included in the XOR: accept either.
  const cs = checksum.toUpperCase();
  if (checksum.length === 2 && xorChecksum(body) !== cs && xorChecksum(`$${body}`) !== cs) {
    throw new Ais140DecodeError(`checksum mismatch (got ${checksum}, expected ${xorChecksum(body)})`);
  }
  // A trailing empty field before `*` (`…,000146,*`) is common.
  const fields = body.split(',').map((f) => f.trim());
  if (fields.length && fields[fields.length - 1] === '') fields.pop();
  return { body, checksum, fields };
}

const IMEI_RE = /^\d{15}$/;
const num = (s: string | undefined): number | null => {
  if (s === undefined || s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};
const hexNum = (s: string | undefined): number | null => (s && /^[0-9A-Fa-f]{1,8}$/.test(s) ? parseInt(s, 16) : null);
const bit = (s: string | undefined): boolean | null => (s === '1' ? true : s === '0' ? false : null);

/** Decimal degrees; values beyond ±90/±180 are NMEA ddmm.mmmm (some firmware). */
export function coordinate(value: string, hemisphere: string, isLat: boolean): number {
  let v = Number(value);
  if (!Number.isFinite(v)) throw new Ais140DecodeError(`bad coordinate ${value}`);
  if (v > (isLat ? 90 : 180)) {
    const deg = Math.floor(v / 100);
    v = deg + (v - deg * 100) / 60;
  }
  const negative = /^[SW]$/i.test(hemisphere);
  return Math.round((negative ? -v : v) * 1e6) / 1e6;
}

/** ddmmyyyy (or ddmmyy) + hhmmss, UTC per the AIS-140 spec. */
export function utcTime(date: string, time: string): Date {
  const m = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(date);
  const t = /^(\d{2})(\d{2})(\d{2})/.exec(time);
  if (!m || !t) throw new Ais140DecodeError(`bad date/time ${date} ${time}`);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), Number(t[1]), Number(t[2]), Number(t[3])));
  if (Number.isNaN(d.getTime()) || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Ais140DecodeError(`bad date ${date}`);
  return d;
}

/** Decode the fields of one packet. Throws Ais140DecodeError for anything that doesn't match a known layout. */
export function decodeAis140(fields: string[]): Ais140Message {
  const header = fields[0] ?? '';
  if (/^EPB$/i.test(header) || fields[1] === 'EMR') return decodeEmergency(fields);
  const anchor = fields.findIndex((f, i) => (f === 'L' || f === 'H') && IMEI_RE.test(fields[i + 1] ?? ''));
  if (anchor >= 0) return decodeLocation(fields, anchor);
  if (/LGN|LOGIN|^LG$/i.test(header)) return decodeLogin(fields);
  if (/HP|HMP|HEALTH|HLT/i.test(header) || fields.some((f) => /^(HP|HMP)$/i.test(f))) return decodeHealth(fields);
  throw new Ais140DecodeError(`unknown packet ${header}`);
}

function decodeLocation(f: string[], anchor: number): Ais140Location {
  // Before the L/H flag: [header, vendor, firmware, packetType, alertId] (alert id optional on some firmware).
  const before = f.slice(1, anchor);
  let alertId: number | null = null;
  if (before.length && /^\d{1,3}$/.test(before[before.length - 1])) alertId = Number(before.pop());
  const packetType = before.length && /^[A-Z]{2}$/i.test(before[before.length - 1]) ? before.pop()!.toUpperCase() : 'NR';
  const vendor = before[0] ?? '';
  const firmware = before[1] ?? '';
  const imeiAt = anchor + 1;
  // Vehicle registration number is optional on some firmware: detect by where the ddmmyyyy date sits.
  const hasReg = /^\d{6}(\d{2})?$/.test(f[imeiAt + 3] ?? '') && /^[01AV]$/i.test(f[imeiAt + 2] ?? '');
  const b = hasReg ? imeiAt + 2 : imeiAt + 1; // index of the GPS fix field
  if (f.length < b + 8) throw new Ais140DecodeError(`location packet too short (${f.length} fields)`);
  const fix = f[b].toUpperCase();
  const at = (k: number) => f[b + k];
  const tail = f.slice(b + 25);
  // Neighbour cells vary (3 or 4 × 3 fields, order per vendor): find the 4-bit DI / 2-bit DO pair after them.
  const dio = tail.findIndex((x, i) => /^[01]{4}$/.test(x) && /^[01]{2}$/.test(tail[i + 1] ?? ''));
  return {
    type: 'location',
    header: f[0],
    vendor,
    firmware,
    packetType,
    alertId,
    history: f[anchor] === 'H',
    imei: f[imeiAt],
    vehicleRegNo: hasReg ? f[imeiAt + 1] || null : null,
    valid: fix === '1' || fix === 'A',
    time: utcTime(at(1), at(2)),
    lat: coordinate(at(3), at(4), true),
    lng: coordinate(at(5), at(6), false),
    speedKph: num(at(7)) ?? 0,
    course: num(at(8)) ?? 0,
    satellites: num(at(9)),
    altitude: num(at(10)),
    pdop: num(at(11)),
    hdop: num(at(12)),
    operator: at(13) || null,
    ignition: bit(at(14)),
    mainPower: bit(at(15)),
    extVoltage: num(at(16)),
    batteryVoltage: num(at(17)),
    emergency: bit(at(18)),
    tamperOpen: at(19) === 'O' ? true : at(19) === 'C' ? false : null,
    csq: num(at(20)),
    mcc: num(at(21)),
    mnc: num(at(22)),
    lac: hexNum(at(23)),
    cellId: hexNum(at(24)),
    digitalInputs: dio >= 0 ? tail[dio] : null,
    digitalOutputs: dio >= 0 ? tail[dio + 1] : null,
    frameNo: dio >= 0 ? num(tail[dio + 2]) : null,
  };
}

/** $LGN,<vehicleRegNo>,<IMEI>,<firmware>,<protocolVersion>,<lat>,<N|S>,<lng>,<E|W> (per spec; reg no optional). */
function decodeLogin(f: string[]) {
  const i = f.findIndex((x) => IMEI_RE.test(x));
  if (i < 0) throw new Ais140DecodeError('login without IMEI');
  return {
    type: 'login' as const,
    header: f[0],
    imei: f[i],
    vehicleRegNo: i >= 2 ? f[i - 1] || null : null,
    firmware: f[i + 1] || null,
    protocolVersion: f[i + 2] || null,
  };
}

/** $<header>,<vendor>,<firmware>,<IMEI>,<battery%>,<lowBatThreshold%>,<memory%>,<ignOnRate>,<ignOffRate>,<DI>,<AI> */
function decodeHealth(f: string[]) {
  const i = f.findIndex((x) => IMEI_RE.test(x));
  if (i < 0) throw new Ais140DecodeError('health packet without IMEI');
  return {
    type: 'health' as const,
    header: f[0],
    vendor: f[1] ?? '',
    firmware: f[2] ?? '',
    imei: f[i],
    batteryLevel: num(f[i + 1]),
    lowBatteryThreshold: num(f[i + 2]),
    memoryPct: num(f[i + 3]),
    intervalIgnOn: num(f[i + 4]),
    intervalIgnOff: num(f[i + 5]),
    digitalInputs: f[i + 6] && /^[01]+$/.test(f[i + 6]) ? f[i + 6] : null,
    analogInput: num(f[i + 7]),
  };
}

/** $EPB,EMR,<IMEI>,<NM|SP>,<ddmmyyyyhhmmss>,<A|V>,<lat>,<N|S>,<lng>,<E|W>,<alt>,<speed>,<distance>,<G|N>,<reg>,<reply no> */
function decodeEmergency(f: string[]) {
  const i = f.findIndex((x) => IMEI_RE.test(x));
  if (i < 0 || f.length < i + 10) throw new Ais140DecodeError('emergency packet too short');
  const dt = f[i + 2];
  if (!/^\d{14}$/.test(dt)) throw new Ais140DecodeError(`bad emergency time ${dt}`);
  return {
    type: 'emergency' as const,
    imei: f[i],
    state: f[i + 1].toUpperCase(),
    time: utcTime(dt.slice(0, 8), dt.slice(8)),
    valid: /^A$/i.test(f[i + 3]),
    lat: coordinate(f[i + 4], f[i + 5], true),
    lng: coordinate(f[i + 6], f[i + 7], false),
    altitude: num(f[i + 8]),
    speedKph: num(f[i + 9]) ?? 0,
    vehicleRegNo: f[i + 12] || null,
    replyNumber: f[i + 13] || null,
  };
}
