/**
 * Person photos on a real PostgreSQL + disk: upload / replace / remove, the company and branch scope (another company's
 * object is a 404) and the files behind it. Not part of the normal run:
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_avatar_test npx jest --testRegex 'object-photos\.db-test\.ts$' --runInBand
 * Allowed databases: see test/scratch-db.ts (only *_test). Creates its own partner / companies and deletes them after.
 */
import { NotFoundException, StreamableFile } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { AuthContext } from '../access/auth-context';
import { dbDescribe } from '../test/scratch-db';
import { deleteCompanyPhotoDir, OBJECT_PHOTOS_DIR } from './object-photo-files';
import { ObjectPhotosService } from './object-photos.service';

/** v1.18 photo switches on (default off; photo-features.db-test.ts covers off). */
const ON = { photos: { personPhotos: true, photoNotes: true } };
const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

const ctxOf = (companyId: string, over: Partial<AuthContext> = {}): AuthContext =>
  ({ userId: '00000000-0000-4000-8000-000000000001', homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null, ...over }) as AuthContext;

async function streamed(f: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of f.getStream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

d(`object photos on ${dbName}`, () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const audit = { record: jest.fn(), recordSystem: jest.fn() };
  const redis = { invalidateCache: jest.fn().mockResolvedValue(undefined) };
  const svc = new ObjectPhotosService(prisma as never, audit as never, redis as never);
  const tag = `Zph${Date.now().toString(36)}`;
  let partnerId = '';
  let a = '';
  let b = '';
  let person = '';
  let vehicle = '';
  let otherPerson = '';

  beforeAll(async () => {
    partnerId = (await prisma.partner.create({ data: { name: `${tag} partner`, slug: `${tag.toLowerCase()}-p` } })).id;
    a = (await prisma.company.create({ data: { partnerId, name: `${tag} A`, settings: ON } })).id;
    b = (await prisma.company.create({ data: { partnerId, name: `${tag} B`, settings: ON } })).id;
    person = (await prisma.trackedObject.create({ data: { companyId: a, name: `${tag} person`, type: 'PERSON' } })).id;
    vehicle = (await prisma.trackedObject.create({ data: { companyId: a, name: `${tag} car`, type: 'VEHICLE' } })).id;
    otherPerson = (await prisma.trackedObject.create({ data: { companyId: b, name: `${tag} other`, type: 'PERSON' } })).id;
  });

  afterAll(async () => {
    const rows = await prisma.trackedObject.findMany({ where: { companyId: { in: [a, b] } }, select: { id: true } });
    for (const r of rows) await svc.remove(ctxOf(a, { isSuperAdmin: true, allCompanies: true }), r.id).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { companyId: { in: [a, b] } } }).catch(() => undefined);
    await prisma.trackedObject.deleteMany({ where: { companyId: { in: [a, b] } } });
    await prisma.company.deleteMany({ where: { id: { in: [a, b] } } });
    await prisma.partner.delete({ where: { id: partnerId } });
    await Promise.all([a, b].map(deleteCompanyPhotoDir));
    await prisma.$disconnect();
  });

  const photo = () =>
    sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 120, b: 200 } } })
      .jpeg()
      .withExifMerge({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 4/1 0/1' } })
      .toBuffer();

  it('uploads, serves (256 / 64 px, no EXIF), replaces (old files removed) and removes a person photo', async () => {
    const first = await svc.upload(ctxOf(a), person, { buffer: await photo(), mimetype: 'image/jpeg' });
    expect(first.photoVersion).toEqual(expect.any(Number));
    const row1 = await prisma.trackedObject.findUniqueOrThrow({ where: { id: person } });
    expect(row1.photoPath!.startsWith(OBJECT_PHOTOS_DIR)).toBe(true);
    expect(row1.photoPath).not.toContain(person);
    expect(row1.photoPath).not.toContain('person');
    expect(existsSync(row1.photoPath!) && existsSync(row1.photoThumbPath!)).toBe(true);

    const thumb = await streamed(await svc.file(ctxOf(a), person, 'thumb'));
    const tm = await sharp(thumb).metadata();
    expect([tm.width, tm.height, tm.format, tm.exif]).toEqual([64, 64, 'jpeg', undefined]);
    const full = await sharp(await streamed(await svc.file(ctxOf(a), person, 'full'))).metadata();
    expect([full.width, full.height]).toEqual([256, 256]);

    const second = await svc.upload(ctxOf(a), person, { buffer: await photo(), mimetype: 'image/jpeg' });
    expect(second.photoVersion!).toBeGreaterThanOrEqual(first.photoVersion!);
    const row2 = await prisma.trackedObject.findUniqueOrThrow({ where: { id: person } });
    expect(row2.photoPath).not.toBe(row1.photoPath);
    expect(existsSync(row1.photoPath!) || existsSync(row1.photoThumbPath!)).toBe(false);

    await expect(svc.remove(ctxOf(a), person)).resolves.toEqual({ objectId: person, photoVersion: null });
    const row3 = await prisma.trackedObject.findUniqueOrThrow({ where: { id: person } });
    expect([row3.photoPath, row3.photoThumbPath, row3.photoAt]).toEqual([null, null, null]);
    expect(existsSync(row2.photoPath!) || existsSync(row2.photoThumbPath!)).toBe(false);
    await expect(svc.file(ctxOf(a), person, 'thumb')).rejects.toBeInstanceOf(NotFoundException);
    // The audit trail never carries a path.
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(OBJECT_PHOTOS_DIR);
  });

  it("another company's object is a 404 for view, upload and remove, and stays untouched", async () => {
    await svc.upload(ctxOf(b), otherPerson, { buffer: await photo(), mimetype: 'image/jpeg' });
    const before = await prisma.trackedObject.findUniqueOrThrow({ where: { id: otherPerson } });
    await expect(svc.file(ctxOf(a), otherPerson, 'thumb')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.upload(ctxOf(a), otherPerson, { buffer: await photo(), mimetype: 'image/jpeg' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove(ctxOf(a), otherPerson)).rejects.toBeInstanceOf(NotFoundException);
    const after = await prisma.trackedObject.findUniqueOrThrow({ where: { id: otherPerson } });
    expect(after.photoPath).toBe(before.photoPath);
    expect(existsSync(after.photoPath!)).toBe(true);
  });

  it('a branch-scoped user reaches only mapped objects; a vehicle cannot have a photo', async () => {
    const assigned = ctxOf(a, { dataScope: 'ASSIGNED', branchIds: [], objectIds: [] });
    await expect(svc.upload(assigned, person, { buffer: await photo(), mimetype: 'image/jpeg' })).rejects.toBeInstanceOf(NotFoundException);
    const mapped = ctxOf(a, { dataScope: 'ASSIGNED', branchIds: [], objectIds: [person] });
    await expect(svc.upload(mapped, person, { buffer: await photo(), mimetype: 'image/jpeg' })).resolves.toMatchObject({ objectId: person });
    await expect(svc.upload(ctxOf(a), vehicle, { buffer: await photo(), mimetype: 'image/jpeg' })).rejects.toThrow('Only people, pets and assets');
  });
});
