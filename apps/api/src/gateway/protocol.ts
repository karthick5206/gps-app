import { NormalizedPosition } from '@veetracer/shared';

/**
 * Contract between the generic TCP server and one device protocol.
 *
 * The server owns sockets, buffering, timeouts, stats and publishing; a decoder is pure protocol logic:
 *  - `split` turns the accumulated byte stream into complete frames (handling fragmentation and garbage),
 *  - `decode` turns one frame into positions, reply bytes and identification (stored on the session).
 * Decoders must never throw for malformed device input they can skip; anything thrown is caught per frame by the
 * server (counted as an error, logged rate-limited) so one bad packet never kills the connection or the process.
 */

export interface BaseSession {
  /** IMEI (or other unique id) once the device identified itself; null before login. */
  uniqueId: string | null;
}

export interface SplitResult {
  /** Complete frames, in stream order. */
  frames: Buffer[];
  /** Unconsumed tail (incomplete frame); the server prepends it to the next chunk. */
  rest: Buffer;
  /** Garbage runs / corrupt frames skipped while splitting. */
  dropped: number;
  /** Set when the stream is unrecoverable (e.g. bad CRC on a protocol that expects a reconnect); the server closes. */
  fatal?: string;
}

export interface DecodeContext {
  receivedAt: Date;
  remote: string;
  /** Rate-limited log (and file capture) of a packet that could not be parsed, so new vendor variants can be adapted. */
  unparsed(reason: string, raw: Buffer, uniqueId?: string | null): void;
  /** Rate-limited warning. */
  warn(key: string, message: string): void;
}

export interface DecodeResult {
  positions: NormalizedPosition[];
  /** Bytes to write back to the device (ACKs), in order. */
  replies: Buffer[];
  /** Close the connection after writing the replies. */
  close?: boolean;
  /**
   * Replies to server commands. `ref` echoes the reference passed to `encodeCommand` when the protocol carries one
   * (GT06 server flag); null when it doesn't (Teltonika Codec 12), in which case the oldest pending command matches.
   */
  commandResponses?: { ref: number | null; text: string; data?: unknown }[];
}

export interface ProtocolDecoder<S extends BaseSession = BaseSession> {
  /** Lower-case protocol id, written to NormalizedPosition.protocol (e.g. `gt06`). */
  readonly name: string;
  /** Largest acceptable frame; longer declared frames are treated as garbage and the pending buffer is capped. */
  readonly maxFrameBytes: number;
  /** For text protocols whose terminator is optional: flush a pending tail after this much silence. */
  readonly flushAfterMs?: number;
  createSession(): S;
  split(buf: Buffer, session: S): SplitResult;
  flush?(rest: Buffer, session: S): SplitResult;
  decode(frame: Buffer, session: S, ctx: DecodeContext): DecodeResult;
  /** Frame carrying a text command to the device; `ref` is echoed in the reply where the protocol supports it. */
  encodeCommand?(text: string, session: S, ref: number): Buffer;
}

export const emptyResult = (): DecodeResult => ({ positions: [], replies: [] });
