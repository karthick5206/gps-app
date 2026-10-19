import { Logger } from '@nestjs/common';
import { createServer as createHttpServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer, Server, Socket } from 'node:net';
import { MediaHub } from './hub';
import { Jt1078Reassembler, Jt1078Splitter } from './packet';
import { MediaStream } from './stream';

/** Media connections that never match a requested stream are closed after this many packets. */
const UNKNOWN_PACKET_LIMIT = 300;
const MEDIA_SOCKET_IDLE_MS = 60_000;
const SWEEP_MS = 5_000;

/**
 * JT/T 1078 media endpoint inside the gateway process:
 *  - TCP `MEDIA_PORT` (public): dashcams push RTP-like packets after 0x9101 / 0x9201;
 *  - HTTP on 127.0.0.1 `MEDIA_HTTP_PORT` (private): `GET /live/<sessionId>.flv` (HTTP-FLV) and
 *    `GET /status/<sessionId>` (JSON), proxied by the API, which authenticates viewers.
 */
export class MediaServer {
  private readonly logger = new Logger('Media');
  private tcp: Server | null = null;
  private http: HttpServer | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  /** Stream id → media sockets feeding it. */
  private readonly sockets = new Map<string, Set<Socket>>();
  readonly stats = { connections: 0, packets: 0, dropped: 0, unknown: 0 };

  constructor(readonly hub: MediaHub) {}

  /** Bound ports (tests use 0). */
  get ports(): { media: number | null; http: number | null } {
    const port = (s: Server | HttpServer | null) => {
      const a = s?.address();
      return a && typeof a === 'object' ? a.port : null;
    };
    return { media: port(this.tcp), http: port(this.http) };
  }

  async listen(mediaPort: number, httpPort: number, httpHost = '127.0.0.1'): Promise<void> {
    this.tcp = createServer((socket) => this.acceptMedia(socket));
    this.tcp.maxConnections = 200;
    this.http = createHttpServer((req, res) => this.onHttp(req, res));
    await new Promise<void>((resolve, reject) => {
      this.tcp!.once('error', reject);
      this.tcp!.listen(mediaPort, () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(httpPort, httpHost, () => resolve());
    });
    this.sweeper = setInterval(() => this.hub.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const s of this.hub.list()) this.hub.close(s.id, 'shutdown');
    for (const set of this.sockets.values()) for (const s of set) s.destroy();
    await Promise.all(
      [this.tcp, this.http].map((s) => new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()))),
    );
  }

  /** Called by the hub's onStop: disconnect the device's media sockets for that stream. */
  dropStream(stream: MediaStream): void {
    for (const s of this.sockets.get(stream.id) ?? []) s.destroy();
    this.sockets.delete(stream.id);
  }

  private acceptMedia(socket: Socket): void {
    this.stats.connections++;
    const splitter = new Jt1078Splitter();
    const reassembler = new Jt1078Reassembler();
    /** Logical channel → stream this connection feeds. */
    const bound = new Map<number, MediaStream>();
    let unknown = 0;
    socket.setTimeout(MEDIA_SOCKET_IDLE_MS, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.stats.connections--;
      for (const stream of bound.values()) this.sockets.get(stream.id)?.delete(socket);
    });
    socket.on('data', (chunk) => {
      let packets;
      try {
        packets = splitter.push(chunk);
      } catch (error) {
        this.logger.warn(`Media parse error from ${socket.remoteAddress}: ${(error as Error).message}`);
        socket.destroy();
        return;
      }
      this.stats.dropped = splitter.dropped;
      for (const p of packets) {
        this.stats.packets++;
        let stream = bound.get(p.channel);
        if (stream && stream.state === 'closed') {
          socket.destroy();
          return;
        }
        if (!stream) {
          const busy = new Set([...this.sockets.entries()].filter(([, set]) => set.size).map(([id]) => id));
          stream = this.hub.bind(p.sim, p.channel, busy) ?? undefined;
          if (!stream) {
            this.stats.unknown++;
            if (++unknown >= UNKNOWN_PACKET_LIMIT) {
              this.logger.warn(`Closing media from ${p.sim} ch${p.channel}: no stream was requested`);
              socket.destroy();
              return;
            }
            continue;
          }
          bound.set(p.channel, stream);
          const set = this.sockets.get(stream.id) ?? new Set<Socket>();
          set.add(socket);
          this.sockets.set(stream.id, set);
          this.logger.log(`Media for ${stream.id} (${p.sim} ch${p.channel}) from ${socket.remoteAddress}`);
        }
        const frame = reassembler.push(p);
        if (frame) stream.push(frame);
      }
    });
  }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const live = /^\/live\/([A-Za-z0-9_-]+)\.flv$/.exec(url.pathname);
    const status = /^\/status\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (req.method !== 'GET' || (!live && !status)) return json(res, 404, { message: 'Not found' });
    const id = (live ?? status)![1];
    const stream = this.hub.get(id);
    if (status) {
      if (!stream) return json(res, 404, { message: 'Stream ended' });
      return json(res, 200, { state: stream.state, codec: stream.codec, viewers: stream.viewerCount, frames: stream.frames });
    }
    if (!stream || stream.state === 'closed') return json(res, 404, { code: 'STREAM_ENDED', message: 'This video stream has ended' });
    if (stream.codec === 'h265') return json(res, 415, { code: 'CODEC_UNSUPPORTED', message: 'This camera sends H.265 video, which the web player cannot show. Set the dashcam to H.264.' });
    res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-cache, no-store, no-transform', Connection: 'close' });
    res.flushHeaders();
    this.hub.attachViewer(id, res);
    const leave = () => this.hub.detachViewer(id, res);
    res.on('close', leave);
    req.on('close', leave);
  }
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
