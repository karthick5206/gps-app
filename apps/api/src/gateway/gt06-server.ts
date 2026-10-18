import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createServer, Server, Socket } from 'node:net';
import { NormalizedPosition } from '@veetracer/shared';
import { POSITIONS_STREAM_MAXLEN, RedisKeys } from '../redis/keys';
import { alarmName, ConnectionStatus, connectionStatus, toNormalizedPosition } from './gt06-position';
import { decodeFrames, decodeMessage, encodeAck, Gt06DecodeError, Gt06Message, requiresAck } from './gt06/codec';

const MAX_PENDING_BYTES = 4096;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const CONN_KEY_TTL_SEC = 300;
const CONN_KEY_REFRESH_MS = 60_000;

interface Connection {
  socket: Socket;
  remote: string;
  imei: string | null;
  rest: Buffer;
  status: ConnectionStatus | null;
  connKeyAt: number;
  unknownLogged: Set<number>;
}

export interface GatewayStats {
  connections: number;
  frames: number;
  positions: number;
  dropped: number;
}

/** Stateless GT06 TCP endpoint: decode, ACK, and append fixes to the `vt:positions` stream. */
export class Gt06Server {
  private readonly logger = new Logger('Gt06Gateway');
  private readonly connections = new Set<Connection>();
  private server: Server | null = null;
  readonly stats: GatewayStats = { connections: 0, frames: 0, positions: 0, dropped: 0 };

  constructor(
    private readonly redis: Redis,
    private readonly gatewayId: string,
  ) {}

  listen(port: number): Promise<void> {
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 20_000;
    return new Promise((resolve) => this.server!.listen(port, resolve));
  }

  async close(): Promise<void> {
    for (const c of this.connections) c.socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: Socket): void {
    const conn: Connection = {
      socket,
      remote: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`,
      imei: null,
      rest: Buffer.alloc(0),
      status: null,
      connKeyAt: 0,
      unknownLogged: new Set(),
    };
    this.connections.add(conn);
    this.stats.connections = this.connections.size;
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk) => this.onData(conn, chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.connections.delete(conn);
      this.stats.connections = this.connections.size;
    });
  }

  private onData(conn: Connection, chunk: Buffer): void {
    const input = conn.rest.length ? Buffer.concat([conn.rest, chunk]) : chunk;
    const { frames, rest, dropped } = decodeFrames(input);
    this.stats.dropped += dropped;
    // A partial frame that never completes is garbage; don't let it grow without bound.
    conn.rest = rest.length > MAX_PENDING_BYTES ? Buffer.alloc(0) : Buffer.from(rest);

    const positions: NormalizedPosition[] = [];
    for (const frame of frames) {
      this.stats.frames++;
      let message: Gt06Message;
      try {
        message = decodeMessage(frame);
      } catch (error) {
        if (!(error instanceof Gt06DecodeError)) throw error;
        this.stats.dropped++;
        continue;
      }
      if (requiresAck(message)) conn.socket.write(encodeAck(message.protocol, message.serial));
      const position = this.handle(conn, message, frame);
      if (position) positions.push(position);
    }
    if (positions.length) this.publish(positions, conn.remote);
    this.refreshConnectionKey(conn);
  }

  private handle(conn: Connection, message: Gt06Message, frame: Buffer): NormalizedPosition | null {
    const receivedAt = new Date();
    switch (message.type) {
      case 'login':
        conn.imei = message.imei;
        conn.connKeyAt = 0;
        return null;
      case 'heartbeat':
        conn.status = connectionStatus(message.status);
        return null;
      case 'gps':
        if (!conn.imei) return null;
        return toNormalizedPosition({
          uniqueId: conn.imei,
          fix: message.fix,
          lbs: message.lbs,
          acc: message.acc,
          status: conn.status,
          extra: {
            ...(message.mileage !== null ? { mileage: message.mileage } : {}),
            ...(message.reupload ? { reupload: true } : {}),
          },
          raw: frame,
          receivedAt,
        });
      case 'alarm':
        conn.status = connectionStatus(message.status);
        if (!conn.imei) return null;
        return toNormalizedPosition({
          uniqueId: conn.imei,
          fix: message.fix,
          lbs: message.lbs,
          acc: null,
          status: conn.status,
          extra: { alarm: alarmName(message.alarm) },
          raw: frame,
          receivedAt,
        });
      case 'unknown':
        if (!conn.unknownLogged.has(message.protocol)) {
          conn.unknownLogged.add(message.protocol);
          this.logger.warn(`Unknown protocol 0x${message.protocol.toString(16)} from ${conn.imei ?? conn.remote}`);
        }
        return null;
    }
  }

  private publish(positions: NormalizedPosition[], remote: string): void {
    const pipeline = this.redis.pipeline();
    for (const p of positions) {
      pipeline.xadd(RedisKeys.positionsStream, 'MAXLEN', '~', POSITIONS_STREAM_MAXLEN, '*', 'data', JSON.stringify(p), 'remote', remote);
    }
    this.stats.positions += positions.length;
    pipeline.exec().catch((error: Error) => this.logger.error(`XADD failed: ${error.message}`));
  }

  private refreshConnectionKey(conn: Connection): void {
    if (!conn.imei) return;
    const now = Date.now();
    if (now - conn.connKeyAt < CONN_KEY_REFRESH_MS) return;
    conn.connKeyAt = now;
    this.redis
      .set(RedisKeys.connection(conn.imei), this.gatewayId, 'EX', CONN_KEY_TTL_SEC)
      .catch((error: Error) => this.logger.error(`Connection key update failed: ${error.message}`));
  }
}
