import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { phoneCountryForTimezone, validHomePoint, type PassengerImportResult } from '@veetracer/shared';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../access/auth-context';
import { AuditService, diffSnapshots } from '../../audit/audit.service';
import { GeocodingService } from '../../geocoding/geocoding.service';
import { PrismaService } from '../../prisma/prisma.service';
import { accessibilityOf } from './people-access';
import { PROFILE_ENTITY, profileSnapshot } from './people.service';
import {
  ImportFormatError,
  finaliseRow,
  parseRowSelection,
  readPassengerCsv,
  refMap,
  validateImportRows,
  type ExistingProfile,
  type ImportLookups,
  type ProfileWrite,
} from './passenger-import';

const CHUNK = 500;
const GEOCODE_CONCURRENCY = 8;

const EXISTING_SELECT = {
  id: true,
  employeeCode: true,
  displayName: true,
  mobile: true,
  email: true,
  homeAddress: true,
  homeLat: true,
  homeLng: true,
  homeGeocodeSource: true,
  homeGeocodeConfidence: true,
  officePoiId: true,
  defaultStopPoiId: true,
  branchId: true,
  accessibility: true,
  isActive: true,
} satisfies Prisma.EmployeeTransportProfileSelect;

const formatError = (message: string) => new BadRequestException({ message, code: 'IMPORT_FORMAT' });

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Passenger CSV import (doc 05 §2.2): preview = dry run (validation report, nothing written); commit = the same
 * validation, then CREATE / UPDATE rows without errors (optionally only selected rows) in chunks. Idempotent on
 * (company, employee_code): UNCHANGED rows are not written, so a second commit of the same file creates 0 rows.
 * Whole-company roles only (corporate admin, doc 05 §6). Geocoding (opt-in) uses only the self-hosted Photon.
 */
@Injectable()
export class PassengerImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly geocoding: GeocodingService,
  ) {}

  async run(ctx: AuthContext, file: { buffer: Buffer } | undefined, opts: { commit: boolean; geocode: boolean; rows?: string }): Promise<PassengerImportResult> {
    if (ctx.dataScope !== 'COMPANY') throw new ForbiddenException({ message: 'Only whole-company roles can import passengers', code: 'FORBIDDEN_GRANT' });
    if (!file?.buffer?.length) throw formatError('Choose a CSV file');
    let parsed: ReturnType<typeof readPassengerCsv>;
    let selection: Set<number> | null;
    try {
      parsed = readPassengerCsv(file.buffer);
      selection = opts.commit ? parseRowSelection(opts.rows) : null;
    } catch (e) {
      if (e instanceof ImportFormatError) throw formatError(e.message);
      throw e;
    }

    const companyId = ctx.companyId;
    const lookups = await this.lookups(companyId);
    const validated = validateImportRows(parsed.rows, lookups);

    if (opts.geocode && this.geocoding.enabled) {
      const need = validated.filter((v) => v.patch && v.patch.homeAddress && v.patch.homeLat === undefined && (!v.existing || v.existing.homeAddress !== v.patch.homeAddress || v.existing.homeLat === null));
      await pool(need, GEOCODE_CONCURRENCY, async (v) => {
        const patch = v.patch!;
        const [hit] = await this.geocoding.search(patch.homeAddress!);
        if (hit && validHomePoint(hit.lat, hit.lng)) {
          patch.homeLat = Number(hit.lat.toFixed(6));
          patch.homeLng = Number(hit.lng.toFixed(6));
          patch.homeSource = 'PHOTON';
          patch.homeConfidence = null;
          v.result.geocode = { lat: patch.homeLat, lng: patch.homeLng, label: hit.label, confidence: null };
        } else {
          v.result.warnings.push({ column: 'home_address', code: 'GEOCODE_NO_RESULT', message: 'Address not found by the map search: confirm the pin later' });
        }
      });
    }

    const plans = validated.map((v) => ({ v, ...finaliseRow(v) }));
    let skipped = 0;
    for (const p of plans) {
      p.v.result.action = p.action;
      if (selection && p.action !== 'ERROR' && !selection.has(p.v.result.row)) {
        p.v.result.action = 'SKIPPED';
        skipped++;
      }
    }

    let creates = plans.filter((p) => p.v.result.action === 'CREATE').length;
    const updates = plans.filter((p) => p.v.result.action === 'UPDATE').length;
    if (opts.commit) creates = await this.write(ctx, plans.filter((p) => ['CREATE', 'UPDATE'].includes(p.v.result.action)));

    const rows = validated.map((v) => v.result);
    return {
      committed: opts.commit,
      totalRows: rows.length,
      creates,
      updates,
      unchanged: rows.filter((r) => r.action === 'UNCHANGED').length,
      errors: rows.filter((r) => r.action === 'ERROR').length,
      skipped,
      duplicates: rows.filter((r) => r.errors.some((e) => e.code.startsWith('DUPLICATE_'))).length,
      rows,
    };
  }

  private async lookups(companyId: string): Promise<ImportLookups> {
    const [company, pois, branches, existing] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
      this.prisma.poi.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true, category: true } }),
      this.prisma.branch.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true } }),
      this.prisma.employeeTransportProfile.findMany({ where: { companyId }, select: EXISTING_SELECT }),
    ]);
    // Offices are looked up among OFFICE places first, stops among SHUTTLE_STOP places first, then any active place.
    const ordered = (cat: string) => [...pois.filter((p) => p.category === cat), ...pois.filter((p) => p.category !== cat)];
    const byCode = new Map<string, ExistingProfile>();
    const emailOwners = new Map<string, string>();
    const mobileOwners = new Map<string, string>();
    for (const p of existing) {
      byCode.set(p.employeeCode, { ...p, accessibility: accessibilityOf(p.accessibility) });
      if (!p.isActive) continue;
      if (p.email && !emailOwners.has(p.email)) emailOwners.set(p.email, p.employeeCode);
      if (p.mobile && !mobileOwners.has(p.mobile)) mobileOwners.set(p.mobile, p.employeeCode);
    }
    return {
      country: phoneCountryForTimezone(company?.timezone),
      sites: refMap(ordered('OFFICE')),
      stops: refMap(ordered('SHUTTLE_STOP')),
      branches: refMap(branches),
      existing: byCode,
      emailOwners,
      mobileOwners,
    };
  }

  /** Writes the planned rows; returns the number of profiles actually created. */
  private async write(ctx: AuthContext, plans: { v: { result: { row: number; employeeCode: string; passengerId: string | null }; existing: ExistingProfile | null }; target: ProfileWrite | null; changed: string[] }[]): Promise<number> {
    const columns = (t: ProfileWrite) => ({ ...t, accessibility: t.accessibility as Prisma.InputJsonValue });
    let created = 0;
    const creates = plans.filter((p) => !p.v.existing && p.target);
    for (let i = 0; i < creates.length; i += CHUNK) {
      const plansChunk = creates.slice(i, i + CHUNK);
      const chunk = plansChunk.map((p) => ({ id: randomUUID(), employeeCode: p.v.result.employeeCode, ...columns(p.target!) }));
      await this.prisma.$transaction(async (tx) => {
        const res = await tx.employeeTransportProfile.createMany({
          data: chunk.map((c) => ({ ...c, companyId: ctx.companyId, createdById: ctx.userId })),
          skipDuplicates: true,
        });
        created += res.count;
        // Rows a concurrent import created first are skipped (skipDuplicates): audit only the rows that exist with our ids.
        const ours = new Set((await tx.employeeTransportProfile.findMany({ where: { id: { in: chunk.map((c) => c.id) } }, select: { id: true } })).map((r) => r.id));
        await tx.auditLog.createMany({
          data: chunk
            .filter((c) => ours.has(c.id))
            .map((c) => ({ companyId: ctx.companyId, userId: ctx.userId, ip: ctx.ip, action: 'CREATE' as const, entity: PROFILE_ENTITY, entityId: c.id, changes: diffSnapshots(null, profileSnapshot({ ...c, source: 'import' })) as Prisma.InputJsonValue })),
        });
        chunk.forEach((c, k) => {
          if (ours.has(c.id)) plansChunk[k].v.result.passengerId = c.id;
        });
      });
    }
    const updates = plans.filter((p) => p.v.existing && p.target);
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      await this.prisma.$transaction(async (tx) => {
        for (const p of chunk) await tx.employeeTransportProfile.update({ where: { id: p.v.existing!.id }, data: columns(p.target!) });
        await tx.auditLog.createMany({
          data: chunk.map((p) => ({
            companyId: ctx.companyId,
            userId: ctx.userId,
            ip: ctx.ip,
            action: 'UPDATE' as const,
            entity: PROFILE_ENTITY,
            entityId: p.v.existing!.id,
            changes: diffSnapshots(profileSnapshot({ ...p.v.existing! }), profileSnapshot({ ...p.v.existing!, ...p.target! })) as Prisma.InputJsonValue,
          })),
        });
      });
    }
    await this.audit.record(ctx, { action: 'CREATE', entity: `${PROFILE_ENTITY}Import`, details: { created, updated: updates.length, rows: plans.length } });
    return created;
  }
}
