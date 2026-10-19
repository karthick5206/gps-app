import { lookup } from 'node:dns/promises';
import { isIP, Socket } from 'node:net';
import { TargetStats } from '../../relay/stats';

export interface UpstreamOptions {
  host: string;
  port: number;
  /** Chunks replayed first on every (re)connect: the device's login / registration, so the upstream sees a session. */
  prelude: () => Buffer[];
  stats: TargetStats;
  /** Bytes / chunks buffered while the upstream is down (oldest dropped first). */
  maxBytes: number;
  maxFrames: number;
  /** Upstream replies are discarded unless this is set (pass downstream). */
  onDownstream?: ((data: Buffer) => void) | null;
  /** Loop / SSRF check of the resolved addresses; an error message refuses the connect. */
  checkAddresses?: (addresses: string[], port: number) => string | null;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  connectTimeoutMs?: number;
  keepAliveMs?: number;
}

/**
 * One upstream TCP connection mirroring one device connection to one target. Never blocks the device: writes are
 * asynchronous, bounded by `maxBytes` (in the socket buffer or the reconnect queue) and dropped oldest-first beyond.
 */
export class RelayUpstream {
  private socket: Socket | null = null;
  private connected = false;
  private closed = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;

  constructor(private readonly opts: UpstreamOptions) {
    opts.stats.sessions++;
    void this.connect();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get queued(): number {
    return this.queuedBytes;
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    const s = this.socket;
    if (this.connected && s && !s.destroyed) {
      if (s.writableLength + chunk.length > this.opts.maxBytes) {
        // The upstream reads slower than the device sends: drop rather than grow.
        this.opts.stats.dropped++;
        return;
      }
      this.send(s, chunk);
      return;
    }
    this.enqueue(chunk);
  }

  /** The device disconnected: flush what is queued (when connected) and close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setQueued(0);
    this.queue.length = 0;
    this.opts.stats.sessions--;
    const s = this.socket;
    if (s && this.connected) s.end();
    else s?.destroy();
  }

  private send(s: Socket, chunk: Buffer): void {
    s.write(chunk);
    this.opts.stats.bytes += chunk.length;
    this.opts.stats.frames++;
    this.opts.stats.success();
  }

  private enqueue(chunk: Buffer): void {
    this.queue.push(chunk);
    let bytes = this.queuedBytes + chunk.length;
    while (this.queue.length && (bytes > this.opts.maxBytes || this.queue.length > this.opts.maxFrames)) {
      bytes -= this.queue.shift()!.length;
      this.opts.stats.dropped++;
    }
    this.setQueued(bytes);
  }

  private setQueued(bytes: number): void {
    this.opts.stats.queued += bytes - this.queuedBytes;
    this.queuedBytes = bytes;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const { host, port } = this.opts;
    let address = host;
    try {
      const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
      const refused = this.opts.checkAddresses?.(addresses, port);
      if (refused) throw new Error(`Refused: ${refused}`);
      address = addresses[0];
    } catch (error) {
      this.fail((error as Error).message);
      return;
    }
    if (this.closed) return;
    const s = new Socket();
    this.socket = s;
    s.setNoDelay(true);
    s.setTimeout(this.opts.connectTimeoutMs ?? 10_000, () => s.destroy(new Error('Connect timed out')));
    let failed: string | null = null;
    s.once('connect', () => {
      s.setTimeout(0);
      s.setKeepAlive(true, this.opts.keepAliveMs ?? 30_000);
      this.connected = true;
      this.attempt = 0;
      this.opts.stats.connected++;
      this.opts.stats.success();
      for (const p of this.opts.prelude()) this.send(s, p);
      for (const q of this.queue.splice(0)) this.send(s, q);
      this.setQueued(0);
    });
    s.on('data', (data: Buffer) => {
      // Replies of the upstream are read (so it never blocks) and discarded: VeeTrax answers the device itself.
      if (this.opts.onDownstream && !this.closed) this.opts.onDownstream(data);
    });
    s.on('error', (error: Error) => {
      failed = error.message;
    });
    s.on('close', () => {
      if (this.socket === s) this.socket = null;
      if (this.connected) {
        this.connected = false;
        this.opts.stats.connected--;
      }
      if (this.closed) return;
      this.fail(failed ?? 'Upstream closed the connection');
    });
    s.connect(port, address);
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.opts.stats.error(`${this.opts.host}:${this.opts.port}: ${message}`);
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 60_000;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 16));
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, Math.round(delay * (0.8 + Math.random() * 0.4)));
    this.timer.unref();
  }
}
