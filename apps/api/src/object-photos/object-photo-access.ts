import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hasPhotoType, type ObjectPhotoSize, type ObjectType } from '@veetracer/shared';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';

/**
 * Who may see or change a tracked object's photo.
 * - Web / mobile users: the objects they can see (their company, or their branches ∪ mapped objects in ASSIGNED scope;
 *   every company for the Super Admin in "all companies" mode, like Masters → Objects). Viewing needs objects:view or
 *   live_map:view, changing needs objects:edit (checked on the route). Shared vehicles of another company are never
 *   included: a photo stays with the company that owns the person.
 * - The Tracker app: only the person its own phone is fitted to (see trackerPhotoTarget).
 * Anything outside the scope is a 404, never a 403, so ids of other companies cannot be probed.
 */
export function photoScopeWhere(ctx: AuthContext, objectId: string): Prisma.TrackedObjectWhereInput {
  return { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId }] };
}

export function assertPhotoType(type: ObjectType): void {
  if (!hasPhotoType(type)) throw new BadRequestException('Only people, pets and assets can have a photo');
}

export function parsePhotoSize(size: string | undefined): ObjectPhotoSize {
  if (size === undefined || size === '' || size === 'full') return 'full';
  if (size === 'thumb') return 'thumb';
  throw new BadRequestException('size must be full or thumb');
}

/** The phone's device row as the tracker session sees it: company and the object it is fitted to now. */
export interface TrackerDeviceRow {
  companyId: string | null;
  assignments: { object: { id: string; companyId: string; type: ObjectType; isActive: boolean } }[];
}

/**
 * The person a Tracker-app phone may set the photo of: the active PERSON object the phone is fitted to now, in the
 * phone's own company. Anything else (no fitting, a vehicle, another company's object) is a 404.
 */
export function trackerPhotoTarget(device: TrackerDeviceRow | null): { objectId: string; companyId: string } {
  const object = device?.assignments[0]?.object;
  if (!device?.companyId || !object || object.companyId !== device.companyId || !object.isActive) throw new NotFoundException('This phone is not linked to a person');
  if (object.type !== 'PERSON') throw new NotFoundException('This phone is not linked to a person');
  return { objectId: object.id, companyId: object.companyId };
}
