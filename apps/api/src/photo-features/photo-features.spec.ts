import { ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { companySwitchesOf, FEATURE_OFF, MENUS, photoFeaturesOf, SYSTEM_ROLES, withoutUnavailableMenus, type CompanySwitch, type PermissionMap } from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import type { Grant } from '../access/decorators';
import { PermissionGuard } from '../access/permission.guard';
import { ObjectPhotosService } from '../object-photos/object-photos.service';
import { PhotoNotesService } from '../photo-notes/photo-notes.service';
import { assertPhotoFeature, companyEditBlock, mergePhotoFeatures, trackerEditBlock, visiblePhotoVersion } from './photo-features';
import { PhotoFeaturesService } from './photo-features.service';

const ON = { photos: { personPhotos: true, photoNotes: true } };

function httpCtx(auth: Partial<AuthContext> | undefined, method = 'GET'): ExecutionContext {
  const req = { auth, method, query: {}, url: '/api/photo-notes' };
  return {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}
const guardFor = (grants: Grant[]) => new PermissionGuard({ getAllAndOverride: () => grants } as unknown as Reflector);
const responseOf = (fn: () => unknown): { code?: string; status?: number } => {
  try {
    fn();
  } catch (e) {
    const ex = e as { getResponse?(): { code?: string }; getStatus?(): number };
    return { code: ex.getResponse?.().code, status: ex.getStatus?.() };
  }
  return {};
};
const asyncCode = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => 'no error',
    (e: { getResponse?(): { code?: string } }) => e.getResponse?.().code,
  );

describe('photo feature switches: resolution', () => {
  it('default OFF: no settings, malformed settings, non-true values', () => {
    expect(photoFeaturesOf(null)).toEqual({ personPhotos: false, photoNotes: false });
    expect(photoFeaturesOf({})).toEqual({ personPhotos: false, photoNotes: false });
    expect(photoFeaturesOf({ photos: 'yes' })).toEqual({ personPhotos: false, photoNotes: false });
    expect(photoFeaturesOf({ photos: { personPhotos: 'true', photoNotes: 1 } })).toEqual({ personPhotos: false, photoNotes: false });
    expect(photoFeaturesOf([])).toEqual({ personPhotos: false, photoNotes: false });
  });

  it('reads Company.settings.photos and lists the switches that are on', () => {
    expect(photoFeaturesOf({ photos: { personPhotos: true } })).toEqual({ personPhotos: true, photoNotes: false });
    expect(companySwitchesOf(ON)).toEqual(['personPhotos', 'photoNotes']);
    expect(companySwitchesOf({ photos: { photoNotes: true }, features: ['etms'] })).toEqual(['photoNotes']);
  });

  it('a PUT changes only the keys it sends', () => {
    expect(mergePhotoFeatures({ personPhotos: true, photoNotes: false }, { photoNotes: true })).toEqual({ personPhotos: true, photoNotes: true });
    expect(mergePhotoFeatures({ personPhotos: true, photoNotes: true }, {})).toEqual({ personPhotos: true, photoNotes: true });
  });

  it('photo versions are hidden while person photos are off (the photo itself is kept)', () => {
    const at = new Date(1_700_000_000_000);
    expect(visiblePhotoVersion(at, {})).toBeNull();
    expect(visiblePhotoVersion(at, ON)).toBe(at.getTime());
    expect(visiblePhotoVersion(null, ON)).toBeNull();
  });
});

describe('photo feature switches: menu stripping (MenuDef.requires.companySetting)', () => {
  const admin = SYSTEM_ROLES.find((r) => r.name === 'Admin')!.permissions;

  it('photo_notes stays in the built-in Admin role; add-on module menus stay out', () => {
    expect(admin.photo_notes).toEqual(['view', 'create', 'edit', 'delete', 'export']);
    expect(admin.etms_partners).toBeUndefined();
    expect(MENUS.find((m) => m.key === 'photo_notes')?.requires).toEqual({ companySetting: 'photoNotes' });
  });

  it('stripped while the switch is off, kept when it is on; other menus untouched', () => {
    const off = withoutUnavailableMenus(admin, []);
    expect(off.photo_notes).toBeUndefined();
    expect(off.objects).toEqual(admin.objects);
    const on = withoutUnavailableMenus(admin, [], ['photoNotes']);
    expect(on.photo_notes).toEqual(admin.photo_notes);
    // personPhotos gates no menu: objects and live map stay.
    expect(withoutUnavailableMenus(admin, [], ['personPhotos']).photo_notes).toBeUndefined();
  });
});

describe('photo feature switches: PermissionGuard', () => {
  const caller = (permissions: PermissionMap, switches: CompanySwitch[]): Partial<AuthContext> => ({ companyId: 'c1', permissions, features: [], switches });

  it('photo-notes routes: 403 FEATURE_OFF while off (not a hidden 404), allowed when on', () => {
    const route = guardFor([['photo_notes', 'view']]);
    expect(responseOf(() => route.canActivate(httpCtx(caller({}, []))))).toEqual({ code: FEATURE_OFF, status: 403 });
    // Even a stale grant does not pass while the switch is off.
    expect(responseOf(() => route.canActivate(httpCtx(caller({ photo_notes: ['view'] }, []))))).toEqual({ code: FEATURE_OFF, status: 403 });
    expect(route.canActivate(httpCtx(caller({ photo_notes: ['view'] }, ['photoNotes'])))).toBe(true);
    expect(() => route.canActivate(httpCtx(caller({}, ['photoNotes'])))).toThrow('Permission denied');
  });

  it('add-on modules keep their 404', () => {
    const etms = guardFor([['etms_partners', 'view']]);
    expect(() => etms.canActivate(httpCtx(caller({ etms_partners: ['view'] }, ['photoNotes'])))).toThrow(NotFoundException);
  });
});

describe('photo feature switches: who may switch', () => {
  const base = { isSuperAdmin: false, isCompanyAdmin: false, permissions: {} as PermissionMap, dataScope: 'COMPANY' as const };

  it('web / VeeTrax app: Super Admin, the built-in Admin, or a whole-company settings:edit user', () => {
    expect(companyEditBlock({ ...base, isSuperAdmin: true })).toBeNull();
    expect(companyEditBlock({ ...base, isCompanyAdmin: true })).toBeNull();
    expect(companyEditBlock({ ...base, permissions: { settings: ['view', 'edit'] } })).toBeNull();
    expect(companyEditBlock({ ...base, permissions: { settings: ['view'] } })).toBe('NOT_ADMIN');
    expect(companyEditBlock({ ...base, permissions: { settings: ['view', 'edit'] }, dataScope: 'ASSIGNED' })).toBe('NOT_ADMIN');
    expect(companyEditBlock({ ...base, isSuperAdmin: true, allCompanies: true })).toBe('NOT_ADMIN');
  });

  it('Tracker app: only the owner phone of a personal / family account', () => {
    expect(trackerEditBlock('INDIVIDUAL', true)).toBeNull();
    expect(trackerEditBlock('FAMILY', true)).toBeNull();
    expect(trackerEditBlock('FAMILY', false)).toBe('NOT_OWNER');
    expect(trackerEditBlock('BUSINESS', true)).toBe('BUSINESS_ACCOUNT');
    expect(trackerEditBlock(null, true)).toBe('BUSINESS_ACCOUNT');
  });

  it('PUT by a non-admin is refused before anything is written', async () => {
    const prisma = { company: { findUniqueOrThrow: jest.fn() }, $executeRaw: jest.fn() };
    const svc = new PhotoFeaturesService(prisma as never, { record: jest.fn() } as never, { invalidateCache: jest.fn() } as never);
    const ctx = { ...base, companyId: 'c1', userId: 'u1', permissions: { settings: ['view'] } } as unknown as AuthContext;
    expect(await asyncCode(svc.set(ctx, { photoNotes: true }))).toBe('FEATURES_NOT_ALLOWED');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('photo feature switches: FEATURE_OFF guards in the services', () => {
  it('assertPhotoFeature', () => {
    expect(() => assertPhotoFeature({}, 'photoNotes')).toThrow(ForbiddenException);
    expect(() => assertPhotoFeature(ON, 'photoNotes')).not.toThrow();
  });

  const row = (settings: unknown) => ({ id: 'o1', companyId: 'c1', type: 'PERSON', photoPath: '/x.jpg', photoThumbPath: '/x-t.jpg', photoAt: new Date(1), company: { settings } });
  const photosWith = (settings: unknown) => {
    const prisma = {
      trackedObject: { findFirst: jest.fn().mockResolvedValue(row(settings)), update: jest.fn() },
      device: { findUnique: jest.fn().mockResolvedValue({ companyId: 'c1', assignments: [{ object: { id: 'o1', companyId: 'c1', type: 'PERSON', isActive: true } }] }) },
    };
    return { prisma, svc: new ObjectPhotosService(prisma as never, { record: jest.fn(), recordSystem: jest.fn() } as never, { invalidateCache: jest.fn() } as never) };
  };
  const ctx = { companyId: 'c1', userId: 'u1', dataScope: 'COMPANY', permissions: {}, branchIds: [], objectIds: [] } as unknown as AuthContext;

  it('person photos off: upload / remove 403 FEATURE_OFF (web and tracker), image 404, no version; nothing is changed', async () => {
    const { prisma, svc } = photosWith({});
    expect(await asyncCode(svc.upload(ctx, 'o1', { buffer: Buffer.from('x'), mimetype: 'image/jpeg' } as never))).toBe(FEATURE_OFF);
    expect(await asyncCode(svc.remove(ctx, 'o1'))).toBe(FEATURE_OFF);
    expect(await asyncCode(svc.trackerUpload('d1', { buffer: Buffer.from('x'), mimetype: 'image/jpeg' } as never))).toBe(FEATURE_OFF);
    expect(await asyncCode(svc.trackerRemove('d1'))).toBe(FEATURE_OFF);
    await expect(svc.file(ctx, 'o1', 'full')).rejects.toThrow(NotFoundException);
    expect(await svc.trackerState('d1')).toEqual({ objectId: 'o1', photoVersion: null });
    expect(prisma.trackedObject.update).not.toHaveBeenCalled();
  });

  it('person photos on: the state carries the version again', async () => {
    const { svc } = photosWith(ON);
    expect(await svc.trackerState('d1')).toEqual({ objectId: 'o1', photoVersion: 1 });
  });

  it('photo notes off: create (web, mobile, tracker) and every tracker route answer 403 FEATURE_OFF', async () => {
    const prisma = { company: { findUnique: jest.fn().mockResolvedValue({ settings: {} }) }, geoPhotoNote: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() } };
    const svc = new PhotoNotesService(prisma as never, { record: jest.fn(), recordSystem: jest.fn() } as never);
    const meta = { lat: '13.0', lng: '80.2', clientId: '7b0d9a3e-1f2a-4c3b-9d4e-5f6a7b8c9d0e' };
    expect(await asyncCode(svc.create({ kind: 'tracker', companyId: 'c1', objectId: 'o1' }, [], meta))).toBe(FEATURE_OFF);
    expect(await asyncCode(svc.create({ kind: 'user', ctx, source: 'WEB' }, [], meta))).toBe(FEATURE_OFF);
    expect(await asyncCode(svc.trackerList('c1', 'o1'))).toBe(FEATURE_OFF);
    expect(await asyncCode(svc.trackerRemove('c1', 'o1', 'n1'))).toBe(FEATURE_OFF);
    expect(await asyncCode(svc.trackerPhoto('c1', 'o1', 'n1', 'p1'))).toBe(FEATURE_OFF);
    expect(prisma.geoPhotoNote.findUnique).not.toHaveBeenCalled();
    expect(prisma.geoPhotoNote.findFirst).not.toHaveBeenCalled();
  });
});
