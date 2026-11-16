import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import type { ObjectPhotoSize, ObjectType } from '@veetracer/shared';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { assertPhotoType, photoScopeWhere, trackerPhotoTarget } from './object-photo-access';
import { deletePhotoFiles, writePhotoFiles } from './object-photo-files';
import { encodePhoto, markerPng, UploadedPhoto, validatePhoto } from './object-photo-image';

const ENTITY = 'object';
const SELECT = { id: true, companyId: true, type: true, photoPath: true, photoThumbPath: true, photoAt: true } as const;

interface PhotoRow {
  id: string;
  companyId: string;
  type: ObjectType;
  photoPath: string | null;
  photoThumbPath: string | null;
  photoAt: Date | null;
}

export interface ObjectPhotoState {
  objectId: string;
  /** ms of the last change; null = no photo. */
  photoVersion: number | null;
}

type Actor = { kind: 'user'; ctx: AuthContext } | { kind: 'phone'; companyId: string; deviceId: string };

/** Person / pet / asset photos (see object-photo-access.ts for who may do what). */
@Injectable()
export class ObjectPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  // ───────────── web / mobile users ─────────────

  async upload(ctx: AuthContext, objectId: string, file: UploadedPhoto | undefined): Promise<ObjectPhotoState> {
    return this.save(await this.find(ctx, objectId), file, { kind: 'user', ctx });
  }

  async remove(ctx: AuthContext, objectId: string): Promise<ObjectPhotoState> {
    return this.clear(await this.find(ctx, objectId), { kind: 'user', ctx });
  }

  async file(ctx: AuthContext, objectId: string, size: ObjectPhotoSize): Promise<StreamableFile> {
    return this.stream(await this.find(ctx, objectId), size);
  }

  // ───────────── Tracker app (the phone's own person) ─────────────

  async trackerState(deviceId: string): Promise<ObjectPhotoState> {
    const row = await this.trackerRow(deviceId);
    return { objectId: row.id, photoVersion: row.photoAt?.getTime() ?? null };
  }

  async trackerUpload(deviceId: string, file: UploadedPhoto | undefined): Promise<ObjectPhotoState> {
    const row = await this.trackerRow(deviceId);
    return this.save(row, file, { kind: 'phone', companyId: row.companyId, deviceId });
  }

  async trackerRemove(deviceId: string): Promise<ObjectPhotoState> {
    const row = await this.trackerRow(deviceId);
    return this.clear(row, { kind: 'phone', companyId: row.companyId, deviceId });
  }

  async trackerFile(deviceId: string, size: ObjectPhotoSize): Promise<StreamableFile> {
    return this.stream(await this.trackerRow(deviceId), size);
  }

  // ───────────── helpers ─────────────

  private async find(ctx: AuthContext, objectId: string): Promise<PhotoRow> {
    const row = await this.prisma.trackedObject.findFirst({ where: photoScopeWhere(ctx, objectId), select: SELECT });
    if (!row) throw new NotFoundException('Object not found');
    return row;
  }

  private async trackerRow(deviceId: string): Promise<PhotoRow> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { companyId: true, assignments: { where: { toTime: null }, take: 1, select: { object: { select: { id: true, companyId: true, type: true, isActive: true } } } } },
    });
    const target = trackerPhotoTarget(device);
    const row = await this.prisma.trackedObject.findFirst({ where: { id: target.objectId, companyId: target.companyId }, select: SELECT });
    if (!row) throw new NotFoundException('This phone is not linked to a person');
    return row;
  }

  private async save(row: PhotoRow, file: UploadedPhoto | undefined, actor: Actor): Promise<ObjectPhotoState> {
    assertPhotoType(row.type);
    validatePhoto(file);
    const encoded = await encodePhoto(file!.buffer);
    const paths = await writePhotoFiles(row.companyId, encoded);
    const photoAt = new Date();
    try {
      await this.prisma.trackedObject.update({ where: { id: row.id }, data: { ...paths, photoAt } });
    } catch (e) {
      await deletePhotoFiles([paths]);
      throw e;
    }
    await deletePhotoFiles([row]);
    await this.record(actor, row.id, row.photoAt !== null, true);
    return { objectId: row.id, photoVersion: photoAt.getTime() };
  }

  private async clear(row: PhotoRow, actor: Actor): Promise<ObjectPhotoState> {
    if (!row.photoPath && !row.photoThumbPath && !row.photoAt) return { objectId: row.id, photoVersion: null };
    await this.prisma.trackedObject.update({ where: { id: row.id }, data: { photoPath: null, photoThumbPath: null, photoAt: null } });
    await deletePhotoFiles([row]);
    await this.record(actor, row.id, true, false);
    return { objectId: row.id, photoVersion: null };
  }

  private async stream(row: PhotoRow, size: ObjectPhotoSize): Promise<StreamableFile> {
    const path = size === 'full' ? row.photoPath : row.photoThumbPath;
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info) throw new NotFoundException('No photo');
    if (size === 'marker') {
      const png = await markerPng(await readFile(path));
      return new StreamableFile(png, { type: 'image/png', length: png.length, disposition: 'inline' });
    }
    return new StreamableFile(createReadStream(path), { type: 'image/jpeg', length: info.size, disposition: 'inline' });
  }

  /** Audit without file paths: only whether a photo was there before and after. */
  private async record(actor: Actor, objectId: string, before: boolean, after: boolean): Promise<void> {
    const entry = { action: 'UPDATE' as const, entity: ENTITY, entityId: objectId, before: { photo: before }, after: { photo: after } };
    if (actor.kind === 'user') await this.audit.record(actor.ctx, entry);
    else await this.audit.recordSystem({ companyId: actor.companyId, userId: null, ip: null }, { ...entry, details: { by: 'tracker app', deviceId: actor.deviceId } });
    // Lists and the live map re-read objects (the snapshot carries photoVersion).
    await this.redis.invalidateCache('object').catch(() => undefined);
  }
}
