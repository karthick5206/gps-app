import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { CommandDispatch, CommandUpdate, CRITICAL_NOT_DELIVERED_OFFLINE, isSafetyCriticalDispatch, NO_QUEUE_NOT_DELIVERED, NormalizedPosition } from '@veetracer/shared';
import { RedisKeys } from '../redis/keys';
import { BaseSession, DecodeContext, DecodedMedia, ProtocolDecoder } from './protocol';
import { RelayHook, RelaySessionHandle } from './relay/relay-manager';
import { PositionPublisher } from './spool/position-publisher';
import { RateLimitedWarn, UnparsedLog } from './unparsed-log';

const IDLE_TIMEOUT_MS = 10 * 60_000;
/** Connections that never identify themselves (port scanners, misconfigured devices) are closed after this. */
const LOGIN_TIMEOUT_MS = 2 * 60_000;
const CONN_KEY_TTL_SEC = 300;
const CONN_KEY_REFRESH_MS = 60_000;
/** Raw frames captured per connection when capture is enabled for a device. */
const CAPTURE_FRAMES_PER_CONNECTION = 500;
/** Command delivery state kept in Valkey for the API to reconcile (seconds). */
const COMMAND_STATE_TTL_SEC = 7 * 86_400;
/** Commands drained per login from the offline queue. */
const QUEUE_DRAIN_MAX = 20;

/**
 * Protocols without a reply reference (Teltonika Codec 12) match replies in send order. An entry still unanswered after
 * this long is evicted, so a command the device never answered can't swallow (or be credited with) a later reply.
 */
export const UNREFERENCED_REPLY_TIMEOUT_MS = 90_000;
/**
 * Text of a reply to an engine-cut (digital output) command on a protocol without reply references: Teltonika answers
 * `setdigout` with e.g. "DOUT1:1 Timeout:INFINITY" (codec.spec.ts) [vendor: confirm the exact text per firmware].
 */
const ENGINE_CUT_REPLY = /\bDOUT\d\s*:|digital outputs? (?:are |is )?set/i;

export interface PendingCommand {
  commandId: string;
  sentAt: number;
  /** Safety-critical (engine stop). */
  critical: boolean;
  /**
   * Critical only: no other reply was outstanding when it was sent and nothing was sent after it, so an unrecognised
   * reply can only be its own.
   */
  clean: boolean;
}

/**
 * Picks the command a reply WITHOUT a protocol reference belongs to (and removes it from `pending`), or null.
 * Order alone is not trusted for engine stop: a position request that was never answered must not be credited with
 * the engine stop's reply, and the engine stop must never be credited with someone else's reply (a false
 * "acknowledged"). So: expired entries are evicted; a reply that looks like an engine-cut reply goes to the oldest
 * pending engine stop; any other reply goes to the oldest non-critical command; an engine stop takes an unrecognised
 * reply only when nothing else was outstanding when it was sent. When in doubt the engine stop stays SENT (unconfirmed).
 */
export function matchUnreferencedReply(pending: Map<number, PendingCommand>, text: string, nowMs: number): string | null {
  for (const [ref, p] of pending) if (nowMs - p.sentAt > UNREFERENCED_REPLY_TIMEOUT_MS) pending.delete(ref);
  const entries = [...pending];
  const critical = entries.find(([, p]) => p.critical);
  const other = entries.find(([, p]) => !p.critical);
  let pick: [number, PendingCommand] | undefined;
  if (critical && ENGINE_CUT_REPLY.test(text)) pick = critical;
  else if (other) pick = other;
  else if (critical && critical[1].clean) pick = critical;
  if (!pick) return null;
  pending.delete(pick[0]);
  return pick[1].commandId;
}

export class DeviceOfflineError extends Error {
  constructor() {
    super('The device is not connected');
  }
}

export interface GatewayStats {
  connections: number;
  frames: number;
  positions: number;
  dropped: number;
  errors: number;
  /** Positions neither XADDed nor spooled; their ACKs were withheld so the device retransmits. */
  enqueueFailures: number;
  lastPacketAt: number | null;
  lastPositionAt: number | null;
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
  /** Photos / clips decoded from device uploads (stored by the gateway's media sink). */
  onMedia?: (media: DecodedMedia[]) => void;
  /** Data forwarding (RAW_TCP): receives every chunk exactly as the device sent it. */
  relay?: RelayHook | null;
  /**
   * Hands positions to the stream, with the durable spool behind it. One instance is shared by all protocol servers
   * of a gateway. Defaults to a spool-less publisher on `redis` (XADD, else withhold the ACK, as before).
   */
  publisher?: PositionPublisher;
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
  /** Registered in `byId` (device identified itself). */
  identified: boolean;
  /** Commands sent and awaiting a reply: protocol reference → pending command, in send order. */
  pending: Map<number, PendingCommand>;
  /**
   * Tail of the reply chain while an XADD is in flight: later replies wait for it so the device sees ACKs in the
   * order it sent the frames. Null when nothing is pending (replies are written immediately).
   */
  writeChain: Promise<void> | null;
  /** Data forwarding of this connection (null when forwarding is off). */
  relay: RelaySessionHandle | null;
}

/**
 * Generic TCP endpoint for one device protocol: owns sockets, buffering, timeouts, stats, publishing to the
 * `vt:positions` stream and the `vt:conn:<id>` connection registry. Protocol logic lives in the decoder.
 */
export class TcpGatewayServer<S extends BaseSession> {
  private readonly logger: Logger;
  private readonly warnings: RateLimitedWarn;
  private readonly connections = new Set<Connection<S>>();
  /** Identified connections by device unique id (latest connection wins). */
  private readonly byId = new Map<string, Connection<S>>();
  private nextRef = (Date.now() / 1000) >>> 0;
  /** In-gateway requests awaiting a device reply, by protocol ref. */
  private readonly waiters = new Map<number, { resolve: (r: { text: string; data?: unknown }) => void; timer: NodeJS.Timeout }>();
  private server: Server | null = null;
  private readonly publisher: PositionPublisher;
  private captureReady: Promise<void> | null = null;
  readonly stats: GatewayStats = {
    connections: 0,
    frames: 0,
    positions: 0,
    dropped: 0,
    errors: 0,
    enqueueFailures: 0,
    lastPacketAt: null,
    lastPositionAt: null,
  };
  /** Port this server was asked to listen on, and why listening failed (for System Health). */
  configuredPort: number | null = null;
  listenError: string | null = null;

  constructor(
    private readonly decoder: ProtocolDecoder<S>,
    private readonly options: TcpGatewayOptions,
  ) {
    this.logger = new Logger(`Gateway:${decoder.name}`);
    this.warnings = new RateLimitedWarn(`Gateway:${decoder.name}`);
    this.publisher = options.publisher ?? new PositionPublisher(options.redis, null);
  }

  get protocol(): string {
    return this.decoder.name;
  }

  /** Bound port (useful with `listen(0)` in tests). */
  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  listen(port: number): Promise<void> {
    this.configuredPort = port;
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 20_000;
    return new Promise((resolve, reject) => {
      this.server!.once('error', (error: Error) => {
        this.listenError = error.message;
        reject(error);
      });
      this.server!.listen(port, () => {
        this.listenError = null;
        resolve();
      });
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
      identified: false,
      pending: new Map(),
      writeChain: null,
      relay: null,
    };
    if (this.options.relay) {
      try {
        conn.relay = this.options.relay.open(this.decoder.name, (data) => {
          if (!socket.destroyed && !socket.writableEnded) socket.write(data);
        });
      } catch (error) {
        this.warnings.warn('relay', `Relay open failed: ${(error as Error).message}`);
      }
    }
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
      conn.relay?.close();
      this.connections.delete(conn);
      const id = conn.session.uniqueId;
      if (id && this.byId.get(id) === conn) this.byId.delete(id);
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
    this.stats.lastPacketAt = Date.now();
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
    this.relayChunk(conn, chunk);
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

  /** Hands the original bytes to data forwarding (after decoding, so the device id of a login chunk is known). */
  private relayChunk(conn: Connection<S>, chunk: Buffer): void {
    if (!conn.relay) return;
    try {
      conn.relay.data(chunk, conn.session.uniqueId);
    } catch (error) {
      // Forwarding must never affect device handling.
      this.warnings.warn('relay', `Relay failed for ${conn.session.uniqueId ?? conn.remote}: ${(error as Error).message}`);
    }
  }

  /**
   * Decodes the frames of one chunk. Replies of frames that carry positions (Teltonika record ACKs, GT06 alarm ACKs,
   * JT808 location replies) are written only after those positions are durable — XADDed, or fsynced to the gateway
   * spool while the cache is unavailable. If neither worked the ACK is withheld and devices retransmit. Positions of
   * frames without an ACK (GT06 0x12/0x22 locations) rely on the spool alone. Other replies (login, heartbeats) are always
   * sent — immediately, or right after an earlier gated reply when one is still waiting (ordering is kept).
   */
  private process(conn: Connection<S>, frames: Buffer[]): void {
    const positions: NormalizedPosition[] = [];
    const segments: { replies: Buffer[]; gated: boolean }[] = [];
    let close = false;
    for (const frame of frames) {
      this.stats.frames++;
      const ctx = this.context(conn);
      try {
        const result = this.decoder.decode(frame, conn.session, ctx);
        this.capture(conn, 'in', frame);
        positions.push(...result.positions);
        if (result.media?.length) this.options.onMedia?.(result.media);
        const gated = result.positions.length > 0;
        const last = segments[segments.length - 1];
        if (last && last.gated === gated) last.replies.push(...result.replies);
        else if (result.replies.length || gated) segments.push({ replies: [...result.replies], gated });
        for (const r of result.commandResponses ?? []) this.onCommandResponse(conn, r.ref, r.text, r.data);
        if (result.close) {
          close = true;
          break;
        }
      } catch (error) {
        // One bad packet must never kill the connection or the process.
        this.stats.errors++;
        this.warnings.warn(`decode:${conn.remote}`, `Decode error from ${conn.session.uniqueId ?? conn.remote}: ${(error as Error).message}`);
        ctx.unparsed(`decoder error: ${(error as Error).message}`, frame, conn.session.uniqueId);
      }
    }
    if (conn.session.uniqueId && !conn.identified) this.onIdentified(conn);
    if (conn.session.uniqueId && conn.loginTimer) {
      clearTimeout(conn.loginTimer);
      conn.loginTimer = null;
    }
    const gate = positions.length ? this.publish(positions, conn.remote) : null;
    segments.forEach((seg, i) => this.reply(conn, seg.replies, seg.gated ? gate : null, close && i === segments.length - 1));
    if (close && !segments.length) this.reply(conn, [], null, true);
    // Any traffic (including heartbeats) refreshes the connection key; the offline sweeper treats it as "online".
    this.refreshConnectionKey(conn);
  }

  /**
   * Writes replies in order. With a `gate` (the XADD of the frames' positions) they wait for it; a failed gate drops
   * them (no ACK → the device resends) and, for protocols that need it (Teltonika), closes the connection.
   */
  private reply(conn: Connection<S>, replies: Buffer[], gate: Promise<boolean> | null, close: boolean): void {
    const write = (ok: boolean) => {
      if (conn.socket.destroyed || conn.socket.writableEnded) return;
      if (!ok) {
        if (this.decoder.closeOnEnqueueFailure) conn.socket.destroy();
        return;
      }
      for (const r of replies) {
        conn.socket.write(r);
        this.capture(conn, 'out', r);
      }
      if (close) conn.socket.end();
    };
    if (!gate && !conn.writeChain) {
      if (replies.length || close) write(true);
      return;
    }
    const chain: Promise<void> = (conn.writeChain ?? Promise.resolve())
      .then(() => gate ?? true)
      .then(write, () => write(false))
      .finally(() => {
        if (conn.writeChain === chain) conn.writeChain = null;
      });
    conn.writeChain = chain;
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  /** Whether a device is connected to this server right now. */
  has(uniqueId: string): boolean {
    return this.byId.has(uniqueId);
  }

  /**
   * Sends a command to a connected device. Returns false when the device is not connected here or the protocol has
   * no command support (the caller re-queues it).
   */
  sendCommand(d: CommandDispatch): boolean {
    const conn = this.byId.get(d.uniqueId);
    if (!conn || !this.decoder.encodeCommand || conn.socket.destroyed) return false;
    const ref = (this.nextRef = (this.nextRef + 1) >>> 0);
    const frame = this.decoder.encodeCommand(d.text, conn.session, ref);
    const now = Date.now();
    const critical = isSafetyCriticalDispatch(d);
    const outstanding = [...conn.pending.values()].filter((p) => now - p.sentAt <= UNREFERENCED_REPLY_TIMEOUT_MS);
    // Anything sent after an engine stop makes an unrecognised reply ambiguous for it (see matchUnreferencedReply).
    for (const p of outstanding) if (p.critical) p.clean = false;
    conn.pending.set(ref, { commandId: d.commandId, sentAt: now, critical, clean: critical && outstanding.length === 0 });
    if (conn.pending.size > 50) conn.pending.delete(conn.pending.keys().next().value as number);
    conn.socket.write(frame);
    this.capture(conn, 'out', frame);
    this.logger.log(`Command ${d.commandId} sent to ${d.uniqueId}: ${d.text}`);
    this.publishCommandUpdate({ commandId: d.commandId, status: 'SENT', at: new Date().toISOString() });
    return true;
  }

  /** Protocol session of a connected device (e.g. its JT808 clock zone), or null. */
  sessionOf(uniqueId: string): S | null {
    const conn = this.byId.get(uniqueId);
    return conn && !conn.socket.destroyed ? conn.session : null;
  }

  /**
   * Gateway-internal request (video signalling): sends `text` through the decoder's command encoder and resolves with
   * the device's matched reply, without touching the DeviceCommand history. Rejects when offline or on timeout.
   */
  request(uniqueId: string, text: string, timeoutMs = 15_000): Promise<{ text: string; data?: unknown }> {
    const conn = this.byId.get(uniqueId);
    if (!conn || !this.decoder.encodeCommand || conn.socket.destroyed) return Promise.reject(new DeviceOfflineError());
    const ref = (this.nextRef = (this.nextRef + 1) >>> 0);
    const frame = this.decoder.encodeCommand(text, conn.session, ref);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(ref);
        reject(new Error('The device did not answer in time'));
      }, timeoutMs);
      timer.unref();
      this.waiters.set(ref, { resolve, timer });
      conn.socket.write(frame);
      this.capture(conn, 'out', frame);
    });
  }

  private onCommandResponse(conn: Connection<S>, ref: number | null, text: string, data?: unknown): void {
    const waiter = ref !== null ? this.waiters.get(ref) : undefined;
    if (waiter && ref !== null) {
      this.waiters.delete(ref);
      clearTimeout(waiter.timer);
      waiter.resolve({ text, data });
      return;
    }
    let commandId: string | null = null;
    if (ref !== null && conn.pending.has(ref)) {
      commandId = conn.pending.get(ref)!.commandId;
      conn.pending.delete(ref);
    } else if (ref === null && conn.pending.size) {
      // No reference in the protocol (Teltonika Codec 12): send order, with timeouts and engine-stop safeguards.
      commandId = matchUnreferencedReply(conn.pending, text, Date.now());
    }
    if (!commandId) {
      this.warnings.warn(`cmd-unmatched:${conn.session.uniqueId}`, `Unmatched command reply from ${conn.session.uniqueId}: ${text}`);
      return;
    }
    this.publishCommandUpdate({ commandId, status: 'ACKED', response: text.slice(0, 1000), at: new Date().toISOString() });
  }

  /** Reports a command as FAILED (with the reason shown in the command history) without sending it. */
  failCommand(commandId: string, error: string): void {
    this.publishCommandUpdate({ commandId, status: 'FAILED', error, at: new Date().toISOString() });
  }

  private publishCommandUpdate(u: CommandUpdate): void {
    const json = JSON.stringify(u);
    this.options.redis
      .multi()
      .set(RedisKeys.commandState(u.commandId), json, 'EX', COMMAND_STATE_TTL_SEC)
      .publish(RedisKeys.commandUpdates, json)
      .exec()
      .catch((error: Error) => this.logger.error(`Command update failed: ${error.message}`));
  }

  /** First packet that identified the device: register it and deliver commands queued while it was offline. */
  private onIdentified(conn: Connection<S>): void {
    const id = conn.session.uniqueId!;
    conn.identified = true;
    this.byId.set(id, conn);
    this.options.redis
      .lpop(RedisKeys.commandQueue(id), QUEUE_DRAIN_MAX)
      .then((items) => {
        for (const raw of items ?? []) {
          try {
            const d = JSON.parse(raw) as CommandDispatch;
            if (isSafetyCriticalDispatch(d)) {
              // Decision Q-01: an engine stop queued while the vehicle was offline is never delivered on reconnect.
              this.logger.warn(`Dropped queued safety-critical command ${d.commandId} for ${id} on reconnect`);
              this.failCommand(d.commandId, CRITICAL_NOT_DELIVERED_OFFLINE);
              continue;
            }
            if (d.noQueue) {
              // Never-queued dispatches (engine-stop position requests) are not delivered late either.
              this.failCommand(d.commandId, NO_QUEUE_NOT_DELIVERED);
              continue;
            }
            this.sendCommand(d);
          } catch {
            // Malformed queue entry: drop it.
          }
        }
      })
      .catch((error: Error) => this.logger.error(`Command queue read failed: ${error.message}`));
  }

  /**
   * Hands the positions to the publisher: XADD, or the durable spool when the cache is unavailable. Resolves true when
   * they are durable (in the stream or fsynced in the spool) and the device ACK may go out; false withholds the ACK.
   * Never rejects.
   */
  private publish(positions: NormalizedPosition[], remote: string): Promise<boolean> {
    this.stats.positions += positions.length;
    this.stats.lastPositionAt = Date.now();
    return this.publisher.publish(positions, remote).then(
      (ok) => {
        if (!ok) this.stats.enqueueFailures += positions.length;
        return ok;
      },
      () => {
        this.stats.enqueueFailures += positions.length;
        return false;
      },
    );
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
