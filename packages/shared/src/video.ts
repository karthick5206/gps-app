/** Dashcam video (JT/T 1078): live and recorded streams served as HTTP-FLV through the API. */

export type VideoStreamType = 'main' | 'sub';
export type VideoCodec = 'unknown' | 'h264' | 'h265';
export type VideoSessionKind = 'live' | 'playback';
export type VideoSessionState = 'starting' | 'streaming' | 'closed';

/** Error codes in 4xx bodies (`code`), so clients can show a specific message. */
export const VIDEO_ERROR_CODES = ['DEVICE_OFFLINE', 'NOT_DASHCAM', 'STREAM_LIMIT', 'CODEC_UNSUPPORTED', 'DEVICE_REFUSED', 'DEVICE_TIMEOUT', 'VIDEO_DISABLED'] as const;
export type VideoErrorCode = (typeof VIDEO_ERROR_CODES)[number];

/** Default channel count when the device has not reported its AV attributes (0x1003). */
export const VIDEO_DEFAULT_CHANNELS = 4;
/** Recordings around an ADAS / DMS alert: ± this many minutes. */
export const VIDEO_ALERT_WINDOW_MIN = 2;

export interface StartLiveVideoRequest {
  channel: number;
  stream?: VideoStreamType;
}

export interface StartPlaybackRequest {
  channel: number;
  /** ISO instants. */
  start: string;
  end: string;
}

export interface VideoSessionDto {
  sessionId: string;
  kind: VideoSessionKind;
  channel: number;
  /** Relative HTTP-FLV URL with a short-lived token (`/api/video/streams/<id>.flv?token=…`). */
  url: string;
  codec: VideoCodec;
  /** When the token in `url` stops being accepted for new connections (the stream itself keeps playing). */
  expiresAt: string;
  /** True when this joined a live stream someone else had already started. */
  joined: boolean;
}

export interface VideoSessionStatusDto {
  sessionId: string;
  state: VideoSessionState;
  codec: VideoCodec;
  viewers: number;
  frames: number;
}

export interface VideoChannelsDto {
  channels: number[];
  /** `device` = reported by the dashcam (0x1003); `default` = assumed. */
  source: 'device' | 'default';
}

export interface VideoRecordingDto {
  channel: number;
  start: string | null;
  end: string | null;
  /** 64-bit alarm flags (hex); non-zero for event recordings. */
  alarmFlags: string;
  /** 0 audio+video, 1 audio, 2 video. */
  avType: number;
  /** 1 main, 2 sub. */
  streamType: number;
  /** 1 main storage, 2 disaster backup. */
  storageType: number;
  sizeBytes: number;
}
