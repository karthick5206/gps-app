/**
 * Minimal FLV muxer for HTTP-FLV live streams (no ffmpeg): H.264 video (AVC sequence header from SPS/PPS + NALU
 * tags, composition time 0) and optional G.711 A-law audio (sound format 7, 8 kHz mono).
 */

export const FlvTagType = { AUDIO: 8, VIDEO: 9, SCRIPT: 18 } as const;

/** NAL unit types (H.264). */
export const Nal = { NON_IDR: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9 } as const;

/** Splits an Annex-B byte stream (00 00 01 / 00 00 00 01 start codes) into NAL units without start codes. */
export function splitAnnexB(data: Buffer): Buffer[] {
  const starts: { at: number; len: number }[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        starts.push({ at: i, len: 3 });
        i += 2;
      } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
        starts.push({ at: i, len: 4 });
        i += 3;
      }
    }
  }
  if (!starts.length) return data.length ? [data] : [];
  const nals: Buffer[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k].at + starts[k].len;
    const to = k + 1 < starts.length ? starts[k + 1].at : data.length;
    if (to > from) nals.push(data.subarray(from, to));
  }
  return nals;
}

export const nalType = (nal: Buffer) => nal[0] & 0x1f;

/** FLV file header (version 1) + PreviousTagSize0. */
export function flvHeader(hasVideo = true, hasAudio = false): Buffer {
  const b = Buffer.alloc(13);
  b.write('FLV', 0, 'latin1');
  b[3] = 1;
  b[4] = (hasAudio ? 0x04 : 0) | (hasVideo ? 0x01 : 0);
  b.writeUInt32BE(9, 5);
  b.writeUInt32BE(0, 9);
  return b;
}

/** One FLV tag followed by its PreviousTagSize. `timestamp` in ms (32-bit, extended byte used above 24 bits). */
export function flvTag(type: number, timestamp: number, data: Buffer): Buffer {
  const ts = Math.max(0, Math.floor(timestamp)) >>> 0;
  const b = Buffer.alloc(11 + data.length + 4);
  b[0] = type;
  b.writeUIntBE(data.length, 1, 3);
  b.writeUIntBE(ts & 0xffffff, 4, 3);
  b[7] = (ts >>> 24) & 0xff;
  b.writeUIntBE(0, 8, 3);
  data.copy(b, 11);
  b.writeUInt32BE(11 + data.length, 11 + data.length);
  return b;
}

/** AVCDecoderConfigurationRecord (ISO 14496-15) from one SPS and one PPS. */
export function avcDecoderConfig(sps: Buffer, pps: Buffer): Buffer {
  const b = Buffer.alloc(11 + sps.length + pps.length);
  b[0] = 1; // configurationVersion
  b[1] = sps[1]; // AVCProfileIndication
  b[2] = sps[2]; // profile_compatibility
  b[3] = sps[3]; // AVCLevelIndication
  b[4] = 0xff; // 6 bits reserved + lengthSizeMinusOne = 3
  b[5] = 0xe1; // 3 bits reserved + 1 SPS
  b.writeUInt16BE(sps.length, 6);
  sps.copy(b, 8);
  let o = 8 + sps.length;
  b[o++] = 1; // 1 PPS
  b.writeUInt16BE(pps.length, o);
  pps.copy(b, o + 2);
  return b;
}

/** VIDEODATA body for the AVC sequence header (frame type 1 key, codec 7 AVC, packet type 0). */
export function avcSequenceHeaderBody(sps: Buffer, pps: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x17, 0x00, 0, 0, 0]), avcDecoderConfig(sps, pps)]);
}

/** VIDEODATA body for one access unit: 4-byte length-prefixed NAL units, composition time 0. */
export function avcNaluBody(nals: Buffer[], keyframe: boolean): Buffer {
  const size = nals.reduce((s, n) => s + 4 + n.length, 0);
  const b = Buffer.alloc(5 + size);
  b[0] = keyframe ? 0x17 : 0x27;
  b[1] = 0x01;
  let o = 5;
  for (const n of nals) {
    b.writeUInt32BE(n.length, o);
    n.copy(b, o + 4);
    o += 4 + n.length;
  }
  return b;
}

/** AUDIODATA body for G.711 A-law, 8 kHz, 16-bit (decoded), mono: flags 0x72. */
export function g711aBody(samples: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x72]), samples]);
}

/** One video access unit ready to mux: NAL units (SPS/PPS/AUD stripped) and whether it starts a GOP. */
export interface AvcAccessUnit {
  timestamp: number;
  keyframe: boolean;
  nals: Buffer[];
}

/**
 * Turns Annex-B frames into access units and tracks the latest SPS / PPS. Returns null for frames that carry
 * only parameter sets (or nothing decodable).
 */
export class AvcParser {
  sps: Buffer | null = null;
  pps: Buffer | null = null;
  /** True when SPS/PPS changed since the last sequence header was taken. */
  configChanged = false;

  push(data: Buffer, timestamp: number): AvcAccessUnit | null {
    const nals: Buffer[] = [];
    let keyframe = false;
    for (const nal of splitAnnexB(data)) {
      const t = nalType(nal);
      if (t === Nal.SPS) {
        if (!this.sps || !this.sps.equals(nal)) this.configChanged = true;
        this.sps = Buffer.from(nal);
      } else if (t === Nal.PPS) {
        if (!this.pps || !this.pps.equals(nal)) this.configChanged = true;
        this.pps = Buffer.from(nal);
      } else if (t === Nal.AUD) {
        continue;
      } else {
        if (t === Nal.IDR) keyframe = true;
        nals.push(nal);
      }
    }
    if (!nals.some((n) => nalType(n) === Nal.IDR || nalType(n) === Nal.NON_IDR || (nalType(n) >= 2 && nalType(n) <= 4))) return null;
    return { timestamp, keyframe, nals };
  }

  sequenceHeader(): Buffer | null {
    if (!this.sps || !this.pps) return null;
    this.configChanged = false;
    return avcSequenceHeaderBody(this.sps, this.pps);
  }
}
