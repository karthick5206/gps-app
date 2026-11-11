/**
 * One simulated GT06 (Concox) device connection: login, heartbeats, reconnect on drop, GPS packets.
 * Same packets as gt06-sim.ts (login with time zone, 0x22 / 0xA0 GPS with the device clock in local time).
 */
import { connect, Socket } from 'node:net';
import {
  decodeFrames,
  encodeGps22,
  encodeGpsA0,
  encodeHeartbeat,
  encodeHeartbeat23,
  encodeInfoVoltage,
  encodeLogin,
  frameProtocol,
  Gt06Fix,
  Gt06Protocol,
  timeZoneWord,
} from '../gateway/gt06/codec';

export type Gt06Variant = 'gt06' | 'gt06-4g';

export interface Gt06LinkOptions {
  host: string;
  port: number;
  protocol: Gt06Variant;
  /** Device time zone, minutes east of UTC (Concox devices stamp fixes in local time). */
  tzMinutes: number;
  heartbeatMs?: number;
  reconnectMs?: number;
  onReady?: () => void;
  onClose?: () => void;
}

export interface LinkFix {
  time: Date;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
}

export class Gt06Link {
  ready = false;
  reconnects = 0;
  private socket: Socket | null = null;
  private rest: Buffer = Buffer.alloc(0);
  private serial = 0;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly lbs: { mcc: number; mnc: number; lac: number; cellId: number };

  constructor(
    readonly imei: string,
    private readonly opts: Gt06LinkOptions,
  ) {
    const n = Number(imei.slice(-6));
    this.lbs = opts.protocol === 'gt06-4g' ? { mcc: 405, mnc: 857, lac: 10_000 + (n % 80_000), cellId: 100_000_000 + n } : { mcc: 404, mnc: 45, lac: 1000 + (n % 8000), cellId: 10_000 + n };
  }

  connect(): void {
    if (this.stopped) return;
    const socket = connect({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(encodeLogin(this.imei, this.nextSerial(), 0x3612, timeZoneWord(this.opts.tzMinutes))));
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.ready = false;
      this.socket = null;
      this.rest = Buffer.alloc(0);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.stopped) return;
      this.reconnects++;
      this.opts.onClose?.();
      setTimeout(() => this.connect(), this.opts.reconnectMs ?? 3000);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.end();
    setTimeout(() => this.socket?.destroy(), 500).unref();
  }

  /** Sends one GPS packet; false when not logged in. */
  sendFix(fix: LinkFix, ignition = true): boolean {
    if (!this.ready || !this.socket) return false;
    const gt06: Gt06Fix = { ...fix, gpsInfoLength: 12, satellites: 10, positioned: true };
    const input = { fix: gt06, lbs: this.lbs, acc: ignition, clockOffsetMinutes: this.opts.tzMinutes };
    this.socket.write(this.opts.protocol === 'gt06-4g' ? encodeGpsA0(input, this.nextSerial()) : encodeGps22(input, this.nextSerial()));
    return true;
  }

  private sendHeartbeat(): void {
    if (!this.ready || !this.socket) return;
    const status = { ignition: true, charging: true, oilCut: false, voltageLevel: 5, gsmSignal: 4 };
    if (this.opts.protocol === 'gt06-4g') {
      this.socket.write(encodeHeartbeat23(status, 13.9, this.nextSerial()));
      this.socket.write(encodeInfoVoltage(13.9, this.nextSerial()));
    } else {
      this.socket.write(encodeHeartbeat(status, this.nextSerial()));
    }
  }

  private onData(chunk: Buffer): void {
    const { frames, rest } = decodeFrames(this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk);
    this.rest = Buffer.from(rest);
    for (const frame of frames) {
      if (frameProtocol(frame) !== Gt06Protocol.LOGIN || this.ready) continue;
      this.ready = true;
      this.heartbeat = setInterval(() => this.sendHeartbeat(), this.opts.heartbeatMs ?? 180_000);
      this.sendHeartbeat();
      this.opts.onReady?.();
    }
  }

  private nextSerial(): number {
    this.serial = (this.serial + 1) & 0xffff;
    return this.serial;
  }
}
