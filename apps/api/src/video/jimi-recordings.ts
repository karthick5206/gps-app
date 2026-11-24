import type { VideoRecordingDto } from '@veetracer/shared';

/**
 * Jimi dashcam SD-card recordings (JC400 / JC261). `FILELIST` makes the camera POST its playback name list to the
 * `FILELIST,<url>` server; `REPLAYLIST,<names>` pushes those files over RTMP to `rtmp://…/live/<imei>` (no channel).
 * General recording names: `<yyyy>_<mm>_<dd>_<hh>_<mi>_<ss>_<code>.mp4`, local camera time; code (vendor event video
 * ID list): 01 front low quality (1-min files), 02 inward low, 03 front HD, 04 inward HD (3-min files).
 */
export interface JimiRecordingFile {
  name: string;
  /** Camera wall clock, YYYY-MM-DDTHH:mm:ss (company time zone). */
  localStart: string;
  /** 1 = road (front), 2 = driver (inward). */
  channel: number;
  hd: boolean;
  durationSec: number;
}

export function parseJimiRecordingName(name: string): JimiRecordingFile | null {
  const m = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2,3})\.(mp4|ts|avi)$/i.exec(name.trim());
  if (!m) return null;
  const code = Number(m[7]);
  const channel = code % 2 === 1 ? 1 : 2;
  const hd = code === 3 || code === 4;
  return { name: name.trim(), localStart: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, channel, hd, durationSec: hd ? 180 : 60 };
}

/** Name list as posted (comma separated string or array) → parsed files, oldest first. */
export function parseJimiFileList(list: unknown): JimiRecordingFile[] {
  const names = Array.isArray(list) ? list.map(String) : typeof list === 'string' ? list.split(',') : [];
  return names
    .map(parseJimiRecordingName)
    .filter((f): f is JimiRecordingFile => !!f)
    .sort((a, b) => a.localStart.localeCompare(b.localStart));
}

/** Files of a channel overlapping [from, to] (UTC), as recordings; `toUtc` converts the camera's local time. */
export function jimiRecordings(files: JimiRecordingFile[], channel: number, from: Date, to: Date, toUtc: (local: string) => Date): (VideoRecordingDto & { fileName: string })[] {
  return files
    .filter((f) => channel === 0 || f.channel === channel)
    .map((f) => {
      const start = toUtc(f.localStart);
      return { f, start, end: new Date(start.getTime() + f.durationSec * 1000) };
    })
    .filter(({ start, end }) => end > from && start < to)
    .map(({ f, start, end }) => ({
      channel: f.channel,
      start: start.toISOString(),
      end: end.toISOString(),
      alarmFlags: '0',
      avType: 2,
      streamType: f.hd ? 1 : 2,
      storageType: 1,
      sizeBytes: 0,
      fileName: f.name,
    }));
}

/** At most `max` consecutive files of a channel covering [start, end] (REPLAYLIST takes several names). */
export function filesForPlayback(files: JimiRecordingFile[], channel: number, start: Date, end: Date, toUtc: (local: string) => Date, max = 5): string[] {
  return jimiRecordings(files, channel, start, end, toUtc)
    .slice(0, max)
    .map((r) => r.fileName);
}
