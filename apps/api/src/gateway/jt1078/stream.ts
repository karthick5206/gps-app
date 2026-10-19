import { AvcAccessUnit, AvcParser, flvHeader, flvTag, FlvTagType, avcNaluBody } from './flv';
import { Jt1078Frame, Jt1078PayloadType } from './packet';

export type VideoCodec = 'unknown' | 'h264' | 'h265';
export type StreamKind = 'live' | 'playback';
export type StreamState = 'starting' | 'streaming' | 'closed';

/** Where FLV bytes go (an HTTP response in production, a fake in tests). */
export interface FlvSink {
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
  readonly writableLength: number;
}

interface Viewer {
  sink: FlvSink;
  started: boolean;
  base: number;
  last: number;
}

/** GOP cache bounds: a late joiner starts at the latest keyframe without unbounded memory. */
const GOP_MAX_FRAMES = 400;
const GOP_MAX_BYTES = 6 * 1024 * 1024;
/** A viewer this far behind (bytes queued in the socket) is dropped instead of buffering without limit. */
const VIEWER_MAX_BACKLOG = 4 * 1024 * 1024;

/**
 * One device stream (live or playback of one channel) fanned out to any number of HTTP-FLV viewers. Viewers that join
 * late get the FLV header, the AVC sequence header and the cached GOP from the latest keyframe.
 */
export class MediaStream {
  codec: VideoCodec = 'unknown';
  state: StreamState = 'starting';
  readonly createdAt = Date.now();
  lastFrameAt = 0;
  frames = 0;
  bytes = 0;
  private readonly avc = new AvcParser();
  private seqHeader: Buffer | null = null;
  private gop: AvcAccessUnit[] = [];
  private gopBytes = 0;
  private readonly viewers = new Set<Viewer>();
  /** Called when the codec is unsupported (the hub closes the stream). */
  onUnsupported: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly uniqueId: string,
    readonly channel: number,
    readonly kind: StreamKind,
    readonly streamType: 'main' | 'sub',
  ) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  /** Frames of the latest GOP held for late joiners (tests / status). */
  get cachedFrames(): number {
    return this.gop.length;
  }

  addViewer(sink: FlvSink): void {
    const v: Viewer = { sink, started: false, base: 0, last: 0 };
    this.viewers.add(v);
    if (this.seqHeader && this.gop.length && this.gop[0].keyframe) {
      this.start(v, this.gop[0].timestamp);
      for (const au of this.gop) this.writeUnit(v, au);
    }
  }

  removeViewer(sink: FlvSink): void {
    for (const v of this.viewers) if (v.sink === sink) this.viewers.delete(v);
  }

  /** Feeds one reassembled 1078 frame. Audio and transparent data are ignored (video-only FLV). */
  push(frame: Jt1078Frame): void {
    if (this.state === 'closed' || frame.kind !== 'video') return;
    this.lastFrameAt = Date.now();
    this.frames++;
    this.bytes += frame.data.length;
    if (this.state === 'starting') this.state = 'streaming';
    if (frame.payloadType === Jt1078PayloadType.H265) {
      if (this.codec !== 'h265') {
        this.codec = 'h265';
        this.onUnsupported?.();
      }
      return;
    }
    const au = this.avc.push(frame.data, frame.timestamp);
    if (!au) return;
    if (this.codec === 'unknown') this.codec = 'h264';
    if (au.keyframe && (this.avc.configChanged || !this.seqHeader)) {
      const header = this.avc.sequenceHeader();
      if (header) {
        const changed = !!this.seqHeader;
        this.seqHeader = header;
        // Resolution change mid-stream: started viewers need the new decoder configuration first.
        if (changed) for (const v of this.viewers) if (v.started) this.send(v, flvTag(FlvTagType.VIDEO, this.ts(v, au.timestamp), header));
      }
    }
    if (au.keyframe) {
      this.gop = [au];
      this.gopBytes = au.nals.reduce((s, n) => s + n.length, 0);
    } else if (this.gop.length) {
      const size = au.nals.reduce((s, n) => s + n.length, 0);
      if (this.gop.length < GOP_MAX_FRAMES && this.gopBytes + size <= GOP_MAX_BYTES) {
        this.gop.push(au);
        this.gopBytes += size;
      } else {
        // Over budget: stop caching until the next keyframe (late joiners wait for it).
        this.gop = [];
        this.gopBytes = 0;
      }
    }
    for (const v of this.viewers) {
      if (!v.started) {
        if (!au.keyframe || !this.seqHeader) continue;
        this.start(v, au.timestamp);
      }
      this.writeUnit(v, au);
    }
  }

  /** Ends every viewer response and drops the cache. */
  close(): void {
    this.state = 'closed';
    this.endViewers();
  }

  /** Ends every viewer response (the stream stays registered, e.g. so its status shows an unsupported codec). */
  endViewers(): void {
    for (const v of this.viewers) {
      try {
        v.sink.end();
      } catch {
        // already gone
      }
    }
    this.viewers.clear();
    this.gop = [];
  }

  private start(v: Viewer, timestamp: number): void {
    v.started = true;
    v.base = timestamp;
    v.last = 0;
    this.send(v, Buffer.concat([flvHeader(true, false), flvTag(FlvTagType.VIDEO, 0, this.seqHeader!)]));
  }

  private writeUnit(v: Viewer, au: AvcAccessUnit): void {
    this.send(v, flvTag(FlvTagType.VIDEO, this.ts(v, au.timestamp), avcNaluBody(au.nals, au.keyframe)));
  }

  /** Viewer-relative, monotonic timestamp (devices reset or jitter their clock). */
  private ts(v: Viewer, timestamp: number): number {
    let t = timestamp - v.base;
    if (t < v.last || t - v.last > 10_000) {
      // Clock jump: re-base so playback continues smoothly.
      v.base = timestamp - v.last - 40;
      t = v.last + 40;
    }
    v.last = t;
    return t;
  }

  private send(v: Viewer, chunk: Buffer): void {
    if (v.sink.writableLength > VIEWER_MAX_BACKLOG) {
      this.viewers.delete(v);
      v.sink.destroy();
      return;
    }
    v.sink.write(chunk);
  }
}
