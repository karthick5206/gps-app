import { BadRequestException, NotFoundException } from '@nestjs/common';
import sharp from 'sharp';
import { AuthContext } from '../access/auth-context';
import { REQUIRED_PERMISSIONS } from '../access/decorators';
import { assertPhotoType, parsePhotoSize, photoScopeWhere, trackerPhotoTarget, TrackerDeviceRow } from './object-photo-access';
import { encodePhoto, validatePhoto } from './object-photo-image';
import { ObjectPhotosController } from './object-photos.controller';
import { ObjectPhotosService } from './object-photos.service';

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OBJ = '33333333-3333-4333-8333-333333333333';

const ctx = (over: Partial<AuthContext> = {}): AuthContext =>
  ({ userId: 'u1', homeCompanyId: CO, companyId: CO, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null, ...over }) as AuthContext;

async function jpegWithGps(width = 400, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 4/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '80/1 14/1 0/1' } })
    .toBuffer();
}

describe('validatePhoto', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

  it('accepts JPEG, PNG and WebP whose content matches the declared type (image/jpg as JPEG)', () => {
    expect(validatePhoto({ buffer: jpeg, mimetype: 'image/jpeg' })).toBe('image/jpeg');
    expect(validatePhoto({ buffer: jpeg, mimetype: 'IMAGE/JPG' })).toBe('image/jpeg');
    expect(validatePhoto({ buffer: png, mimetype: 'image/png' })).toBe('image/png');
    expect(validatePhoto({ buffer: webp, mimetype: 'image/webp' })).toBe('image/webp');
  });

  it('refuses no file, an empty file, more than 5 MB, other types and a content / type mismatch', () => {
    expect(() => validatePhoto(undefined)).toThrow('Choose a photo');
    expect(() => validatePhoto({ buffer: Buffer.alloc(0), mimetype: 'image/png' })).toThrow('Choose a photo');
    expect(() => validatePhoto({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: 'image/jpeg' })).toThrow('larger than 5 MB');
    expect(() => validatePhoto({ buffer: jpeg, mimetype: 'image/heic' })).toThrow('JPEG, PNG or WebP');
    expect(() => validatePhoto({ buffer: jpeg, mimetype: 'image/gif' })).toThrow(BadRequestException);
    expect(() => validatePhoto({ buffer: png, mimetype: 'image/jpeg' })).toThrow('does not match');
    expect(() => validatePhoto({ buffer: Buffer.from('<svg/>'), mimetype: 'image/png' })).toThrow('does not match');
  });
});

describe('encodePhoto', () => {
  it('makes square 256 px and 64 px JPEGs, upright, with no EXIF / GPS left', async () => {
    const input = await jpegWithGps();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    const { full, thumb } = await encodePhoto(input);
    for (const [buf, size] of [[full, 256], [thumb, 64]] as const) {
      const m = await sharp(buf).metadata();
      expect(m.format).toBe('jpeg');
      expect([m.width, m.height]).toEqual([size, size]);
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(m.orientation).toBeUndefined();
      expect(buf.includes(Buffer.from('TestCam'))).toBe(false);
    }
  });

  it('flattens a transparent PNG onto white', async () => {
    const png = await sharp({ create: { width: 50, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const { thumb } = await encodePhoto(png);
    const { data } = await sharp(thumb).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  it('turns an unreadable file into a 400', async () => {
    await expect(encodePhoto(Buffer.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('photo access rules', () => {
  it('scopes to the caller company, their branches / objects, or every company in Super Admin "all" mode', () => {
    expect(photoScopeWhere(ctx(), OBJ)).toEqual({ AND: [{ companyId: CO }, { id: OBJ }] });
    expect(photoScopeWhere(ctx({ dataScope: 'ASSIGNED', branchIds: ['b1'], objectIds: ['o1'] }), OBJ)).toEqual({
      AND: [{ companyId: CO, OR: [{ branchId: { in: ['b1'] } }, { id: { in: ['o1'] } }] }, { id: OBJ }],
    });
    expect(photoScopeWhere(ctx({ isSuperAdmin: true, allCompanies: true }), OBJ)).toEqual({ AND: [{}, { id: OBJ }] });
  });

  it('never reaches a vehicle shared by another company', () => {
    const where = photoScopeWhere(ctx({ shares: [{ objectId: OBJ, ownerCompanyId: OTHER, startAt: 0, alertsOn: false }] }), OBJ);
    expect(JSON.stringify(where)).not.toContain(OTHER);
    expect(where).toEqual({ AND: [{ companyId: CO }, { id: OBJ }] });
  });

  it('only people, pets and assets have photos', () => {
    expect(() => assertPhotoType('PERSON')).not.toThrow();
    expect(() => assertPhotoType('PET')).not.toThrow();
    expect(() => assertPhotoType('ASSET')).not.toThrow();
    expect(() => assertPhotoType('VEHICLE')).toThrow(BadRequestException);
  });

  it('parses the size', () => {
    expect(parsePhotoSize(undefined)).toBe('full');
    expect(parsePhotoSize('thumb')).toBe('thumb');
    expect(() => parsePhotoSize('../x')).toThrow(BadRequestException);
  });

  it('the Tracker app reaches only the active person its phone is fitted to, in the phone company', () => {
    const dev = (object: TrackerDeviceRow['assignments'][number]['object'] | null, companyId: string | null = CO): TrackerDeviceRow => ({ companyId, assignments: object ? [{ object }] : [] });
    expect(trackerPhotoTarget(dev({ id: OBJ, companyId: CO, type: 'PERSON', isActive: true }))).toEqual({ objectId: OBJ, companyId: CO });
    expect(() => trackerPhotoTarget(null)).toThrow(NotFoundException);
    expect(() => trackerPhotoTarget(dev(null))).toThrow(NotFoundException);
    expect(() => trackerPhotoTarget(dev({ id: OBJ, companyId: CO, type: 'VEHICLE', isActive: true }))).toThrow(NotFoundException);
    expect(() => trackerPhotoTarget(dev({ id: OBJ, companyId: OTHER, type: 'PERSON', isActive: true }))).toThrow(NotFoundException);
    expect(() => trackerPhotoTarget(dev({ id: OBJ, companyId: CO, type: 'PERSON', isActive: false }))).toThrow(NotFoundException);
    expect(() => trackerPhotoTarget(dev({ id: OBJ, companyId: CO, type: 'PERSON', isActive: true }, null))).toThrow(NotFoundException);
  });

  it('routes: viewing needs objects:view or live_map:view, upload / remove need objects:edit', () => {
    const grants = (name: keyof ObjectPhotosController) => Reflect.getMetadata(REQUIRED_PERMISSIONS, ObjectPhotosController.prototype[name]);
    expect(grants('file')).toEqual([['objects', 'view'], ['live_map', 'view']]);
    expect(grants('upload')).toEqual([['objects', 'edit']]);
    expect(grants('remove')).toEqual([['objects', 'edit']]);
  });
});

describe('ObjectPhotosService scope', () => {
  const make = (row: unknown) => {
    const prisma = {
      trackedObject: { findFirst: jest.fn().mockResolvedValue(row), update: jest.fn() },
      device: { findUnique: jest.fn() },
    };
    const audit = { record: jest.fn(), recordSystem: jest.fn() };
    const redis = { invalidateCache: jest.fn().mockResolvedValue(undefined) };
    return { svc: new ObjectPhotosService(prisma as never, audit as never, redis as never), prisma };
  };

  it('an object outside the scope (e.g. another company) is a 404 for view, upload and remove, nothing written', async () => {
    const { svc, prisma } = make(null);
    await expect(svc.file(ctx(), OBJ, 'thumb')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.upload(ctx(), OBJ, { buffer: await jpegWithGps(), mimetype: 'image/jpeg' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove(ctx(), OBJ)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.trackedObject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ companyId: CO }, { id: OBJ }] } }));
    expect(prisma.trackedObject.update).not.toHaveBeenCalled();
  });

  it('a vehicle cannot get a photo', async () => {
    const { svc, prisma } = make({ id: OBJ, companyId: CO, type: 'VEHICLE', photoPath: null, photoThumbPath: null, photoAt: null });
    await expect(svc.upload(ctx(), OBJ, { buffer: await jpegWithGps(), mimetype: 'image/jpeg' })).rejects.toThrow('Only people, pets and assets');
    expect(prisma.trackedObject.update).not.toHaveBeenCalled();
  });

  it('no photo yet: 404 on GET, remove is a no-op', async () => {
    const { svc, prisma } = make({ id: OBJ, companyId: CO, type: 'PERSON', photoPath: null, photoThumbPath: null, photoAt: null });
    await expect(svc.file(ctx(), OBJ, 'full')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove(ctx(), OBJ)).resolves.toEqual({ objectId: OBJ, photoVersion: null });
    expect(prisma.trackedObject.update).not.toHaveBeenCalled();
  });
});
