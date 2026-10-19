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
export function playbackRange(rec: { start: string | null; end: string | null }, window?: { from: Date; to: Date } | null): { start: string; end: string } | null {
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
