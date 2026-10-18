import {
  BASE_RATE,
  PLAYBACK_RATES,
  realToVirtual,
  sampleAt,
  virtualToReal,
  type PlaybackRate,
  type Sample,
  type TrackIndex,
} from './playback-core';

export interface PlaybackState {
  playing: boolean;
  rate: PlaybackRate;
  /** True once the cursor reached the end (Play then restarts). */
  ended: boolean;
  /** Bumped on every seek/pause so React can react to discrete cursor moves (not per frame). */
  seekVersion: number;
}

export type FrameListener = (sample: Sample, info: { playing: boolean; force: boolean }) => void;

const FRAME_STATS = 240;

/**
 * Drives playback outside React: requestAnimationFrame advances playback time, maps it to real time
 * (binary search on the precomputed index) and hands the interpolated sample to imperative listeners
 * (map, timeline cursor, data panel). React only sees discrete state (playing / rate / ended / seeks).
 */
export class PlaybackEngine {
  private idx: TrackIndex;
  private v = 0; // playback time (ms since start, compressed axis)
  private hintT = -1;
  private raf = 0;
  private last = 0;
  private state: PlaybackState = { playing: false, rate: 1, ended: false, seekVersion: 0 };
  private readonly stateListeners = new Set<() => void>();
  private readonly frameListeners = new Set<FrameListener>();
  private current: Sample;
  /** Recent frame intervals (ms) for diagnostics (exposed on window in dev). */
  readonly frameTimes = new Float32Array(FRAME_STATS);
  /** Time spent in our per-frame work (sampling + listeners incl. MapLibre source updates), ms. */
  readonly workTimes = new Float32Array(FRAME_STATS);
  private frameCount = 0;
  /** End of the play window (real ms); null = end of track. Used by "play this trip". */
  private stopAt: number | null = null;

  constructor(idx: TrackIndex) {
    this.idx = idx;
    this.current = sampleAt(idx, idx.start);
  }

  get index() {
    return this.idx;
  }

  /** Swaps the index (e.g. skip-stops toggled) keeping the real-time cursor. */
  setIndex(idx: TrackIndex) {
    const t = this.current.t;
    this.idx = idx;
    this.hintT = -1;
    this.v = realToVirtual(idx, t);
    this.emitFrame(true);
  }

  getState = (): PlaybackState => this.state;
  getSample = (): Sample => this.current;

  subscribe = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  /** Registers an imperative per-frame listener and immediately calls it with the current sample. */
  onFrame(listener: FrameListener) {
    this.frameListeners.add(listener);
    listener(this.current, { playing: this.state.playing, force: true });
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  private setState(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((l) => l());
  }

  play() {
    if (this.idx.n < 2) return;
    if (this.state.ended || this.v >= this.idx.duration) {
      this.v = 0;
      this.hintT = -1;
      this.stopAt = null;
    }
    this.setState({ playing: true, ended: false });
    this.last = 0;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    if (!this.state.playing) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stopAt = null;
    this.setState({ playing: false, seekVersion: this.state.seekVersion + 1 });
    this.emitFrame(true);
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  setRate(rate: PlaybackRate) {
    if (PLAYBACK_RATES.includes(rate)) this.setState({ rate });
  }

  /** Moves the cursor to real time `t`; keeps playing if it was. `until` limits playback to a window. */
  seek(t: number, { play = false, until = null }: { play?: boolean; until?: number | null } = {}) {
    const clamped = Math.min(Math.max(t, this.idx.start), this.idx.end);
    this.v = realToVirtual(this.idx, clamped);
    this.hintT = -1;
    this.stopAt = until;
    this.setState({ ended: false, seekVersion: this.state.seekVersion + 1 });
    this.emitFrame(true);
    if (play) this.play();
  }

  /** Steps by `deltaMs` of real time. */
  step(deltaMs: number) {
    this.seek(this.current.t + deltaMs, { play: this.state.playing });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.frameListeners.clear();
    this.stateListeners.clear();
  }

  private emitFrame(force: boolean) {
    const t = virtualToReal(this.idx, this.v);
    const s = sampleAt(this.idx, t, this.hintT);
    this.hintT = s.i;
    this.current = s;
    const info = { playing: this.state.playing, force };
    for (const l of this.frameListeners) l(s, info);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (!this.state.playing) return;
    const dt = this.last ? Math.min(now - this.last, 100) : 0; // clamp after tab switches
    if (this.last) this.frameTimes[this.frameCount++ % FRAME_STATS] = now - this.last;
    this.last = now;
    this.v += dt * BASE_RATE * this.state.rate;
    let finished = false;
    if (this.v >= this.idx.duration) {
      this.v = this.idx.duration;
      finished = true;
    }
    const w0 = performance.now();
    this.emitFrame(false);
    this.workTimes[(this.frameCount + FRAME_STATS - 1) % FRAME_STATS] = performance.now() - w0;
    if (this.stopAt !== null && this.current.t >= this.stopAt) finished = true;
    if (finished) {
      this.stopAt = null;
      this.setState({ playing: false, ended: this.v >= this.idx.duration, seekVersion: this.state.seekVersion + 1 });
      this.emitFrame(true);
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Mean / p95 / max of the recorded frame intervals. */
  frameStats() {
    const n = Math.min(this.frameCount, FRAME_STATS);
    if (!n) return null;
    const stats = (src: Float32Array) => {
      const arr = Array.from(src.slice(0, n)).sort((a, b) => a - b);
      return { mean: arr.reduce((a, b) => a + b, 0) / n, p95: arr[Math.floor(n * 0.95)] ?? arr[n - 1], max: arr[n - 1] };
    };
    return { frames: this.frameCount, interval: stats(this.frameTimes), work: stats(this.workTimes) };
  }
}
