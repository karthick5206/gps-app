import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { NormalizedPosition } from '@veetracer/shared';
import { POSITIONS_STREAM_MAXLEN, RedisKeys } from '../redis/keys';
import { BaseSession, DecodeContext, ProtocolDecoder } from './protocol';
import { RateLimitedWarn, UnparsedLog } from './unparsed-log';

const IDLE_TIMEOUT_MS = 10 * 60_000;
/** Connections that never identify themselves (port scanners, misconfigured devices) are closed after this. */
const LOGIN_TIMEOUT_MS = 2 * 60_000;
const CONN_KEY_TTL_SEC = 300;
const CONN_KEY_REFRESH_MS = 60_000;
/** Raw frames captured per connection when capture is enabled for a device. */
const CAPTURE_FRAMES_PER_CONNECTION = 500;

export interface GatewayStats {
  connections: number;
  frames: number;
  positions: number;
  dropped: number;
  errors: number;
}

export interface TcpGatewayOptions {
  redis: Redis;
  gatewayId: string;
  unparsed: UnparsedLog;
  /**
   * Raw frame capture (JSON lines in `<dir>/capture-<protocol>.log`) for building test fixtures from real devices:
   * `ids` = unique ids to capture, or `'all'`. Null disables.
   */
  capture?: { dir: string; ids: Set<string> | 'all' } | null;
}

interface Connection<S extends BaseSession> {
  socket: Socket;
  remote: string;
  session: S;
  rest: Buffer;
  connKeyAt: number;
  captured: number;
  flushTimer: NodeJS.Timeout | null;
  loginTimer: NodeJS.Timeout | null;
}

/**
 * Generic TCP endpoint for one device protocol: owns sockets, buffering, timeouts, stats, publishing to the
 * `vt:positions` stream and the `vt:conn:<id>` connection registry. Protocol logic lives in the decoder.
 */
export class TcpGatewayServer<S extends BaseSession> {
  private readonly logger: Logger;
  private readonly warnings: RateLimitedWarn;
  private readonly connections = new Set<Connection<S>>();
  private server: Server | null = null;
  private captureReady: Promise<void> | null = null;
  readonly stats: GatewayStats = { connections: 0, frames: 0, positions: 0, dropped: 0, errors: 0 };

  constructor(
    private readonly decoder: ProtocolDecoder<S>,
    private readonly options: TcpGatewayOptions,
  ) {
    this.logger = new Logger(`Gateway:${decoder.name}`);
    this.warnings = new RateLimitedWarn(`Gateway:${decoder.name}`);
  }

  get protocol(): string {
    return this.decoder.name;
  }

  /** Bound port (useful with `listen(0)` in tests). */
  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  listen(port: number): Promise<void> {
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 20_000;
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, () => resolve());
    });
  }

  async close(): Promise<void> {
    for (const c of this.connections) c.socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: Socket): void {
    const conn: Connection<S> = {
      socket,
      remote: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`,
      session: this.decoder.createSession(),
      rest: Buffer.alloc(0),
      connKeyAt: 0,
      captured: 0,
      flushTimer: null,
      loginTimer: null,
    };
    this.connections.add(conn);
    this.stats.connections = this.connections.size;
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    conn.loginTimer = setTimeout(() => {
      if (!conn.session.uniqueId) socket.destroy();
    }, LOGIN_TIMEOUT_MS);
    conn.loginTimer.unref();
    socket.on('data', (chunk) => this.onData(conn, chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (conn.flushTimer) clearTimeout(conn.flushTimer);
      if (conn.loginTimer) clearTimeout(conn.loginTimer);
      this.connections.delete(conn);
      this.stats.connections = this.connections.size;
    });
  }

  private context(conn: Connection<S>): DecodeContext {
    return {
      receivedAt: new Date(),
      remote: conn.remote,
      unparsed: (reason, raw, uniqueId) => this.options.unparsed.record(this.decoder.name, reason, raw, uniqueId ?? conn.remote),
      warn: (key, message) => this.warnings.warn(key, message),
    };
  }

  private onData(conn: Connection<S>, chunk: Buffer): void {
    if (conn.flushTimer) {
      clearTimeout(conn.flushTimer);
      conn.flushTimer = null;
    }
    const input = conn.rest.length ? Buffer.concat([conn.rest, chunk]) : chunk;
    let split;
    try {
      split = this.decoder.split(input, conn.session);
    } catch (error) {
      this.stats.errors++;
      this.warnings.warn(`split:${conn.remote}`, `Split failed for ${conn.session.uniqueId ?? conn.remote}: ${(error as Error).message}`);
      conn.socket.destroy();
      return;
    }
    this.stats.dropped += split.dropped;
    // A partial frame that never completes is garbage; don't let it grow without bound.
    conn.rest = split.rest.length > this.decoder.maxFrameBytes ? Buffer.alloc(0) : Buffer.from(split.rest);
    this.process(conn, split.frames);
    if (split.fatal) {
      this.warnings.warn(`fatal:${conn.remote}`, `Closing ${conn.session.uniqueId ?? conn.remote}: ${split.fatal}`);
      conn.socket.end();
      return;
    }
    if (conn.rest.length && this.decoder.flush && this.decoder.flushAfterMs) {
      conn.flushTimer = setTimeout(() => {
        conn.flushTimer = null;
        const flushed = this.decoder.flush!(conn.rest, conn.session);
        conn.rest = Buffer.from(flushed.rest);
        this.process(conn, flushed.frames);
      }, this.decoder.flushAfterMs);
      conn.flushTimer.unref();
    }
  }

  private process(conn: Connection<S>, frames: Buffer[]): void {
    const positions: NormalizedPosition[] = [];
    for (const frame of frames) {
      this.stats.frames++;
      const ctx = this.context(conn);
      try {
        const result = this.decoder.decode(frame, conn.session, ctx);
        this.capture(conn, 'in', frame);
        for (const reply of result.replies) {
          conn.socket.write(reply);
          this.capture(conn, 'out', reply);
        }
        positions.push(...result.positions);
        if (result.close) {
          conn.socket.end();
          break;
        }
      } catch (error) {
        // One bad packet must never kill the connection or the process.
        this.stats.errors++;
        this.warnings.warn(`decode:${conn.remote}`, `Decode error from ${conn.session.uniqueId ?? conn.remote}: ${(error as Error).message}`);
        ctx.unparsed(`decoder error: ${(error as Error).message}`, frame, conn.session.uniqueId);
      }
    }
    if (conn.session.uniqueId && conn.loginTimer) {
      clearTimeout(conn.loginTimer);
      conn.loginTimer = null;
    }
    if (positions.length) this.publish(positions, conn.remote);
    // Any traffic (including heartbeats) refreshes the connection key; the offline sweeper treats it as "online".
    this.refreshConnectionKey(conn);
  }

  private publish(positions: NormalizedPosition[], remote: string): void {
    const pipeline = this.options.redis.pipeline();
    for (const p of positions) {
      pipeline.xadd(RedisKeys.positionsStream, 'MAXLEN', '~', POSITIONS_STREAM_MAXLEN, '*', 'data', JSON.stringify(p), 'remote', remote);
    }
    this.stats.positions += positions.length;
    pipeline.exec().catch((error: Error) => this.logger.error(`XADD failed: ${error.message}`));
  }

  private refreshConnectionKey(conn: Connection<S>): void {
    const id = conn.session.uniqueId;
    if (!id) return;
    const now = Date.now();
    if (now - conn.connKeyAt < CONN_KEY_REFRESH_MS) return;
    conn.connKeyAt = now;
    this.options.redis
      .set(RedisKeys.connection(id), this.options.gatewayId, 'EX', CONN_KEY_TTL_SEC)
      .catch((error: Error) => this.logger.error(`Connection key update failed: ${error.message}`));
  }

  private capture(conn: Connection<S>, direction: 'in' | 'out', bytes: Buffer): void {
    const cfg = this.options.capture;
    const id = conn.session.uniqueId;
    if (!cfg || !id || conn.captured >= CAPTURE_FRAMES_PER_CONNECTION) return;
    if (cfg.ids !== 'all' && !cfg.ids.has(id)) return;
    conn.captured++;
    const line = JSON.stringify({ at: new Date().toISOString(), protocol: this.decoder.name, id, remote: conn.remote, dir: direction, hex: bytes.toString('hex') });
    this.captureReady ??= mkdir(cfg.dir, { recursive: true }).then(() => undefined);
    void this.captureReady
      .then(() => appendFile(join(cfg.dir, `capture-${this.decoder.name}.log`), `${line}\n`))
      .catch((error: Error) => this.warnings.warn('capture', `Capture write failed: ${error.message}`));
  }
}
