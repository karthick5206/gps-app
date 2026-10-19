import { randomBytes } from 'node:crypto';
import { FlvSink, MediaStream, StreamKind } from './stream';

export class StreamLimitError extends Error {
  constructor(max: number) {
    super(`The video server is at its limit of ${max} concurrent streams. Close another stream and try again.`);
  }
}

export interface MediaHubOptions {
  maxStreams: number;
  /** Close a stream this long after its last viewer left (or after it opened without anyone connecting). */
  idleMs?: number;
  /** Close a stream that sent no media for this long (device never connected or stopped sending). */
  noDataMs?: number;
  /** Called once when a stream closes, so the device can be told to stop (0x9102 / 0x9202). */
  onStop?: (stream: MediaStream, reason: string) => void;
}

export interface OpenRequest {
  uniqueId: string;
  channel: number;
  kind: StreamKind;
  streamType: 'main' | 'sub';
}

/**
 * Registry of device streams. Live streams are shared per (device, channel); playback streams are always new.
 * Streams close when idle (no viewers for `idleMs`) or silent (no media for `noDataMs`).
 */
export class MediaHub {
  private readonly streams = new Map<string, MediaStream>();
  private readonly emptySince = new Map<string, number>();
  readonly idleMs: number;
  readonly noDataMs: number;

  constructor(private readonly options: MediaHubOptions) {
    this.idleMs = options.idleMs ?? 30_000;
    this.noDataMs = options.noDataMs ?? 30_000;
  }

  get size(): number {
    return this.streams.size;
  }

  get(id: string): MediaStream | undefined {
    return this.streams.get(id);
  }

  list(): MediaStream[] {
    return [...this.streams.values()];
  }

  /** Existing live stream for this device channel, if any. */
  findLive(uniqueId: string, channel: number): MediaStream | undefined {
    return this.list().find((s) => s.kind === 'live' && s.uniqueId === uniqueId && s.channel === channel && s.state !== 'closed');
  }

  /** Opens a stream (or joins the live one already running). Throws StreamLimitError when full. */
  open(req: OpenRequest, now = Date.now()): { stream: MediaStream; joined: boolean } {
    if (req.kind === 'live') {
      const existing = this.findLive(req.uniqueId, req.channel);
      if (existing) return { stream: existing, joined: true };
    }
    if (this.streams.size >= this.options.maxStreams) throw new StreamLimitError(this.options.maxStreams);
    const id = `${req.kind === 'live' ? 'l' : 'p'}${randomBytes(9).toString('base64url')}`;
    const stream = new MediaStream(id, req.uniqueId, req.channel, req.kind, req.streamType);
    // H.265: end the viewers (the player shows why from the status); the idle sweep then stops the device.
    stream.onUnsupported = () => {
      stream.endViewers();
      if (!this.emptySince.has(id)) this.emptySince.set(id, Date.now());
    };
    this.streams.set(id, stream);
    this.emptySince.set(id, now);
    return { stream, joined: false };
  }

  attachViewer(id: string, sink: FlvSink): MediaStream | null {
    const stream = this.streams.get(id);
    if (!stream || stream.state === 'closed') return null;
    stream.addViewer(sink);
    this.emptySince.delete(id);
    return stream;
  }

  detachViewer(id: string, sink: FlvSink, now = Date.now()): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.removeViewer(sink);
    if (!stream.viewerCount) this.emptySince.set(id, now);
  }

  /** A viewer said it left: close at once when nobody else is watching. */
  leave(id: string): boolean {
    const stream = this.streams.get(id);
    if (!stream || stream.viewerCount) return false;
    this.close(id, 'viewer left');
    return true;
  }

  close(id: string, reason: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    this.emptySince.delete(id);
    stream.close();
    this.options.onStop?.(stream, reason);
  }

  /** The stream a new media connection from this SIM / channel belongs to: the newest one not yet bound. */
  bind(sim: string, channel: number, bound: Set<string>): MediaStream | null {
    const candidates = this.list()
      .filter((s) => s.channel === channel && sameTerminal(s.uniqueId, sim) && s.state !== 'closed')
      .sort((a, b) => b.createdAt - a.createdAt);
    return candidates.find((s) => !bound.has(s.id)) ?? candidates[0] ?? null;
  }

  /** Closes idle and silent streams; call every few seconds. Returns the ids closed. */
  sweep(now = Date.now()): string[] {
    const closed: string[] = [];
    for (const s of this.list()) {
      const empty = this.emptySince.get(s.id);
      let reason: string | null = null;
      if (empty !== undefined && now - empty >= this.idleMs) reason = 'no viewers';
      else if (s.frames === 0 && now - s.createdAt >= this.noDataMs) reason = 'no media from device';
      else if (s.frames > 0 && now - s.lastFrameAt >= this.noDataMs) reason = 'device stopped sending';
      if (reason) {
        this.close(s.id, reason);
        closed.push(s.id);
      }
    }
    return closed;
  }
}

/** Terminal ids compared without leading zeros (JT808 headers and 1078 SIM fields pad differently). */
export function sameTerminal(a: string, b: string): boolean {
  return a.replace(/^0+/, '') === b.replace(/^0+/, '');
}
