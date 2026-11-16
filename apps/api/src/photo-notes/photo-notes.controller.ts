import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { EXPENSE_KINDS, PHOTO_NOTE_CATEGORIES, PHOTO_NOTE_CATEGORY_LABELS, PHOTO_NOTE_FILE_FIELD, PHOTO_NOTE_MAX_BYTES, PHOTO_NOTE_MAX_PHOTOS, PHOTO_NOTE_NOTE_MAX, PHOTO_NOTE_SOURCE_LABELS, type PhotoNoteCategory, type PhotoNoteDto, type Paginated } from '@veetracer/shared';
import { IsIn, IsInt, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Response } from 'express';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequireAnyPermission, RequirePermission } from '../access/decorators';
import { csvFile } from '../common/csv';
import { MobileTrackerService } from '../mobile-tracker/mobile-tracker.service';
import type { IncomingPhoto } from './photo-notes.logic';
import { PhotoNotesService } from './photo-notes.service';

const UPLOAD = FilesInterceptor(PHOTO_NOTE_FILE_FIELD, PHOTO_NOTE_MAX_PHOTOS, { limits: { fileSize: PHOTO_NOTE_MAX_BYTES, files: PHOTO_NOTE_MAX_PHOTOS, fields: 20, fieldSize: 8 * 1024 } });

/** Multipart text fields (strings on the wire); checked in detail by parseMeta. */
class CreateFields {
  @IsOptional() @IsString() @MaxLength(64) clientId?: string;
  @IsOptional() @IsString() @MaxLength(64) objectId?: string;
  @IsOptional() @IsString() @MaxLength(40) takenAt?: string;
  @IsOptional() @IsString() @MaxLength(30) lat?: string;
  @IsOptional() @IsString() @MaxLength(30) lng?: string;
  @IsOptional() @IsString() @MaxLength(30) accuracyM?: string;
  @IsOptional() @IsString() @MaxLength(20) category?: string;
  @IsOptional() @IsString() @MaxLength(PHOTO_NOTE_NOTE_MAX + 50) note?: string;
  @IsOptional() @IsString() @MaxLength(20) amountMinor?: string;
  @IsOptional() @IsString() @MaxLength(5) currency?: string;
  @IsOptional() @IsIn(['WEB', 'MOBILE']) source?: 'WEB' | 'MOBILE';
}

class ListQuery {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsIn(PHOTO_NOTE_CATEGORIES) category?: PhotoNoteCategory;
  @IsOptional() @IsString() @MaxLength(100) bbox?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['1', '0', 'true', 'false']) mine?: string;
  @IsOptional() @IsNumberString() page?: string;
  @IsOptional() @IsNumberString() pageSize?: string;
  @IsOptional() @IsIn(['csv', 'json']) format?: string;
}

class PhotoQuery {
  @IsOptional() @IsIn(['thumb', 'full']) size?: 'thumb' | 'full';
}

class UpdateBody {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(PHOTO_NOTE_NOTE_MAX) note?: string | null;
  @IsOptional() @IsIn(PHOTO_NOTE_CATEGORIES) category?: PhotoNoteCategory;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100_000_000) amountMinor?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(3) currency?: string | null;
}

class ToExpenseBody {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsIn(EXPENSE_KINDS) kind?: string;
  @IsOptional() @IsString() @MaxLength(120) vendor?: string;
}

class TrackerListQuery {
  @IsOptional() @IsNumberString() limit?: string;
}

const pageOf = (q: ListQuery) => ({ ...q, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined });

/** Location photo notes for signed-in users (web and the VeeTrax mobile app). */
@Controller('photo-notes')
export class PhotoNotesController {
  constructor(private readonly notes: PhotoNotesService) {}

  @Post() @RequirePermission('photo_notes', 'create')
  @UseInterceptors(UPLOAD)
  async create(@Auth() ctx: AuthContext, @Body() body: CreateFields, @UploadedFiles() files: IncomingPhoto[] | undefined, @Res({ passthrough: true }) res: Response): Promise<PhotoNoteDto> {
    const r = await this.notes.create({ kind: 'user', ctx, source: body.source ?? 'WEB' }, files, body);
    res.status(r.created ? 201 : 200);
    return r.note;
  }

  @Get() @RequirePermission('photo_notes', 'view')
  async list(@Auth() ctx: AuthContext, @Query() q: ListQuery): Promise<Paginated<PhotoNoteDto> | StreamableFile> {
    if (q.format !== 'csv') return this.notes.list(ctx, pageOf(q));
    // The guard already required `export` for format=csv.
    const rows = await this.notes.exportRows(ctx, pageOf(q));
    return csvFile('photo-notes', rows, [
      { header: 'Taken at', value: (r) => r.takenAt },
      { header: 'Category', value: (r) => PHOTO_NOTE_CATEGORY_LABELS[r.category] },
      { header: 'Person / vehicle', value: (r) => r.objectName },
      { header: 'Uploaded by', value: (r) => r.userName },
      { header: 'Note', value: (r) => r.note },
      { header: 'Amount', value: (r) => (r.amountMinor === null ? null : (r.amountMinor / 100).toFixed(2)) },
      { header: 'Currency', value: (r) => r.currency },
      { header: 'Address', value: (r) => r.address },
      { header: 'Latitude', value: (r) => r.lat },
      { header: 'Longitude', value: (r) => r.lng },
      { header: 'Accuracy (m)', value: (r) => r.accuracyM },
      { header: 'Photos', value: (r) => r.photos.length },
      { header: 'Source', value: (r) => PHOTO_NOTE_SOURCE_LABELS[r.source] },
      { header: 'In expenses', value: (r) => (r.expenseId ? 'Yes' : '') },
    ]);
  }

  @Get(':id') @RequirePermission('photo_notes', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<PhotoNoteDto> {
    return this.notes.get(ctx, id);
  }

  @Get(':id/photos/:photoId') @RequirePermission('photo_notes', 'view')
  photo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('photoId', ParseUUIDPipe) photoId: string, @Query() q: PhotoQuery): Promise<StreamableFile> {
    return this.notes.photo(ctx, id, photoId, q.size);
  }

  @Patch(':id') @RequireAnyPermission(['photo_notes', 'create'], ['photo_notes', 'edit'])
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBody): Promise<PhotoNoteDto> {
    return this.notes.update(ctx, id, body);
  }

  @Delete(':id') @RequireAnyPermission(['photo_notes', 'create'], ['photo_notes', 'delete'])
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.notes.remove(ctx, id);
  }

  @Post(':id/expense') @HttpCode(200) @RequirePermission('photo_notes', 'view')
  toExpense(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ToExpenseBody): Promise<PhotoNoteDto> {
    return this.notes.toExpense(ctx, id, body);
  }
}

/** Tracker app: photo notes of the phone's own person, with the tracker session token (Bearer). */
@Controller('tracker/v1/photo-notes')
@UseGuards(ThrottlerGuard)
export class TrackerPhotoNotesController {
  constructor(
    private readonly notes: PhotoNotesService,
    private readonly tracker: MobileTrackerService,
  ) {}

  @Public() @Post() @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseInterceptors(UPLOAD)
  async create(@Headers('authorization') authorization: string | undefined, @Body() body: CreateFields, @UploadedFiles() files: IncomingPhoto[] | undefined, @Res({ passthrough: true }) res: Response): Promise<PhotoNoteDto> {
    const owner = await this.tracker.phoneOwner(authorization);
    if (!body.lat || !body.lng) throw new BadRequestException('The location of the photo is missing');
    const r = await this.notes.create({ kind: 'tracker', ...owner }, files, { ...body, objectId: undefined });
    res.status(r.created ? 201 : 200);
    return r.note;
  }

  @Public() @Get() @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async list(@Headers('authorization') authorization: string | undefined, @Query() q: TrackerListQuery): Promise<{ items: PhotoNoteDto[] }> {
    const o = await this.tracker.phoneOwner(authorization);
    return this.notes.trackerList(o.companyId, o.objectId, q.limit ? Number(q.limit) : undefined);
  }

  @Public() @Get(':id/photos/:photoId') @Throttle({ default: { ttl: 60_000, limit: 120 } })
  async photo(@Headers('authorization') authorization: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Param('photoId', ParseUUIDPipe) photoId: string, @Query() q: PhotoQuery): Promise<StreamableFile> {
    const o = await this.tracker.phoneOwner(authorization);
    return this.notes.trackerPhoto(o.companyId, o.objectId, id, photoId, q.size);
  }

  @Public() @Delete(':id') @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async remove(@Headers('authorization') authorization: string | undefined, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    const o = await this.tracker.phoneOwner(authorization);
    return this.notes.trackerRemove(o.companyId, o.objectId, id);
  }
}
