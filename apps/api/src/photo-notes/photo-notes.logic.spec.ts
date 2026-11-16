import sharp from 'sharp';
import type { AuthContext } from '../access/auth-context';
import { encodePhoto } from './photo-notes.images';
import { canChange, moneyFields, parseBbox, parseMeta, photoNoteScope, PhotoNoteInputError, readExif, sniffImageType, validatePhotos } from './photo-notes.logic';
import { tzOffsetMinutes } from './photo-notes.service';

/** Little-endian TIFF with a GPS IFD (lat / lng in D M S) and an Exif IFD with DateTimeOriginal (+ optional offset). */
function exifBlock(opts: { lat: [number, number, number]; latRef: 'N' | 'S'; lng: [number, number, number]; lngRef: 'E' | 'W'; dt?: string; offset?: string; prefix?: boolean }): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  // Layout: IFD0 at 8 (2 entries), GPS IFD, Exif IFD, then the data area.
  const ifd0At = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const gpsAt = ifd0At + ifd0Size;
  const gpsSize = 2 + 4 * 12 + 4;
  const exifEntries = opts.offset ? 2 : 1;
  const exifAt = gpsAt + gpsSize;
  const exifSize = 2 + exifEntries * 12 + 4;
  let dataAt = exifAt + exifSize;
  const data: Buffer[] = [];
  const alloc = (b: Buffer) => {
    const at = dataAt;
    data.push(b);
    dataAt += b.length;
    return at;
  };
  const entry = (tag: number, type: number, count: number, value: number | Buffer) => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(type, 2);
    e.writeUInt32LE(count, 4);
    if (typeof value === 'number') e.writeUInt32LE(value, 8);
    else value.copy(e, 8);
    return e;
  };
  const rat = (v: [number, number, number]) => {
    const b = Buffer.alloc(24);
    v.forEach((x, i) => {
      b.writeUInt32LE(Math.round(x * 100), i * 8);
      b.writeUInt32LE(100, i * 8 + 4);
    });
    return b;
  };
  const shortAscii = (s: string) => Buffer.concat([Buffer.from(`${s}\0`, 'latin1'), Buffer.alloc(4)]).subarray(0, 4);
  const ifd = (entries: Buffer[]) => {
    const n = Buffer.alloc(2);
    n.writeUInt16LE(entries.length, 0);
    return Buffer.concat([n, ...entries, Buffer.alloc(4)]);
  };
  const latAt = alloc(rat(opts.lat));
  const lngAt = alloc(rat(opts.lng));
  const dtStr = Buffer.from(`${opts.dt ?? '2026:11:10 09:30:00'}\0`, 'latin1');
  const dtAt = alloc(dtStr);
  const offStr = opts.offset ? Buffer.from(`${opts.offset}\0`, 'latin1') : null;
  const offAt = offStr ? alloc(offStr) : 0;
  parts.push(header);
  parts.push(ifd([entry(0x8769, 4, 1, exifAt), entry(0x8825, 4, 1, gpsAt)]));
  parts.push(ifd([entry(1, 2, 2, shortAscii(opts.latRef)), entry(2, 5, 3, latAt), entry(3, 2, 2, shortAscii(opts.lngRef)), entry(4, 5, 3, lngAt)]));
  parts.push(ifd([entry(0x9003, 2, dtStr.length, dtAt), ...(offStr ? [entry(0x9011, 2, offStr.length, offAt)] : [])]));
  const tiff = Buffer.concat([...parts, ...data]);
  return opts.prefix === false ? tiff : Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

const ctx = (over: Partial<AuthContext>): AuthContext =>
  ({ userId: 'u1', homeCompanyId: 'c1', companyId: 'c1', isSuperAdmin: false, permissions: {}, dataScope: 'ASSIGNED', branchIds: ['b1'], objectIds: ['o1'], ip: null, ...over }) as AuthContext;

describe('photo note validation', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

  it('recognises JPEG / PNG / WebP by content, not by the declared type', () => {
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(webp)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('%PDF-1.4'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
  });

  it('accepts 1–5 photos up to 10 MB each', () => {
    expect(() => validatePhotos([{ buffer: jpeg }])).not.toThrow();
    expect(() => validatePhotos([])).toThrow('at least one');
    expect(() => validatePhotos(undefined)).toThrow(PhotoNoteInputError);
    expect(() => validatePhotos(Array.from({ length: 6 }, () => ({ buffer: jpeg })))).toThrow('at most 5');
    expect(() => validatePhotos([{ buffer: Buffer.concat([jpeg, Buffer.alloc(10 * 1024 * 1024)]) }])).toThrow('10 MB');
    expect(() => validatePhotos([{ buffer: Buffer.from('%PDF-1.4'), mimetype: 'image/jpeg' }])).toThrow('JPEG, PNG or WebP');
  });

  it('parses the multipart fields', () => {
    const now = Date.parse('2026-11-15T10:00:00Z');
    const m = parseMeta({ clientId: '3f1a2b3c-1111-4222-8333-444455556666', lat: '13.0827', lng: '80.2707', accuracyM: '12.34', category: 'bill', note: '  Lunch  ', amountMinor: '45000', takenAt: '2026-11-15T09:00:00Z' }, now);
    expect(m).toMatchObject({ lat: 13.0827, lng: 80.2707, accuracyM: 12.3, category: 'BILL', note: 'Lunch', amountMinor: 45000, currency: 'INR' });
    expect(m.takenAt?.toISOString()).toBe('2026-11-15T09:00:00.000Z');
    expect(parseMeta({}, now)).toMatchObject({ category: 'OTHER', lat: null, lng: null, clientId: null });
  });

  it('refuses bad fields', () => {
    const now = Date.parse('2026-11-15T10:00:00Z');
    expect(() => parseMeta({ category: 'SELFIE' }, now)).toThrow('category');
    expect(() => parseMeta({ lat: '13' }, now)).toThrow('both');
    expect(() => parseMeta({ lat: '95', lng: '80' }, now)).toThrow('not valid');
    expect(() => parseMeta({ lat: '0', lng: '0' }, now)).toThrow('not valid');
    expect(() => parseMeta({ lat: 'abc', lng: '80' }, now)).toThrow('not a number');
    expect(() => parseMeta({ takenAt: '2026-11-16T10:00:00Z' }, now)).toThrow('plausible');
    expect(() => parseMeta({ clientId: 'x' }, now)).toThrow('client id');
    expect(() => parseMeta({ objectId: 'nope' }, now)).toThrow();
    expect(() => parseMeta({ note: 'x'.repeat(1001) }, now)).toThrow('1000');
    expect(() => parseMeta({ category: 'BILL', amountMinor: '12.5' }, now)).toThrow('amount');
  });

  it('keeps an amount only on bills and receipts', () => {
    expect(moneyFields('VISIT', 500, 'INR')).toEqual({ amountMinor: null, currency: null });
    expect(moneyFields('RECEIPT', 500, null)).toEqual({ amountMinor: 500, currency: 'INR' });
    expect(moneyFields('BILL', 500, 'usd')).toEqual({ amountMinor: 500, currency: 'USD' });
    expect(() => moneyFields('BILL', 0, null)).toThrow();
    expect(() => moneyFields('BILL', 500, 'RUPEES')).toThrow('currency');
  });

  it('parses a bbox', () => {
    expect(parseBbox('80.1,12.9,80.3,13.2')).toEqual({ minLng: 80.1, minLat: 12.9, maxLng: 80.3, maxLat: 13.2 });
    expect(() => parseBbox('1,2,3')).toThrow();
    expect(() => parseBbox('80.3,12.9,80.1,13.2')).toThrow('Invalid bbox');
  });
});

describe('EXIF', () => {
  it('reads GPS and DateTimeOriginal (company zone when no offset is recorded)', () => {
    const e = readExif(exifBlock({ lat: [13, 4, 57.72], latRef: 'N', lng: [80, 16, 14.52], lngRef: 'E' }));
    expect(e.lat).toBeCloseTo(13.0827, 4);
    expect(e.lng).toBeCloseTo(80.2707, 4);
    // 09:30 IST = 04:00 UTC
    expect(e.takenAt?.toISOString()).toBe('2026-11-10T04:00:00.000Z');
  });

  it('honours S / W and OffsetTimeOriginal, with or without the Exif prefix', () => {
    const e = readExif(exifBlock({ lat: [33, 52, 0], latRef: 'S', lng: [151, 12, 36], lngRef: 'W', offset: '+11:00', prefix: false }));
    expect(e.lat).toBeCloseTo(-33.8667, 4);
    expect(e.lng).toBeCloseTo(-151.21, 4);
    expect(e.takenAt?.toISOString()).toBe('2026-11-09T22:30:00.000Z');
  });

  it('gives nulls for missing or broken blocks', () => {
    expect(readExif(undefined)).toEqual({ lat: null, lng: null, takenAt: null });
    expect(readExif(Buffer.from('Exif\0\0garbage-garbage'))).toEqual({ lat: null, lng: null, takenAt: null });
    const cut = exifBlock({ lat: [13, 0, 0], latRef: 'N', lng: [80, 0, 0], lngRef: 'E' }).subarray(0, 40);
    expect(() => readExif(cut)).not.toThrow();
  });

  it('works out a zone offset', () => {
    expect(tzOffsetMinutes('Asia/Kolkata')).toBe(330);
    expect(tzOffsetMinutes('UTC')).toBe(0);
  });
});

describe('re-encode', () => {
  jest.setTimeout(30_000);

  it('shrinks to 1920 px + a 320 px thumbnail, JPEG, and strips EXIF', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 200, g: 50, b: 50 } } })
      .withExif({ IFD0: { Copyright: 'owner secret', Artist: 'someone' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(big).metadata()).exif).toBeDefined();
    const out = await encodePhoto(big);
    expect([out.width, out.height]).toEqual([1920, 1440]);
    const full = await sharp(out.full).metadata();
    const thumb = await sharp(out.thumb).metadata();
    expect(full.format).toBe('jpeg');
    expect([full.width, full.height]).toEqual([1920, 1440]);
    expect([thumb.width, thumb.height]).toEqual([320, 240]);
    expect(full.exif).toBeUndefined();
    expect(thumb.exif).toBeUndefined();
  });

  it('never enlarges, turns PNG with transparency into JPEG', async () => {
    const png = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await encodePhoto(png);
    expect([out.width, out.height]).toEqual([200, 100]);
    expect((await sharp(out.full).metadata()).format).toBe('jpeg');
  });

  it('refuses a file that is not an image', async () => {
    await expect(encodePhoto(Buffer.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]))).rejects.toThrow();
  });
});

describe('visibility scope', () => {
  it('without view: only the caller’s own notes in the acting company', () => {
    expect(photoNoteScope(ctx({ permissions: { photo_notes: ['create'] } }))).toEqual({ companyId: 'c1', deletedAt: null, userId: 'u1' });
  });

  it('with view and company scope: every note of the company', () => {
    const w = photoNoteScope(ctx({ dataScope: 'COMPANY', permissions: { photo_notes: ['view'] } }));
    expect(w).toEqual({ companyId: 'c1', deletedAt: null, OR: [{ userId: 'u1' }, { companyId: 'c1' }] });
  });

  it('with view and assigned scope: own + objects in scope + object-less notes of visible users', () => {
    const w = photoNoteScope(ctx({ permissions: { photo_notes: ['view'] } }));
    expect(w.companyId).toBe('c1');
    expect(w.deletedAt).toBeNull();
    expect(w.OR).toEqual([
      { userId: 'u1' },
      { object: { is: { companyId: 'c1', OR: [{ branchId: { in: ['b1'] } }, { id: { in: ['o1'] } }] } } },
      { objectId: null, user: { is: { companyId: 'c1', OR: [{ id: 'u1' }, { branches: { some: { branchId: { in: ['b1'] } } } }] } } },
    ]);
  });

  it('own notes change with create; other people’s need edit / delete', () => {
    const creator = ctx({ permissions: { photo_notes: ['view', 'create'] } });
    expect(canChange(creator, { userId: 'u1' }, 'edit')).toBe(true);
    expect(canChange(creator, { userId: 'u1' }, 'delete')).toBe(true);
    expect(canChange(creator, { userId: 'u2' }, 'edit')).toBe(false);
    expect(canChange(creator, { userId: null }, 'delete')).toBe(false);
    const manager = ctx({ permissions: { photo_notes: ['view', 'edit', 'delete'] } });
    expect(canChange(manager, { userId: 'u2' }, 'edit')).toBe(true);
    expect(canChange(manager, { userId: null }, 'delete')).toBe(true);
    expect(canChange(ctx({ permissions: { photo_notes: ['view'] } }), { userId: 'u1' }, 'edit')).toBe(false);
  });
});
