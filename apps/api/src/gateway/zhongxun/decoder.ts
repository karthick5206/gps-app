import { NormalizedPosition } from '@veetracer/shared';
import { compact } from '../attributes';
import { BaseSession, DecodeContext, DecodeResult, emptyResult, ProtocolDecoder, SplitResult } from '../protocol';
import { readZxFix, splitZhongxun, zxAlarm, zxCommand, zxDateReply, ZX_MAX_FRAME_BYTES, ZxFix, zxFrame, ZhongxunProtocol as P, zxTimeReply } from './codec';

export const ZHONGXUN_PROTOCOL = 'zhongxun';

export interface ZhongxunSession extends BaseSession {
  batteryLevel: number | null;
  charging: boolean | null;
  gsmSignal: number | null;
  iccid: string | null;
  /** Device time zone (hours east of UTC) from the status packet. */
  timeZoneHours: number | null;
  lastFix: { lat: number; lng: number; course: number } | null;
  /** Time (ms) of the last event without GPS: each gets a unique time, so its history row is never lost. */
  lastEventMs: number;
}

/**
 * Last GPS fix per card, kept across connections in this gateway process (bounded): an SOS straight after a reconnect
 * (common indoors on a weak network) still carries the real last position instead of 0,0.
 */
const LAST_FIX = new Map<string, { lat: number; lng: number; course: number }>();
const LAST_FIX_MAX = 100_000;
function rememberFix(uniqueId: string, fix: { lat: number; lng: number; course: number }): void {
  LAST_FIX.delete(uniqueId);
  LAST_FIX.set(uniqueId, fix);
  if (LAST_FIX.size > LAST_FIX_MAX) LAST_FIX.delete(LAST_FIX.keys().next().value as string);
}

/** receivedAt as ISO text, memoised: every frame of one TCP chunk shares the same Date. */
let isoDate: Date | null = null;
let isoText = '';
const receivedIso = (d: Date): string => {
  if (d !== isoDate) {
    isoDate = d;
    isoText = d.toISOString();
  }
  return isoText;
};

/** Wi-Fi / cell packets that must be answered with their date (and carry an optional alarm byte). */
const WIFI_LBS = new Set<number>([P.WIFI_LBS, P.WIFI_LBS_OFFLINE, P.WIFI_LBS_4G, P.WIFI_LBS_4G_OFFLINE, P.WIFI_LBS_4G_SPECIAL, P.WIFI_LBS_4G_SPECIAL_OFFLINE]);
const CELL_LEN: Record<number, number> = { 0x17: 5, 0x69: 5, 0x18: 9, 0x19: 9, 0x1a: 9, 0x1b: 9 };

/** Device signal 0–100 → the shared 0–4 scale. */
const signal4 = (v: number) => Math.max(0, Math.min(4, Math.round(v / 25)));

/**
 * Zhongxun blue ID card trackers (own TCP port, ZHONGXUN_PORT 5032). Positions from 0x10 (live) / 0x11 (stored) GPS
 * packets; Wi-Fi / cell packets have no coordinates (no cell location service yet) but carry alarms; SOS 0x99,
 * overspeed 0x86, vibration 0x94, low battery, wear 0x56, charging 0x81–0x83, ICCID 0xB3. Packets 0x01 / 0x10 / 0x11 /
 * 0x13 / 0x17 / 0x69 (and the 4G variants) must be answered or the device reconnects.
 */
export class ZhongxunDecoder implements ProtocolDecoder<ZhongxunSession> {
  readonly name = ZHONGXUN_PROTOCOL;
  readonly maxFrameBytes = ZX_MAX_FRAME_BYTES;

  createSession(): ZhongxunSession {
    return { uniqueId: null, batteryLevel: null, charging: null, gsmSignal: null, iccid: null, timeZoneHours: null, lastFix: null, lastEventMs: 0 };
  }

  split(buf: Buffer): SplitResult {
    return splitZhongxun(buf, this.maxFrameBytes);
  }

  encodeCommand(text: string): Buffer {
    const frame = zxCommand(text);
    if (!frame) throw new Error(`Unsupported command for this ID card: ${text}`);
    return frame;
  }

  decode(frame: Buffer, session: ZhongxunSession, ctx: DecodeContext): DecodeResult {
    const result = emptyResult();
    const b2 = frame[2];
    const proto = frame[3];
    const c = frame.subarray(4, frame.length - 2);
    const event = (extra: Record<string, unknown>) => {
      if (session.uniqueId) result.positions.push(this.eventPosition(session, frame, ctx, extra));
    };

    switch (proto) {
      case P.LOGIN: {
        session.uniqueId = c.subarray(0, 8).toString('hex').replace(/^0/, '');
        session.lastFix = session.lastFix ?? LAST_FIX.get(session.uniqueId) ?? null;
        result.replies.push(zxFrame(P.LOGIN, Buffer.alloc(0), 0x01));
        break;
      }
      case P.HEARTBEAT:
        break;
      case P.GPS:
      case P.GPS_OFFLINE: {
        result.replies.push(zxDateReply(proto, c));
        if (!session.uniqueId || c.length < 18) break;
        const fix = readZxFix(c);
        const ext = c.length >= 21 ? { altitude: c.readUInt16BE(18), ...zxAlarm(c[20]) } : { altitude: null, alarm: null, event: null };
        result.positions.push(
          this.position(session, fix, frame, ctx, proto === P.GPS_OFFLINE, ext.altitude, { alarm: ext.alarm, event: ext.event }),
        );
        break;
      }
      case P.STATUS: {
        // battery % · software version · time zone · status interval (min) · [signal 0–100] · [...]; echoed back.
        result.replies.push(frame);
        if (c.length >= 1) session.batteryLevel = Math.min(100, c[0]);
        if (c.length >= 3) session.timeZoneHours = c[2] > 12 ? c[2] - 256 : c[2];
        if (c.length >= 5 && c.length <= 6) session.gsmSignal = signal4(c[4]);
        if (session.lastFix) event({ event: 'status' });
        break;
      }
      case P.TIME:
        result.replies.push(zxTimeReply(ctx.receivedAt));
        break;
      case P.SOS:
        // No GPS in this packet: raised at the last known fix (the processor falls back to the vehicle's last valid
        // point when even that is missing). Ask the card to locate now, so a fresh fix follows the alert.
        event({ alarm: 'sos', noGpsFix: true });
        result.replies.push(zxFrame(P.LOCATE, Buffer.alloc(0), 0x01));
        break;
      case P.VIBRATION:
        event({ alarm: 'vibration' });
        break;
      case P.OVERSPEED:
        event({ alarm: 'overspeed', overspeedKph: c[0] ?? null });
        break;
      case P.CHARGE_DONE:
        // 7878 01 81 = charging finished; 7878 02 81 = low battery (sent every 12 h).
        if (b2 === 0x02) event({ alarm: 'lowBattery' });
        else {
          session.charging = false;
          event({ event: 'chargeComplete' });
        }
        break;
      case P.CHARGE_ON:
        session.charging = true;
        event({ event: 'chargerConnected' });
        break;
      case P.CHARGE_OFF:
        session.charging = false;
        event({ event: 'chargerDisconnected' });
        break;
      case P.WEAR:
        // 00 = taken off (worn card removed), 01 = worn.
        event(c[0] === 0 ? { alarm: 'tamper', event: 'removed' } : { event: 'worn' });
        break;
      case P.ICCID: {
        const iccid = c.toString('latin1').replace(/[^0-9A-Fa-f]/g, '');
        if (iccid && iccid !== session.iccid) {
          session.iccid = iccid;
          event({ iccid, event: 'sim' });
        }
        break;
      }
      case P.CALL_SOS:
        // The card asks to call its SOS number (long press): an emergency as well, so it raises SOS too (the alert
        // cooldown merges it with a 0x99 sent for the same press).
        event({ alarm: 'sos', event: 'callSos', noGpsFix: true });
        result.replies.push(zxFrame(P.LOCATE, Buffer.alloc(0), 0x01));
        break;
      case P.CALL_DAD:
      case P.CALL_MOM:
        event({ event: proto === P.CALL_DAD ? 'callDad' : 'callMom' });
        break;
      case P.ATTENDANCE:
        event({ event: c[0] === 1 ? 'wifiAttendanceIn' : 'wifiAttendanceOut' });
        break;
      case P.INTERVAL_SYNC:
      case P.RECOVER_PASSWORD:
        result.replies.push(frame);
        break;
      case P.LOCATE:
      case P.SLEEP:
      case P.FACTORY_RESET:
      case P.SYNC_SETTINGS:
      case P.SYNC_WHITELIST:
      case P.STEPS:
      case P.RECORDING:
        break;
      default:
        if (WIFI_LBS.has(proto)) {
          result.replies.push(zxDateReply(proto, c));
          this.wifiLbs(proto, b2, c, session, event);
          break;
        }
        ctx.unparsed(`unknown protocol 0x${proto.toString(16).padStart(2, '0')}`, frame, session.uniqueId);
    }
    return result;
  }

  /** Wi-Fi / cell packet: no coordinates (no cell location yet); the serving cell and an alarm (V1.2) are reported. */
  private wifiLbs(proto: number, wifiCount: number, c: Buffer, session: ZhongxunSession, event: (extra: Record<string, unknown>) => void): void {
    const cellLen = CELL_LEN[proto];
    let i = 6 + wifiCount * 7;
    if (c.length < i + 4) return;
    const cells = c[i];
    const mcc = c.readUInt16BE(i + 1);
    const mnc = c[i + 3];
    i += 4;
    let lac: number | null = null;
    let cellId: number | null = null;
    if (cells > 0 && c.length >= i + cellLen) {
      lac = cellLen === 9 ? c.readUInt32BE(i) : c.readUInt16BE(i);
      cellId = cellLen === 9 ? c.readUInt32BE(i + 4) : c.readUInt16BE(i + 2);
    }
    const alarmAt = i + cells * cellLen;
    const flags = c.length > alarmAt ? c[alarmAt] : 0;
    const a = zxAlarm(flags);
    if ((a.alarm || a.event) && session.uniqueId) event({ alarm: a.alarm, event: a.event, mcc, mnc, lac, cellId, noGpsFix: true });
  }

  private position(session: ZhongxunSession, fix: ZxFix, frame: Buffer, ctx: DecodeContext, reupload: boolean, altitude: number | null, extra: Record<string, unknown>): NormalizedPosition {
    if (fix.positioned) {
      session.lastFix = { lat: fix.lat, lng: fix.lng, course: fix.course };
      rememberFix(session.uniqueId!, session.lastFix);
    }
    return {
      protocol: ZHONGXUN_PROTOCOL,
      uniqueId: session.uniqueId!,
      fixTime: fix.iso,
      receivedAt: receivedIso(ctx.receivedAt),
      lat: fix.lat,
      lng: fix.lng,
      speedKph: fix.speedKph,
      course: fix.course,
      altitude,
      satellites: fix.satellites,
      valid: fix.positioned,
      ignition: null,
      attributes: compact({
        batteryLevel: session.batteryLevel,
        charging: session.charging,
        gsmSignal: session.gsmSignal,
        ...extra,
        ...(reupload ? { reupload: true } : {}),
      }),
      raw: frame.toString('hex'),
    };
  }

  /** Event without GPS: receive time at the last known fix, marked invalid (keeps the map point, carries the alarm). */
  private eventPosition(session: ZhongxunSession, frame: Buffer, ctx: DecodeContext, extra: Record<string, unknown>): NormalizedPosition {
    const last = session.lastFix ?? { lat: 0, lng: 0, course: 0 };
    const ms = Math.max(ctx.receivedAt.getTime(), session.lastEventMs + 1);
    session.lastEventMs = ms;
    const time = new Date(ms);
    const fix: ZxFix = { time, iso: time.toISOString(), satellites: 0, lat: last.lat, lng: last.lng, speedKph: 0, course: last.course, positioned: false };
    return this.position(session, fix, frame, ctx, false, null, extra);
  }
}
