/**
 * Device simulator: N devices over TCP from one process.
 *   npm run sim -- --count 20 --host 127.0.0.1 --port 5023 --interval 10 --imei-start 868120000000001 [--duration 60]
 *     --protocol gt06 (default) | gt06-4g (0xA0/0x23/0x94/0xA4, e.g. V5/VL149) | teltonika (Codec 8, default port 5027)
 *     --tz 330   GT06 device time zone in minutes (fixes are stamped in local time, as Concox devices do)
 */
import { connect, Socket } from 'node:net';
import {
  decodeFrames,
  encodeAlarm,
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
import { encodeAvlPacket, encodeImei } from '../gateway/teltonika/codec';
import { DEFAULT_IMEI_START, imeiAt, numberArg, parseArgs } from './cli-args';
import { VehicleMovement } from './movement';

const TICK_MS = 100;
const HEARTBEAT_MS = 180_000;
const SUMMARY_MS = 10_000;
const SOS_PROBABILITY = 1 / 20_000;

type SimProtocol = 'gt06' | 'gt06-4g' | 'teltonika';
const PROTOCOLS: SimProtocol[] = ['gt06', 'gt06-4g', 'teltonika'];

const args = parseArgs(process.argv.slice(2));
const protocol = (args.get('protocol') ?? 'gt06') as SimProtocol;
if (!PROTOCOLS.includes(protocol)) throw new Error(`--protocol must be one of ${PROTOCOLS.join(', ')}`);
const config = {
  protocol,
  tzMinutes: numberArg(args, 'tz', 330),
  count: numberArg(args, 'count', 20),
  host: args.get('host') ?? '127.0.0.1',
  port: numberArg(args, 'port', protocol === 'teltonika' ? 5027 : 5023),
  intervalMs: numberArg(args, 'interval', 10) * 1000,
  imeiStart: numberArg(args, 'imei-start', DEFAULT_IMEI_START),
  durationMs: numberArg(args, 'duration', 0) * 1000,
};

const stats = { sent: 0, alarms: 0, reconnects: 0, loginAcks: 0 };
const rand = (min: number, max: number) => min + Math.random() * (max - min);

class SimDevice {
  private socket: Socket | null = null;
  private rest: Buffer = Buffer.alloc(0);
  private serial = 0;
  private lastStepAt = Date.now();
  private nextSendAt = 0;
  private nextHeartbeatAt = 0;
  private lastFixSecond = 0;
  private readonly lbs = { mcc: 404, mnc: 45, lac: Math.floor(rand(1000, 9000)), cellId: Math.floor(rand(10_000, 900_000)) };
  private readonly lbs4g = { mcc: 405, mnc: 857, lac: Math.floor(rand(10_000, 90_000)), cellId: Math.floor(rand(1e8, 9e8)) };
  private readonly movement = new VehicleMovement(Date.now());
  ready = false;
  stopped = false;

  constructor(readonly imei: string) {}

  connect(): void {
    if (this.stopped) return;
    const socket = connect({ host: config.host, port: config.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () =>
      socket.write(
        config.protocol === 'teltonika'
          ? encodeImei(this.imei)
          : encodeLogin(this.imei, this.nextSerial(), 0x3612, timeZoneWord(config.tzMinutes)),
      ),
    );
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.ready = false;
      this.socket = null;
      this.rest = Buffer.alloc(0);
      if (this.stopped) return;
      stats.reconnects++;
      setTimeout(() => this.connect(), rand(2000, 5000));
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
  }

  tick(now: number): void {
    if (!this.ready || !this.socket) return;
    if (now >= this.nextHeartbeatAt && config.protocol !== 'teltonika') {
      this.nextHeartbeatAt = now + HEARTBEAT_MS;
      const status = { ignition: this.movement.ignition, charging: true, oilCut: false, voltageLevel: 5, gsmSignal: 4 };
      if (config.protocol === 'gt06-4g') {
        this.socket.write(encodeHeartbeat23(status, this.voltage(), this.nextSerial()));
        this.socket.write(encodeInfoVoltage(this.voltage(), this.nextSerial()));
      } else {
        this.socket.write(encodeHeartbeat(status, this.nextSerial()));
      }
    }
    // Timestamps have 1 s resolution; two fixes in one second would collide on (deviceId, fixTime).
    const second = Math.floor(now / 1000);
    if (now < this.nextSendAt || second === this.lastFixSecond) return;
    this.lastFixSecond = second;
    // Stay on schedule, but never burst to catch up after a stall.
    this.nextSendAt = Math.max(this.nextSendAt + config.intervalMs, now + config.intervalMs / 2);

    this.movement.step(now, (now - this.lastStepAt) / 1000);
    this.lastStepAt = now;
    const m = this.movement;
    const fix: Gt06Fix = {
      time: new Date(second * 1000),
      gpsInfoLength: 12,
      satellites: Math.floor(rand(7, 13)),
      lat: m.lat,
      lng: m.lng,
      speedKph: m.speedKph,
      course: m.course,
      positioned: true,
    };
    const sos = Math.random() < SOS_PROBABILITY;
    if (sos) stats.alarms++;
    this.socket.write(this.packet(fix, m.ignition, sos));
    stats.sent++;
  }

  private voltage(): number {
    return this.movement.ignition ? 13.8 + Math.random() * 0.4 : 12.4 + Math.random() * 0.2;
  }

  private packet(fix: Gt06Fix, ignition: boolean, sos: boolean): Buffer {
    const clockOffsetMinutes = config.tzMinutes;
    const status = { ignition, charging: true, oilCut: false, voltageLevel: 5, gsmSignal: 4 };
    switch (config.protocol) {
      case 'gt06':
        return sos
          ? encodeAlarm({ fix, lbs: this.lbs, status, alarm: 0x01, clockOffsetMinutes }, this.nextSerial())
          : encodeGps22({ fix, lbs: this.lbs, acc: ignition, clockOffsetMinutes }, this.nextSerial());
      case 'gt06-4g':
        return sos
          ? encodeAlarm({ fix, lbs: this.lbs4g, status, alarm: 0x01, clockOffsetMinutes }, this.nextSerial(), Gt06Protocol.ALARM_4G)
          : encodeGpsA0({ fix, lbs: this.lbs4g, acc: ignition, clockOffsetMinutes }, this.nextSerial());
      case 'teltonika':
        return encodeAvlPacket([
          {
            timestamp: fix.time,
            priority: sos ? 2 : 0,
            lat: fix.lat,
            lng: fix.lng,
            angle: Math.round(fix.course),
            satellites: fix.satellites,
            speedKph: Math.round(fix.speedKph),
            io: { 239: ignition ? 1 : 0, 240: fix.speedKph > 3 ? 1 : 0, 21: 4, 66: Math.round(this.voltage() * 1000), 113: 95 },
            sizes: { 66: 2 },
          },
        ]);
    }
  }

  private onData(chunk: Buffer): void {
    if (config.protocol === 'teltonika') {
      // The first reply byte 0x01 accepts the IMEI; later replies are 4-byte record ACKs.
      if (!this.ready && chunk[0] === 0x01) this.onReady();
      return;
    }
    const { frames, rest } = decodeFrames(this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk);
    this.rest = Buffer.from(rest);
    for (const frame of frames) {
      if (frameProtocol(frame) !== Gt06Protocol.LOGIN || this.ready) continue;
      this.onReady();
    }
  }

  private onReady(): void {
    this.ready = true;
    stats.loginAcks++;
    const now = Date.now();
    this.lastStepAt = now;
    this.nextSendAt = now + rand(0, config.intervalMs);
    this.nextHeartbeatAt = now + rand(0, HEARTBEAT_MS);
  }

  private nextSerial(): number {
    this.serial = (this.serial + 1) & 0xffff;
    return this.serial;
  }
}

function main(): void {
  const devices = Array.from({ length: config.count }, (_, i) => new SimDevice(imeiAt(config.imeiStart, i)));
  // Ramp connections up (≈ 500/s, max 20 s) instead of opening thousands of sockets at once.
  const rampMs = Math.min(config.count * 2, 20_000);
  devices.forEach((d) => setTimeout(() => d.connect(), Math.random() * rampMs));
  console.log(
    `Simulating ${config.count} ${config.protocol} devices → ${config.host}:${config.port}, every ${config.intervalMs / 1000}s ` +
      `(IMEI ${devices[0]?.imei} … ${devices[devices.length - 1]?.imei})`,
  );

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const d of devices) d.tick(now);
  }, TICK_MS);

  let lastSent = 0;
  const summary = setInterval(() => {
    const connected = devices.reduce((n, d) => n + (d.ready ? 1 : 0), 0);
    const rate = ((stats.sent - lastSent) * 1000) / SUMMARY_MS;
    lastSent = stats.sent;
    console.log(
      `[sim] connected=${connected}/${config.count} sent=${stats.sent} rate=${rate.toFixed(1)}/s ` +
        `alarms=${stats.alarms} reconnects=${stats.reconnects}`,
    );
  }, SUMMARY_MS);

  const stop = () => {
    clearInterval(ticker);
    clearInterval(summary);
    devices.forEach((d) => d.stop());
    console.log(`[sim] stopped: sent=${stats.sent} alarms=${stats.alarms}`);
    setTimeout(() => process.exit(0), 200);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (config.durationMs > 0) setTimeout(stop, config.durationMs);
}

main();
