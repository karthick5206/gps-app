/**
 * Photo notes on a real PostgreSQL (scratch DB only, see test/scratch-db.ts). Not part of the normal run:
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_geophoto_test npx jest --testRegex 'photo-notes\.db-test\.ts$' --runInBand
 * Creates its own partner / companies / users / objects (unique tag) and removes them, with the photo folders, at the end.
 */
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { dbDescribe } from '../test/scratch-db';
import { PHOTO_NOTES_DIR, PhotoNotesService } from './photo-notes.service';

/** v1.18 photo switches on (default off; photo-features.db-test.ts covers off). */
const ON = { photos: { personPhotos: true, photoNotes: true } };
const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

d(`photo notes on ${dbName}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const service = new PhotoNotesService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));
  const tag = `Zpn${Date.now().toString(36)}`;
  let partnerId = '';
  const companyIds: string[] = [];
  let photo: Buffer;
  let A: { company: string; owner: AuthContext; other: AuthContext; admin: AuthContext; objectId: string };
  let B: { admin: AuthContext };

  const ctx = (companyId: string, userId: string, over: Partial<AuthContext>): AuthContext =>
    ({ userId, homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: { photo_notes: ['view', 'create'] }, dataScope: 'ASSIGNED', branchIds: [], objectIds: [], ip: null, ...over }) as AuthContext;
  const fields = (over: Record<string, string> = {}) => ({ lat: '13.0827', lng: '80.2707', category: 'BILL', amountMinor: '45000', note: `${tag} lunch`, ...over });

  beforeAll(async () => {
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 120, b: 90 } } }).jpeg().toBuffer();
    const partner = await prisma.partner.create({ data: { name: `${tag} partner`, slug: `${tag.toLowerCase()}-p` } });
    partnerId = partner.id;
    const mk = async (n: string) => {
      const c = await prisma.company.create({ data: { partnerId, name: `${tag} ${n}`, settings: ON } });
      companyIds.push(c.id);
      return c.id;
    };
    const ca = await mk('A');
    const cb = await mk('B');
    const user = (companyId: string, n: string) => prisma.user.create({ data: { companyId, name: `${tag} ${n}` } });
    const [owner, other, admin, adminB] = await Promise.all([user(ca, 'owner'), user(ca, 'other'), user(ca, 'admin'), user(cb, 'adminB')]);
    const obj = await prisma.trackedObject.create({ data: { companyId: ca, name: `${tag} person`, type: 'PERSON' } });
    const all = { photo_notes: ['view', 'create', 'edit', 'delete', 'export'] } as AuthContext['permissions'];
    A = {
      company: ca,
      owner: ctx(ca, owner.id, {}),
      other: ctx(ca, other.id, {}),
      admin: ctx(ca, admin.id, { dataScope: 'COMPANY', permissions: all }),
      objectId: obj.id,
    };
    B = { admin: ctx(cb, adminB.id, { dataScope: 'COMPANY', permissions: all }) };
  });

  afterAll(async () => {
    for (const c of companyIds) await rm(join(PHOTO_NOTES_DIR, c), { recursive: true, force: true }).catch(() => undefined);
    if (companyIds.length) {
      await prisma.geoPhotoNote.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.auditLog.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.trackedObject.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.user.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    if (partnerId) await prisma.partner.delete({ where: { id: partnerId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('create is idempotent by clientId (an offline re-send returns the saved note)', async () => {
    const clientId = `${tag}-c1-0000`;
    const first = await service.create({ kind: 'user', ctx: A.owner, source: 'MOBILE' }, [{ buffer: photo, mimetype: 'image/jpeg' }, { buffer: photo, mimetype: 'image/jpeg' }], fields({ clientId }));
    expect(first.created).toBe(true);
    expect(first.note).toMatchObject({ category: 'BILL', amountMinor: 45000, currency: 'INR', source: 'MOBILE', mine: true, canEdit: true, canDelete: true });
    expect(first.note.photos).toHaveLength(2);
    expect(first.note.photos[0]).toMatchObject({ width: 800, height: 600 });
    const again = await service.create({ kind: 'user', ctx: A.owner, source: 'MOBILE' }, [{ buffer: photo, mimetype: 'image/jpeg' }], fields({ clientId }));
    expect(again.created).toBe(false);
    expect(again.note.id).toBe(first.note.id);
    expect(await prisma.geoPhotoNote.count({ where: { companyId: A.company, clientId } })).toBe(1);
    // Another user may not take over the id.
    await expect(service.create({ kind: 'user', ctx: A.other, source: 'MOBILE' }, [{ buffer: photo }], fields({ clientId }))).rejects.toThrow('already used');
    // Files exist under var/photo-notes/<company>/<note>/.
    const row = await prisma.geoPhotoNotePhoto.findFirstOrThrow({ where: { noteId: first.note.id } });
    expect(row.path.startsWith(join(PHOTO_NOTES_DIR, A.company, first.note.id))).toBe(true);
    expect((await stat(row.thumbPath)).size).toBeGreaterThan(0);
  });

  it('owner and admin see the note; another plain user does not; another company gets 404', async () => {
    const { note } = await service.create({ kind: 'user', ctx: A.owner, source: 'WEB' }, [{ buffer: photo }], fields({ category: 'VISIT', note: `${tag} visit` }));
    expect(note.amountMinor).toBeNull();
    expect((await service.get(A.owner, note.id)).id).toBe(note.id);
    const asAdmin = await service.get(A.admin, note.id);
    expect(asAdmin).toMatchObject({ mine: false, canEdit: true, canDelete: true });
    await expect(service.get(A.other, note.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(B.admin, note.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.photo(B.admin, note.id, note.photos[0].id, 'thumb')).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.list(A.other, {})).total).toBe(0);
    expect((await service.list(B.admin, {})).total).toBe(0);
    const adminList = await service.list(A.admin, { q: `${tag} visit` });
    expect(adminList.items.map((n) => n.id)).toEqual([note.id]);
    expect((await service.list(A.owner, { mine: '1' })).total).toBeGreaterThanOrEqual(2);
    expect((await service.list(A.admin, { category: 'VISIT', bbox: '80,13,80.5,13.5' })).total).toBe(1);
    expect((await service.list(A.admin, { category: 'VISIT', bbox: '70,10,71,11' })).total).toBe(0);
    // A user with view in ASSIGNED scope sees notes of the objects in scope (the Tracker-app note of that person).
    await service.create({ kind: 'tracker', companyId: A.company, objectId: A.objectId }, [{ buffer: photo }], fields({ category: 'OTHER', clientId: `${tag}-t1-0000` }));
    expect((await service.list(A.other, {})).total).toBe(0);
    const scoped = { ...A.other, objectIds: [A.objectId] };
    expect((await service.list(scoped, {})).items.map((n) => n.source)).toEqual(['TRACKER_APP']);
    expect((await service.trackerList(A.company, A.objectId)).items).toHaveLength(1);
    // The admin can edit; the plain scoped user can see but not edit someone else's note.
    const trackerNote = (await service.list(scoped, {})).items[0];
    await expect(service.update(scoped, trackerNote.id, { note: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await service.update(A.admin, trackerNote.id, { note: 'checked' })).note).toBe('checked');
  });

  it('delete: only the owner or a user with delete; soft-deleted notes vanish and are swept with their files', async () => {
    const { note } = await service.create({ kind: 'user', ctx: A.owner, source: 'WEB' }, [{ buffer: photo }], fields({ category: 'RECEIPT', amountMinor: '1200' }));
    await expect(service.remove(A.other, note.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(B.admin, note.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(A.owner, note.id)).resolves.toEqual({ ok: true });
    await expect(service.get(A.admin, note.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(A.owner, note.id)).rejects.toBeInstanceOf(NotFoundException);
    const row = await prisma.geoPhotoNote.findUniqueOrThrow({ where: { id: note.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { companyId: A.company, entity: 'GeoPhotoNote', entityId: note.id, action: 'DELETE' } })).toBe(1);
    // 31 days later the sweep removes the row and its folder.
    const dir = join(PHOTO_NOTES_DIR, A.company, note.id);
    expect(await stat(dir).then(() => true)).toBe(true);
    const r = await service.sweep(Date.now() + 31 * 86_400_000, Date.now() + 60_000);
    expect(r.notes).toBeGreaterThanOrEqual(1);
    expect(await prisma.geoPhotoNote.findUnique({ where: { id: note.id } })).toBeNull();
    expect(await stat(dir).then(() => true, () => false)).toBe(false);
  });

  it('a user purge cascades to their notes (erasure)', async () => {
    const u = await prisma.user.create({ data: { companyId: A.company, name: `${tag} leaver` } });
    const c = ctx(A.company, u.id, {});
    const { note } = await service.create({ kind: 'user', ctx: c, source: 'MOBILE' }, [{ buffer: photo }], fields());
    await prisma.auditLog.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
    expect(await prisma.geoPhotoNote.findUnique({ where: { id: note.id } })).toBeNull();
    expect(await prisma.geoPhotoNotePhoto.count({ where: { noteId: note.id } })).toBe(0);
  });
});
