import { createServer, connect, Server, Socket } from 'node:net';

/**
 * Controllable TCP proxy for chaos tests.
 *   up        forwards traffic
 *   cut       closes every connection (RST) and refuses new ones: a crashed peer / firewall reset
 *   blackhole keeps connections open but stops reading in both directions: a silent network partition. Nothing is
 *             dropped (as with TCP retransmission): what was sent arrives late once the mode is back to up.
 */
export type ProxyMode = 'up' | 'cut' | 'blackhole';

export class ChaosProxy {
  private server: Server | null = null;
  private readonly pairs = new Set<{ client: Socket; upstream: Socket }>();
  mode: ProxyMode = 'up';

  constructor(
    readonly name: string,
    readonly listenPort: number,
    readonly targetHost: string,
    readonly targetPort: number,
  ) {}

  start(): Promise<void> {
    this.server = createServer((client) => this.accept(client));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.listenPort, '127.0.0.1', () => resolve());
    });
  }

  setMode(mode: ProxyMode): void {
    this.mode = mode;
    if (mode === 'cut') {
      for (const p of this.pairs) {
        p.client.resetAndDestroy();
        p.upstream.destroy();
      }
      this.pairs.clear();
    }
    for (const p of this.pairs) {
      if (mode === 'blackhole') {
        p.client.pause();
        p.upstream.pause();
      } else if (mode === 'up') {
        p.client.resume();
        p.upstream.resume();
      }
    }
  }

  private accept(client: Socket): void {
    if (this.mode === 'cut') {
      client.resetAndDestroy();
      return;
    }
    const upstream = connect({ host: this.targetHost, port: this.targetPort });
    const pair = { client, upstream };
    this.pairs.add(pair);
    const close = () => {
      client.destroy();
      upstream.destroy();
      this.pairs.delete(pair);
    };
    client.on('data', (d) => upstream.write(d));
    upstream.on('data', (d) => client.write(d));
    if (this.mode === 'blackhole') {
      client.pause();
      upstream.pause();
    }
    client.on('error', close);
    upstream.on('error', close);
    client.on('close', close);
    upstream.on('close', close);
  }

  async stop(): Promise<void> {
    this.setMode('cut');
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
