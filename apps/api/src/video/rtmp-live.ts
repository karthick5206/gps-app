import { get as httpGet } from 'node:http';

/**
 * RTMP live video for dashcams that push RTMP themselves (Jimi JC400 / JC261: `RTMP,ON,OUT|IN,<minutes>` sent over
 * the GT06 connection; the camera pushes to `rtmp://<host>:1935/live/<channel>/<imei>`). MediaMTX (MIT) receives the
 * push on :1935 and serves it as HLS on localhost; VideoController proxies the playlist and segments to the viewer.
 */
export const MEDIAMTX_API = process.env.MEDIAMTX_API_URL ?? 'http://127.0.0.1:9997';
export const MEDIAMTX_HLS = process.env.MEDIAMTX_HLS_URL ?? 'http://127.0.0.1:8888';
/** How long the camera streams after one request (the firmware stops by itself; 2–180 min). */
export const RTMP_LIVE_MINUTES = Math.min(180, Math.max(2, Number(process.env.JIMI_LIVE_MINUTES ?? 15)));

export interface MediaPath {
  name: string;
  ready: boolean;
  readyTime: string | null;
}

/** Camera word for the RTMP command: channel 1 = road (front, OUT), 2 = driver (inward, IN). */
export const rtmpCamera = (channel: number): 'OUT' | 'IN' => (channel === 2 ? 'IN' : 'OUT');

export const rtmpCommand = (channel: number, minutes = RTMP_LIVE_MINUTES) => `RTMP,ON,${rtmpCamera(channel)},${minutes}`;

/**
 * The ready stream path of a device (`live/<n>/<imei>`), preferring stream 0 (single-stream push). With `since`, only
 * a stream that became ready after the command was sent counts (the camera restarts its push when switching cameras).
 */
export function pickReadyPath(items: MediaPath[], imei: string, since?: number): string | null {
  const re = new RegExp(`^live/(\\d)/${imei}$`);
  const ready = items
    .filter((p) => p.ready && re.test(p.name))
    .filter((p) => since === undefined || (p.readyTime !== null && Date.parse(p.readyTime) >= since - 2_000))
    .sort((a, b) => a.name.localeCompare(b.name));
  return ready[0]?.name ?? null;
}

/** Recorded-video push (`REPLAYLIST`): the camera streams SD-card files to `live/<imei>` (no channel). */
export function pickPlaybackPath(items: MediaPath[], imei: string, since?: number): string | null {
  const name = `live/${imei}`;
  const p = items.find((i) => i.name === name && i.ready && (since === undefined || (i.readyTime !== null && Date.parse(i.readyTime) >= since - 2_000)));
  return p ? p.name : null;
}

/** MediaMTX /v3/paths/list (localhost API). Empty when MediaMTX is not running. */
export function listMediaPaths(base = MEDIAMTX_API): Promise<MediaPath[]> {
  return new Promise((resolve) => {
    const req = httpGet(`${base}/v3/paths/list?itemsPerPage=1000`, { timeout: 3_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        try {
          const items = (JSON.parse(body) as { items?: { name: string; ready?: boolean; readyTime?: string | null }[] }).items ?? [];
          resolve(items.map((i) => ({ name: i.name, ready: !!i.ready, readyTime: i.readyTime ?? null })));
        } catch {
          resolve([]);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve([]));
  });
}
