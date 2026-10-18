/**
 * GT06 device simulator: N devices over TCP from one process.
 *   npm run sim -- --count 20 --host 127.0.0.1 --port 5023 --interval 10 --imei-start 868120000000001 [--duration 60]
 */
import { connect, Socket } from 'node:net';
import { decodeFrames, encodeAlarm, encodeGps22, encodeHeartbeat, encodeLogin, frameProtocol, Gt06Protocol } from '../gateway/gt06/codec';
import { DEFAULT_IMEI_START, imeiAt, numberArg, parseArgs } from './cli-args';
import { VehicleMovement } from './movement';

const TICK_MS = 100;
const HEARTBEAT_MS = 180_000;
const SUMMARY_MS = 10_000;
const SOS_PROBABILITY = 1 / 20_000;

const args = parseArgs(process.argv.slice(2));
const config = {
  count: numberArg(args, 'count', 20),
  host: args.get('host') ?? '127.0.0.1',
  port: numberArg(args, 'port', 5023),
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
  private readonly movement = new VehicleMovement(Date.now());
  ready = false;
  stopped = false;

  constructor(readonly imei: string) {}

  connect(): void {
    if (this.stopped) return;
    const socket = connect({ host: config.host, port: config.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(encodeLogin(this.imei, this.nextSerial(), 0x3612, 0x3200)));
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.ready = false;
      this.socket = null;
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
    if (now >= this.nextHeartbeatAt) {
      this.nextHeartbeatAt = now + HEARTBEAT_MS;
      this.socket.write(
        encodeHeartbeat(
          { ignition: this.movement.ignition, charging: true, oilCut: false, voltageLevel: 5, gsmSignal: 4 },
          this.nextSerial(),
        ),
      );
    }
    // GT06 timestamps have 1 s resolution; two fixes in one second would collide on (deviceId, fixTime).
    const second = Math.floor(now / 1000);
    if (now < this.nextSendAt || second === this.lastFixSecond) return;
    this.lastFixSecond = second;
    // Stay on schedule, but never burst to catch up after a stall.
    this.nextSendAt = Math.max(this.nextSendAt + config.intervalMs, now + config.intervalMs / 2);

    this.movement.step(now, (now - this.lastStepAt) / 1000);
    this.lastStepAt = now;
    const m = this.movement;
    const fix = {
      time: new Date(second * 1000),
      gpsInfoLength: 12,
      satellites: Math.floor(rand(7, 13)),
      lat: m.lat,
      lng: m.lng,
      speedKph: m.speedKph,
      course: m.course,
      positioned: true,
    };
    if (Math.random() < SOS_PROBABILITY) {
      stats.alarms++;
      const status = { ignition: m.ignition, charging: true, oilCut: false, voltageLevel: 5, gsmSignal: 4 };
      this.socket.write(encodeAlarm({ fix, lbs: this.lbs, status, alarm: 0x01 }, this.nextSerial()));
    } else {
      this.socket.write(encodeGps22({ fix, lbs: this.lbs, acc: m.ignition }, this.nextSerial()));
    }
    stats.sent++;
  }

  private onData(chunk: Buffer): void {
    const { frames, rest } = decodeFrames(this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk);
    this.rest = Buffer.from(rest);
    for (const frame of frames) {
      if (frameProtocol(frame) !== Gt06Protocol.LOGIN || this.ready) continue;
      this.ready = true;
      stats.loginAcks++;
      const now = Date.now();
      this.lastStepAt = now;
      this.nextSendAt = now + rand(0, config.intervalMs);
      this.nextHeartbeatAt = now + rand(0, HEARTBEAT_MS);
    }
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
    `Simulating ${config.count} GT06 devices → ${config.host}:${config.port}, every ${config.intervalMs / 1000}s ` +
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
