import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  addDays,
  ComplianceSummary,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MIME_TYPES,
  DocumentDto,
  documentStatus,
  documentTypeLabel,
  LICENSE_WARN_DAYS,
  serviceStatus,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { BulkActionDto, runBulk } from '../common/bulk';
import { iso } from '../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../common/list-query';
import { APP_ROOT } from '../config/env';
import { driverScopeWhere } from '../drivers/drivers.service';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey } from '../summarizer/tz';
import { CreateDocumentDto, DocumentListQuery, UpdateDocumentDto } from './documents.dto';
import { dateOf, odometers, ymd } from './reminder-logic';

const ENTITY = 'document';
export const DOCUMENTS_DIR = join(APP_ROOT, 'var', 'documents');

const INCLUDE = {
  object: { select: { name: true, plateNumber: true } },
  driver: { select: { name: true } },
} satisfies Prisma.DocumentInclude;
type Row = Prisma.DocumentGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: ['number', 'notes', 'type', 'object.name', 'object.plateNumber', 'driver.name'],
  sort: { expiresOn: 'expiresOn', type: 'type', number: 'number', issuedOn: 'issuedOn', objectName: 'object.name', driverName: 'driver.name', createdAt: 'createdAt' },
  defaultSort: 'expiresOn',
  status: null,
};

const STATUS_LABEL: Record<DocumentDto['status'], string> = { VALID: 'Valid', EXPIRING: 'Expiring', EXPIRED: 'Expired', NO_EXPIRY: 'No expiry' };

const CSV: CsvSpec<DocumentDto> = {
  name: 'documents',
  columns: [
    { header: 'Document', value: (d) => documentTypeLabel(d.type) },
    { header: 'Number', value: (d) => d.number },
    { header: 'Vehicle', value: (d) => d.objectName },
    { header: 'Plate', value: (d) => d.plateNumber },
    { header: 'Driver', value: (d) => d.driverName },
    { header: 'Issued on', value: (d) => d.issuedOn },
    { header: 'Expires on', value: (d) => d.expiresOn },
    { header: 'Days left', value: (d) => d.daysLeft },
    { header: 'Status', value: (d) => STATUS_LABEL[d.status] },
    { header: 'Reminder (days before)', value: (d) => d.reminderDays },
    { header: 'File', value: (d) => d.file?.name ?? null },
    { header: 'Notes', value: (d) => d.notes },
  ],
};

/** Magic bytes per allowed type, so a renamed executable can't be stored as a "PDF". */
const SIGNATURES: Record<(typeof DOCUMENT_MIME_TYPES)[number], (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
};
const EXT: Record<(typeof DOCUMENT_MIME_TYPES)[number], string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export interface UploadedDocumentFile {
  buffer: Buffer;
  originalname?: string;
  mimetype?: string;
  size?: number;
}

const blank = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'document';

/** Documents the caller may see: those of visible vehicles and of visible drivers. */
export function documentScopeWhere(ctx: Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds' | 'objectIds'>): Prisma.DocumentWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return { companyId: ctx.companyId, OR: [{ object: { is: objectScopeWhere(ctx) } }, { driver: { is: driverScopeWhere(ctx) } }] };
}

export function toDocumentDto(d: Row, today: string, names: Map<string, string> = new Map()): DocumentDto {
  const expiresOn = ymd(d.expiresOn);
  const { status, daysLeft } = documentStatus(expiresOn, d.reminderDays, today);
  return {
    id: d.id,
    owner: d.driverId ? 'DRIVER' : 'VEHICLE',
    objectId: d.objectId,
    objectName: d.object?.name ?? null,
    plateNumber: d.object?.plateNumber ?? null,
    driverId: d.driverId,
    driverName: d.driver?.name ?? null,
    type: d.type,
    number: d.number,
    issuedOn: ymd(d.issuedOn),
    expiresOn,
    reminderDays: d.reminderDays,
    notes: d.notes,
    file: d.filePath && d.fileName ? { name: d.fileName, type: d.fileType ?? 'application/octet-stream', size: d.fileSize ?? 0 } : null,
    status,
    daysLeft,
    createdByName: d.createdById ? (names.get(d.createdById) ?? null) : null,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Today (YYYY-MM-DD) in the company timezone. */
  async today(companyId: string): Promise<string> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    return localDayKey(Date.now(), company?.timezone ?? 'Asia/Kolkata');
  }

  async list(ctx: AuthContext, query: DocumentListQuery) {
    const today = await this.today(ctx.companyId);
    const plan = planList<Prisma.DocumentWhereInput, Prisma.DocumentOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.DocumentWhereInput[] = [documentScopeWhere(ctx), plan.where];
    if (query.objectId) filters.push({ objectId: query.objectId });
    if (query.driverId) filters.push({ driverId: query.driverId });
    if (query.owner) filters.push(query.owner === 'DRIVER' ? { driverId: { not: null } } : { objectId: { not: null } });
    if (query.type) filters.push({ type: query.type });
    if (query.expiry) filters.push(await this.expiryWhere(ctx.companyId, query.expiry, today));
    const where: Prisma.DocumentWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.document.count({ where }),
    ]);
    const names = await this.userNames(rows.map((r) => r.createdById));
    return listResult(plan, rows.map((r) => toDocumentDto(r, today, names)), total, CSV);
  }

  /** Expiry status as a filter; "expiring" depends on each row's own reminder window, hence the SQL. */
  private async expiryWhere(companyId: string, expiry: NonNullable<DocumentListQuery['expiry']>, today: string): Promise<Prisma.DocumentWhereInput> {
    if (expiry === 'NO_EXPIRY') return { expiresOn: null };
    if (expiry === 'EXPIRED') return { expiresOn: { lt: dateOf(today) } };
    const rows =
      expiry === 'EXPIRING'
        ? await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Document"
            WHERE "companyId" = ${companyId}::uuid AND "expiresOn" >= ${today}::date AND "expiresOn" <= ${today}::date + "reminderDays"`
        : await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Document"
            WHERE "companyId" = ${companyId}::uuid AND "expiresOn" > ${today}::date + "reminderDays"`;
    return { id: { in: rows.map((r) => r.id) } };
  }

  async get(ctx: AuthContext, id: string): Promise<DocumentDto> {
    const row = await this.find(ctx, id);
    return toDocumentDto(row, await this.today(ctx.companyId), await this.userNames([row.createdById]));
  }

  async create(ctx: AuthContext, dto: CreateDocumentDto): Promise<DocumentDto> {
    const owner = await this.assertOwner(ctx, dto.objectId ?? null, dto.driverId ?? null);
    this.assertDates(dto.issuedOn ?? null, dto.expiresOn ?? null);
    const row = await this.prisma.document.create({
      data: {
        ...(this.data(dto) as Omit<Prisma.DocumentUncheckedCreateInput, 'companyId' | 'type'>),
        companyId: ctx.companyId,
        type: dto.type,
        objectId: owner.objectId,
        driverId: owner.driverId,
        createdById: ctx.userId,
      },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: this.snapshot(row) });
    await this.syncLicence(row);
    return this.get(ctx, row.id);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDocumentDto): Promise<DocumentDto> {
    const before = await this.find(ctx, id);
    let ownerData: { objectId: string | null; driverId: string | null } | undefined;
    if (dto.objectId !== undefined || dto.driverId !== undefined) {
      ownerData = await this.assertOwner(ctx, dto.objectId !== undefined ? dto.objectId : before.objectId, dto.driverId !== undefined ? dto.driverId : before.driverId);
    }
    this.assertDates(dto.issuedOn !== undefined ? dto.issuedOn : ymd(before.issuedOn), dto.expiresOn !== undefined ? dto.expiresOn : ymd(before.expiresOn));
    const data = this.data(dto);
    // New expiry or reminder window: the reminders job starts over for this document.
    const expiryChanged = (dto.expiresOn !== undefined && dto.expiresOn?.slice(0, 10) !== ymd(before.expiresOn)) || (dto.reminderDays !== undefined && dto.reminderDays !== before.reminderDays);
    const row = await this.prisma.document.update({
      where: { id },
      data: { ...data, ...(ownerData ?? {}), ...(dto.type ? { type: dto.type } : {}), ...(expiryChanged ? { notifiedState: null } : {}) },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: this.snapshot(before), after: this.snapshot(row) });
    await this.syncLicence(row);
    return this.get(ctx, id);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    await this.prisma.document.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: this.snapshot(before) });
    if (before.filePath) await unlink(before.filePath).catch(() => undefined);
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    if (dto.action !== 'delete') throw new BadRequestException('Documents can only be deleted in bulk');
    return runBulk(ctx, 'documents', dto, {
      setActive: () => Promise.reject(new BadRequestException('Documents have no active flag')),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  // ───────────── attachment ─────────────

  async attach(ctx: AuthContext, id: string, file: UploadedDocumentFile | undefined): Promise<DocumentDto> {
    const before = await this.find(ctx, id);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a file to upload');
    if (file.buffer.length > DOCUMENT_MAX_BYTES) throw new BadRequestException('The file is larger than 10 MB');
    const type = (file.mimetype ?? '').toLowerCase() as (typeof DOCUMENT_MIME_TYPES)[number];
    if (!DOCUMENT_MIME_TYPES.includes(type)) throw new BadRequestException('Upload a PDF or an image (JPEG, PNG, WebP, HEIC)');
    if (!SIGNATURES[type](file.buffer)) throw new BadRequestException('The file content does not match its type');
    const dir = join(DOCUMENTS_DIR, ctx.companyId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}-${randomUUID()}.${EXT[type]}`);
    await writeFile(path, file.buffer);
    const fileName = safeName(file.originalname?.trim() || `${before.type.toLowerCase()}.${EXT[type]}`);
    await this.prisma.document.update({ where: { id }, data: { fileName, filePath: path, fileType: type, fileSize: file.buffer.length } });
    if (before.filePath && before.filePath !== path) await unlink(before.filePath).catch(() => undefined);
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: { file: before.fileName }, after: { file: fileName } });
    return this.get(ctx, id);
  }

  async detach(ctx: AuthContext, id: string): Promise<DocumentDto> {
    const before = await this.find(ctx, id);
    if (!before.filePath) return this.get(ctx, id);
    await this.prisma.document.update({ where: { id }, data: { fileName: null, filePath: null, fileType: null, fileSize: null } });
    await unlink(before.filePath).catch(() => undefined);
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: { file: before.fileName }, after: { file: null } });
    return this.get(ctx, id);
  }

  async file(ctx: AuthContext, id: string): Promise<StreamableFile> {
    const row = await this.find(ctx, id);
    if (!row.filePath || !row.fileName) throw new NotFoundException('This document has no file');
    const info = await stat(row.filePath).catch(() => null);
    if (!info) throw new NotFoundException('The file no longer exists');
    return new StreamableFile(createReadStream(row.filePath), {
      type: row.fileType ?? 'application/octet-stream',
      disposition: `attachment; filename="${row.fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
      length: info.size,
    });
  }

  // ───────────── dashboard ─────────────

  /** Expiring / expired documents and due services the caller can see. */
  async summary(ctx: AuthContext): Promise<ComplianceSummary> {
    const today = await this.today(ctx.companyId);
    const monthEnd = addDays(`${today.slice(0, 7)}-01`, 31).slice(0, 7);
    const lastOfMonth = addDays(`${monthEnd}-01`, -1);
    const [docs, licences, reminders] = await Promise.all([
      this.prisma.document.findMany({
        where: { AND: [documentScopeWhere(ctx), { expiresOn: { not: null } }] },
        select: { expiresOn: true, reminderDays: true },
      }),
      // Licence expiry kept on the driver only (no driving licence document): reminded too.
      this.prisma.driver.findMany({
        where: { AND: [driverScopeWhere(ctx), { isActive: true, licenseExpiry: { not: null }, documents: { none: { type: 'DRIVING_LICENCE' } } }] },
        select: { licenseExpiry: true },
      }),
      this.prisma.serviceReminder.findMany({
        where: { companyId: ctx.companyId, isActive: true, object: objectScopeWhere(ctx) },
        select: { objectId: true, dueAt: true, dueOdometerKm: true, notifyBeforeDays: true, notifyBeforeKm: true },
      }),
    ]);
    const out: ComplianceSummary = { documentsExpiring: 0, documentsExpired: 0, documentsExpiringThisMonth: 0, servicesDueSoon: 0, servicesOverdue: 0 };
    for (const d of [...docs, ...licences.map((l) => ({ expiresOn: l.licenseExpiry, reminderDays: LICENSE_WARN_DAYS }))]) {
      const expiresOn = ymd(d.expiresOn)!;
      const { status } = documentStatus(expiresOn, d.reminderDays, today);
      if (status === 'EXPIRED') out.documentsExpired++;
      else if (status === 'EXPIRING') out.documentsExpiring++;
      if (expiresOn >= today && expiresOn <= lastOfMonth) out.documentsExpiringThisMonth++;
    }
    const odo = await odometers(this.prisma, reminders.filter((r) => r.dueOdometerKm !== null).map((r) => r.objectId));
    for (const r of reminders) {
      const { status } = serviceStatus({ ...r, dueAt: ymd(r.dueAt) }, today, odo.get(r.objectId) ?? null);
      if (status === 'OVERDUE') out.servicesOverdue++;
      else if (status === 'DUE_SOON') out.servicesDueSoon++;
    }
    return out;
  }

  // ───────────── helpers ─────────────

  private data(dto: UpdateDocumentDto): Prisma.DocumentUncheckedUpdateInput {
    const date = (v: string | null | undefined) => (v === undefined ? undefined : v ? dateOf(v) : null);
    return {
      number: blank(dto.number),
      issuedOn: date(dto.issuedOn),
      expiresOn: date(dto.expiresOn),
      reminderDays: dto.reminderDays,
      notes: blank(dto.notes),
    };
  }

  private assertDates(issuedOn: string | null, expiresOn: string | null): void {
    if (issuedOn && expiresOn && issuedOn.slice(0, 10) > expiresOn.slice(0, 10)) throw new BadRequestException('The expiry date is before the issue date');
  }

  /** Exactly one owner, visible to the caller. */
  private async assertOwner(ctx: AuthContext, objectId: string | null, driverId: string | null): Promise<{ objectId: string | null; driverId: string | null }> {
    if (!!objectId === !!driverId) throw new BadRequestException('Choose either a vehicle or a driver');
    if (objectId) {
      const ok = await this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: objectId }] } });
      if (!ok) throw new BadRequestException('Vehicle not found');
    } else {
      const ok = await this.prisma.driver.count({ where: { AND: [driverScopeWhere(ctx), { id: driverId! }] } });
      if (!ok) throw new BadRequestException('Driver not found');
    }
    return { objectId, driverId };
  }

  /** A driver's (renewed) driving licence document keeps the licence number / expiry on the driver up to date. */
  private async syncLicence(row: Row): Promise<void> {
    if (!row.driverId || row.type !== 'DRIVING_LICENCE' || !row.expiresOn) return;
    const driver = await this.prisma.driver.findUnique({ where: { id: row.driverId }, select: { licenseExpiry: true, licenseNo: true } });
    if (!driver || (driver.licenseExpiry && driver.licenseExpiry > row.expiresOn)) return;
    if (driver.licenseExpiry?.getTime() === row.expiresOn.getTime() && (driver.licenseNo ?? null) === (row.number ?? driver.licenseNo ?? null)) return;
    await this.prisma.driver.update({
      where: { id: row.driverId },
      data: { licenseExpiry: row.expiresOn, licenseNo: row.number ?? driver.licenseNo, licenseNotifiedState: null },
    });
  }

  private snapshot(row: Row): Record<string, unknown> {
    const { object: _o, driver: _d, filePath: _p, notifiedState: _n, ...rest } = row;
    return rest;
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.document.findFirst({ where: { AND: [documentScopeWhere(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }
}
