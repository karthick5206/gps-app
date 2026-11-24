import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Jimi 4G dashcams (JC400 / JC261) upload event photos / clips over HTTP (`UPLOAD,<url>` command): multipart `file`,
 * `filename` (unique), `timestamp` (ms) and `sign` = Base64( md5_hex_lowercase( filename + timestamp + key ) ).
 * The key is fixed in the firmware; it is configured as JIMI_UPLOAD_KEY (not stored in the repository).
 */
export function jimiSign(filename: string, timestamp: string, key: string): string {
  const hex = createHash('md5').update(`${filename}${timestamp}${key}`, 'utf8').digest('hex');
  return Buffer.from(hex, 'utf8').toString('base64');
}

export function verifyJimiSign(filename: string, timestamp: string, sign: string, key: string): boolean {
  const expected = Buffer.from(jimiSign(filename, timestamp, key));
  const given = Buffer.from(sign.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface JimiFileName {
  imei: string;
  /** Device-local wall clock in the name (the camera's time zone), as YYYY-MM-DDTHH:mm:ss. */
  localTime: string | null;
  /** 1 = road (front) camera, 2 = driver (inward) camera, null = unknown. */
  channel: number | null;
}

/**
 * Event file names: `EVENT_<imei>_00000000_<yyyy>_<mm>_<dd>_<hh>_<mi>_<ss>[_<F|I>]_<code>.<ext>`
 * (e.g. EVENT_357730090564767_00000000_2021_01_29_07_28_18_F_05.mp4). The camera letter (F front / I inward) is
 * optional; without it the code's parity tells the camera (odd = front, even = inward, per the vendor's event video ID
 * list). Returns null for names without an IMEI.
 */
export function parseJimiFileName(name: string): JimiFileName | null {
  const m = /^[A-Z]+_(\d{15})_\d+_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})(?:_([FI]))?(?:_(\d+))?\./i.exec(name);
  if (!m) {
    const imei = /(?:^|_)(\d{15})(?:_|\.)/.exec(name)?.[1];
    return imei ? { imei, localTime: null, channel: null } : null;
  }
  const [, imei, y, mo, d, h, mi, s, cam, code] = m;
  const channel = cam ? (cam.toUpperCase() === 'F' ? 1 : 2) : code ? (Number(code) % 2 === 1 ? 1 : 2) : null;
  return { imei, localTime: `${y}-${mo}-${d}T${h}:${mi}:${s}`, channel };
}

const MIME: Record<string, string> = { mp4: 'video/mp4', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', h264: 'video/h264', avi: 'video/x-msvideo' };

export function jimiMime(name: string): string | null {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/** Wall-clock time in `timeZone` (IANA) → UTC. Iterates twice so DST edges settle (India has none). */
export function zonedToUtc(local: string, timeZone: string): Date {
  const asUtc = new Date(`${local}Z`);
  let guess = asUtc.getTime();
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(guess))
      .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    guess += asUtc.getTime() - shown;
  }
  return new Date(guess);
}
