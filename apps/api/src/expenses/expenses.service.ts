import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EXPENSE_KINDS, vehicleCost, type ExpenseDto, type ExpenseInput, type ExpenseKind, type ExpenseSummaryDto } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { APP_ROOT } from '../config/env';
import { odometers } from '../documents/reminder-logic';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey } from '../summarizer/tz';

export const EXPENSES_DIR = join(APP_ROOT, 'var', 'expenses');
const MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES: Record<string, { ext: string; sig: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', sig: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: 'png', sig: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': { ext: 'webp', sig: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  'application/pdf': { ext: 'pdf', sig: (b) => b.subarray(0, 4).toString() === '%PDF' },
};

export interface UploadedBill {
  buffer: Buffer;
  mimetype?: string;
}

const INCLUDE = { object: { select: { name: true, plateNumber: true } } } as const;
type Row = Prisma.ExpenseGetPayload<{ include: typeof INCLUDE }>;

/**
 * Fuel & expense log per vehicle with a bill photo; the VeeTrax odometer is stored with each entry. Summary: km per
 * litre and cost per km over a period (distance from the day summaries).
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scope(ctx: AuthContext): Prisma.ExpenseWhereInput {
    return { object: { is: allCompaniesOr(ctx, objectScopeWhere(ctx)) } };
  }

  private async names(rows: Row[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => (r.createdById ? [r.createdById] : [])))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toDto(r: Row, names: Map<string, string>): ExpenseDto {
    return {
      id: r.id,
      objectId: r.objectId,
      objectName: r.object.plateNumber && r.object.plateNumber !== r.object.name ? `${r.object.name} (${r.object.plateNumber})` : r.object.name,
      kind: r.kind as ExpenseKind,
      at: r.at.toISOString(),
      amountPaise: r.amountPaise,
      litres: r.litres,
      odometerKm: r.odometerKm,
      vendor: r.vendor,
      note: r.note,
      hasPhoto: !!r.photoPath,
      createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null,
    };
  }

  async list(ctx: AuthContext, q: { objectId?: string; from?: string; to?: string; kind?: ExpenseKind }): Promise<ExpenseDto[]> {
    const rows = await this.prisma.expense.findMany({
      where: { AND: [this.scope(ctx), q.objectId ? { objectId: q.objectId } : {}, q.kind ? { kind: q.kind } : {}, q.from ? { at: { gte: new Date(q.from) } } : {}, q.to ? { at: { lte: new Date(q.to) } } : {}] },
      include: INCLUDE,
      orderBy: { at: 'desc' },
      take: 500,
    });
    const names = await this.names(rows);
    return rows.map((r) => this.toDto(r, names));
  }

  private validate(i: ExpenseInput): void {
    if (!EXPENSE_KINDS.includes(i.kind)) throw new BadRequestException('Choose the expense type');
    if (!Number.isInteger(i.amountPaise) || i.amountPaise <= 0 || i.amountPaise > 100_000_000) throw new BadRequestException('Enter the amount');
    if (i.kind === 'FUEL' && (!i.litres || i.litres <= 0 || i.litres > 2000)) throw new BadRequestException('Enter the litres filled');
    const at = Date.parse(i.at);
    if (!Number.isFinite(at) || at > Date.now() + 5 * 60_000) throw new BadRequestException('Enter a date that is not in the future');
  }

  async create(ctx: AuthContext, i: ExpenseInput): Promise<ExpenseDto> {
    this.validate(i);
    const o = await this.prisma.trackedObject.findFirst({ where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: i.objectId }] }, select: { id: true, companyId: true } });
    if (!o) throw new NotFoundException('Vehicle not found');
    const odo = (await odometers(this.prisma, [o.id])).get(o.id) ?? null;
    const row = await this.prisma.expense.create({
      data: { companyId: o.companyId, objectId: o.id, kind: i.kind, at: new Date(i.at), amountPaise: i.amountPaise, litres: i.kind === 'FUEL' ? (i.litres ?? null) : null, odometerKm: odo, vendor: i.vendor?.trim().slice(0, 120) || null, note: i.note?.trim().slice(0, 300) || null, createdById: ctx.userId },
      include: INCLUDE,
    });
    await this.audit.record({ ...ctx, companyId: o.companyId }, { action: 'CREATE', entity: 'Expense', entityId: row.id, after: { objectId: o.id, kind: i.kind, amountPaise: i.amountPaise, litres: row.litres } });
    return this.toDto(row, await this.names([row]));
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.expense.findFirst({ where: { AND: [this.scope(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('Expense not found');
    return row;
  }

  async remove(ctx: AuthContext, id: string): Promise<{ ok: true }> {
    const row = await this.find(ctx, id);
    await this.prisma.expense.delete({ where: { id } });
    if (row.photoPath) await unlink(row.photoPath).catch(() => undefined);
    await this.audit.record({ ...ctx, companyId: row.companyId }, { action: 'DELETE', entity: 'Expense', entityId: id, before: { kind: row.kind, amountPaise: row.amountPaise, at: row.at.toISOString() } });
    return { ok: true };
  }

  async attach(ctx: AuthContext, id: string, file: UploadedBill | undefined): Promise<ExpenseDto> {
    const row = await this.find(ctx, id);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a photo of the bill');
    if (file.buffer.length > MAX_BYTES) throw new BadRequestException('The file is larger than 10 MB');
    const type = PHOTO_TYPES[(file.mimetype ?? '').toLowerCase()];
    if (!type || !type.sig(file.buffer)) throw new BadRequestException('Upload a photo (JPEG, PNG, WebP) or a PDF');
    const dir = join(EXPENSES_DIR, row.companyId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}-${randomUUID()}.${type.ext}`);
    await writeFile(path, file.buffer);
    await this.prisma.expense.update({ where: { id }, data: { photoPath: path, photoType: (file.mimetype ?? '').toLowerCase() } });
    if (row.photoPath) await unlink(row.photoPath).catch(() => undefined);
    return this.toDto(await this.find(ctx, id), await this.names([row]));
  }

  async photo(ctx: AuthContext, id: string): Promise<StreamableFile> {
    const row = await this.find(ctx, id);
    if (!row.photoPath) throw new NotFoundException('No bill photo');
    const info = await stat(row.photoPath).catch(() => null);
    if (!info) throw new NotFoundException('The file no longer exists');
    return new StreamableFile(createReadStream(row.photoPath), { type: row.photoType ?? 'application/octet-stream', length: info.size, disposition: 'inline' });
  }

  /** Per-vehicle km / L and cost per km for a period (distance from the day summaries). */
  async summary(ctx: AuthContext, from: string, to: string): Promise<ExpenseSummaryDto> {
    const f = new Date(from);
    const t = new Date(to);
    if (!Number.isFinite(f.getTime()) || !Number.isFinite(t.getTime()) || f > t) throw new BadRequestException('Choose a valid date range');
    const rows = await this.prisma.expense.findMany({ where: { AND: [this.scope(ctx), { at: { gte: f, lte: t } }] }, include: INCLUDE });
    const ids = [...new Set(rows.map((r) => r.objectId))];
    // DailySummary.day is the company-local calendar day (stored at UTC midnight); a UTC slice of `from` would add the day before.
    const company = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
    const tz = company?.timezone ?? 'Asia/Kolkata';
    const dayOf = (d: Date) => new Date(`${localDayKey(d.getTime(), tz)}T00:00:00.000Z`);
    const km = await this.prisma.dailySummary.groupBy({ by: ['objectId'], where: { objectId: { in: ids }, day: { gte: dayOf(f), lte: dayOf(t) } }, _sum: { distanceKm: true } });
    const kmBy = new Map(km.map((k) => [k.objectId, k._sum.distanceKm ?? 0]));
    const byKind = Object.fromEntries(EXPENSE_KINDS.map((k) => [k, 0])) as Record<ExpenseKind, number>;
    const per = new Map<string, { name: string; litres: number; fuel: number; other: number }>();
    for (const r of rows) {
      byKind[r.kind as ExpenseKind] += r.amountPaise;
      const e = per.get(r.objectId) ?? { name: r.object.plateNumber && r.object.plateNumber !== r.object.name ? `${r.object.name} (${r.object.plateNumber})` : r.object.name, litres: 0, fuel: 0, other: 0 };
      if (r.kind === 'FUEL') {
        e.litres += r.litres ?? 0;
        e.fuel += r.amountPaise;
      } else e.other += r.amountPaise;
      per.set(r.objectId, e);
    }
    const vehicles = [...per.entries()]
      .map(([objectId, e]) => {
        const d = Math.round((kmBy.get(objectId) ?? 0) * 10) / 10;
        return { objectId, objectName: e.name, km: d, fuelLitres: Math.round(e.litres * 100) / 100, fuelPaise: e.fuel, otherPaise: e.other, ...vehicleCost(d, e.litres, e.fuel, e.other) };
      })
      .sort((a, b) => b.fuelPaise + b.otherPaise - (a.fuelPaise + a.otherPaise));
    return { from: f.toISOString(), to: t.toISOString(), vehicles, totalPaise: rows.reduce((s, r) => s + r.amountPaise, 0), byKind };
  }
}
