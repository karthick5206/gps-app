/** Pure helpers for the dashcam video UI (unit-tested with node --test). */

/** Recordings window around an alert: ± `minutes` (default 2). */
export function alertWindow(at: string | Date, minutes = 2): { from: Date; to: Date } {
  const t = typeof at === 'string' ? Date.parse(at) : at.getTime();
  return { from: new Date(t - minutes * 60_000), to: new Date(t + minutes * 60_000) };
}

/** Grid columns for n live tiles: 1 → 1, 2 → 2, 3–4 → 2, 5–9 → 3, more → 4. */
export function gridColumns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

/** File size for the recordings list. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** True when any of the 64 alarm bits of a 0x1205 item is set (event recording). */
export function isAlarmRecording(alarmFlagsHex: string): boolean {
  return /[1-9a-f]/i.test(alarmFlagsHex);
}

/** Clamp a recording to the requested window so playback starts near the alert, not at the file start. */
export function playbackRange(
  rec: { start: string | null; end: string | null },
  window?: { from: Date; to: Date } | null,
): { start: string; end: string } | null {
  if (!rec.start) return null;
  let start = Date.parse(rec.start);
  let end = rec.end ? Date.parse(rec.end) : start + 60_000;
  if (window) {
    start = Math.max(start, window.from.getTime());
    end = Math.min(end, window.to.getTime());
    if (end <= start) return null;
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** URL (relative) of the video page for a vehicle, used by the alert action and the mobile app. */
export function videoPagePath(objectId: string, opts: { channel?: number; at?: string } = {}): string {
  const q = new URLSearchParams({ objectId });
  if (opts.channel) q.set('channel', String(opts.channel));
  if (opts.at) q.set('at', opts.at);
  return `/video?${q.toString()}`;
}

/** File name for a saved video frame: `<vehicle>_<yyyy-mm-dd_hh-mm-ss>.png` (UTC clock, safe characters only). */
export function frameFileName(vehicle: string, iso: string): string {
  const name =
    vehicle
      .trim()
      .replace(/[^\w-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'video';
  return `${name}_${iso.slice(0, 19).replace('T', '_').replace(/:/g, '-')}.png`;
}

/** Recorded playback window for SD-card cameras: from `start`, moved by `shiftMin` minutes, `lengthMin` long. */
export function shiftWindow(start: string, shiftMin: number, lengthMin = 5): { start: string; end: string } {
  const s = Date.parse(start) + shiftMin * 60_000;
  return { start: new Date(s).toISOString(), end: new Date(s + lengthMin * 60_000).toISOString() };
}

export interface TimelineSpan {
  channel: number;
  /** Position in the timeline, 0–1. */
  left: number;
  width: number;
  start: string;
  end: string;
  event: boolean;
}

/**
 * Recordings → coloured spans on a [from, to] timeline: files of one channel that follow each other (gap ≤ `joinSec`)
 * merge into one span; parts outside the window are cut off.
 */
export function timelineSpans(
  recs: { channel: number; start: string | null; end: string | null; alarmFlags: string }[],
  from: Date,
  to: Date,
  joinSec = 5,
): TimelineSpan[] {
  const t0 = from.getTime();
  const total = to.getTime() - t0;
  if (total <= 0) return [];
  const sorted = recs
    .filter((r) => r.start && r.end)
    .map((r) => ({
      channel: r.channel,
      s: Math.max(t0, Date.parse(r.start!)),
      e: Math.min(to.getTime(), Date.parse(r.end!)),
      event: isAlarmRecording(r.alarmFlags),
    }))
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.channel - b.channel || a.s - b.s);
  const out: { channel: number; s: number; e: number; event: boolean }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.channel === r.channel && last.event === r.event && r.s - last.e <= joinSec * 1000) last.e = Math.max(last.e, r.e);
    else out.push({ ...r });
  }
  return out.map((r) => ({
    channel: r.channel,
    left: (r.s - t0) / total,
    width: (r.e - r.s) / total,
    start: new Date(r.s).toISOString(),
    end: new Date(r.e).toISOString(),
    event: r.event,
  }));
}

/** The recording of `channel` that covers `at`, else the next one after it (click on the timeline → what to play). */
export function recordingAt<R extends { channel: number; start: string | null; end: string | null }>(recs: R[], channel: number, at: number): R | null {
  const mine = recs.filter((r) => r.channel === channel && r.start && r.end).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
  return mine.find((r) => Date.parse(r.start!) <= at && Date.parse(r.end!) > at) ?? mine.find((r) => Date.parse(r.start!) > at) ?? null;
}
