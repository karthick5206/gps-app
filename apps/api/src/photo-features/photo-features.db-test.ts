/**
 * Photo feature switches (v1.18) on a real PostgreSQL: default OFF → 403 FEATURE_OFF, an admin switches on → it works,
 * a non-admin cannot switch, a business phone cannot switch, the owner phone of a personal account can, and nothing
 * leaks into another company. Not part of the normal run:
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_photoflags_test npx jest --testRegex 'photo-features\.db-test\.ts$' --runInBand
 * Allowed databases: see test/scratch-db.ts (only *_test). Creates its own partner / companies and deletes them after.
 */
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FEATURE_OFF } from '@veetracer/shared';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AuthContextService } from '../access/auth-context.service';
import { ensureSystemRoles } from '../access/system-roles';
import { AuditService } from '../audit/audit.service';
import { ObjectsService } from '../masters/objects/objects.service';
import { deleteCompanyPhotoDir } from '../object-photos/object-photo-files';
import { ObjectPhotosService } from '../object-photos/object-photos.service';
import { PhotoNotesService } from '../photo-notes/photo-notes.service';
import type { PrismaService } from '../prisma/prisma.service';
import { dbDescribe } from '../test/scratch-db';
import { trackerPhotoFeatures } from './photo-features';
import { PhotoFeaturesService } from './photo-features.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

const codeOf = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => 'no error',
    (e: { getResponse?(): { code?: string } }) => e.getResponse?.().code ?? (e as Error).message,
  );

d(`photo feature switches on ${dbName}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const db = prisma as unknown as PrismaService;
  const audit = new AuditService(db);
  const redis = { invalidateCache: jest.fn().mockResolvedValue(undefined) };
  const auth = new AuthContextService(db, {} as never, { jwtSecret: 'x' } as never);
  const features = new PhotoFeaturesService(db, audit, redis as never);
  const photos = new ObjectPhotosService(db, audit, redis as never);
  const notes = new PhotoNotesService(db, audit);
  const objects = new ObjectsService(db, audit, redis as never);
  const tag = `Zpf${Date.now().toString(36)}`;
  const num = () => `9198${randomBytes(4).readUInt32BE(0).toString().padStart(8, '0').slice(0, 8)}`;
  const companyIds: string[] = [];
  let partnerId = '';
  let modelId = '';
  let jpeg: Buffer;
  // Business company A (admin, plain user, person, a company phone) and B (isolation); personal account P.
  const A = { id: '', admin: '', user: '', person: '', phone: '', phoneNo: '' };
  const B = { id: '', admin: '', person: '' };
  const P = { id: '', owner: '', ownerPhone: '', ownerNo: '', memberPhone: '', memberNo: '' };

  const company = async (name: string, accountType: 'BUSINESS' | 'INDIVIDUAL' | 'FAMILY' = 'BUSINESS') => {
    const c = await prisma.company.create({ data: { partnerId, name: `${tag} ${name}`, accountType } });
    companyIds.push(c.id);
    return { id: c.id, roles: await ensureSystemRoles(prisma, c.id) };
  };
  const user = async (companyId: string, roleId: string, n: string, mobile?: string) =>
    (await prisma.user.create({ data: { companyId, name: `${tag} ${n}`, mobile: mobile ? `+${mobile}` : null, roles: { create: [{ roleId }] } } })).id;
  const phone = async (companyId: string, uniqueId: string, objectName: string) => {
    const device = await prisma.device.create({ data: { companyId, modelId, uniqueId, ingestToken: randomBytes(12).toString('hex') } });
    const object = await prisma.trackedObject.create({ data: { companyId, name: `${tag} ${objectName}`, type: 'PERSON' } });
    await prisma.deviceAssignment.create({ data: { deviceId: device.id, objectId: object.id, fromTime: new Date() } });
    return { deviceId: device.id, objectId: object.id };
  };
  const ctxOf = (userId: string) => auth.forUser(userId, undefined, null);
  const upload = () => ({ buffer: jpeg, mimetype: 'image/jpeg' });
  const noteFields = () => ({ lat: '13.0827', lng: '80.2707', category: 'VISIT', note: `${tag} visit` });

  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 20, g: 90, b: 160 } } }).jpeg().toBuffer();
    partnerId = (await prisma.partner.create({ data: { name: `${tag} partner`, slug: `${tag.toLowerCase()}-p` } })).id;
    modelId = (await prisma.deviceModel.create({ data: { brand: tag, model: 'phone', protocol: `${tag}-proto`, capabilities: [] } })).id;

    const a = await company('A');
    A.id = a.id;
    A.admin = await user(a.id, a.roles.get('Admin')!, 'admin A');
    A.user = await user(a.id, a.roles.get('User')!, 'user A');
    A.person = (await prisma.trackedObject.create({ data: { companyId: a.id, name: `${tag} person A`, type: 'PERSON' } })).id;
    A.phoneNo = num();
    // A business phone whose number is even the admin's own: still no switching from the Tracker app.
    await user(a.id, a.roles.get('Admin')!, 'admin A phone', A.phoneNo);
    A.phone = (await phone(a.id, A.phoneNo, 'phone A')).deviceId;

    const b = await company('B');
    B.id = b.id;
    B.admin = await user(b.id, b.roles.get('Admin')!, 'admin B');
    B.person = (await prisma.trackedObject.create({ data: { companyId: b.id, name: `${tag} person B`, type: 'PERSON' } })).id;

    const p = await company('P', 'FAMILY');
    P.id = p.id;
    P.ownerNo = num();
    P.memberNo = num();
    P.owner = await user(p.id, p.roles.get('Admin')!, 'owner P', P.ownerNo);
    P.ownerPhone = (await phone(p.id, P.ownerNo, 'owner phone')).deviceId;
    P.memberPhone = (await phone(p.id, P.memberNo, 'member phone')).deviceId;
  });

  afterAll(async () => {
    for (const c of companyIds) {
      await deleteCompanyPhotoDir(c).catch(() => undefined);
      await rm(join(process.cwd(), 'var', 'photo-notes', c), { recursive: true, force: true }).catch(() => undefined);
    }
    if (companyIds.length) {
      const where = { companyId: { in: companyIds } };
      await prisma.geoPhotoNote.deleteMany({ where });
      await prisma.auditLog.deleteMany({ where });
      await prisma.deviceAssignment.deleteMany({ where: { device: where } });
      await prisma.device.deleteMany({ where });
      await prisma.trackedObject.deleteMany({ where });
      await prisma.userRole.deleteMany({ where: { user: where } });
      await prisma.user.deleteMany({ where });
      await prisma.rolePermission.deleteMany({ where: { role: where } });
      await prisma.role.deleteMany({ where });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    if (modelId) await prisma.deviceModel.delete({ where: { id: modelId } }).catch(() => undefined);
    if (partnerId) await prisma.partner.delete({ where: { id: partnerId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('default OFF: switches off, photo_notes menu stripped, uploads and notes refused with 403 FEATURE_OFF', async () => {
    const admin = await ctxOf(A.admin);
    expect(await features.get(admin)).toMatchObject({ personPhotos: false, photoNotes: false, canEdit: true });
    expect(admin.permissions.photo_notes).toBeUndefined();
    expect(admin.switches).toEqual([]);
    expect(await codeOf(photos.upload(admin, A.person, upload()))).toBe(FEATURE_OFF);
    expect(await codeOf(notes.create({ kind: 'user', ctx: admin, source: 'WEB' }, [upload()], noteFields()))).toBe(FEATURE_OFF);
    expect(await codeOf(photos.trackerUpload(A.phone, upload()))).toBe(FEATURE_OFF);
    expect(await codeOf(notes.trackerList(A.id, A.person))).toBe(FEATURE_OFF);
  });

  it('a non-admin cannot switch; the admin can (audited before / after) and then everything works', async () => {
    const plain = await ctxOf(A.user);
    expect(await features.get(plain)).toMatchObject({ canEdit: false, blockedBy: 'NOT_ADMIN' });
    expect(await codeOf(features.set(plain, { personPhotos: true, photoNotes: true }))).toBe('FEATURES_NOT_ALLOWED');

    const admin = await ctxOf(A.admin);
    expect(await features.set(admin, { personPhotos: true })).toMatchObject({ personPhotos: true, photoNotes: false });
    expect(await features.set(admin, { photoNotes: true })).toMatchObject({ personPhotos: true, photoNotes: true });
    const settings = (await prisma.company.findUniqueOrThrow({ where: { id: A.id } })).settings as Record<string, unknown>;
    expect(settings.photos).toEqual({ personPhotos: true, photoNotes: true });
    const log = await prisma.auditLog.findFirst({ where: { companyId: A.id, entity: 'company', action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(log)).toContain('photos');

    const fresh = await ctxOf(A.admin);
    expect(fresh.permissions.photo_notes).toEqual(['view', 'create', 'edit', 'delete', 'export']);
    const up = await photos.upload(fresh, A.person, upload());
    expect(up.photoVersion).toEqual(expect.any(Number));
    expect((await objects.get(fresh, A.person)).photoVersion).toBe(up.photoVersion);
    const created = await notes.create({ kind: 'user', ctx: fresh, source: 'WEB' }, [upload()], noteFields());
    expect(created.created).toBe(true);
    // The plain user now holds the built-in User role's photo notes grant again.
    expect((await ctxOf(A.user)).permissions.photo_notes).toBeDefined();
  });

  it('switching off again hides (not deletes) the photo; switching on shows it again', async () => {
    const admin = await ctxOf(A.admin);
    await features.set(admin, { personPhotos: false });
    const off = await ctxOf(A.admin);
    expect((await objects.get(off, A.person)).photoVersion).toBeNull();
    await expect(photos.file(off, A.person, 'thumb')).rejects.toBeInstanceOf(NotFoundException);
    expect(await codeOf(photos.remove(off, A.person))).toBe(FEATURE_OFF);
    expect((await prisma.trackedObject.findUniqueOrThrow({ where: { id: A.person } })).photoPath).not.toBeNull();
    await features.set(off, { personPhotos: true });
    expect((await objects.get(await ctxOf(A.admin), A.person)).photoVersion).toEqual(expect.any(Number));
  });

  it('another company is untouched: B stays off and refuses, its admin sees its own switches only', async () => {
    const b = await ctxOf(B.admin);
    expect(await features.get(b)).toMatchObject({ personPhotos: false, photoNotes: false });
    expect(b.permissions.photo_notes).toBeUndefined();
    expect(await codeOf(photos.upload(b, B.person, upload()))).toBe(FEATURE_OFF);
    // B's admin cannot reach A's object (404 before any switch question).
    await expect(photos.upload(b, A.person, upload())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('Tracker app: a business phone sees the state but cannot switch ("Ask your administrator")', async () => {
    expect(await features.trackerGet(A.phone, A.phoneNo)).toMatchObject({ personPhotos: true, photoNotes: true, canEdit: false, blockedBy: 'BUSINESS_ACCOUNT' });
    expect(await codeOf(features.trackerSet(A.phone, A.phoneNo, { photoNotes: false }))).toBe('FEATURES_NOT_ALLOWED');
    expect((await prisma.company.findUniqueOrThrow({ where: { id: A.id } })).settings).toMatchObject({ photos: { photoNotes: true } });
  });

  it("Tracker app: the personal account owner's phone switches; a family member's phone cannot; A and B unaffected", async () => {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: P.id } });
    expect(await trackerPhotoFeatures(prisma, company, P.ownerNo)).toEqual({ personPhotos: false, photoNotes: false, canEdit: true });
    expect(await trackerPhotoFeatures(prisma, company, P.memberNo)).toMatchObject({ canEdit: false });
    expect(await features.trackerGet(P.memberPhone, P.memberNo)).toMatchObject({ canEdit: false, blockedBy: 'NOT_OWNER' });
    expect(await codeOf(features.trackerSet(P.memberPhone, P.memberNo, { photoNotes: true }))).toBe('FEATURES_NOT_ALLOWED');

    expect(await features.trackerSet(P.ownerPhone, P.ownerNo, { photoNotes: true })).toMatchObject({ photoNotes: true, personPhotos: false, canEdit: true });
    const p = await prisma.company.findUniqueOrThrow({ where: { id: P.id } });
    expect(p.settings).toMatchObject({ photos: { photoNotes: true, personPhotos: false } });
    const log = await prisma.auditLog.findFirst({ where: { companyId: P.id, entity: 'company', action: 'UPDATE' } });
    expect(log?.userId).toBe(P.owner);
    // The member's phone may now use photo notes (same account), but still not profile photos.
    expect((await notes.trackerList(P.id, (await prisma.deviceAssignment.findFirstOrThrow({ where: { deviceId: P.memberPhone } })).objectId)).items).toEqual([]);
    expect(await codeOf(photos.trackerUpload(P.memberPhone, upload()))).toBe(FEATURE_OFF);
    // Isolation: B is still all off.
    expect((await prisma.company.findUniqueOrThrow({ where: { id: B.id } })).settings).not.toMatchObject({ photos: { photoNotes: true } });
  });
});
