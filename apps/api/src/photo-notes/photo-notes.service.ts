import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EXPENSE_KINDS, PHOTO_NOTE_CATEGORIES, PHOTO_NOTE_MONEY_CATEGORIES, PHOTO_NOTE_NOTE_MAX, type ExpenseKind, type PhotoNoteCategory, type PhotoNoteDto, type PhotoNoteSource, type Paginated } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasPermission, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { APP_ROOT } from '../config/env';
import { ExpensesService } from '../expenses/expenses.service';
import { GeocodingService } from '../geocoding/geocoding.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertPhotoFeature } from '../photo-features/photo-features';
import { encodePhoto, type EncodedPhoto } from './photo-notes.images';
import { canChange, moneyFields, parseBbox, parseMeta, photoNoteScope, PhotoNoteInputError, validatePhotos, type IncomingPhoto, type PhotoNoteMeta, type RawMeta } from './photo-notes.logic';

/** Under the API's var/ (included in the nightly backup): var/photo-notes/<companyId>/<noteId>/<photoId>[-t].jpg */
export const PHOTO_NOTES_DIR = join(APP_ROOT, 'var', 'photo-notes');
const DAY_MS = 86_400_000;
/** Soft-deleted notes are kept this long (undo by support), then rows and files go for good. */
export const PHOTO_NOTE_DELETED_KEEP_DAYS = Number(process.env.PHOTO_NOTE_DELETED_KEEP_DAYS ?? 30);
/** Optional overall retention (days); 0 / unset = keep until deleted. */
export const PHOTO_NOTE_RETENTION_DAYS = Number(process.env.PHOTO_NOTE_RETENTION_DAYS ?? 0);

const INCLUDE = {
  photos: { orderBy: { position: 'asc' }, select: { id: true, width: true, height: true, path: true, thumbPath: true } },
  object: { select: { name: true, plateNumber: true } },
  user: { select: { name: true } },
} satisfies Prisma.GeoPhotoNoteInclude;
type Row = Prisma.GeoPhotoNoteGetPayload<{ include: typeof INCLUDE }>;

/** Who is uploading: a signed-in user (web / mobile app) or a Tracker-app phone (its assigned person). */
export type Uploader = { kind: 'user'; ctx: AuthContext; source: Extract<PhotoNoteSource, 'WEB' | 'MOBILE'> } | { kind: 'tracker'; companyId: string; objectId: string };

export interface PhotoNoteListFilter {
  from?: string;
  to?: string;
  objectId?: string;
  category?: string;
  bbox?: string;
  q?: string;
  mine?: string;
  page?: number;
  pageSize?: number;
}

const bad = (e: unknown): never => {
  if (e instanceof PhotoNoteInputError) throw new BadRequestException(e.message);
  throw e;
};

/** Minutes east of UTC of a time zone at a moment (for EXIF times, which carry no zone). */
export function tzOffsetMinutes(tz: string, at = new Date()): number {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  } catch {
    return 330;
  }
}

/**
 * Location photo notes: photos re-encoded and stored under var/photo-notes, served only through scope-checked
 * endpoints. Never logs coordinates or file paths.
 */
@Injectable()
export class PhotoNotesService {
  private readonly logger = new Logger('PhotoNotes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly geocoding?: GeocodingService,
    @Optional() private readonly expenses?: ExpensesService,
  ) {}

  // ───────────── create ─────────────

  async create(up: Uploader, files: IncomingPhoto[] | undefined, raw: RawMeta): Promise<{ note: PhotoNoteDto; created: boolean }> {
    let meta: PhotoNoteMeta;
    try {
      meta = parseMeta(raw);
    } catch (e) {
      return bad(e);
    }
    const companyId = up.kind === 'user' ? up.ctx.companyId : up.companyId;
    // The company's photoNotes switch (the guard already checked it for signed-in users; the Tracker app has no guard).
    await this.assertEnabled(companyId);
    // Idempotent replay first: the offline queue re-sends the same clientId (maybe after the photos were cleaned up).
    if (meta.clientId) {
      const prior = await this.byClientId(up, companyId, meta.clientId);
      if (prior) return { note: prior, created: false };
    }
    try {
      validatePhotos(files);
    } catch (e) {
      return bad(e);
    }
    let objectId: string | null = null;
    if (up.kind === 'tracker') objectId = up.objectId;
    else if (meta.objectId) {
      const o = await this.prisma.trackedObject.findFirst({ where: { AND: [objectScopeWhere(up.ctx), { id: meta.objectId }] }, select: { id: true } });
      if (!o) throw new NotFoundException('Person / vehicle not found');
      objectId = o.id;
    }
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    const offset = tzOffsetMinutes(company?.timezone ?? 'Asia/Kolkata');
    const encoded: EncodedPhoto[] = [];
    for (const f of files!) {
      try {
        encoded.push(await encodePhoto(f.buffer, offset));
      } catch {
        throw new BadRequestException('A photo could not be read; take it again');
      }
    }
    let lat = meta.lat;
    let lng = meta.lng;
    let accuracyM = meta.accuracyM;
    let takenAt = meta.takenAt;
    // Web uploads may come without a position: the photo's EXIF GPS (and time) is used when present.
    if (lat === null || lng === null) {
      const gps = up.kind === 'user' && up.source === 'WEB' ? encoded.find((p) => p.exif.lat !== null && p.exif.lng !== null)?.exif : undefined;
      if (!gps) throw new BadRequestException({ message: 'The photo has no location: pick the location on the map', code: 'LOCATION_REQUIRED' });
      lat = gps.lat;
      lng = gps.lng;
      accuracyM = null;
    }
    if (!takenAt && up.kind === 'user' && up.source === 'WEB') {
      const t = encoded.find((p) => p.exif.takenAt)?.exif.takenAt;
      if (t && t.getTime() <= Date.now() + 10 * 60_000) takenAt = t;
    }
    takenAt ??= new Date();
    const address = await this.geocoding?.reverse(lat!, lng!).catch(() => null);

    const id = randomUUID();
    const dir = join(PHOTO_NOTES_DIR, companyId, id);
    await mkdir(dir, { recursive: true });
    const photos: Prisma.GeoPhotoNotePhotoCreateManyNoteInput[] = [];
    try {
      for (const [i, p] of encoded.entries()) {
        const photoId = randomUUID();
        const path = join(dir, `${photoId}.jpg`);
        const thumbPath = join(dir, `${photoId}-t.jpg`);
        await writeFile(path, p.full);
        await writeFile(thumbPath, p.thumb);
        photos.push({ id: photoId, position: i, path, thumbPath, width: p.width, height: p.height, bytes: p.full.length });
      }
      const row = await this.prisma.geoPhotoNote.create({
        data: {
          id,
          companyId,
          objectId,
          userId: up.kind === 'user' ? up.ctx.userId : null,
          takenAt,
          lat: lat!,
          lng: lng!,
          accuracyM,
          address: address ?? null,
          category: meta.category,
          note: meta.note,
          amountMinor: meta.amountMinor,
          currency: meta.currency,
          source: up.kind === 'user' ? up.source : 'TRACKER_APP',
          clientId: meta.clientId,
          photos: { createMany: { data: photos } },
        },
        include: INCLUDE,
      });
      // Coordinates and paths are personal / internal: the audit keeps ids, category and the photo count.
      const after = { category: row.category, objectId: row.objectId, source: row.source, photos: photos.length, amountMinor: row.amountMinor };
      if (up.kind === 'user') await this.audit.record(up.ctx, { action: 'CREATE', entity: 'GeoPhotoNote', entityId: row.id, after });
      else await this.audit.recordSystem({ companyId, userId: null, ip: null }, { action: 'CREATE', entity: 'GeoPhotoNote', entityId: row.id, after: { ...after, via: 'tracker app' } });
      return { note: this.toDto(row, up.kind === 'user' ? up.ctx : null), created: true };
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      // Two sends of the same clientId at once: the loser returns the winner's note.
      if (meta.clientId && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const prior = await this.byClientId(up, companyId, meta.clientId);
        if (prior) return { note: prior, created: false };
      }
      throw e;
    }
  }

  private async byClientId(up: Uploader, companyId: string, clientId: string): Promise<PhotoNoteDto | null> {
    const row = await this.prisma.geoPhotoNote.findUnique({ where: { companyId_clientId: { companyId, clientId } }, include: INCLUDE });
    if (!row) return null;
    const same = up.kind === 'user' ? row.userId === up.ctx.userId : row.userId === null && row.objectId === up.objectId;
    if (!same) throw new ConflictException('This note id is already used');
    return this.toDto(row, up.kind === 'user' ? up.ctx : null);
  }

  // ───────────── read ─────────────

  private where(ctx: AuthContext, f: PhotoNoteListFilter): Prisma.GeoPhotoNoteWhereInput {
    const and: Prisma.GeoPhotoNoteWhereInput[] = [photoNoteScope(ctx)];
    const date = (s: string, label: string) => {
      const d = new Date(s);
      if (!Number.isFinite(d.getTime())) throw new BadRequestException(`Invalid ${label} date`);
      return d;
    };
    if (f.from) and.push({ takenAt: { gte: date(f.from, 'from') } });
    if (f.to) and.push({ takenAt: { lte: date(f.to, 'to') } });
    if (f.objectId) and.push({ objectId: f.objectId });
    if (f.category) {
      const c = f.category.toUpperCase() as PhotoNoteCategory;
      if (!PHOTO_NOTE_CATEGORIES.includes(c)) throw new BadRequestException('Unknown category');
      and.push({ category: c });
    }
    if (f.bbox) {
      try {
        const b = parseBbox(f.bbox);
        and.push({ lat: { gte: b.minLat, lte: b.maxLat }, lng: { gte: b.minLng, lte: b.maxLng } });
      } catch (e) {
        bad(e);
      }
    }
    const q = f.q?.trim().slice(0, 100);
    if (q) and.push({ OR: [{ note: { contains: q, mode: 'insensitive' } }, { address: { contains: q, mode: 'insensitive' } }] });
    if (f.mine === '1' || f.mine === 'true') and.push({ userId: ctx.userId });
    return { AND: and };
  }

  async list(ctx: AuthContext, f: PhotoNoteListFilter): Promise<Paginated<PhotoNoteDto>> {
    const page = Math.max(1, Math.floor(Number(f.page) || 1));
    const pageSize = Math.min(500, Math.max(1, Math.floor(Number(f.pageSize) || 50)));
    const where = this.where(ctx, f);
    const [rows, total] = await Promise.all([
      this.prisma.geoPhotoNote.findMany({ where, include: INCLUDE, orderBy: [{ takenAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.geoPhotoNote.count({ where }),
    ]);
    return { items: rows.map((r) => this.toDto(r, ctx)), total, page, pageSize };
  }

  /** CSV export: up to 10 000 notes of the filter, newest first. */
  async exportRows(ctx: AuthContext, f: PhotoNoteListFilter): Promise<PhotoNoteDto[]> {
    const rows = await this.prisma.geoPhotoNote.findMany({ where: this.where(ctx, f), include: INCLUDE, orderBy: { takenAt: 'desc' }, take: 10_000 });
    return rows.map((r) => this.toDto(r, ctx));
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.geoPhotoNote.findFirst({ where: { AND: [photoNoteScope(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('Photo note not found');
    return row;
  }

  async get(ctx: AuthContext, id: string): Promise<PhotoNoteDto> {
    return this.toDto(await this.find(ctx, id), ctx);
  }

  async photo(ctx: AuthContext, id: string, photoId: string, size: string | undefined): Promise<StreamableFile> {
    return this.stream(await this.find(ctx, id), photoId, size);
  }

  private async stream(row: Row, photoId: string, size: string | undefined): Promise<StreamableFile> {
    const p = row.photos.find((x) => x.id === photoId);
    if (!p) throw new NotFoundException('Photo not found');
    const path = size === 'thumb' ? p.thumbPath : p.path;
    const info = await stat(path).catch(() => null);
    if (!info) throw new NotFoundException('The photo file no longer exists');
    return new StreamableFile(createReadStream(path), { type: 'image/jpeg', length: info.size, disposition: 'inline' });
  }

  // ───────────── change ─────────────

  async update(ctx: AuthContext, id: string, b: { note?: string | null; category?: string; amountMinor?: number | null; currency?: string | null }): Promise<PhotoNoteDto> {
    const row = await this.find(ctx, id);
    if (!canChange(ctx, row, 'edit')) throw new ForbiddenException('You can only edit your own photo notes');
    const category = (b.category?.toUpperCase() ?? row.category) as PhotoNoteCategory;
    if (!PHOTO_NOTE_CATEGORIES.includes(category)) throw new BadRequestException('Choose a category');
    const note = b.note === undefined ? row.note : b.note?.trim() || null;
    if (note && note.length > PHOTO_NOTE_NOTE_MAX) throw new BadRequestException(`The note is longer than ${PHOTO_NOTE_NOTE_MAX} characters`);
    let money: { amountMinor: number | null; currency: string | null };
    try {
      money = moneyFields(category, b.amountMinor === undefined ? row.amountMinor : b.amountMinor, b.currency === undefined ? row.currency : b.currency);
    } catch (e) {
      return bad(e);
    }
    const next = await this.prisma.geoPhotoNote.update({ where: { id }, data: { category, note, ...money }, include: INCLUDE });
    await this.audit.record(ctx, {
      action: 'UPDATE',
      entity: 'GeoPhotoNote',
      entityId: id,
      before: { category: row.category, note: row.note, amountMinor: row.amountMinor, currency: row.currency },
      after: { category: next.category, note: next.note, amountMinor: next.amountMinor, currency: next.currency },
    });
    return this.toDto(next, ctx);
  }

  /** Soft delete; rows and files are removed for good by the retention sweep after PHOTO_NOTE_DELETED_KEEP_DAYS. */
  async remove(ctx: AuthContext, id: string): Promise<{ ok: true }> {
    const row = await this.find(ctx, id);
    if (!canChange(ctx, row, 'delete')) throw new ForbiddenException('You can only delete your own photo notes');
    await this.prisma.geoPhotoNote.update({ where: { id }, data: { deletedAt: new Date(), deletedById: ctx.userId } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'GeoPhotoNote', entityId: id, before: { category: row.category, objectId: row.objectId, source: row.source, takenAt: row.takenAt.toISOString() } });
    return { ok: true };
  }

  /** "Send to Fuel & expenses": an Expense with the note's amount and first photo (needs expenses: create). */
  async toExpense(ctx: AuthContext, id: string, b: { objectId?: string; kind?: string; vendor?: string }): Promise<PhotoNoteDto> {
    if (!this.expenses) throw new NotFoundException('Expenses are not available');
    if (!hasPermission(ctx, 'expenses', 'create')) throw new ForbiddenException('You need permission to add expenses');
    const row = await this.find(ctx, id);
    if (!PHOTO_NOTE_MONEY_CATEGORIES.includes(row.category as PhotoNoteCategory)) throw new BadRequestException('Only bills and receipts can be sent to expenses');
    if (row.expenseId) throw new ConflictException('This note is already in Fuel & expenses');
    if (!row.amountMinor) throw new BadRequestException('Enter the amount of the bill first');
    if (row.currency && row.currency !== 'INR') throw new BadRequestException('Only amounts in INR can be sent to expenses');
    const objectId = row.objectId ?? b.objectId;
    if (!objectId) throw new BadRequestException('Choose the vehicle / person the expense belongs to');
    const kind = (b.kind?.toUpperCase() ?? 'OTHER') as ExpenseKind;
    if (!EXPENSE_KINDS.includes(kind) || kind === 'FUEL') throw new BadRequestException('Choose an expense type (fuel fill-ups are entered in Fuel & expenses)');
    const expense = await this.expenses.create(ctx, { objectId, kind, at: row.takenAt.toISOString(), amountPaise: row.amountMinor, vendor: b.vendor?.trim().slice(0, 120) || null, note: row.note?.slice(0, 300) ?? null });
    const first = row.photos[0];
    if (first) {
      const buffer = await readFile(first.path).catch(() => null);
      if (buffer) await this.expenses.attach(ctx, expense.id, { buffer, mimetype: 'image/jpeg' }).catch((e: Error) => this.logger.warn(`Bill photo of expense ${expense.id} not attached: ${e.message}`));
    }
    const next = await this.prisma.geoPhotoNote.update({ where: { id }, data: { expenseId: expense.id }, include: INCLUDE });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'GeoPhotoNote', entityId: id, details: { sentToExpense: expense.id } });
    return this.toDto(next, ctx);
  }

  /** 403 FEATURE_OFF while the company's photoNotes switch is off (notes are kept, only hidden). */
  async assertEnabled(companyId: string): Promise<void> {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    assertPhotoFeature(c?.settings, 'photoNotes');
  }

  // ───────────── Tracker app (the phone's person) ─────────────

  private trackerWhere(companyId: string, objectId: string): Prisma.GeoPhotoNoteWhereInput {
    return { companyId, objectId, source: 'TRACKER_APP', userId: null, deletedAt: null };
  }

  async trackerList(companyId: string, objectId: string, limit?: number): Promise<{ items: PhotoNoteDto[] }> {
    await this.assertEnabled(companyId);
    const take = Math.min(100, Math.max(1, Math.floor(Number(limit) || 30)));
    const rows = await this.prisma.geoPhotoNote.findMany({ where: this.trackerWhere(companyId, objectId), include: INCLUDE, orderBy: { takenAt: 'desc' }, take });
    return { items: rows.map((r) => this.toDto(r, null, true)) };
  }

  private async trackerFind(companyId: string, objectId: string, id: string): Promise<Row> {
    await this.assertEnabled(companyId);
    const row = await this.prisma.geoPhotoNote.findFirst({ where: { ...this.trackerWhere(companyId, objectId), id }, include: INCLUDE });
    if (!row) throw new NotFoundException('Photo note not found');
    return row;
  }

  async trackerPhoto(companyId: string, objectId: string, id: string, photoId: string, size?: string): Promise<StreamableFile> {
    return this.stream(await this.trackerFind(companyId, objectId, id), photoId, size);
  }

  async trackerRemove(companyId: string, objectId: string, id: string): Promise<{ ok: true }> {
    const row = await this.trackerFind(companyId, objectId, id);
    await this.prisma.geoPhotoNote.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.recordSystem({ companyId, userId: null, ip: null }, { action: 'DELETE', entity: 'GeoPhotoNote', entityId: id, details: { via: 'tracker app', category: row.category } });
    return { ok: true };
  }

  // ───────────── retention / erasure ─────────────

  /**
   * Retention sweep (called by RetentionService): soft-deleted notes past PHOTO_NOTE_DELETED_KEEP_DAYS and, when
   * PHOTO_NOTE_RETENTION_DAYS is set, notes taken before that are removed with their files; then folders of notes that no
   * longer exist (a purge of their person / user / company removes rows only) are deleted. Returns the counts.
   */
  async sweep(now: number, deadline: number): Promise<{ notes: number; orphanDirs: number }> {
    let notes = 0;
    const or: Prisma.GeoPhotoNoteWhereInput[] = [{ deletedAt: { lt: new Date(now - PHOTO_NOTE_DELETED_KEEP_DAYS * DAY_MS) } }];
    if (PHOTO_NOTE_RETENTION_DAYS > 0) or.push({ takenAt: { lt: new Date(now - PHOTO_NOTE_RETENTION_DAYS * DAY_MS) } });
    for (;;) {
      if (Date.now() > deadline) return { notes, orphanDirs: 0 };
      const batch = await this.prisma.geoPhotoNote.findMany({ where: { OR: or }, select: { id: true, companyId: true }, take: 200 });
      if (!batch.length) break;
      for (const n of batch) await rm(join(PHOTO_NOTES_DIR, n.companyId, n.id), { recursive: true, force: true }).catch(() => undefined);
      notes += (await this.prisma.geoPhotoNote.deleteMany({ where: { id: { in: batch.map((n) => n.id) } } })).count;
      if (batch.length < 200) break;
    }
    return { notes, orphanDirs: await this.sweepOrphans(deadline) };
  }

  private async sweepOrphans(deadline: number): Promise<number> {
    let removed = 0;
    const companies = await readdir(PHOTO_NOTES_DIR).catch(() => [] as string[]);
    for (const c of companies) {
      if (Date.now() > deadline) break;
      const dirs = (await readdir(join(PHOTO_NOTES_DIR, c)).catch(() => [] as string[])).filter((d) => /^[0-9a-f-]{36}$/i.test(d));
      for (let i = 0; i < dirs.length; i += 500) {
        const chunk = dirs.slice(i, i + 500);
        const known = new Set((await this.prisma.geoPhotoNote.findMany({ where: { id: { in: chunk } }, select: { id: true } })).map((r) => r.id));
        // A folder written in the last hour may belong to a note being saved right now.
        for (const d of chunk) {
          if (known.has(d)) continue;
          const info = await stat(join(PHOTO_NOTES_DIR, c, d)).catch(() => null);
          if (!info || Date.now() - info.mtimeMs < 3600_000) continue;
          await rm(join(PHOTO_NOTES_DIR, c, d), { recursive: true, force: true }).catch(() => undefined);
          removed++;
        }
      }
    }
    return removed;
  }

  // ───────────── mapping ─────────────

  private toDto(r: Row, ctx: AuthContext | null, trackerOwner = false): PhotoNoteDto {
    const mine = trackerOwner || (!!ctx && r.userId === ctx.userId);
    return {
      id: r.id,
      objectId: r.objectId,
      objectName: r.object ? (r.object.plateNumber && r.object.plateNumber !== r.object.name ? `${r.object.name} (${r.object.plateNumber})` : r.object.name) : null,
      userId: r.userId,
      userName: r.user?.name ?? null,
      takenAt: r.takenAt.toISOString(),
      lat: r.lat,
      lng: r.lng,
      accuracyM: r.accuracyM,
      address: r.address,
      category: r.category as PhotoNoteCategory,
      note: r.note,
      amountMinor: r.amountMinor,
      currency: r.currency,
      source: r.source as PhotoNoteSource,
      clientId: r.clientId,
      photos: r.photos.map((p) => ({ id: p.id, width: p.width, height: p.height })),
      expenseId: r.expenseId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      mine,
      canEdit: trackerOwner ? false : !!ctx && canChange(ctx, r, 'edit'),
      canDelete: trackerOwner ? true : !!ctx && canChange(ctx, r, 'delete'),
    };
  }
}
