import { Prisma } from '@prisma/client';
import { PHOTO_NOTE_CATEGORIES, PHOTO_NOTE_MAX_BYTES, PHOTO_NOTE_MAX_PHOTOS, PHOTO_NOTE_MONEY_CATEGORIES, PHOTO_NOTE_NOTE_MAX, type PhotoNoteCategory } from '@veetracer/shared';
import { hasPermission, objectScopeWhere, userScopeWhere } from '../access/access-rules';
import type { AuthContext } from '../access/auth-context';

/** Pure helpers of the photo notes module (validation, EXIF, scope); unit-tested in photo-notes.logic.spec.ts. */

export class PhotoNoteInputError extends Error {}

export interface IncomingPhoto {
  buffer: Buffer;
  mimetype?: string;
  size?: number;
}

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** The real type of a photo by its first bytes (the declared mimetype is not trusted); null = not JPEG / PNG / WebP. */
export function sniffImageType(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  for (const [type, sig] of Object.entries(SIGNATURES)) if (sig(b)) return type as 'image/jpeg' | 'image/png' | 'image/webp';
  return null;
}

/** 1–5 photos, each JPEG / PNG / WebP (by content) and ≤ 10 MB. Throws PhotoNoteInputError with a user message. */
export function validatePhotos(files: IncomingPhoto[] | undefined): void {
  const list = files ?? [];
  if (!list.length) throw new PhotoNoteInputError('Add at least one photo');
  if (list.length > PHOTO_NOTE_MAX_PHOTOS) throw new PhotoNoteInputError(`Add at most ${PHOTO_NOTE_MAX_PHOTOS} photos`);
  for (const f of list) {
    if (!f.buffer?.length) throw new PhotoNoteInputError('A photo is empty');
    if (f.buffer.length > PHOTO_NOTE_MAX_BYTES) throw new PhotoNoteInputError('A photo is larger than 10 MB');
    if (!sniffImageType(f.buffer)) throw new PhotoNoteInputError('Upload photos (JPEG, PNG or WebP)');
  }
}

export interface RawMeta {
  clientId?: unknown;
  objectId?: unknown;
  takenAt?: unknown;
  lat?: unknown;
  lng?: unknown;
  accuracyM?: unknown;
  category?: unknown;
  note?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
  source?: unknown;
}

export interface PhotoNoteMeta {
  clientId: string | null;
  objectId: string | null;
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  category: PhotoNoteCategory;
  note: string | null;
  amountMinor: number | null;
  currency: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A client id: a UUID or a similar opaque token from the device. */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_AMOUNT_MINOR = 100_000_000;
/** The phone's clock may run a little ahead. */
const FUTURE_SKEW_MS = 10 * 60_000;
/** Offline queues can hold notes for a while, but not for years. */
const OLDEST_MS = 400 * 86_400_000;

const str = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' ? String(v) : null);

function num(v: unknown, label: string): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new PhotoNoteInputError(`${label} is not a number`);
  return n;
}

/** Multipart text fields → checked values. Location may be missing here (web: taken from EXIF later). */
export function parseMeta(raw: RawMeta, now = Date.now()): PhotoNoteMeta {
  const clientId = str(raw.clientId);
  if (clientId !== null && !CLIENT_ID_RE.test(clientId)) throw new PhotoNoteInputError('Invalid client id');
  const objectId = str(raw.objectId);
  if (objectId !== null && !UUID_RE.test(objectId)) throw new PhotoNoteInputError('Invalid person / vehicle');
  const category = (str(raw.category) ?? 'OTHER').toUpperCase() as PhotoNoteCategory;
  if (!PHOTO_NOTE_CATEGORIES.includes(category)) throw new PhotoNoteInputError('Choose a category');
  let takenAt: Date | null = null;
  const t = str(raw.takenAt);
  if (t !== null) {
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) throw new PhotoNoteInputError('Invalid time');
    if (ms > now + FUTURE_SKEW_MS || ms < now - OLDEST_MS) throw new PhotoNoteInputError('The time of the photo is not plausible');
    takenAt = new Date(ms);
  }
  const lat = num(raw.lat, 'Latitude');
  const lng = num(raw.lng, 'Longitude');
  if ((lat === null) !== (lng === null)) throw new PhotoNoteInputError('Send both latitude and longitude of the location');
  if (lat !== null && lng !== null) assertCoords(lat, lng);
  const acc = num(raw.accuracyM, 'Accuracy');
  const accuracyM = acc === null || acc < 0 ? null : Math.min(Math.round(acc * 10) / 10, 100_000);
  const note = str(raw.note);
  if (note && note.length > PHOTO_NOTE_NOTE_MAX) throw new PhotoNoteInputError(`The note is longer than ${PHOTO_NOTE_NOTE_MAX} characters`);
  const money = moneyFields(category, num(raw.amountMinor, 'Amount'), str(raw.currency));
  return { clientId, objectId, takenAt, lat, lng, accuracyM, category, note, ...money };
}

export function assertCoords(lat: number, lng: number): void {
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || (lat === 0 && lng === 0)) throw new PhotoNoteInputError('The location is not valid');
}

/** Amount only for BILL / RECEIPT: whole minor units, 1 … 10 crore paise; currency defaults to INR. */
export function moneyFields(category: PhotoNoteCategory, amountMinor: number | null, currency: string | null): { amountMinor: number | null; currency: string | null } {
  if (amountMinor === null || !PHOTO_NOTE_MONEY_CATEGORIES.includes(category)) return { amountMinor: null, currency: null };
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR) throw new PhotoNoteInputError('Enter a valid amount');
  const cur = (currency ?? 'INR').toUpperCase();
  if (!CURRENCY_RE.test(cur)) throw new PhotoNoteInputError('Invalid currency');
  return { amountMinor, currency: cur };
}

/** "minLng,minLat,maxLng,maxLat" → bounds; throws on anything else. */
export function parseBbox(s: string): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  const p = s.split(',').map((x) => Number(x.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) throw new PhotoNoteInputError('bbox must be minLng,minLat,maxLng,maxLat');
  const [minLng, minLat, maxLng, maxLat] = p;
  if (minLat > maxLat || minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180 || minLng > maxLng) throw new PhotoNoteInputError('Invalid bbox');
  return { minLng, minLat, maxLng, maxLat };
}

// ───────────── EXIF (GPS and time of a web upload) ─────────────

export interface ExifInfo {
  lat: number | null;
  lng: number | null;
  takenAt: Date | null;
}

/**
 * Reads GPS position and DateTimeOriginal from an EXIF block (as sharp's metadata().exif returns it: "Exif\0\0" + TIFF,
 * or the bare TIFF). Never throws: a broken block gives nulls. The time has no zone in EXIF; it is read in `tzOffsetMin`
 * (minutes east of UTC, default IST) unless OffsetTimeOriginal is present.
 */
export function readExif(buf: Buffer | undefined | null, tzOffsetMin = 330): ExifInfo {
  const none: ExifInfo = { lat: null, lng: null, takenAt: null };
  if (!buf || buf.length < 14) return none;
  try {
    const base = buf.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0;
    const order = buf.subarray(base, base + 2).toString('latin1');
    if (order !== 'II' && order !== 'MM') return none;
    const le = order === 'II';
    const u16 = (o: number) => (le ? buf.readUInt16LE(base + o) : buf.readUInt16BE(base + o));
    const u32 = (o: number) => (le ? buf.readUInt32LE(base + o) : buf.readUInt32BE(base + o));
    if (u16(2) !== 42) return none;
    type Entry = { tag: number; type: number; count: number; valueOff: number };
    const ifd = (off: number): Entry[] => {
      if (off <= 0 || base + off + 2 > buf.length) return [];
      const n = u16(off);
      const out: Entry[] = [];
      for (let i = 0; i < n && i < 512; i++) {
        const e = off + 2 + i * 12;
        if (base + e + 12 > buf.length) break;
        const type = u16(e + 2);
        const count = u32(e + 4);
        const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
        out.push({ tag: u16(e), type, count, valueOff: size * count > 4 ? u32(e + 8) : e + 8 });
      }
      return out;
    };
    const ascii = (e: Entry | undefined) => (e && e.type === 2 && base + e.valueOff + e.count <= buf.length ? buf.subarray(base + e.valueOff, base + e.valueOff + e.count).toString('latin1').replace(/\0+$/, '') : null);
    const rationals = (e: Entry | undefined) => {
      if (!e || e.type !== 5 || base + e.valueOff + e.count * 8 > buf.length) return null;
      const out: number[] = [];
      for (let i = 0; i < e.count; i++) {
        const d = u32(e.valueOff + i * 8 + 4);
        out.push(d ? u32(e.valueOff + i * 8) / d : NaN);
      }
      return out;
    };
    const ifd0 = ifd(u32(4));
    const exifPtr = ifd0.find((e) => e.tag === 0x8769);
    const gpsPtr = ifd0.find((e) => e.tag === 0x8825);
    let lat: number | null = null;
    let lng: number | null = null;
    if (gpsPtr) {
      const g = ifd(u32(gpsPtr.valueOff));
      const dms = (r: number[] | null) => (r && r.length >= 3 && r.every(Number.isFinite) ? r[0] + r[1] / 60 + r[2] / 3600 : null);
      const la = dms(rationals(g.find((e) => e.tag === 2)));
      const lo = dms(rationals(g.find((e) => e.tag === 4)));
      const laRef = ascii(g.find((e) => e.tag === 1));
      const loRef = ascii(g.find((e) => e.tag === 3));
      if (la !== null && lo !== null) {
        const y = laRef === 'S' ? -la : la;
        const x = loRef === 'W' ? -lo : lo;
        if (y >= -90 && y <= 90 && x >= -180 && x <= 180 && !(y === 0 && x === 0)) {
          lat = Math.round(y * 1e7) / 1e7;
          lng = Math.round(x * 1e7) / 1e7;
        }
      }
    }
    let takenAt: Date | null = null;
    const sub = exifPtr ? ifd(u32(exifPtr.valueOff)) : [];
    const dt = ascii(sub.find((e) => e.tag === 0x9003)) ?? ascii(ifd0.find((e) => e.tag === 0x0132));
    const m = dt ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dt) : null;
    if (m) {
      const offStr = ascii(sub.find((e) => e.tag === 0x9011));
      const om = offStr ? /^([+-])(\d{2}):(\d{2})$/.exec(offStr) : null;
      const off = om ? (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) : tzOffsetMin;
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60_000;
      if (Number.isFinite(ms) && +m[1] > 1990) takenAt = new Date(ms);
    }
    return { lat, lng, takenAt };
  } catch {
    return none;
  }
}

// ───────────── visibility ─────────────

type ScopeCtx = Pick<AuthContext, 'companyId' | 'userId' | 'dataScope' | 'branchIds' | 'objectIds' | 'permissions'>;

/**
 * Notes the caller may see (never deleted ones, always the acting company only):
 * - their own uploads;
 * - with `photo_notes: view`: notes of the objects in their data scope, and notes without an object uploaded by users
 *   they may see (whole company in COMPANY scope).
 */
export function photoNoteScope(ctx: ScopeCtx): Prisma.GeoPhotoNoteWhereInput {
  const own: Prisma.GeoPhotoNoteWhereInput = { userId: ctx.userId };
  if (!hasPermission(ctx, 'photo_notes', 'view')) return { companyId: ctx.companyId, deletedAt: null, ...own };
  const others: Prisma.GeoPhotoNoteWhereInput[] =
    ctx.dataScope === 'COMPANY' ? [{ companyId: ctx.companyId }] : [{ object: { is: objectScopeWhere(ctx) } }, { objectId: null, user: { is: userScopeWhere(ctx) } }];
  return { companyId: ctx.companyId, deletedAt: null, OR: [own, ...others] };
}

/** Own notes need `create` (or edit / delete); other people's visible notes need `edit` / `delete`. */
export function canChange(ctx: Pick<AuthContext, 'userId' | 'permissions'>, note: { userId: string | null }, action: 'edit' | 'delete'): boolean {
  if (hasPermission(ctx, 'photo_notes', action)) return true;
  return note.userId === ctx.userId && hasPermission(ctx, 'photo_notes', 'create');
}
