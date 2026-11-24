import type { VideoRecordingDto, VideoSessionDto } from '@veetracer/shared';
import type { VideoSource } from 'expo-video';
import type { TFunction } from 'i18next';
import { ApiError, errorMessage } from '@/lib/api';
import { serverUrl } from '@/lib/config';

/**
 * Dashcam video helpers for the native screens (same rules as the web's features/video/video-utils.ts; kept here
 * because the web helpers live in the web app).
 */

export const absoluteUrl = (url: string): string => (/^https?:\/\//.test(url) ? url : `${serverUrl()}${url}`);

/** Player source for a session: HLS for RTMP cameras (Jimi), progressive HTTP-FLV for JT/T 1078 dashcams. */
export function sessionSource(s: VideoSessionDto): VideoSource {
  return { uri: absoluteUrl(s.url), contentType: /\.m3u8(\?|$)/.test(s.url) ? 'hls' : 'progressive' };
}

/** Clip / photo the phone can play: MP4, and MPEG-TS minutes downloaded from Jimi SD cards (ExoPlayer / AVPlayer). */
export const phonePlayable = (mime: string): boolean => mime === 'video/mp4' || mime === 'video/mp2t';

export function videoErrorText(t: TFunction, err: unknown): string {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case 'DEVICE_OFFLINE':
      return t('The dashcam is offline. Video needs the device to be connected.');
    case 'NOT_DASHCAM':
      return t('This vehicle has no dashcam with video.');
    case 'STREAM_LIMIT':
      return t('Too many videos are playing right now. Close another video and try again.');
    case 'CODEC_UNSUPPORTED':
      return t('This camera sends H.265 video, which cannot be played here. Set the dashcam to H.264.');
    case 'DEVICE_TIMEOUT':
      return err instanceof ApiError && err.message ? err.message : t('The dashcam did not answer. Check that it is online and try again.');
    case 'DEVICE_REFUSED':
      return err instanceof ApiError && err.message ? err.message : t('The dashcam refused the request.');
    case 'VIDEO_DISABLED':
      return t('Video is not enabled on the server.');
    default:
      return errorMessage(err);
  }
}

/** 1 = road (front), 2 = driver (inward) on Jimi and most dashcams. */
export function channelName(t: TFunction, ch: number): string {
  return ch === 1 ? t('Road camera') : ch === 2 ? t('Driver camera') : t('CH{{n}}', { n: ch });
}

export function isAlarmRecording(alarmFlagsHex: string): boolean {
  return /[1-9a-f]/i.test(alarmFlagsHex);
}

export interface TimelineSpan {
  channel: number;
  left: number;
  width: number;
  event: boolean;
}

/** Recordings → spans on a [from, to] timeline (0–1); back-to-back files of a camera merge. */
export function timelineSpans(recs: VideoRecordingDto[], from: number, to: number, joinSec = 5): TimelineSpan[] {
  const total = to - from;
  if (total <= 0) return [];
  const sorted = recs
    .filter((r) => r.start && r.end)
    .map((r) => ({ channel: r.channel, s: Math.max(from, Date.parse(r.start!)), e: Math.min(to, Date.parse(r.end!)), event: isAlarmRecording(r.alarmFlags) }))
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.channel - b.channel || a.s - b.s);
  const out: { channel: number; s: number; e: number; event: boolean }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.channel === r.channel && last.event === r.event && r.s - last.e <= joinSec * 1000) last.e = Math.max(last.e, r.e);
    else out.push({ ...r });
  }
  return out.map((r) => ({ channel: r.channel, left: (r.s - from) / total, width: (r.e - r.s) / total, event: r.event }));
}

/** The recording of `channel` covering `at`, else the next one. */
export function recordingAt(recs: VideoRecordingDto[], channel: number, at: number): VideoRecordingDto | null {
  const mine = recs.filter((r) => r.channel === channel && r.start && r.end).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
  return mine.find((r) => Date.parse(r.start!) <= at && Date.parse(r.end!) > at) ?? mine.find((r) => Date.parse(r.start!) > at) ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Local clock time "14:05" (timeline ticks). */
export const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Local clock time with seconds "14:05:09". */
export const hhmmss = (ms: number): string => `${hhmm(ms)}:${pad(new Date(ms).getSeconds())}`;
